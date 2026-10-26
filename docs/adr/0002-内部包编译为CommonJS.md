# ADR 0002：内部包编译为 CommonJS，由 electron-vite 打包进主进程

- 状态：已接受 · 2026-10-26

## 背景

仓库采用 pnpm workspace（`apps/desktop` + `packages/*`）。Electron 主进程生态目前以 CommonJS 为主：sandboxed preload 脚本只支持 CJS，`better-sqlite3` 等 native 模块也是 CJS。workspace 内部包若以纯源码（`.ts` 直发）或 ESM-only 形式发布，会与 Electron 主进程的模块解析、electron-vite 的依赖外置（externalize）机制产生冲突：被 externalize 的包在运行时经 `node_modules` 解析，指向 `.ts` 源码时 Node 无法执行。

## 决定

- `packages/*` 内部包用 `tsc` 编译为 **CommonJS**（`main: dist/index.js` + `dist/index.d.ts`），构建顺序由 `pnpm -r` 按依赖拓扑执行。
- 内部包登记在 `apps/desktop` 的 **devDependencies** 中，electron-vite 的 `externalizeDepsPlugin` 只外置 dependencies/devDependencies 中的第三方库，`@baize/*` 因此被打进 `out/main`、`out/preload` 产物，运行时不再依赖 workspace 链接。
- main 与 preload 显式输出 `format: 'cjs'`、文件名 `[name].cjs`，避免不同 electron-vite / Vite 版本对输出格式默认值的差异。
- 渲染层只做 **type-only** 引用内部包类型（运行时一律经 preload 的 contextBridge API），避免渲染器对 CJS 包的运行时依赖。
- Vitest 测试经根配置 alias 直接引用包源码，测试前无需先构建。

## 备选方案

| 方案                                                     | 不选的原因                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| ESM-only 内部包 + Electron ESM 入口                      | 与 sandboxed preload（CJS-only）及 native 模块互操作复杂，收益仅为格式统一 |
| 内部包也走 bundler（tsup 等）                            | 多引入构建链；`tsc` 已满足 CJS + d.ts 需求                                 |
| 内部包放 dependencies 并由 electron-builder 随 asar 打包 | pnpm symlink 在 electron-builder 中的打包行为不可靠，且产物体积无谓增大    |

## 后果

- 包间 import 在构建产物中保持 `require('@baize/shared')` 形式，运行前需先 `pnpm -r build`（根 `dev`/`build` 脚本已内置）。
- 各包多一份 `tsconfig.build.json`（Node10 解析 + CJS 输出），与根 typecheck 配置（bundler 解析 + 源码 paths）并存，属可接受的配置重复。
- 未来若引入 ESM-only 的依赖（如某些 `sqlite-vec` 周边工具），只在构建脚本侧使用，不进入运行时主进程。
