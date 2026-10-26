// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Daily token budget: stops calls once the user-configured limit is reached.
 * Real provider usage is preferred; when a provider does not report usage we
 * fall back to a conservative character-based estimate (see ADR 0003).
 */
export interface UsageRecord {
  /** Local calendar date (YYYY-MM-DD). */
  date: string
  used: number
}

export function estimateTokens(text: string): number {
  // CJK-heavy conversations: ~1 token per 2 characters is a safe overestimate.
  return Math.ceil(text.length / 2)
}

export function todayKey(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class DailyTokenBudget {
  constructor(
    /** Null = unlimited. */
    private getLimit: () => number | null,
    private record: (usage: UsageRecord) => void,
    private load: () => UsageRecord | null,
  ) {}

  status(now = new Date()): { allowed: boolean; used: number; limit: number | null } {
    const limit = this.getLimit()
    const current = this.load()
    const used = current && current.date === todayKey(now) ? current.used : 0
    return { allowed: limit === null || used < limit, used, limit }
  }

  /** Adds usage (real or estimated) and returns the new total. */
  add(tokens: number, now = new Date()): number {
    const current = this.load()
    const used = current && current.date === todayKey(now) ? current.used : 0
    const total = used + Math.max(0, Math.round(tokens))
    this.record({ date: todayKey(now), used: total })
    return total
  }
}
