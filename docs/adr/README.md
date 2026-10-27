# 架构决策记录（ADR）

每条重要的技术决定新建一个文件：`NNNN-标题.md`，包含：背景、决定、备选方案、后果。

| 编号 | 标题 | 状态 |
|---|---|---|
| 0001 | 采用 Electron + TypeScript，macOS 优先 | 已接受（[0001](0001-采用Electron与macOS优先.md)） |
| 0005 | 记忆存储采用 Node 内置 node:sqlite，替代 better-sqlite3 | 已接受（[0005](0005-记忆存储采用node内置sqlite.md)） |
| 0006 | 生产构建端到端冒烟测试（Playwright `_electron` + xvfb） | 已接受（[0006](0006-生产构建端到端冒烟测试.md)） |
