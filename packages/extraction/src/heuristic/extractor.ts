/**
 * The heuristic extractor — the correctness baseline (ADR-0006: "heuristics are the correctness
 * baseline, never a stub"). Zero LLM, zero network, deterministic.
 *
 * Recognizes (memory-model.md §8 stage 4, event-memory-schemas.md §3):
 * 1. explicit user intent (`explicit.remember`) — highest source authority;
 * 2. explicit decision language ("we decided", "chose X over Y", "settled on");
 * 3. preference statements ("always/never/prefer/make sure to");
 * 4. error + resolution pairs (`error.raised`/failing command followed by a related success);
 * 5. recurring commands and command sequences (≥ 2 occurrences → procedural candidate);
 * 6. versioned facts ("upgraded to Node 22");
 * 7. stack/dependency mentions (git commits, pull requests, documents);
 * 8. session-scoped working signals (unresolved errors, edited files, tasks, hypotheses, open
 *    questions) which route to working memory instead of durable memory.
 *
 * Everything then passes the future-value gate; semantic facts are emitted as
 * `semantic_candidate`, never `semantic`.
 */

import {
  ExtractionResultSchema,
  type EvidenceSpan,
  type ExtractedMemory,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
  type OnememoryEvent,
  type WorkingCandidate,
} from '@onememory/core';

import { createHeuristicClassifier, EXPLICIT_SEMANTIC_SUBTYPE, type Classifier, type WorkingSignal } from '../classifier';
import {
  buildEvidence,
  eventTextForMatching,
  normalizeEvent,
  type NormalizedEvent,
} from '../events';
import { createFutureValueGate } from '../gate';
import { DEFAULT_THRESHOLDS, HEURISTIC_PROMPT_VERSION, type ExtractionThresholds } from '../types';

import {
  DECISION_NOISE_PATTERNS,
  DECISION_PATTERNS,
  HYPOTHESIS_PATTERNS,
  OPEN_QUESTION_PATTERNS,
  PREFERENCE_NOISE_PATTERNS,
  PREFERENCE_PATTERNS,
  TASK_PATTERNS,
  VERSION_NOISE_PATTERNS,
  VERSION_PATTERNS,
  extractTechMentions,
  executableOf,
  firstMatch,
  isDeniedCommand,
  sentenceAround,
  significantTokens,
} from './patterns';

export interface HeuristicExtractorOptions {
  thresholds?: Partial<ExtractionThresholds>;
  classifier?: Classifier;
}

const MAX_CONTENT = 500;
const MAX_FILES_TRACKED = 5;
const MAX_WORKING_PER_RULE = 5;
const MAX_STACK_EVIDENCE = 3;
const MAX_SEQUENCE_EVIDENCE = 3;

function clamp(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) : collapsed;
}

interface ProseSource {
  event: NormalizedEvent;
  text: string;
  role: 'user' | 'assistant' | 'document' | 'session';
}

