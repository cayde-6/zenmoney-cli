import { ZmError } from '../errors.js'
import type { ZmDiff } from './types.js'

export const DIFF_URL = 'https://api.zenmoney.ru/v8/diff/'

// A failed fetch's error message can itself carry the token: undici's own
// header-validation error embeds the full `Authorization` header value (e.g.
// `Headers.append: "Bearer <token>" is an invalid header value.`), so it must
// never be forwarded to the caller as-is. Any message that mentions the
// request headers is replaced outright with a generic one (its wording is
// unpredictable and always low-value); otherwise every literal occurrence of
// the token is scrubbed, in case it leaked into the message some other way.
function sanitizeNetworkMessage(message: string, token: string): string {
  if (/headers?/i.test(message)) return 'invalid request headers'
  return token ? message.split(token).join('***') : message
}

export async function fetchDiff(token: string, serverTimestamp: number, deps: { fetch: typeof fetch; now: () => Date }): Promise<ZmDiff> {
  let res: Response
  try {
    res = await deps.fetch(DIFF_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentClientTimestamp: Math.floor(deps.now().getTime() / 1000), serverTimestamp }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw new ZmError('NETWORK', `cannot reach ZenMoney: ${sanitizeNetworkMessage((e as Error).message, token)}`, 'check your connection and retry')
  }
  if (res.status === 401 || res.status === 403) throw new ZmError('AUTH', 'ZenMoney rejected the token', 'run zm auth')
  if (!res.ok) {
    let bodyText: string
    try {
      bodyText = await res.text()
    } catch {
      // Reading the body itself failed (e.g. a truncated/aborted response):
      // there's nothing to report but the status, and definitely nothing to
      // scrub a token out of.
      throw new ZmError('NETWORK', `ZenMoney API error ${res.status}`)
    }
    // Scrub the token from the FULL body before truncating, not after: the
    // token can start anywhere, including straddling the 200-char cut point,
    // and slicing first would leave a truncated-but-still-identifiable prefix
    // of it sitting right at the boundary. Only the token itself is scrubbed
    // here (not the fuller sanitizeNetworkMessage heuristic above): a real API
    // error body legitimately mentioning "header" has nothing to do with the
    // undici header-validation leak that heuristic targets, and would lose
    // real diagnostic detail for no reason.
    const safeBody = (token ? bodyText.split(token).join('***') : bodyText).slice(0, 200)
    throw new ZmError('NETWORK', `ZenMoney API error ${res.status}: ${safeBody}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ZmError('NETWORK', 'invalid response from ZenMoney')
  }
  const bodyTimestamp = (body as { serverTimestamp?: unknown } | null)?.serverTimestamp
  if (typeof bodyTimestamp !== 'number') throw new ZmError('NETWORK', 'invalid response from ZenMoney')
  return body as ZmDiff
}
