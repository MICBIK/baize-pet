# ADR 0004：占位动画的 VP9-Alpha 生成管线（ffmpeg 双流 + mediabunny 合并）

- 状态：已接受 · 2026-10-26

## 背景

docs/07 M1 要求占位动画"用 ffmpeg 等工具程序生成透明背景的简单图形动画（VP9 + `yuva420p`）"。实现时发现：**主线 ffmpeg 不支持 VP9 alpha 编码**——`libvpx-vp9` 接受 `yuva420p` 输入但静默丢弃 alpha 平面（编码结果为不透明 yuv420p）；`mkvmerge` 也无法把第二条 VP9 流作为 BlockAdditional 挂到第一条流上。而 Chromium/Electron 播放 VP9 alpha 依赖 WebM 容器的 `BlockAdditional`（alpha 层）+ `ALPHA_MODE=1` 标记。

另外 ffmpeg `geq` 滤镜有两个坑：只处理 planar 格式的 alpha（packed `rgba` 输入 alpha 全 0）；对不含 Y 变量的表达式按行求值后整帧复制（图形会塌缩成一条线）。

## 决定

占位资产由 `scripts/generate-placeholder-animations.mjs` 生成：

1. ffmpeg `geq` 逐像素绘制（输入 `format=gbrap` planar；表达式以 `hypot(X-cx, Y-cy)` 点距离形式书写，保证 Y 参与逐像素求值）；
2. 颜色与 alpha（灰度 lum）分别编码为两条 VP9 流；
3. mediabunny（纯 TS，MIT）读取两条流，把 alpha 帧作为 `EncodedPacket.sideData.alpha` 合并写出一个 WebM，容器自动携带 `ALPHA_MODE=1` 与 BlockAdditional。

验证方式：mediabunny 读回确认每帧 alpha 数据非空；Chromium 渲染验证透明生效。

## 备选方案

| 方案 | 不选的原因 |
|---|---|
| ffmpeg 直出 `-pix_fmt yuva420p` | 主线 ffmpeg 静默丢弃 alpha（实测） |
| mkvmerge 合并双轨 | 输出为两个视频轨道，不是 alpha 结构（实测） |
| APNG / 序列帧 | 07 规定素材链统一 VP9-Alpha webm，`<video>` 播放路径不能为占位资产分叉 |
| 手写 EBML 合并 | mediabunny 已实现同能力且经过验证，避免自研容器层 |

## 后果

- 生成脚本依赖 Node + ffmpeg + mediabunny（root devDependency，仅构建期使用，不进运行时）。
- 正式美术素材到位后可整体替换 `characters/placeholder/animations/`，播放端（`<video>` + `baize-character://` 协议）无需改动。
- `characters/placeholder/README.md` 记录了完整命令与坑位，作为后续素材链（AI 生成 → 抠像 → VP9-Alpha）的参考。
