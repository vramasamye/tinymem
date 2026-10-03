/**
 * The prompt seam. Interactive use goes through `@clack/prompts`; scripts, CI and tests use
 * {@link createNonInteractivePrompt}, which answers from provided defaults or fails closed — a
 * non-interactive `onemem init` with missing answers tells the user exactly which flag to pass
 * instead of hanging.
 */

import * as clack from '@clack/prompts';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompt {
  intro(text: string): void;
  outro(text: string): void;
  select<T extends string>(message: string, options: SelectOption<T>[], initial: T): Promise<T>;
  text(message: string, options: { placeholder?: string; defaultValue?: string }): Promise<string>;
  note(text: string, title?: string): void;
}

export class PromptRequiredError extends Error {
  constructor(public readonly flag: string, detail: string) {
    super(`${detail} (pass ${flag})`);
    this.name = 'PromptRequiredError';
  }
}

export function createClackPrompt(): Prompt {
  return {
    intro: (text) => clack.intro(text),
    outro: (text) => clack.outro(text),
    note: (text, title) => clack.note(text, title),
    // clack's `Option<Value>` is a deferred conditional type on Value, so the literal is built
    // against the resolved `Option<string>` shape and the answer is narrowed back to T.
    select: async <T extends string>(
      message: string,
      options: SelectOption<T>[],
      initial: T,
    ): Promise<T> => {
      const choice = await clack.select<string>({
        message,
        options: options.map((option) => ({
          value: option.value as string,
          label: option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
        })),
        initialValue: initial,
      });
      if (clack.isCancel(choice)) {
        throw new Error('cancelled');
      }
      return choice as T;
    },
    text: async (message: string, options: { placeholder?: string; defaultValue?: string }): Promise<string> => {
      const answer = await clack.text({
        message,
        ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options.defaultValue === undefined ? {} : { defaultValue: options.defaultValue }),
      });
      if (clack.isCancel(answer)) {
        throw new Error('cancelled');
      }
      return answer;
    },
  };
}

/** Answers every question with the default; throws when there is no default. */
export function createNonInteractivePrompt(): Prompt {
  return {
    intro: () => {},
    outro: () => {},
    note: () => {},
    select: async <T extends string>(_message: string, _options: SelectOption<T>[], initial: T): Promise<T> => {
      void _message;
      void _options;
      return initial;
    },
    text: async (_message: string, options: { placeholder?: string; defaultValue?: string }): Promise<string> => {
      void _message;
      if (options.defaultValue === undefined) {
        throw new PromptRequiredError('--name', 'a project name is required in non-interactive mode');
      }
      return options.defaultValue;
    },
  };
}
