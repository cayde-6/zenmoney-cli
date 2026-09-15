import { it, expect } from 'vitest'
import { classifyWriteStreamError } from '../../src/cli/streamErrors.js'

// Review round item 4: bin.ts must only swallow EPIPE — any other stream
// error (e.g. ENOSPC) must still surface as a failure, not be silently
// absorbed just because an 'error' listener now exists on the stream.
it('EPIPE exits quietly with the exit code so far (defaulting to 0)', () => {
  expect(classifyWriteStreamError({ name: 'Error', message: 'EPIPE', code: 'EPIPE' }, undefined)).toEqual({ type: 'exit', code: 0 })
  expect(classifyWriteStreamError({ name: 'Error', message: 'EPIPE', code: 'EPIPE' }, 2)).toEqual({ type: 'exit', code: 2 })
})
it('any other error code is rethrown, not swallowed', () => {
  for (const code of ['ENOSPC', 'EIO', undefined]) {
    expect(classifyWriteStreamError({ name: 'Error', message: 'boom', code }, 0)).toEqual({ type: 'rethrow' })
  }
})