export function createHeuristicExtractor(options: HeuristicExtractorOptions = {}): Extractor {
  const thresholds: ExtractionThresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const classifier = options.classifier ?? createHeuristicClassifier();
  const gate = createFutureValueGate({ thresholds });

  return {
    async extract(inputs: ExtractionInput[]): Promise<ExtractionResult> {
      const normalized: NormalizedEvent[] = [];
      const eventById = new Map<string, OnememoryEvent>();
      const sourceByEvent = new Map<string, string>();
      const roleByEvent = new Map<string, 'user' | 'assistant'>();

      for (const input of inputs) {
        sourceByEvent.set(input.event.id, input.source.id);
        eventById.set(input.event.id, input.event);
        if (input.event.kind === 'conversation.message') {
          const payload = input.event.payload as { role?: string };
          roleByEvent.set(
            input.event.id,
            payload.role === 'user' ? 'user' : 'assistant',
          );
        }
        try {
          normalized.push(normalizeEvent(input));
        } catch {
          // A malformed payload is flagged `needs_review` by the NORMALIZE stage; the extractor
          // skips it and keeps processing the rest of the batch (never drops the event itself).
        }
      }
      normalized.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

      const memories: ExtractedMemory[] = [];
      const working: WorkingCandidate[] = [];

      function evidenceFor(event: NormalizedEvent, excerptText?: string): EvidenceSpan {
        const envelope = eventById.get(event.event_id)!;
        return buildEvidence(
          envelope,
          sourceByEvent.get(event.event_id) ?? event.source_id,
          excerptText ?? eventTextForMatching(envelope),
        );
      }

      function push(candidate: ExtractedMemory): void {
        memories.push({ ...candidate, content: clamp(candidate.content, MAX_CONTENT) });
      }

      function pushWorking(signal: WorkingSignal, content: string, event: NormalizedEvent): void {
        const candidate = classifier.routeWorking({
          signal,
          content,
          session_id: event.session_id,
        });
        if (candidate) working.push(candidate);
      }

      // --- 1. explicit user intent --------------------------------------------------------
      for (const event of normalized) {
        if (event.kind !== 'explicit.remember' || !event.explicit) continue;
        const declared = event.explicit.type;
        // `explicit.remember` may declare a durable type; anything semantic-ish (or absent) is an
        // explicit user statement, which memory-model.md §9 allows to become `semantic` directly.
        const explicitDurableTypes = new Set(['procedural', 'decision', 'preference', 'failure']);
        const isSemantic = declared === undefined || !explicitDurableTypes.has(declared);
        push({
          type: isSemantic ? 'semantic_candidate' : (declared as ExtractedMemory['type']),
          ...(isSemantic ? { subtype: EXPLICIT_SEMANTIC_SUBTYPE } : {}),
          content: event.explicit.content,
          importance: event.explicit.importance ?? 0.9,
          confidence: 0.95,
          entities: extractTechMentions(event.explicit.content),
          evidence: [evidenceFor(event, event.explicit.content)],
          future_value_rationale: 'explicit user statement — highest source authority',
        });
      }

      // --- prose sources for language rules -----------------------------------------------
      const proseSources: ProseSource[] = [];
      for (const event of normalized) {
        const envelope = eventById.get(event.event_id)!;
        if (event.kind === 'conversation.message') {
          const payload = envelope.payload as { content?: string };
          proseSources.push({
            event,
            text: String(payload.content ?? ''),
            role: roleByEvent.get(event.event_id) ?? 'assistant',
          });
        } else if (event.kind === 'document.added' && event.document) {
          proseSources.push({ event, text: event.document.text, role: 'document' });
        } else if (event.kind === 'session.end') {
          const payload = envelope.payload as { summary?: string };
          if (payload.summary) {
            proseSources.push({ event, text: payload.summary, role: 'session' });
          }
        }
      }

      // --- 2. decision language ------------------------------------------------------------
      for (const source of proseSources) {
        if (firstMatch(source.text, DECISION_NOISE_PATTERNS)) continue;
        const match = firstMatch(source.text, DECISION_PATTERNS);
        if (!match) continue;
        const user = source.role === 'user';
        const isChoice = match.captures.length >= 2;
        const statement = isChoice
          ? `${match.captures[0]} over ${match.captures[1]}`
          : (match.captures[0] ?? match.match);
        push({
          type: 'decision',
          subtype: isChoice ? 'decision.choice' : 'decision.statement',
          content: `Decision: ${statement}`,
          importance: 0.8,
          confidence: user ? 0.85 : 0.6,
          entities: extractTechMentions(match.match),
          evidence: [evidenceFor(source.event, match.match)],
          future_value_rationale: 'explicit decision language — prevents re-litigating settled choices',
        });
      }

      // --- 3. preference statements --------------------------------------------------------
      for (const source of proseSources) {
        if (firstMatch(source.text, PREFERENCE_NOISE_PATTERNS)) continue;
        const match = firstMatch(source.text, PREFERENCE_PATTERNS);
        if (!match) continue;
        const user = source.role === 'user';
        const statement = match.captures.filter(Boolean).join(' over ');
        if (statement.trim().length < 3) continue;
        push({
          type: 'preference',
          subtype: 'preference.statement',
          content: `Preference: ${statement}`,
          importance: 0.6,
          confidence: user ? 0.7 : 0.5,
          entities: extractTechMentions(match.match),
          evidence: [evidenceFor(source.event, match.match)],
          future_value_rationale: 'stated preference — constrains how future work should be done',
        });
      }

      // --- 4. error + resolution pairs ------------------------------------------------------
      const failures = normalized.filter(
        (event) =>
          event.error !== undefined ||
          (event.command !== undefined && event.command.exit_code !== null && event.command.exit_code !== 0),
      );
      const successes = normalized.filter(
        (event) =>
          (event.command !== undefined && event.command.exit_code === 0) ||
          (event.tests !== undefined && event.tests.failed === 0) ||
          isSuccessfulToolResult(eventById.get(event.event_id)),
      );

      /**
       * Relatedness: a success resolves a failure when it runs the same command again, when the
       * failure was a test run and the tests now pass, or when the texts share a significant token
       * that is not merely the shared executable (`bun test` failing is not fixed by `bun install`).
       */
      function isRelated(failure: NormalizedEvent, success: NormalizedEvent): boolean {
        const failureCommand = failure.command?.normalized;
        const successCommand = success.command?.normalized;
        if (failureCommand && successCommand && failureCommand === successCommand) return true;
        if (failure.error?.origin === 'test' && success.tests) return true;
        const executableTokens = new Set(
          [failureCommand, successCommand]
            .filter((value): value is string => value !== undefined)
            .map(executableOf)
            .filter((value) => value.length > 0),
        );
        const failureTokens = significantTokens(
          failure.error
            ? `${failure.error.message} ${failure.error.context ?? ''}`
            : `${failure.command?.text ?? ''} ${failure.command?.normalized ?? ''}`,
        );
        const successTokens = significantTokens(
          success.command
            ? `${success.command.text} ${success.command.normalized}`
            : success.tests
              ? success.tests.failure_names.join(' ')
              : eventTextForMatching(eventById.get(success.event_id)!),
        );
        for (const token of failureTokens) {
          if (successTokens.has(token) && !executableTokens.has(token)) return true;
        }
        return false;
      }

      function pairFor(failure: NormalizedEvent): NormalizedEvent | undefined {
        return successes.find((candidate) => {
          if (candidate.occurred_at <= failure.occurred_at) return false;
          if (
            failure.session_id &&
            candidate.session_id &&
            failure.session_id !== candidate.session_id
          ) {
            return false;
          }
          return isRelated(failure, candidate);
        });
      }

      const pairings = failures.map((failure) => ({ failure, success: pairFor(failure) }));

      for (const { failure, success } of pairings) {
        const label = failure.error?.message ?? `\`${failure.command?.text ?? 'command'}\` failed`;
        if (!success) {
          pushWorking('unresolved_error', `Unresolved error: ${label}`, failure);
          continue;
        }
        // A failing command whose incident also produced an `error.raised` is described better by
        // that event: emit one failure candidate per incident, not two.
        if (failure.command && !failure.error) {
          const coveredByErrorEvent = pairings.some(
            (other) =>
              other.success !== undefined &&
              other.failure.error !== undefined &&
              other.failure.session_id === failure.session_id &&
              other.failure.occurred_at >= failure.occurred_at &&
              other.failure.occurred_at <= success.occurred_at,
          );
          if (coveredByErrorEvent) continue;
        }
        const resolution = success.command
          ? `\`${success.command.text}\``
          : success.tests
            ? 'tests passing'
            : 'the following tool call succeeded';
        push({
          type: 'failure',
          subtype: 'failure.resolved',
          content: `Error: ${clamp(label, 200)} — resolved by: ${resolution}`,
          importance: 0.75,
          confidence: 0.7,
          entities: extractTechMentions(`${label} ${resolution}`),
          evidence: [evidenceFor(failure, label), evidenceFor(success, resolution)],
          future_value_rationale: 'error followed by a related success — the fix is reusable',
        });
      }

      // --- 5. recurring commands and sequences ---------------------------------------------
      const commandEvents = normalized.filter(
        (event) => event.command !== undefined && !isDeniedCommand(event.command.normalized),
      );

      const bySession = new Map<string, NormalizedEvent[]>();
      for (const event of commandEvents) {
        const key = event.session_id ?? '(no-session)';
        const list = bySession.get(key);
        if (list) list.push(event);
        else bySession.set(key, [event]);
      }

      // Recurring sequences are the stronger signal; collect them first so single commands that
      // are part of a recurring sequence are not emitted as separate procedural candidates.
      const recurringSequences = new Map<string, NormalizedEvent[]>();
      for (const events of bySession.values()) {
        const ordered = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
        const sequences = new Map<string, NormalizedEvent[]>();
        for (let index = 0; index + 1 < ordered.length; index += 1) {
          const first = ordered[index]!;
          const second = ordered[index + 1]!;
          const key = `${first.command!.normalized} → ${second.command!.normalized}`;
          const list = sequences.get(key);
          if (list) list.push(first, second);
          else sequences.set(key, [first, second]);
        }
        for (const [sequence, occurrences] of sequences) {
          if (occurrences.length / 2 < thresholds.min_sequence_occurrences) continue;
          recurringSequences.set(sequence, occurrences);
        }
      }

      const commandsInSequences = new Set<string>();
      for (const sequence of recurringSequences.keys()) {
        for (const command of sequence.split(' → ')) commandsInSequences.add(command);
      }

      const byCommand = new Map<string, NormalizedEvent[]>();
      for (const event of commandEvents) {
        const key = event.command!.normalized;
        const list = byCommand.get(key);
        if (list) list.push(event);
        else byCommand.set(key, [event]);
      }
      for (const [command, occurrences] of byCommand) {
        if (occurrences.length < thresholds.min_command_occurrences) continue;
        if (commandsInSequences.has(command)) continue;
        push({
          type: 'procedural',
          subtype: 'procedural.command',
          content: `Recurring command: \`${command}\` (used ${occurrences.length} times)`,
          importance: 0.55,
          confidence: 0.65,
          entities: extractTechMentions(command),
          evidence: occurrences.slice(0, MAX_SEQUENCE_EVIDENCE).map((event) => evidenceFor(event, command)),
          future_value_rationale: 'repeated command — a repeatable procedure worth remembering',
        });
      }

      for (const [sequence, occurrences] of recurringSequences) {
        const occurrenceCount = occurrences.length / 2;
        const unique = [...new Map(occurrences.map((event) => [event.event_id, event])).values()];
        push({
          type: 'procedural',
          subtype: 'procedural.sequence',
          content: `Recurring command sequence: \`${sequence}\` (${occurrenceCount} times)`,
          importance: 0.55,
          confidence: 0.65,
          entities: extractTechMentions(sequence),
          evidence: unique.slice(0, MAX_SEQUENCE_EVIDENCE).map((event) => evidenceFor(event)),
          future_value_rationale: 'repeated command sequence — a repeatable procedure',
        });
      }

      // --- 6. versioned facts ---------------------------------------------------------------
      for (const source of proseSources) {
        if (firstMatch(source.text, VERSION_NOISE_PATTERNS)) continue;
        const match = firstMatch(source.text, VERSION_PATTERNS);
        if (!match) continue;
        const statement = match.captures.filter(Boolean).join(' ');
        if (!/\d/.test(statement)) continue;
        const techs = extractTechMentions(match.match);
        push({
          type: 'semantic_candidate',
          subtype: 'semantic.version',
          content: `Version: ${statement}`,
          importance: 0.65,
          confidence: source.role === 'user' ? 0.7 : 0.6,
          entities: techs,
          evidence: [evidenceFor(source.event, match.match)],
          future_value_rationale: 'versioned fact — answers "which version does this project use?"',
        });
      }

      // --- 7. stack / dependency mentions ---------------------------------------------------
      const stackEvidence = new Map<string, NormalizedEvent[]>();
      for (const event of normalized) {
        let text: string | undefined;
        let label: string | undefined;
        if (event.commit) {
          text = `${event.commit.message} ${event.commit.files.join(' ')}`;
          label = `commit ${event.commit.sha.slice(0, 8)}`;
        } else if (event.pull_request) {
          text = event.pull_request.title;
          label = `PR #${event.pull_request.number}`;
        } else if (event.document) {
          text = `${event.document.title ?? ''} ${event.document.text}`;
          label = `document ${event.document.title ?? event.document.path ?? event.document.uri ?? ''}`.trim();
        }
        if (text === undefined || label === undefined) continue;
        for (const tech of extractTechMentions(text).slice(0, 3)) {
          const key = `${tech}|${label}`;
          const list = stackEvidence.get(key);
          if (list) list.push(event);
          else stackEvidence.set(key, [event]);
        }
      }
      for (const [key, events] of stackEvidence) {
        const separator = key.lastIndexOf('|');
        const tech = key.slice(0, separator);
        const label = key.slice(separator + 1);
        push({
          type: 'episodic',
          subtype: 'episodic.stack',
          content: `Uses ${tech} (${label})`,
          importance: 0.5,
          confidence: 0.5,
          entities: [tech],
          evidence: events.slice(0, MAX_STACK_EVIDENCE).map((event) => evidenceFor(event)),
          future_value_rationale: 'stack mention — feeds the project digest',
        });
      }

      // --- 8. working-memory signals ---------------------------------------------------------
      const files = normalized.filter((event) => event.file !== undefined).slice(-MAX_FILES_TRACKED);
      for (const event of files) {
        pushWorking('edited_file', `Editing ${event.file!.path}`, event);
      }

      let questions = 0;
      let hypotheses = 0;
      let tasks = 0;
      for (const source of proseSources) {
        if (source.role !== 'user' && source.role !== 'assistant') continue;
        const question = firstMatch(source.text, OPEN_QUESTION_PATTERNS);
        if (question && questions < MAX_WORKING_PER_RULE) {
          const index = source.text.indexOf(question.match);
          pushWorking('open_question', sentenceAround(source.text, index, question.match.length), source.event);
          questions += 1;
          continue;
        }
        const hypothesis = firstMatch(source.text, HYPOTHESIS_PATTERNS);
        if (hypothesis && hypotheses < MAX_WORKING_PER_RULE) {
          const index = source.text.indexOf(hypothesis.match);
          pushWorking(
            'stated_hypothesis',
            sentenceAround(source.text, index, hypothesis.match.length),
            source.event,
          );
          hypotheses += 1;
          continue;
        }
        const task = firstMatch(source.text, TASK_PATTERNS);
        if (task && tasks < MAX_WORKING_PER_RULE) {
          pushWorking('stated_task', task.match, source.event);
          tasks += 1;
        }
      }

      const gated = gate.apply({
        memories,
        working,
        extraction_meta: { method: 'heuristic', prompt_version: HEURISTIC_PROMPT_VERSION },
      });

      // The contract: the extractor MUST emit this exact shape (event-memory-schemas.md §3).
      return ExtractionResultSchema.parse(gated.result);
    },
  };
}

function isSuccessfulToolResult(event: OnememoryEvent | undefined): boolean {
  if (!event || event.kind !== 'conversation.tool_result') return false;
  return (event.payload as { ok?: boolean }).ok === true;
}
