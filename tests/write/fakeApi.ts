// Shared fake `fetch` for write-mode --apply tests: returns each of `bodies`
// in order (as a 200 JSON response) and records each call's parsed request
// body into `calls`, so a test can assert on what was actually POSTed (the
// sync call, then the push call) without a real network round-trip. Copied
// from tests/cli/sync.test.ts's local apiFetch helper of the same shape.
export function apiFetch(bodies: unknown[], calls: any[] = []) {
  return (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(bodies.shift()), { status: 200 })
  }) as any
}
