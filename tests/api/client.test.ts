import { it, expect } from 'vitest'
import { fetchDiff } from '../../src/api/client.js'

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
it('sends an AbortSignal so a hung request eventually surfaces as NETWORK', async () => {
  let req: any
  const f = (async (url: string, init: any) => { req = { url, init }; return new Response(JSON.stringify({ serverTimestamp: 1 }), { status: 200 }) }) as any
  await fetchDiff('t', 0, { fetch: f, now })
  expect(req.init.signal).toBeInstanceOf(AbortSignal)
})
