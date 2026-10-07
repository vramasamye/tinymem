/**
 * The skill review controller: the bundle is rendered from the API (never re-rendered
 * client-side), the action gates follow the lifecycle the API enforces, and the two
 * actions send exactly the audited request the REST surface expects.
 */

import { describe, expect, test } from 'bun:test';

import { ApiError, createApiClient } from '../../../api/client';
import {
  FIXTURE_SKILL_MARKDOWN,
  PROJECT_ID,
  SKILL_ID_CANDIDATE,
  SKILL_ID_VERIFIED,
  anchorUrl,
  apiErrorBody,
  defaultStubRoutes,
  fixtureSkillReview,
  fixtureSkillSummary,
  jsonResponse,
  stubApi,
} from '../../../test/fixtures';
import { approveSkill, loadSkillReview, rejectSkill } from './controller';

const skillUrl = (id: string) => `/v1/projects/${PROJECT_ID}/skills/${id}`;

function recording(routes = defaultStubRoutes()) {
  const sent: Array<{ path: string; body: unknown }> = [];
  const inner = stubApi(routes);
  const api = createApiClient({
    fetchImpl: async (input, init) => {
      sent.push({
        path: new URL(anchorUrl(input)).pathname,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return inner(input, init);
    },
  });
  return { api, sent };
}

describe('loadSkillReview', () => {
  test('a candidate with evidence renders the API markdown and offers approve + reject', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadSkillReview(api, PROJECT_ID, SKILL_ID_CANDIDATE);

    expect(vm.skill.name).toBe('raise-cloud-run-memory');
    expect(vm.markdown).toBe(FIXTURE_SKILL_MARKDOWN);
    expect(vm.audit.map((event) => event.action)).toEqual(['created']);
    expect(vm.canApprove).toBeTrue();
    expect(vm.approveBlockedReason).toBeNull();
    expect(vm.canReject).toBeTrue();
  });

  test('a verified skill cannot be approved again but can still be retired', async () => {
    const routes = defaultStubRoutes();
    routes[`GET ${skillUrl(SKILL_ID_VERIFIED)}`] = fixtureSkillReview(fixtureSkillSummary(SKILL_ID_VERIFIED));
    const vm = await loadSkillReview(createApiClient({ fetchImpl: stubApi(routes) }), PROJECT_ID, SKILL_ID_VERIFIED);

    expect(vm.canApprove).toBeFalse();
    expect(vm.approveBlockedReason).toContain('verified');
    expect(vm.canReject).toBeTrue();
  });

  test('a candidate without evidence is not approvable; a deprecated skill offers no action', async () => {
    const routes = defaultStubRoutes();
    routes[`GET ${skillUrl(SKILL_ID_CANDIDATE)}`] = fixtureSkillReview(fixtureSkillSummary(SKILL_ID_CANDIDATE, { evidence_count: 0 }));
    const bare = await loadSkillReview(createApiClient({ fetchImpl: stubApi(routes) }), PROJECT_ID, SKILL_ID_CANDIDATE);
    expect(bare.canApprove).toBeFalse();
    expect(bare.approveBlockedReason).toContain('evidence');

    routes[`GET ${skillUrl(SKILL_ID_CANDIDATE)}`] = fixtureSkillReview(fixtureSkillSummary(SKILL_ID_CANDIDATE, { status: 'deprecated' }));
    const retired = await loadSkillReview(createApiClient({ fetchImpl: stubApi(routes) }), PROJECT_ID, SKILL_ID_CANDIDATE);
    expect(retired.canApprove).toBeFalse();
    expect(retired.canReject).toBeFalse();
  });

  test('an unknown skill surfaces the API 404 verbatim', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const error = await loadSkillReview(api, PROJECT_ID, SKILL_ID_VERIFIED).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('not_found');
  });
});

describe('the review actions', () => {
  test('approve posts the chosen runtime and trimmed note; blank fields are omitted', async () => {
    const routes = defaultStubRoutes();
    routes[`POST ${skillUrl(SKILL_ID_CANDIDATE)}/promote`] = {
      project_id: PROJECT_ID,
      skill: fixtureSkillSummary(SKILL_ID_CANDIDATE, { status: 'verified' }),
      written_path: '/repo/.agents/skills/raise-cloud-run-memory/SKILL.md',
      skills_root: '/repo/.agents/skills',
      skills_root_source: 'runtime-flag',
      markdown_bytes: FIXTURE_SKILL_MARKDOWN.length,
    };
    const { api, sent } = recording(routes);

    const result = await approveSkill(api, PROJECT_ID, SKILL_ID_CANDIDATE, { runtime: 'codex', note: '  looks right ' });
    expect(result.written_path).toBe('/repo/.agents/skills/raise-cloud-run-memory/SKILL.md');
    await approveSkill(api, PROJECT_ID, SKILL_ID_CANDIDATE, { runtime: '', note: '   ' });

    expect(sent.map((call) => call.body)).toEqual([{ runtime: 'codex', note: 'looks right' }, {}]);
  });

  test('reject posts the reason and passes the API refusal through unchanged', async () => {
    const routes = defaultStubRoutes();
    routes[`POST ${skillUrl(SKILL_ID_CANDIDATE)}/deprecate`] = (request: Request) =>
      request
        .json()
        .then((body: { note: string }) =>
          body.note === ''
            ? jsonResponse(apiErrorBody('invalid_request', 'note: Too small'), 400)
            : jsonResponse({ project_id: PROJECT_ID, skill: fixtureSkillSummary(SKILL_ID_CANDIDATE, { status: 'deprecated' }) }),
        ) as unknown as Response;
    const { api, sent } = recording(routes);

    const result = await rejectSkill(api, PROJECT_ID, SKILL_ID_CANDIDATE, 'wrong fix');
    expect(result.skill.status).toBe('deprecated');
    expect(sent.at(-1)?.body).toEqual({ note: 'wrong fix' });

    const error = await rejectSkill(api, PROJECT_ID, SKILL_ID_CANDIDATE, '').catch((caught: unknown) => caught);
    expect((error as ApiError).message).toBe('note: Too small');
  });
});
