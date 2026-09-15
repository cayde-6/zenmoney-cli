import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ZmError } from '../errors.js'

export interface LimitSpec { amount: number; currency: string }
export type RawLimit = number | { amount: number; currency?: string } | null
export interface BudgetFile { currency?: string; limits?: Record<string, RawLimit> }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateLimit(value: unknown, key: string, source: string): RawLimit {
  if (value === null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" must be a finite number >= 0`)
    }
    return value
  }
  if (isPlainObject(value)) {
    const amount = value.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" must have a finite "amount" >= 0`)
    }
    if (value.currency !== undefined && typeof value.currency !== 'string') {
      throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" currency must be a string`)
    }
    return value.currency !== undefined ? { amount, currency: value.currency as string } : { amount }
  }
  throw new ZmError('INVALID_ARGS', `${source}: limit "${key}" has an invalid shape`)
}

// Parses and validates one budget yaml file's shape. Does not resolve category
// names, uppercase currency codes, or merge with anything else — that's mergeBudget's job.
export function parseBudgetFile(text: string, source: string): BudgetFile {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ZmError('INVALID_ARGS', `${source}: invalid yaml: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (raw === null || raw === undefined) return {}
  if (!isPlainObject(raw)) throw new ZmError('INVALID_ARGS', `${source}: must be a yaml object`)

  for (const key of Object.keys(raw)) {
    if (key !== 'currency' && key !== 'limits') {
      throw new ZmError('INVALID_ARGS', `${source}: unknown key "${key}"`)
    }
  }

  const result: BudgetFile = {}
  if ('currency' in raw) {
    if (typeof raw.currency !== 'string') throw new ZmError('INVALID_ARGS', `${source}: "currency" must be a string`)
    result.currency = raw.currency
  }
  if ('limits' in raw) {
    // A `limits:` key followed only by comments (as `zm budget init` writes
    // before anything is uncommented) parses as `limits: null`, not `{}` —
    // treat that as an empty limits object rather than a shape error.
    if (raw.limits === null) {
      result.limits = {}
    } else {
      if (!isPlainObject(raw.limits)) throw new ZmError('INVALID_ARGS', `${source}: "limits" must be an object`)
      const limits: Record<string, RawLimit> = {}
      for (const [key, value] of Object.entries(raw.limits)) {
        limits[key] = validateLimit(value, key, source)
      }
      result.limits = limits
    }
  }
  return result
}

function toLimitSpec(raw: number | { amount: number; currency?: string }, fileCurrency: string | undefined, effectiveCurrency: string | undefined, key: string): LimitSpec {
  const amount = typeof raw === 'number' ? raw : raw.amount
  const ownCurrency = typeof raw === 'number' ? undefined : raw.currency
  const currency = ownCurrency ?? fileCurrency ?? effectiveCurrency
  if (!currency) throw new ZmError('INVALID_ARGS', `limit "${key}" has no currency`)
  return { amount, currency: currency.toUpperCase() }
}

// Merges the template (base) and a month override into one effective limit map.
// A month limit of `null` deletes the base's limit for that key.
export function mergeBudget(base: BudgetFile | null, month: BudgetFile | null): Map<string, LimitSpec> {
  const effectiveCurrency = month?.currency ?? base?.currency
  const result = new Map<string, LimitSpec>()

  for (const [key, raw] of Object.entries(base?.limits ?? {})) {
    if (raw === null) continue
    result.set(key, toLimitSpec(raw, base?.currency, effectiveCurrency, key))
  }
  for (const [key, raw] of Object.entries(month?.limits ?? {})) {
    if (raw === null) {
      result.delete(key)
      continue
    }
    result.set(key, toLimitSpec(raw, month?.currency, effectiveCurrency, key))
  }
  return result
}

// Reads `<dir>/default.yaml` (template) and `<dir>/<month>.yaml` (override), if
// they exist, and merges them. Fails if neither is present.
export function loadBudget(dir: string, month: string): { limits: Map<string, LimitSpec>; sources: string[] } {
  const defaultPath = join(dir, 'default.yaml')
  const monthPath = join(dir, `${month}.yaml`)
  const sources: string[] = []

  let base: BudgetFile | null = null
  if (existsSync(defaultPath)) {
    base = parseBudgetFile(readFileSync(defaultPath, 'utf8'), defaultPath)
    sources.push(defaultPath)
  }
  let monthFile: BudgetFile | null = null
  if (existsSync(monthPath)) {
    monthFile = parseBudgetFile(readFileSync(monthPath, 'utf8'), monthPath)
    sources.push(monthPath)
  }
  if (sources.length === 0) {
    throw new ZmError('INVALID_ARGS', `no budget files found in ${dir}`, 'run zm budget init')
  }
  return { limits: mergeBudget(base, monthFile), sources }
}
