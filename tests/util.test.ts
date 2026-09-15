import { describe, it, expect } from 'vitest'
import { round2, round1, monthOf, daysInMonth, monthRange, addMonths, suggest } from '../src/util.js'

describe('util', () => {
  it('rounds', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round1(12.345)).toBe(12.3)
    expect(round2(1.005)).toBe(1)
    expect(round2(1.255)).toBe(1.25)
  })
  it('months', () => {
    expect(monthOf('2026-09-15')).toBe('2026-09')
    expect(daysInMonth('2026-02')).toBe(28)
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
  })
  it('suggests closest names', () => {
    expect(suggest(['Groceries', 'Gifts', 'Health'], 'grocer')[0]).toBe('Groceries')
  })
})
