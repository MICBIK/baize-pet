# BaiZe 仓库说明（给 AI 协作者）

- 产品与设计文档在 `docs/`，是唯一事实来源。当前阶段按 `docs/07-工程骨架方案.md` 执行。
- 技术栈已定：Electron + TypeScript + React，pnpm monorepo，macOS 优先（见 `docs/adr/0001-*`）。不要更换框架；需要偏离时先写 ADR。
- 红线：不复制其他 AGPL/GPL 项目代码；无任何遥测；API key 只经 `safeStorage` 存储；"捣蛋"只做视觉效果；源文件加 `// SPDX-License-Identifier: AGPL-3.0-only`。
- 文档用中文，代码与注释用英文，提交信息用 Conventional Commits。
- 有矛盾或需要产品判断的问题写到 `docs/open-questions.md`，不要擅自改产品决策。
