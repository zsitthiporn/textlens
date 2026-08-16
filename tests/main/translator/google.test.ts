/**
 * M4-02, features T2 + T7 - the Google adapter.
 *
 * HTTP is mocked throughout: this suite runs in CI with no network. The response bodies below
 * are not invented, they are copied from what the real endpoint returned on 2026-08-16 - which
 * matters for an undocumented API, where a mock built from a guessed schema would test only
 * that the code agrees with the guess.
 */

import { describe, expect, it } from 'vitest';

import {
  GOOGLE_CLIENT,
  GoogleTranslateEngine,
  parseBatchResponse,
} from '../../../src/main/services/translator/engines/google.js';
import {
  TranslationError,
  type HttpFetch,
  type HttpRequestInit,
  type HttpResponse,
} from '../../../src/main/services/translator/types.js';

interface Captured {
  url: string;
  init: HttpRequestInit | undefined;
}

/** A fetch double that records the request and replays a canned response. */
function stubFetch(
  response: { status?: number; body: string } | (() => never),
  captured: Captured[] = [],
): { fetch: HttpFetch; captured: Captured[] } {
  // Narrowed here rather than inside the closure below: TypeScript discards narrowing of a
  // captured parameter across a function boundary.
  const thrower = typeof response === 'function' ? response : null;
  const status = typeof response === 'function' ? 200 : (response.status ?? 200);
  const body = typeof response === 'function' ? '' : response.body;

  const fetchImpl: HttpFetch = async (url, init) => {
    captured.push({ url, init });
    if (thrower !== null) thrower();
    const result: HttpResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
    return result;
  };
  return { fetch: fetchImpl, captured };
}

/** Verbatim from the real endpoint: five inputs, five results, flat array, input order. */
const REAL_BATCH_BODY =
  '["คุณต้องค้นหากุญแจโบราณ","ประตูปิดแล้ว","มุ่งหน้าไปทางเหนือผ่านสะพาน","กด F เพื่อเปิดประตู","สุขภาพของคุณต่ำ"]';

const FIVE = [
  'You must find the ancient key',
  'The gate is closed',
  'Head north past the bridge',
  'Press F to open the door',
  'Your health is low',
];

