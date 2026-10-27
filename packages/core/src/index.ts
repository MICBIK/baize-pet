// SPDX-License-Identifier: AGPL-3.0-only

export {
  type BehaviorConfig,
  BehaviorHistory,
  type BehaviorPick,
  BehaviorSelector,
  type CandidateAction,
  canInterrupt,
  DEFAULT_BEHAVIOR_CONFIG,
  INTERRUPT_PRIORITY,
  type InterruptSource,
  mulberry32,
  type SceneContext,
  type SceneRule,
} from './behavior'
export {
  type CharacterManifest,
  CharacterManifestSchema,
  CharacterPackError,
  emotionParamsOf,
  type LoadedCharacterPack,
  loadCharacterPack,
  SceneCandidateSchema,
  SceneSchema,
} from './character-pack'
export {
  DEFAULT_EMOTION_PARAMS,
  type EmotionParams,
  type EmotionRates,
  EmotionState,
  type EmotionVector,
  type InteractionGains,
  type InteractionType,
} from './emotion'
export { EventBus, type PetEvent, type PetEventListener } from './event-bus'
export { type LineProvider, PresetLinePool } from './lines'
