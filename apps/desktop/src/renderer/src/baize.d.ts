// SPDX-License-Identifier: AGPL-3.0-only
import type { BaizeApi } from '../preload/index'

declare global {
  interface Window {
    baize: BaizeApi
  }
}