describe('GoogleTranslateEngine - the request', () => {
  it('sends one POST carrying every text, with the client id that makes batching work', async () => {
    const { fetch, captured } = stubFetch({ body: REAL_BATCH_BODY });
    const engine = new GoogleTranslateEngine({ fetch });

    await engine.translateBatch([...FIVE], 'en', 'th');

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.init?.method).toBe('POST');
    // The client id is load-bearing: with client=gtx on translate_a/single the endpoint
    // answers 200 with only the FIRST input translated.
    expect(request?.url).toContain(`client=${GOOGLE_CLIENT}`);
    expect(request?.url).toContain('sl=en');
    expect(request?.url).toContain('tl=th');

    const body = new URLSearchParams(request?.init?.body ?? '');
    expect(body.getAll('q')).toEqual(FIVE);
  });

  it('keeps the texts out of the URL, which is the part that lands in proxy logs', async () => {
    const { fetch, captured } = stubFetch({ body: '["ก"]' });
    await new GoogleTranslateEngine({ fetch }).translateBatch(['The gate is closed'], 'en', 'th');

    expect(captured[0]?.url).not.toContain('gate');
  });

  it('carries a User-Agent, without which the endpoint answers 403', async () => {
    const { fetch, captured } = stubFetch({ body: '["ก"]' });
    await new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th');

    expect(captured[0]?.init?.headers?.['User-Agent']).toBeTruthy();
  });

  it('attaches an abort signal so a hung connection cannot stall the pipeline forever', async () => {
    const { fetch, captured } = stubFetch({ body: '["ก"]' });
    await new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th');

    expect(captured[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('makes no request at all for an empty batch', async () => {
    const { fetch, captured } = stubFetch({ body: '[]' });
    const results = await new GoogleTranslateEngine({ fetch }).translateBatch([], 'en', 'th');

    expect(results).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});

describe('GoogleTranslateEngine - the response', () => {
  it('returns five results for five inputs, in input order', async () => {
    const { fetch } = stubFetch({ body: REAL_BATCH_BODY });
    const results = await new GoogleTranslateEngine({ fetch }).translateBatch([...FIVE], 'en', 'th');

    expect(results).toHaveLength(5);
    expect(results[0]).toBe('คุณต้องค้นหากุญแจโบราณ');
    expect(results[4]).toBe('สุขภาพของคุณต่ำ');
  });

  it('handles a single input, whose real response shape is the same flat array', async () => {
    const { fetch } = stubFetch({ body: '["ประตูปิดแล้ว"]' });
    const results = await new GoogleTranslateEngine({ fetch }).translateBatch(
      ['The gate is closed'],
      'en',
      'th',
    );

    expect(results).toEqual(['ประตูปิดแล้ว']);
  });

  it('holds the slot for a blank input instead of sending it and coming back short', async () => {
    const { fetch, captured } = stubFetch({ body: '["ก","ข"]' });
    const results = await new GoogleTranslateEngine({ fetch }).translateBatch(
      ['one', '   ', 'three'],
      'en',
      'th',
    );

    // Two sent, three returned, blank preserved by position.
    expect(new URLSearchParams(captured[0]?.init?.body ?? '').getAll('q')).toEqual(['one', 'three']);
    expect(results).toEqual(['ก', '   ', 'ข']);
  });

  it('makes no request when every input is blank', async () => {
    const { fetch, captured } = stubFetch({ body: '[]' });
    const results = await new GoogleTranslateEngine({ fetch }).translateBatch(['', '  '], 'en', 'th');

    expect(results).toEqual(['', '  ']);
    expect(captured).toHaveLength(0);
  });
});

describe('GoogleTranslateEngine - failures throw, they never return a plausible array', () => {
  it('throws on 429 with the status on the error, so the rate limiter can see it', async () => {
    const { fetch } = stubFetch({ status: 429, body: 'rate limited' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th'),
    ).rejects.toMatchObject({ kind: 'rate-limit', status: 429 });
  });

  it('puts the status code in the message too, for whoever is reading the log', async () => {
    const { fetch } = stubFetch({ status: 429, body: '' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th'),
    ).rejects.toThrow(/HTTP 429/u);
  });

  it('throws on 500, classified as network so it gets the shorter backoff', async () => {
    const { fetch } = stubFetch({ status: 500, body: 'oops' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th'),
    ).rejects.toMatchObject({ kind: 'network', status: 500 });
  });

  it('throws when the transport itself fails', async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th'),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws on an unparseable body instead of returning empty strings', async () => {
    const { fetch } = stubFetch({ body: '<!DOCTYPE html><html>blocked</html>' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['hello'], 'en', 'th'),
    ).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('throws when the result count does not match - the real gtx failure mode', async () => {
    // Exactly what translate_a/single?client=gtx does: HTTP 200, five sent, one back.
    const { fetch } = stubFetch({ body: '["คุณต้องค้นหากุญแจโบราณ"]' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch([...FIVE], 'en', 'th'),
    ).rejects.toThrow(/expected 5 results, got 1/u);
  });

  it('throws when there are more results than inputs', async () => {
    const { fetch } = stubFetch({ body: '["ก","ข","ค"]' });

    await expect(
      new GoogleTranslateEngine({ fetch }).translateBatch(['one', 'two'], 'en', 'th'),
    ).rejects.toThrow(/expected 2 results, got 3/u);
  });

  it('never puts the request text or the response body into the error message', async () => {
    const secret = 'Zorblatt the Unspeakable guards the ninth gate';
    const { fetch } = stubFetch({ body: '["คำแปลลับ"]' });

    try {
      await new GoogleTranslateEngine({ fetch }).translateBatch([secret, 'second'], 'en', 'th');
      expect.unreachable('should have thrown on the count mismatch');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('Zorblatt');
      expect(message).not.toContain('คำแปลลับ');
      expect(message).toContain('expected 2 results, got 1');
    }
  });
});

describe('parseBatchResponse', () => {
  it('accepts the flat array the endpoint returns for an explicit source language', () => {
    expect(parseBatchResponse('["ก","ข"]', 2)).toEqual(['ก', 'ข']);
  });

  it('accepts the nested shape that sl=auto produces, taking element zero', () => {
    expect(parseBatchResponse('[["ก","en"],["ข","en"]]', 2)).toEqual(['ก', 'ข']);
  });

  it('rejects a JSON value that is not an array', () => {
    expect(() => parseBatchResponse('{"error":"nope"}', 1)).toThrow(/expected a JSON array/u);
  });

  it('rejects an entry that is neither a string nor a string-headed array', () => {
    expect(() => parseBatchResponse('["ก",42]', 2)).toThrow(/result 1 was number/u);
    expect(() => parseBatchResponse('["ก",null]', 2)).toThrow(/result 1 was null/u);
  });

  it('reports the body length rather than the body when JSON parsing fails', () => {
    const html = '<html>you have been blocked, Zorblatt</html>';
    try {
      parseBatchResponse(html, 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('Zorblatt');
      expect((error as Error).message).toContain(String(html.length));
    }
  });

  it('classifies every shape problem as protocol', () => {
    try {
      parseBatchResponse('nonsense', 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationError);
      expect((error as TranslationError).kind).toBe('protocol');
    }
  });
});

describe('GoogleTranslateEngine - healthCheck', () => {
  it('sends a real request and reports success', async () => {
    const { fetch, captured } = stubFetch({ body: '["ตกลง"]' });
    const result = await new GoogleTranslateEngine({ fetch }).healthCheck();

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });

  it('sends a fixed neutral token, never anything from the screen', async () => {
    const { fetch, captured } = stubFetch({ body: '["ตกลง"]' });
    await new GoogleTranslateEngine({ fetch }).healthCheck();

    expect(new URLSearchParams(captured[0]?.init?.body ?? '').getAll('q')).toEqual(['ok']);
  });

  it('reports the real failure rather than throwing', async () => {
    const { fetch } = stubFetch({ status: 429, body: '' });
    const result = await new GoogleTranslateEngine({ fetch }).healthCheck();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('429');
  });

  it('reports failure when the endpoint answers with an empty translation', async () => {
    const { fetch } = stubFetch({ body: '[""]' });
    const result = await new GoogleTranslateEngine({ fetch }).healthCheck();

    expect(result.ok).toBe(false);
  });
});

describe('GoogleTranslateEngine - construction', () => {
  it('rejects a nonsensical timeout rather than disabling the deadline', () => {
    expect(() => new GoogleTranslateEngine({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => new GoogleTranslateEngine({ timeoutMs: -1 })).toThrow(RangeError);
  });

  it('is named google', () => {
    expect(new GoogleTranslateEngine().name).toBe('google');
  });
});
