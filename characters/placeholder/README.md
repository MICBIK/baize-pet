# 占位角色包（placeholder）

程序生成的占位角色，供工程骨架开发与验收使用，**不是正式美术资源**。

## 内容

```
manifest.json            # 角色包描述（名称、版本、动作 → 动画文件映射、自发行为 scenes）
animations/idle_breath.webm  # 待机呼吸/小盹（3s 循环，VP9 + alpha）
animations/idle_look.webm    # 自发：好奇张望（4s 循环）
animations/idle_wiggle.webm  # 自发：开心扭动（2.5s 循环）
animations/click.webm        # 点击反应（1s 单次）
animations/drag.webm         # 拖拽摇摆（1.5s 循环）

自发行为候选来自 manifest 的 `scenes` 字段（idle_spontaneous 场景，
3 个候选：idle_nap / idle_look / idle_wiggle），台词池按场景 id 配置。
persona/persona.md       # 人设文档（喂给 LLM 的 system prompt 素材）
LICENSE.txt              # 资产授权声明（随仓库 AGPL-3.0-only）
```

## 生成方式

动画由 `scripts/generate-placeholder-animations.mjs` 程序生成：ffmpeg 的 `geq`
滤镜逐像素画出暖白色圆形生物（含两只眼睛），颜色与 alpha 分别编码为两条 VP9
流，再用 mediabunny 合并为带 alpha（BlockAdditional + `ALPHA_MODE=1`）的
WebM——主线 ffmpeg 不支持 VP9 alpha 编码，因此需要这个两步管线；托盘图标
`assets/tray.png` 由同一脚本生成。

重新生成（需要 PATH 中有 ffmpeg）：

```bash
pnpm install          # 安装 mediabunny（根 devDependency）
node scripts/generate-placeholder-animations.mjs
```

### 已踩过的坑（供后续素材链参考）

- **geq 只在 planar 格式上处理 alpha**：输入必须是 `format=gbrap`（planar RGB+A），
  不能用 packed `rgba`，否则 alpha 平面全 0。
- **geq 对不引用 Y 变量的表达式按行求值后整帧复制**：图形表达式必须写成
  `hypot(X-cx, Y-cy)` 的点距离形式（Y 要真实出现在表达式里）。
- **VP9 alpha 的容器标记**：`ALPHA_MODE=1` 必须存在，Chromium 才会解析
  BlockAdditional 中的 alpha 层。
