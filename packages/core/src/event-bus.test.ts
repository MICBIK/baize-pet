// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest'
import { EventBus, type PetEvent } from './event-bus'

const makeEvent = (type = 'click', payload: unknown = { n: 1 }): PetEvent => ({
  source: 'input',
  type,
  payload,
  timestamp: 1_700_000_000_000,
})

describe('EventBus', () => {
  it('delivers events to every subscriber', () => {
    const bus = new EventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    bus.publish(makeEvent())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(makeEvent())
  })

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    bus.publish(makeEvent())
    unsubscribe()
    bus.publish(makeEvent())
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener does not affect other subscribers', () => {
    const bus = new EventBus()
    const boom = vi.fn(() => {
      throw new Error('listener exploded')
    })
    const after = vi.fn()
    bus.subscribe(boom)
    bus.subscribe(after)
    expect(() => bus.publish(makeEvent())).not.toThrow()
    expect(boom).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('reports listener exceptions through the error handler', () => {
    const bus = new EventBus()
    const onError = vi.fn()
    bus.onError(onError)
    bus.subscribe(() => {
      throw new Error('bad listener')
    })
    bus.publish(makeEvent('tick'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ type: 'tick' })
  })

  it('a throwing error handler still does not break publishing', () => {
    const bus = new EventBus()
    bus.onError(() => {
      throw new Error('handler is broken too')
    })
    bus.subscribe(() => {
      throw new Error('bad listener')
    })
    const after = vi.fn()
    bus.subscribe(after)
    expect(() => bus.publish(makeEvent())).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('listenerCount reflects subscriptions', () => {
    const bus = new EventBus()
    const off = bus.subscribe(() => {})
    expect(bus.listenerCount()).toBe(1)
    off()
    expect(bus.listenerCount()).toBe(0)
  })
})
