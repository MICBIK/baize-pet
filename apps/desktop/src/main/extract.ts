// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lightweight rule-based fact extraction from a chat turn (docs/07 M4: "明确事实
 * （名字、偏好）做轻量抽取"). Deliberately regex-based: no extra LLM round trips.
 */
export interface ExtractedFacts {
  userName?: string
  petName?: string
  preferences: string[]
}

const USER_NAME_PATTERNS = [
  /(?:我叫|我的名字是|叫我|名字叫)\s*([一-龥a-zA-Z0-9·]{1,12})/,
  /^([一-龥a-zA-Z0-9·]{1,12})\s*[，,]?\s*(?:请多指教|你好|你们好)/,
]

const PET_NAME_PATTERNS = [
  /(?:你就叫|你就叫做|你叫|给你起名(?:字)?[叫为]?|给你取名(?:字)?[叫为]?|就叫你)\s*([一-龥a-zA-Z0-9·]{1,12})/,
]

const PREFERENCE_PATTERN = /我(?:很喜欢|喜欢|爱|讨厌|不喜欢|害怕)([一-龥a-zA-Z0-9]{1,16})/g

const STOPWORDS = new Set(['什么', '怎么', '吗', '呢', '吧'])

function clean(name: string): string | undefined {
  const trimmed = name.trim().replace(/[的呗哦嗯呢吧啊呀~～。！!？?，,]+$/g, '')
  if (trimmed.length === 0 || STOPWORDS.has(trimmed)) return undefined
  return trimmed
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  // String.match with a non-global regex returns the first match array or null.
  const match = text.match(pattern)
  const captured = match?.[1]
  return captured ? clean(captured) : undefined
}

export function extractFacts(text: string): ExtractedFacts {
  const facts: ExtractedFacts = { preferences: [] }

  for (const pattern of USER_NAME_PATTERNS) {
    const name = firstMatch(text, pattern)
    if (name) {
      facts.userName = name
      break
    }
  }

  for (const pattern of PET_NAME_PATTERNS) {
    const name = firstMatch(text, pattern)
    if (name) {
      facts.petName = name
      break
    }
  }

  for (const match of text.matchAll(PREFERENCE_PATTERN)) {
    const target = match[1] ? clean(match[1]) : undefined
    if (target) {
      facts.preferences.push(target)
    }
  }

  return facts
}
