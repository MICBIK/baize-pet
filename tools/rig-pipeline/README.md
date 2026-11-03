# rig-pipeline · 分层角色美术管线

把"一张标准像"变成 rig 角色包（`characters/baize-b3`）的可复现脚本集合。所有生图脚本只从环境变量 `BAIZE_IMAGE_API_KEY` 读 key（变量名照此），绝不写进文件/日志/报告。

## 脚本清单（按执行顺序）

| 步骤 | 脚本 | 产物 |
|---|---|---|
| 1 | `gen-image.cjs one/batch`（key 经 stdin 注入 curl，不进 argv） | master 候选 / 变体 / 表情图 |
| 2 | `normalize_master.py` | `demo/rig-art/master.png`（角色高 1024px） |
| 3 | `make-variant-jobs.cjs` + batch | 12 变体 × 2 候选 |
| 4 | `register_variants.py`（ECC 金字塔 + ORB 回退） | `registered/` + qa 叠图（人工看图） |
| 5 | `segment_parts.py`（SAM vit_b + 颜色法，提示见 parts.prompts.json） | `parts-full/*.png` + qa/segmentation.png |
| 6 | `extend_parts.py`（关节外扩，外扩像素拷贝 master 原色） | `parts-ext/*.png` |
| 7 | `qa.py`（复原/关节压力/小尺寸） | `qa/qa-report.txt` + 四组 QA 图 |
| 8 | `make-clips.cjs` | 35 clips + 18 表情预设 |
| 9 | `export_pack.py`（锚点用序列帧同一把尺量测） | `characters/baize-b3/` |
| 10 | `make-expression-jobs.cjs` + `extract_patches.py` | A6 眼/嘴贴片（插槽扩充用） |
| 11 | `probe_mask_support.py` | A0 mask 支持探测 |

## 关键设计决定

- **变体单参考**：变体/表情图只用 master 单参考 + 强化克隆措辞——双参考会被 ref-standard 的成年向比例带跑（open-questions #13）。
- **配准口径**：全局 ECC 只做粗对齐（IoU 记录不做硬门槛），0.97 门槛在实际取用区域做局部精调后检验（open-questions #12）。
- **外扩像素拷 master 原色**：静止时合成与 master 逐像素一致（复原 IoU=1.0），旋转时带出合理颜色；只向不透明区内生长。
- **锚点同一把尺**：rig.json 锚点用序列帧归一化器的迭代带宽法量测，保证 rig↔图集同尺寸。
- **安全**：生图 key 只走 `BAIZE_IMAGE_API_KEY` 环境变量；curl `-K -` stdin 注入，不进 argv/日志；demo/ 与 *.dmg 已 gitignore。
