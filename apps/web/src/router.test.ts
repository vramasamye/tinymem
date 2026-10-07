/**
 * The route-map test: every M10 backlog surface has exactly one route, every path
 * is unique, and the count is pinned (the mission report quotes it).
 */

import { describe, expect, test } from 'bun:test';

import { APP_ROUTES, ROUTE_COUNT } from './router';

/** The M10 backlog surface list (docs/backlog/issues.md ## M10 — Web UI). */
const M10_SURFACES = [
  'memories list/filter',
  'full-text + structured search',
  'timeline (status history',
  'graph view',
  'projects',
  'decisions',
  'failures',
  'skills',
  'sources/provenance',
  'quality dashboard',
] as const;

describe('the route map', () => {
  test('has 13 routes (10 surfaces + browse + skill review + the root redirect)', () => {
    expect(ROUTE_COUNT).toBe(13);
    expect(APP_ROUTES.length).toBe(13);
  });

  test('every path is unique', () => {
    const paths = APP_ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('every route element is present (no undefined pages)', () => {
    for (const route of APP_ROUTES) {
      expect(route.element).not.toBeNull();
      expect(route.element).toBeDefined();
    }
  });

  test('the root redirects to the memories surface', () => {
    expect(APP_ROUTES[0]?.path).toBe('/');
    expect(APP_ROUTES[0]?.surface).toContain('redirect');
    expect(APP_ROUTES[0]?.surface).toContain('memories');
  });

  test('every M10 backlog surface has a route declaring it', () => {
    const declared = APP_ROUTES.map((route) => route.surface).join('\n');
    for (const surface of M10_SURFACES) {
      expect(declared).toContain(surface);
    }
  });

  test('the exact route paths are pinned (deep links are a contract)', () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/memories',
      '/browse',
      '/memories/:memoryId',
      '/memories/:memoryId/timeline',
      '/projects',
      '/decisions',
      '/failures',
      '/skills',
      '/skills/:skillId/review',
      '/graph',
      '/sources',
      '/quality',
    ]);
  });

  test('the timeline route is memory-scoped (the API has no project-wide event stream)', () => {
    const timeline = APP_ROUTES.find((route) => route.surface.includes('timeline'));
    expect(timeline?.path).toBe('/memories/:memoryId/timeline');
  });
});
