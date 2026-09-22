export type ErrorCode = 'UNEXPECTED' | 'INVALID_ARGS' | 'AUTH' | 'NETWORK' | 'NO_CACHE' | 'CACHE_BUSY' | 'CONFLICT'
export const EXIT: Record<ErrorCode, number> = { UNEXPECTED: 1, INVALID_ARGS: 2, AUTH: 3, NETWORK: 4, NO_CACHE: 5, CACHE_BUSY: 6, CONFLICT: 7 }
export class ZmError extends Error {
  constructor(public code: ErrorCode, message: string, public hint?: string) { super(message) }
}
