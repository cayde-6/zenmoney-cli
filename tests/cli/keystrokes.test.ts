import { it, expect, vi } from 'vitest'
import { applyKeystrokes, promptHidden, type HiddenInputStream } from '../../src/cli/commands/sync.js'

// Pure byte-handling helper behind promptHidden's raw-mode TTY reading.
// promptHidden's own raw-mode wiring is exercised below via a fake
// HiddenInputStream (see "promptHidden" tests further down).

it('accumulates normal characters across chunks', () => {
  let r = applyKeystrokes('', 'ab')
  expect(r).toEqual({ value: 'ab', done: false, cancelled: false })
  r = applyKeystrokes(r.value, 'c')
  expect(r).toEqual({ value: 'abc', done: false, cancelled: false })
})

it('backspace (\\x7f) removes the last character', () => {
  expect(applyKeystrokes('abc', '\x7f')).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('backspace on an empty buffer stays empty', () => {
  expect(applyKeystrokes('', '\x7f')).toEqual({ value: '', done: false, cancelled: false })
})

it('Enter (\\r or \\n) finishes without cancelling', () => {
  expect(applyKeystrokes('abc', '\r')).toEqual({ value: 'abc', done: true, cancelled: false })
  expect(applyKeystrokes('abc', '\n')).toEqual({ value: 'abc', done: true, cancelled: false })
})

it('Ctrl-C (\\x03) finishes and cancels', () => {
  expect(applyKeystrokes('abc', '\x03')).toEqual({ value: 'abc', done: true, cancelled: true })
})

it('stops at the first terminator within a chunk, ignoring anything after it', () => {
  expect(applyKeystrokes('', 'secret\r\ngarbage')).toEqual({ value: 'secret', done: true, cancelled: false })
})

it('ignores escape sequences (e.g. an arrow key\'s ESC [ A)', () => {
  expect(applyKeystrokes('ab', '\x1b[Ac')).toEqual({ value: 'abc', done: false, cancelled: false })
})

it('a bare ESC at the end of a chunk becomes pending rather than being dropped immediately', () => {
  expect(applyKeystrokes('ab', '\x1b')).toEqual({ value: 'ab', done: false, cancelled: false, pending: '\x1b' })
})

it('\\b acts as backspace, same as \\x7f', () => {
  expect(applyKeystrokes('abc', '\b')).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('Ctrl-D (\\x04) finishes input like Enter, not cancelled', () => {
  expect(applyKeystrokes('abc', '\x04')).toEqual({ value: 'abc', done: true, cancelled: false })
})

it('ignores a multi-byte CSI sequence with several parameter bytes before its final byte (e.g. an SGR color code)', () => {
  expect(applyKeystrokes('ab', '\x1b[38;5;196mc')).toEqual({ value: 'abc', done: false, cancelled: false })
})

it('ignores an SS3 sequence (e.g. an arrow key sent as ESC O A)', () => {
  expect(applyKeystrokes('ab', '\x1bOA')).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('ignores Alt+key (ESC followed by a plain character)', () => {
  expect(applyKeystrokes('ab', '\x1bx')).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('a CSI sequence split across chunks does not leak its tail into the token', () => {
  const r1 = applyKeystrokes('ab', '\x1b[')
  expect(r1).toEqual({ value: 'ab', done: false, cancelled: false, pending: '\x1b[' })
  const r2 = applyKeystrokes(r1.value, 'A', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('an SS3 sequence split across chunks does not leak its tail into the token', () => {
  const r1 = applyKeystrokes('ab', '\x1bO')
  expect(r1).toEqual({ value: 'ab', done: false, cancelled: false, pending: '\x1bO' })
  const r2 = applyKeystrokes(r1.value, 'A', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('a split CSI sequence still tracks normal characters typed after it resumes', () => {
  const r1 = applyKeystrokes('x', '\x1b[')
  const r2 = applyKeystrokes(r1.value, 'Ay', r1.pending)
  expect(r2).toEqual({ value: 'xy', done: false, cancelled: false })
})

it('a pending bare ESC continues as a CSI sequence when the next chunk starts with [', () => {
  const r1 = applyKeystrokes('ab', '\x1b')
  expect(r1).toEqual({ value: 'ab', done: false, cancelled: false, pending: '\x1b' })
  const r2 = applyKeystrokes(r1.value, '[A', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('ESC + x within one chunk is Alt+x (swallowed) — same as the existing single-chunk case', () => {
  expect(applyKeystrokes('ab', '\x1bx')).toEqual({ value: 'ab', done: false, cancelled: false })
})

it('a lone ESC followed by an unrelated later chunk is dropped on its own; the new chunk is not swallowed', () => {
  const r1 = applyKeystrokes('ab', '\x1b')
  expect(r1).toEqual({ value: 'ab', done: false, cancelled: false, pending: '\x1b' })
  const r2 = applyKeystrokes(r1.value, 'x', r1.pending)
  expect(r2).toEqual({ value: 'abx', done: false, cancelled: false })
})

it('a control byte aborts an unfinished CSI sequence and is then processed normally: Enter', () => {
  const r1 = applyKeystrokes('ab', '\x1b[')
  expect(r1.pending).toBe('\x1b[')
  const r2 = applyKeystrokes(r1.value, '\r', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: true, cancelled: false })
})

it('a control byte aborts an unfinished CSI sequence and is then processed normally: Ctrl-C', () => {
  const r1 = applyKeystrokes('ab', '\x1b[')
  expect(r1.pending).toBe('\x1b[')
  const r2 = applyKeystrokes(r1.value, '\x03', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: true, cancelled: true })
})

it('a control byte also aborts an unfinished SS3 sequence and is then processed normally', () => {
  const r1 = applyKeystrokes('ab', '\x1bO')
  expect(r1.pending).toBe('\x1bO')
  const r2 = applyKeystrokes(r1.value, '\r', r1.pending)
  expect(r2).toEqual({ value: 'ab', done: true, cancelled: false })
})

// promptHidden's raw-mode TTY wiring, driven via a fake HiddenInputStream
// instead of a real terminal (see the HiddenInputStream export on
// src/cli/commands/sync.ts, added specifically so this is testable).
function fakeStdin(chunks: string[]): { stdin: HiddenInputStream; calls: string[] } {
  const calls: string[] = []
  const stdin: HiddenInputStream = {
    setRawMode: m => { calls.push(`setRawMode(${m})`) },
    resume: () => { calls.push('resume') },
    pause: () => { calls.push('pause') },
    setEncoding: e => { calls.push(`setEncoding(${e})`) },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c
    },
  }
  return { stdin, calls }
}

it('promptHidden writes the prompt, enables raw mode, and resolves with the typed token', async () => {
  const written: string[] = []
  const { stdin, calls } = fakeStdin(['sec', 'ret\r'])
  const result = await promptHidden('token: ', { stdin, writeErr: s => written.push(s) })
  expect(result).toBe('secret')
  expect(written).toEqual(['token: ', '\n'])
  expect(calls).toEqual(['setRawMode(true)', 'resume', 'setEncoding(utf8)', 'setRawMode(false)', 'pause'])
})

it('promptHidden rejects with "cancelled" on Ctrl-C, still disabling raw mode', async () => {
  const { stdin, calls } = fakeStdin(['abc\x03'])
  await expect(promptHidden('token: ', { stdin, writeErr: () => {} })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: 'cancelled' })
  expect(calls).toContain('setRawMode(false)')
  expect(calls).toContain('pause')
})

it('promptHidden rejects with "empty token" if the stream ends without a terminator', async () => {
  const { stdin } = fakeStdin(['abc'])
  await expect(promptHidden('token: ', { stdin, writeErr: () => {} })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: 'empty token' })
})

// With no `deps` at all, promptHidden falls back to the real process.stdin
// and to writing process.stderr directly — the actual call shape every real
// call site (registerSync's `auth` action) uses. process.stdin is swapped
// out for a fake stream (same shape as fakeStdin's, above) via
// Object.defineProperty and always restored, and process.stderr.write is
// spied on rather than replaced outright, so nothing here ever touches a
// real terminal or actually writes to the test runner's own stderr.
it('promptHidden defaults to process.stdin and process.stderr.write when no deps are given', async () => {
  const { stdin } = fakeStdin(['sec', 'ret\r'])
  const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const result = await promptHidden('token: ')
    expect(result).toBe('secret')
    expect(stderrWrite).toHaveBeenCalledWith('token: ')
    expect(stderrWrite).toHaveBeenCalledWith('\n')
  } finally {
    Object.defineProperty(process, 'stdin', originalStdin)
    stderrWrite.mockRestore()
  }
})
