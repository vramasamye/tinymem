/**
 * Ollama embedder tests against a tiny local `Bun.serve` stub implementing the native
 * `POST /api/embed` shape. No real Ollama, no network beyond loopback.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { createOllamaEmbedder } from './ollama';
import { EmbedderError } from './types';

interface StubRequest {
  path: string;
  body: { model?: string; input?: string[] };
  authorization: string | null;
}

interface Stub {
  baseUrl: string;
  requests: StubRequest[];
  stop(): void;
}

function startOllamaStub(
  handler: (body: { model?: string; input?: string[] }, request: Request) => Response,
): Stub {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      let body: { model?: string; input?: string[] } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        body = {};
      }
      requests.push({
        path: url.pathname,
        body,
        authorization: request.headers.get('authorization'),
      });
      return handler(body, request);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
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

describe('ollamaEmbedder', () => {
  test('embeds via the native /api/embed endpoint and records provenance', async () => {
    const stub = startOllamaStub((body) => {
      const input = body.input ?? [];
      return Response.json({
        model: body.model,
        embeddings: input.map((_, index) => vector(index + 1)),
        total_duration: 123,
      });
    });
    stubs.push(stub);

    const embedder = createOllamaEmbedder({ model: 'nomic-embed-text', baseUrl: stub.baseUrl });
    expect(embedder.provider).toBe('ollama');
    expect(embedder.meta).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
      revision: null,
      dim: null,
    });
    // Dimension is unknown until the first call: say so instead of guessing.
    expect(() => embedder.dim).toThrow(EmbedderError);

    const vectors = await embedder.embed(['alpha', 'beta']);
    expect(vectors).toEqual([vector(1), vector(2)]);
    expect(embedder.dim).toBe(4);
    expect(embedder.meta.dim).toBe(4);

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.path).toBe('/api/embed');
    expect(stub.requests[0]!.path).not.toBe('/api/embeddings');
    expect(stub.requests[0]!.body).toEqual({ model: 'nomic-embed-text', input: ['alpha', 'beta'] });
  });

  test('honours a configured dimension and rejects a mismatched response', async () => {
    const stub = startOllamaStub(() => Response.json({ embeddings: [vector(1, 3)] }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({
      model: 'm',
      dim: 4,
      baseUrl: stub.baseUrl,
    });
    await expect(embedder.embed(['x'])).rejects.toThrow(/returned 3 dimensions but 4 were expected/);
    try {
      await embedder.embed(['x']);
    } catch (error) {
      expect(error).toBeInstanceOf(EmbedderError);
      expect((error as EmbedderError).kind).toBe('dimension');
    }
  });

  test('batches requests and concatenates results in order', async () => {
    const stub = startOllamaStub((body) =>
      Response.json({
        embeddings: (body.input ?? []).map((text) => vector(Number(text.slice(1)))),
      }),
    );
    stubs.push(stub);
    const embedder = createOllamaEmbedder({
      model: 'm',
      dim: 4,
      batchSize: 2,
      baseUrl: stub.baseUrl,
    });
    const vectors = await embedder.embed(['t1', 't2', 't3', 't4', 't5']);
    expect(stub.requests).toHaveLength(3);
    expect(vectors).toHaveLength(5);
    expect(vectors[0]).toEqual(vector(1));
    expect(vectors[4]).toEqual(vector(5));
  });

  test('does not call the server for an empty input', async () => {
    const stub = startOllamaStub(() => Response.json({ embeddings: [] }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({ model: 'm', dim: 4, baseUrl: stub.baseUrl });
    expect(await embedder.embed([])).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });

  test('maps HTTP failures to a protocol error', async () => {
    const stub = startOllamaStub(() => new Response('model not found', { status: 404 }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({ model: 'missing', dim: 4, baseUrl: stub.baseUrl });
    await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 404/);
  });

  test('maps an unreachable server to a transport error', async () => {
    const embedder = createOllamaEmbedder({ model: 'm', dim: 4, baseUrl: 'http://127.0.0.1:1' });
    try {
      await embedder.embed(['x']);
      throw new Error('expected the embedder to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbedderError);
      expect((error as EmbedderError).kind).toBe('transport');
    }
  });

  test('rejects a response with the wrong number of embeddings', async () => {
    const stub = startOllamaStub(() => Response.json({ embeddings: [vector(1)] }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({ model: 'm', dim: 4, baseUrl: stub.baseUrl });
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow(/1 embeddings for 2 inputs/);
  });

  test('rejects a non-conforming response body', async () => {
    const stub = startOllamaStub(() => Response.json({ embeddings: 'nope' }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({ model: 'm', dim: 4, baseUrl: stub.baseUrl });
    await expect(embedder.embed(['a'])).rejects.toThrow(/unexpected \/api\/embed response/);
  });

  test('probe() discovers the dimension and is idempotent', async () => {
    const stub = startOllamaStub(() => Response.json({ embeddings: [vector(1)] }));
    stubs.push(stub);
    const embedder = createOllamaEmbedder({ model: 'm', baseUrl: stub.baseUrl });
    const meta = await embedder.probe();
    expect(meta.dim).toBe(4);
    expect(stub.requests).toHaveLength(1);
    await embedder.probe();
    expect(stub.requests).toHaveLength(1);
  });
});
