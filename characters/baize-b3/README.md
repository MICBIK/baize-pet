# baize-b3 · 分层 rig 角色包

默认角色包（renderer: "rig"）：分层部件 + 程序动画，动作名与行为系统逐一对应（35 个 rig clips + 4 个 sprite 图集 = 39 个动画键）。

## 目录结构

- `manifest.json` — renderer: "rig"，animations 用 `rig:<clip>` / `sprite:<sheet>` 两种前缀形式
- `rig/rig.json` — 部件表（z/parent/pivot/插槽）、锚点（hoodWidth=524px、groundY=1101、centerX=435，master 像素坐标）、clips/expressions 清单
- `rig/parts/*.png` — 每部件一张（0.5x master 缩放，角色高 512px）
- `rig/clips/*.json` — 关键帧动作（由 `tools/rig-pipeline/make-clips.cjs` 生成）
- `rig/expressions.json` — 18 个表情预设
- `sprites/*.png + sprites.json` — 4 个大动作图集（dance/sit/sit-idle/hide-in-hood），256 网格、地面线 246，与 rig 共用锚点

## 从 demo/ 原始素材重建（命令清单）

```bash
# 0) Python 环境（一次）
python3 -m venv demo/rig-art/.venv
demo/rig-art/.venv/bin/pip install numpy pillow scipy opencv-python-headless torch torchvision segment-anything
# SAM 权重: https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth -> demo/rig-art/models/

# 1) master 候选生成（需 BAIZE_IMAGE_API_KEY，key 只走环境变量）
BAIZE_IMAGE_API_KEY=$(node demo/rig-art/key.cjs) node tools/rig-pipeline/gen-image.cjs batch --jobs demo/rig-art/master-jobs.json
#    人工从 demo/rig-art/master-candidates/ 挑选（本轮选 m3），写进 normalize_master.py 的常量

# 2) 归一化（角色高 1024px）
demo/rig-art/.venv/bin/python tools/rig-pipeline/normalize_master.py

# 3) 变体生成（12 种 × 2 候选，master 单参考）
node tools/rig-pipeline/make-variant-jobs.cjs
BAIZE_IMAGE_API_KEY=$(node demo/rig-art/key.cjs) node tools/rig-pipeline/gen-image.cjs batch --jobs demo/rig-art/variant-jobs.json

# 4) 配准（ECC 金字塔 + ORB 回退，叠图人工验收）
demo/rig-art/.venv/bin/python tools/rig-pipeline/register_variants.py

# 5) SAM 分割（parts.prompts.json 为可复现提示）
demo/rig-art/.venv/bin/python tools/rig-pipeline/segment_parts.py

# 6) A5 关节外扩
demo/rig-art/.venv/bin/python tools/rig-pipeline/extend_parts.py

# 7) A9 验收（复原/关节压力/小尺寸，报告在 demo/rig-art/qa/qa-report.txt）
demo/rig-art/.venv/bin/python tools/rig-pipeline/qa.py

# 8) clips + 表情预设
node tools/rig-pipeline/make-clips.cjs demo/rig-art/clips-out

# 9) 导出本包
demo/rig-art/.venv/bin/python tools/rig-pipeline/export_pack.py
```

## 已知问题

- master（m3）与序列帧源（ref-standard）头身比例存在约 12% 差异；rig↔sprite 切换处兜帽宽度与地面线已对齐（双锚点），角色高度差待联系表目检后决定是否按高度重归一化图集
- 手臂插槽当前只有 down 姿势；wave/up/hold 等插槽待变体配准后由 export_pack.py 注册
- 眼/嘴插槽当前只有 open/smile；A6 表情贴片批次完成后扩充
