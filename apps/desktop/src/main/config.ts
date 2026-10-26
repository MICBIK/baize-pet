// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AppConfig, AppConfigSchema, defaultAppConfig } from '@baize/shared'

const CONFIG_FILE = 'config.json'

export class ConfigStore {
  private readonly filePath: string
  private cache: AppConfig

  private constructor(userDataDir: string, initial: AppConfig) {
    this.filePath = join(userDataDir, CONFIG_FILE)
    this.cache = initial
  }

  static load(userDataDir: string): ConfigStore {
    const filePath = join(userDataDir, CONFIG_FILE)
    let config = defaultAppConfig()
    try {
      // A corrupted or outdated file falls back to defaults; user data (memory) lives elsewhere.
      config = AppConfigSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch {
      mkdirSync(userDataDir, { recursive: true })
    }
    return new ConfigStore(userDataDir, config)
  }

  get(): AppConfig {
    return this.cache
  }

  set(patch: Partial<AppConfig>): void {
    this.cache = AppConfigSchema.parse({ ...this.cache, ...patch })
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2))
  }
}
