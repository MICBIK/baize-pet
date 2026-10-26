// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatTurn } from '@baize/shared'

/**
 * Working memory: the bounded recent-conversation window kept in RAM only
 * (never persisted, never exported — docs/04 §1).
 */
export class WorkingMemory {
  private readonly turns: ChatTurn[] = []

  constructor(private readonly maxTurns = 12) {}

  append(role: ChatTurn['role'], content: string, at = Date.now()): void {
    this.turns.push({ role, content, at })
    while (this.turns.length > this.maxTurns) {
      this.turns.shift()
    }
  }

  recent(): ChatTurn[] {
    return [...this.turns]
  }

  clear(): void {
    this.turns.length = 0
  }
}
