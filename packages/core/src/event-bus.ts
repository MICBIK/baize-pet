// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed publish/subscribe event bus for pet events.
 *
 * Events are `{ source, type, payload, timestamp }`. Listeners are isolated:
 * an exception thrown by one listener never prevents the others from running,
 * and is reported through the optional error handler instead.
 */
export interface PetEvent<T = unknown> {
  /** Where the event came from, e.g. "input", "timer", "system". */
  source: string
  /** Event type within the source, e.g. "click", "tick". */
  type: string
  payload: T
  timestamp: number
}

export type PetEventListener = (event: PetEvent) => void

export class EventBus {
  private readonly listeners = new Set<PetEventListener>()
  private errorHandler: ((error: unknown, event: PetEvent) => void) | null = null

  /** Registers a listener; returns an unsubscribe function. */
  subscribe(listener: PetEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Installs a handler for listener exceptions (listener error isolation hook). */
  onError(handler: (error: unknown, event: PetEvent) => void): void {
    this.errorHandler = handler
  }

  publish(event: PetEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        try {
          this.errorHandler?.(error, event)
        } catch {
          // A broken error handler must never break publishing.
        }
      }
    }
  }

  listenerCount(): number {
    return this.listeners.size
  }
}
