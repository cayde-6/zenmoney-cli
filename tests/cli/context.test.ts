import { it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { readStdinWithTimeout } from '../../src/cli/context.js'

// Low-level, stream-based stdin reader behind ctx.readStdin(): the 5s timeout
// (used by `zm auth` to avoid hanging forever on a pipe that never sends
// anything) must apply only while no data has arrived yet, and must never
// keep the process alive once it fires. See src/cli/commands/sync.ts for how
// zm auth consumes ctx.readStdin(), and tests/e2e/bin.test.ts for the
// end-to-end version of case (a) below against the real binary.

it('rejects after ms when nothing is ever written, and destroys the stream', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    const expectation = expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGS', message: 'no token provided' })
    await vi.advanceTimersByTimeAsync(1000)
    await expectation
    expect(stream.destroyed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('applies the timeout only until the first chunk arrives, then reads to the end with no timeout', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    await vi.advanceTimersByTimeAsync(500)
    stream.write('first-')
    // Well past the original 1000ms budget: must not fire since a chunk already arrived.
    await vi.advanceTimersByTimeAsync(2000)
    stream.write('second')
    stream.end()
    await expect(promise).resolves.toBe('first-second')
  } finally {
    vi.useRealTimers()
  }
})

it('clears the timer on success, leaving nothing pending', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    stream.end('data')
    await promise
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('clears the timer when the stream errors before any data arrives', async () => {
  vi.useFakeTimers()
  try {
    const stream = new PassThrough()
    const promise = readStdinWithTimeout(stream, 1000)
    const expectation = expect(promise).rejects.toThrow('boom')
    stream.emit('error', new Error('boom'))
    await expectation
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
