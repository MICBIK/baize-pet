# ADR 0001：采用 Electron + TypeScript，macOS 优先

- 状态：已接受 · 2026-10-26

## 背景

初版设计选用 Tauri 2 + Rust。评审发现：Tauri 在 macOS 上使用系统 WKWebView（Safari 内核），不支持 VP9 透明 webm，而角色素材链的产物正是 VP9-Alpha webm；本地语音栈（ASR / TTS）在 Rust 侧需要自行接 C 接口；全栈需同时维护 Rust 与前端两门语言。项目负责人是深度 Mac 用户，决定先做 macOS、再做 Windows（Windows 一定会做）。

## 决定

- 桌面框架采用 **Electron + TypeScript**，渲染层 React，打包用 electron-builder。
- 平台顺序：macOS（Apple Silicon）优先，Windows 在 CI 中保持可构建，第二阶段补齐。
- 构建发布交给 GitHub Actions 矩阵（macOS + Windows），本机无需打包环境。
- 本地语音采用 sherpa-onnx（Node 包），麦克风使用 Chromium 自带回声消除。
- Mac 独有能力（如 Apple 端侧模型）以后通过小型 Swift 辅助进程提供。

## 备选方案

| 方案 | 不选的原因 |
|---|---|
| Tauri 2 + Rust | macOS 不支持 VP9 透明视频；语音生态需自行接入；两门语言 |
| Swift 原生 | Windows 需要重写 |
| Flutter / Godot | 透明穿透窗口与 AI 生态支持较弱 |

## 后果

- 常驻内存约 150-250MB，高于 Tauri；通过隐藏时暂停渲染、模型按需加载来缓解。
- 一套动画格式（VP9-Alpha webm）同时覆盖 Mac 与 Windows，dsh-pet 已验证的素材链可直接复用。
- 贡献者门槛最低（只需 TypeScript）。
- 第一阶段自签名，Mac 上无法做静默自动更新，改为"提示新版本 + 跳转下载页"。
