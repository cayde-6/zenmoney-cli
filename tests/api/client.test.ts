import { it, expect, vi, afterEach } from 'vitest'
import { fetchDiff, parseTimeoutMs } from '../../src/api/client.js'

const now = () => new Date('2026-09-15T12:00:00Z')

it('posts diff request with bearer token', async () => {
  let req: any
  const f = (async (url: string, init: any) => { req = { url, init }; return new Response(JSON.stringify({ serverTimestamp: 5 }), { status: 200 }) }) as any
  const d = await fetchDiff('tok', 123, { fetch: f, now })
  expect(d.serverTimestamp).toBe(5)
  expect(req.url).toBe('https://api.zenmoney.ru/v8/diff/')
  expect(req.init.method).toBe('POST')
  expect(req.init.headers.Authorization).toBe('Bearer tok')
  expect(JSON.parse(req.init.body)).toEqual({ currentClientTimestamp: 1789473600, serverTimestamp: 123 })
})
it('401 → AUTH', async () => {
  const f = (async () => new Response('', { status: 401 })) as any
  await expect(fetchDiff('bad', 0, { fetch: f, now })).rejects.toMatchObject({ code: 'AUTH', hint: 'run zm auth' })
})
it('500 and network failure → NETWORK', async () => {
  const f500 = (async () => new Response('oops', { status: 500 })) as any
  await expect(fetchDiff('t', 0, { fetch: f500, now })).rejects.toMatchObject({ code: 'NETWORK' })
  const fErr = (async () => { throw new TypeError('fetch failed') }) as any
  await expect(fetchDiff('t', 0, { fetch: fErr, now })).rejects.toMatchObject({ code: 'NETWORK' })
})
it('non-JSON 200 body → NETWORK', async () => {
  const f = (async () => new Response('not json', { status: 200 })) as any
  await expect(fetchDiff('t', 0, { fetch: f, now })).rejects.toMatchObject({ code: 'NETWORK' })
})
it('200 JSON body without a numeric serverTimestamp → NETWORK', async () => {
  const missing = (async () => new Response(JSON.stringify({ instrument: [] }), { status: 200 })) as any
  await expect(fetchDiff('t', 0, { fetch: missing, now })).rejects.toMatchObject({ code: 'NETWORK', message: 'invalid response from ZenMoney' })
  const wrongType = (async () => new Response(JSON.stringify({ serverTimestamp: '5' }), { status: 200 })) as any
  await expect(fetchDiff('t', 0, { fetch: wrongType, now })).rejects.toMatchObject({ code: 'NETWORK', message: 'invalid response from ZenMoney' })
})
it('never echoes the token if it leaks into a non-2xx response body', async () => {
  const f = (async () => new Response('rejected: Authorization: Bearer SECRET_TOKEN_2', { status: 500 })) as any
  const err = await fetchDiff('SECRET_TOKEN_2', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK' })
  expect(err.message).not.toContain('SECRET_TOKEN_2')
  expect(err.message).toContain('***')
})
it('scrubs the token from the full response body before truncating to 200 chars (no partial leak at the cut)', async () => {
  const token = 'SECRET_TOKEN_3'
  // The token starts at index 190, i.e. straddles the old code's slice(0, 200)
  // cut point (190 + 10 = 200): naively slicing first would leave the token's
  // first 10 chars ("SECRETTOKE") sitting right at the truncation boundary.
  const body = 'x'.repeat(190) + token + 'tail'
  const f = (async () => new Response(body, { status: 500 })) as any
  const err = await fetchDiff(token, 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK' })
  expect(err.message).not.toContain('SECR')
  expect(err.hint ?? '').not.toContain('SECR')
})
it('still throws a NETWORK error, without the raw body, if reading the response body itself fails', async () => {
  const fakeRes = { ok: false, status: 500, text: async () => { throw new Error('body read failed') } }
  const f = (async () => fakeRes) as any
  const err = await fetchDiff('t', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK', message: 'ZenMoney API error 500' })
})
it('never echoes the token when the underlying fetch error message contains it (e.g. undici header validation)', async () => {
  const f = (async () => {
    throw new TypeError('Headers.append: "Bearer SECRET_TOKEN_1" is an invalid header value.')
  }) as any
  const err = await fetchDiff('SECRET_TOKEN_1', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK' })
  expect(err.message).not.toContain('SECRET_TOKEN_1')
  expect(err.hint ?? '').not.toContain('SECRET_TOKEN_1')
})
it('does not attempt to scrub an empty token from a fetch-error message', async () => {
  const f = (async () => { throw new TypeError('generic connection failure') }) as any
  const err = await fetchDiff('', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK' })
  expect(err.message).toContain('generic connection failure')
})
it('does not attempt to scrub an empty token from a non-2xx response body', async () => {
  const f = (async () => new Response('plain error body', { status: 500 })) as any
  const err = await fetchDiff('', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK', message: 'ZenMoney API error 500: plain error body' })
})
it('sends an AbortSignal so a hung request eventually surfaces as NETWORK', async () => {
  let req: any
  const f = (async (url: string, init: any) => { req = { url, init }; return new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 }) }) as any
  await fetchDiff('t', 0, { fetch: f, now })
  expect(req.init.signal).toBeInstanceOf(AbortSignal)
})
// A-12: network timeout configurable via ZM_TIMEOUT_MS.
it('parseTimeoutMs defaults to 60000 and accepts a positive integer', () => {
  expect(parseTimeoutMs({})).toBe(60_000)
  expect(parseTimeoutMs({ ZM_TIMEOUT_MS: '5000' })).toBe(5000)
})
it('parseTimeoutMs rejects a non-positive-integer ZM_TIMEOUT_MS', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    expect(() => parseTimeoutMs({ ZM_TIMEOUT_MS: bad })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  }
})
// Review round item 5: only /^\d+$/ in 1..2147483647 is accepted — Number()
// alone is too permissive (accepts exponent notation, hex, and leading/
// trailing whitespace), and an unbounded value could silently misbehave
// with setTimeout's ~32-bit delay ceiling.
it('parseTimeoutMs rejects values Number() would accept but are not plain decimal integers', () => {
  for (const bad of ['1e3', '0x10', ' 5 ', '5 ', ' 5', '+5']) {
    expect(() => parseTimeoutMs({ ZM_TIMEOUT_MS: bad })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  }
})
it('parseTimeoutMs rejects a value above the 2147483647ms ceiling', () => {
  expect(() => parseTimeoutMs({ ZM_TIMEOUT_MS: '3000000000' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }))
  expect(parseTimeoutMs({ ZM_TIMEOUT_MS: '2147483647' })).toBe(2147483647)
})
afterEach(() => { vi.restoreAllMocks() })

// Review round item 3: the previous version of this test only asserted
// `signal instanceof AbortSignal`, which is true regardless of which
// timeout value (if any) was actually used — it would still pass if
// `deps.timeoutMs` were silently ignored. Spying on the real
// `AbortSignal.timeout` factory proves the configured value actually reaches
// it, not just that *some* AbortSignal was attached.
it('fetchDiff uses deps.timeoutMs for the abort signal instead of the 60s default', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const f = (async () => new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 })) as any
  await fetchDiff('t', 0, { fetch: f, now, timeoutMs: 5000 })
  expect(timeoutSpy).toHaveBeenCalledWith(5000)
})
it('fetchDiff defaults to a 60000ms abort timeout when deps.timeoutMs is omitted', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
  const f = (async () => new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 })) as any
  await fetchDiff('t', 0, { fetch: f, now })
  expect(timeoutSpy).toHaveBeenCalledWith(60_000)
})
// A-13: a network-level fetch failure's cause.code (e.g. ENOTFOUND) is
// appended to the message, since it's the most useful diagnostic detail.
it('appends a sanitized cause.code to the message when the underlying fetch error carries one', async () => {
  const f = (async () => {
    throw new TypeError('connect failed', { cause: { code: 'ENOTFOUND' } })
  }) as any
  const err = await fetchDiff('secret-token', 0, { fetch: f, now }).catch(e => e)
  expect(err).toMatchObject({ code: 'NETWORK' })
  expect(err.message).toContain('ENOTFOUND')
})
it('fetchDiff sends push entities in the body', async () => {
  const calls: any[] = []
  const f = (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ serverTimestamp: 5 }), { status: 200 }) }) as any
  const tx = { id: 'x' } as any
  await fetchDiff('tok', 4, { fetch: f, now: () => new Date(1000_000) }, { transaction: [tx] })
  expect(calls[0]).toEqual({ currentClientTimestamp: 1000, serverTimestamp: 4, transaction: [tx] })
})
it('still scrubs the token even when a cause.code is appended', async () => {
  const f = (async () => {
    throw new TypeError('Headers.append: "Bearer SECRET_TOKEN_4" is an invalid header value.', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
  }) as any
  const err = await fetchDiff('SECRET_TOKEN_4', 0, { fetch: f, now }).catch(e => e)
  expect(err.message).not.toContain('SECRET_TOKEN_4')
  expect(err.message).toContain('UND_ERR_CONNECT_TIMEOUT')
})
