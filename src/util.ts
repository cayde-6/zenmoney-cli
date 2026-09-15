// Shared collator for every sort of names/paths/keys (categories, accounts,
// currencies, merchants, ...): a fixed locale ('en') makes ordering
// deterministic regardless of the process's LANG, while still handling
// Cyrillic (and any other script) titles sensibly at runtime.
const collator = new Intl.Collator('en')

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b)
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

// Local calendar date (YYYY-MM-DD) of `d`, as opposed to its UTC date.
export function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Local calendar month (YYYY-MM) of `d`, as opposed to its UTC month.
export function localMonth(d: Date): string {
  return monthOf(localDateString(d))
}

export function daysInMonth(month: string): number {
  const [year, mon] = month.split('-').map(Number)
  return new Date(year!, mon!, 0).getDate()
}

export function monthRange(month: string): { from: string; to: string } {
  const days = daysInMonth(month)
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}` }
}

export function addMonths(month: string, n: number): string {
  const [year, mon] = month.split('-').map(Number)
  const total = year! * 12 + (mon! - 1) + n
  const newYear = Math.floor(total / 12)
  const newMonth = total - newYear * 12 + 1
  return `${newYear}-${String(newMonth).padStart(2, '0')}`
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j]!, dp[j - 1]!)
      prev = temp
    }
  }
  return dp[n]!
}

export function suggest(candidates: string[], query: string, n = 3): string[] {
  const q = query.trim().toLowerCase()
  const scored = candidates.map(candidate => {
    const c = candidate.trim().toLowerCase()
    let score = levenshtein(c, q)
    if (c.includes(q)) score -= 100 // includes() already covers startsWith()
    return { candidate, score }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, n).map(s => s.candidate)
}
