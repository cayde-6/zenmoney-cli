import { it, expect } from 'vitest'
import { applyKeystrokes } from '../../src/cli/commands/sync.js'

// Pure byte-handling helper behind promptHidden's raw-mode TTY reading. The
// raw-mode wiring itself (process.stdin.setRawMode etc.) is untested — see the
// comment above promptHidden in src/cli/commands/sync.ts.

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
