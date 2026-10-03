/**
 * OpenAI-compatible embedder tests against a local `Bun.serve` stub implementing the
 * `POST /v1/embeddings` shape used by LM Studio / llama.cpp / vLLM.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { createOpenAiCompatibleEmbedder } from './openai-compatible';
import { EmbedderError } from './types';

interface StubRequest {
  path: string;
  body: { model?: string; input?: string[]; encoding_format?: string };
  authorization: string | null;
}

interface Stub {
  baseUrl: string;
  requests: StubRequest[];
  stop(): void;
}

function startStub(
  handler: (body: StubRequest['body']) => Response,
): Stub {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      let body: StubRequest['body'] = {};
      try {
        body = (await request.json()) as StubRequest['body'];
      } catch {
        body = {};
      }
      requests.push({
        path: url.pathname,
        body,
        authorization: request.headers.get('authorization'),
      });
      return handler(body);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

function vector(seed: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, index) => Number((seed + index / 10).toFixed(3)));
}

const stubs: Stub[] = [];
afterEach(() => {
  for (const stub of stubs.splice(0)) stub.stop();
});

describe('openaiCompatibleEmbedder', () => {
  test('posts to /v1/embeddings and returns vectors in input order', async () => {
    const stub = startStub((body) => {
      const input = body.input ?? [];
      // Deliberately reversed indexes: the API contract allows any order.
      const data = input
        .map((_, index) => ({ embedding: vector(index + 1), index, object: 'embedding' }))
        .reverse();
      return Response.json({ object: 'list', data, model: body.model, usage: { prompt_tokens: 3 } });
    });
    stubs.push(stub);

    const embedder = createOpenAiCompatibleEmbedder({ model: 'nomic-embed-text-v1.5', baseUrl: stub.baseUrl });
    const vectors = await embedder.embed(['one', 'two', 'three']);
    expect(vectors).toEqual([vector(1), vector(2), vector(3)]);
    expect(embedder.dim).toBe(4);
    expect(embedder.meta.provider).toBe('openai-compatible');
    expect(stub.requests[0]!.path).toBe('/v1/embeddings');
    expect(stub.requests[0]!.body).toEqual({
      model: 'nomic-embed-text-v1.5',
      input: ['one', 'two', 'three'],
      encoding_format: 'float',
    });
  });

  test('sends the bearer token only when an api key is configured', async () => {
    const stub = startStub(() => Response.json({ data: [{ embedding: vector(1), index: 0 }] }));
    stubs.push(stub);
    const withKey = createOpenAiCompatibleEmbedder({
      model: 'm',
      dim: 4,
      baseUrl: stub.baseUrl,
      apiKey: 'sk-local',
    });
    await withKey.embed(['x']);
    expect(stub.requests[0]!.authorization).toBe('Bearer sk-local');

    const withoutKey = createOpenAiCompatibleEmbedder({ model: 'm', dim: 4, baseUrl: stub.baseUrl });
    await withoutKey.embed(['x']);
    expect(stub.requests[1]!.authorization).toBeNull();
  });

  test('honours a configured dimension and rejects a mismatched response', async () => {
    const stub = startStub(() => Response.json({ data: [{ embedding: vector(1, 8), index: 0 }] }));
    stubs.push(stub);
    const embedder = createOpenAiCompatibleEmbedder({ model: 'm', dim: 4, baseUrl: stub.baseUrl });
    try {
      await embedder.embed(['x']);
      throw new Error('expected the embedder to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbedderError);
      expect((error as EmbedderError).kind).toBe('dimension');
    }
  });

  test('rejects a non-conforming body and HTTP errors', async () => {
    const badShape = startStub(() => Response.json({ data: [{ nope: true }] }));
    stubs.push(badShape);
    const shapeEmbedder = createOpenAiCompatibleEmbedder({ model: 'm', dim: 4, baseUrl: badShape.baseUrl });
    await expect(shapeEmbedder.embed(['x'])).rejects.toThrow(/unexpected response/);

    const failing = startStub(() => new Response('boom', { status: 503 }));
    stubs.push(failing);
    const failingEmbedder = createOpenAiCompatibleEmbedder({ model: 'm', dim: 4, baseUrl: failing.baseUrl });
    await expect(failingEmbedder.embed(['x'])).rejects.toThrow(/HTTP 503/);
  });

  test('defaults to the LM Studio loopback endpoint', () => {
    const embedder = createOpenAiCompatibleEmbedder({ model: 'm', dim: 4 });
    expect(embedder.meta.provider).toBe('openai-compatible');
    expect(embedder.dim).toBe(4);
  });
});
