# ADR 0005：记忆存储采用 Node 内置 node:sqlite，替代 better-sqlite3

- 状态：已接受 · 2026-10-26（修订 ADR 0001/07 §2 的存储选型）

## 背景

07 §2 与 ADR 0001 选定 `better-sqlite3 + sqlite-vec`。实现中发现 better-sqlite3 是原生模块，必须在 Node ABI（vitest 单测）与 Electron ABI（应用运行时）之间二选一：`electron-builder install-app-deps` 重建为 Electron ABI 后，`pnpm test` 的单测立即崩溃；反之亦然。同一份 `node_modules` 无法同时满足两个运行时，而 CI（Node 跑测试、Electron 打包）与本地开发都需要两者。

## 决定

- 记忆引擎改用 **Node 22.13+ 内置的 `node:sqlite`**（`DatabaseSync`，同步 API 与 better-sqlite3 高度同形）。Node 22 LTS、Node 24 与 Electron 45 内置的 Node 22.x 均已默认启用，无 ABI 问题、无 postinstall、无跨平台二进制分发。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 只保留 `electron`、`esbuild`；`better-sqlite3` 依赖移除。
- `engines` 提升至 `>=22.13.0`（node:sqlite 去 flag 的最早 22.x 版本）。
- 实现层差异已封装：`PRAGMA user_version` 经常量表 `prepare().run()`；事务用 `BEGIN/COMMIT/ROLLBACK` 包装器 `runInTransaction`；`VACUUM INTO ?` 仍走参数绑定。
- sqlite-vec 维持"下一轮接入"（open-questions #4）：`node:sqlite` 支持加载扩展（`db.loadExtension`），接入路径不变。

## 备选方案

| 方案 | 不选的原因 |
|---|---|
| 保留 better-sqlite3 + 按运行时反复重建 ABI | 测试与开发每次切换要重编译，CI 时长与稳定性不可接受 |
| 测试改用 mock 数据库 | 07 验收要求"导出 → 清空 → 导入后数据完全一致"的真实 SQLite 行为 |
| 测试在 Electron 环境运行（vitest electron runner） | 引入 Electron 启动开销，CI 复杂度不降反升 |

## 后果

- 运行时零原生模块依赖（Electron 主进程无 .node 文件需要 asarUnpack），打包与 CI 更简单。
- `node:sqlite` 的 API 面（无 `transaction()` 包装、无 `pragma()` 辅助、`PRAGMA` 赋值不支持参数绑定）已在引擎内部封装，接口（docs/04 §6）不变。
- 若未来需要 sqlite-vec 的向量检索，通过 `loadExtension` 加载，或届时评估独立的向量索引文件方案。
