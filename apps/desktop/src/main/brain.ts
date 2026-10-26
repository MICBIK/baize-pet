// SPDX-License-Identifier: AGPL-3.0-only
import {
  BehaviorHistory,
  type BehaviorPick,
  BehaviorSelector,
  DEFAULT_BEHAVIOR_CONFIG,
  DEFAULT_EMOTION_PARAMS,
  type EmotionParams,
  EmotionState,
  type InteractionType,
  loadCharacterPack,
  PresetLinePool,
  type SceneContext,
  type SceneRule,
} from '@baize/core'

/**
 * Wires the @baize/core behavior system to the loaded character pack: emotion
 * decay/accumulation, spontaneous picks (scene: idle) and preset line delivery.
 */
export class PetBrain {
  private readonly pack
  private readonly emotion = new EmotionState()
  private readonly history = new BehaviorHistory()
  private readonly linePool
  private readonly selector
  private readonly emotionParams: EmotionParams
  private lastTick = Date.now()

  constructor(packDir: string) {
    this.pack = loadCharacterPack(packDir)
    this.linePool = new PresetLinePool(this.pack.manifest.lines ?? {})
    this.emotionParams = this.pack.manifest.emotion ?? DEFAULT_EMOTION_PARAMS
    const rule: SceneRule = {
      id: 'idle_nap',
      match: () => true,
      candidates: () => [
        {
          action: 'idle_nap',
          baseWeight: 1,
          emotionAffinity: { happy: -0.4, bored: 0.6 },
        },
      ],
    }
    this.selector = new BehaviorSelector([rule], {
      ...DEFAULT_BEHAVIOR_CONFIG,
      ...(this.pack.manifest.behavior ?? {}),
    })
  }

  get manifest() {
    return this.pack.manifest
  }

  get emotionVector() {
    return this.emotion.value
  }

  /** Periodic tick: decays emotion and may produce a spontaneous action + line. */
  tick(now = Date.now()): { action: string; line: string | null } | null {
    this.emotion.decay(now - this.lastTick, this.emotionParams)
    this.lastTick = now
    const context: SceneContext = {
      now: new Date(now),
      emotion: this.emotion.value,
      recentEvents: [],
      activeInteraction: null,
      ...this.history.snapshot(this.pack.manifest.behavior?.cooldownMs ?? 45_000, now),
    }
    const pick: BehaviorPick | null = this.selector.pick(context)
    if (!pick) return null
    this.history.record(pick.action, now)
    return { action: pick.action, line: this.linePool.line(pick.sceneId, this.emotion.value) }
  }

  /** User interaction: accumulate emotion and return a line for the bubble. */
  onInteraction(type: InteractionType, now = Date.now()): string | null {
    this.emotion.apply(type, this.emotionParams)
    this.lastTick = now
    return this.linePool.line(type, this.emotion.value)
  }
}
