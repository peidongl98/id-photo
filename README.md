# 证件照生成器（ID Photo）

纯前端证件照制作工具。上传照片 → 选规格 → 下载，全过程在浏览器本地完成，**照片不上传任何服务器**。

- 线上地址：https://id-photo-3kh.pages.dev
- 仓库：https://github.com/peidongl98/id-photo

## 功能

| 模块 | 说明 |
|---|---|
| 上传 | 点击 / 拖拽 / 粘帖 / 手机拍照；JPG、PNG、HEIC；自动按 EXIF 方向摆正 |
| 人脸检测 | MediaPipe Face Landmarker（468 关键点），自动算裁剪框，人脸居中 |
| 构图 | 人脸占比 0.50–0.70（默认 0.62）、脸部垂直位置（默认 0.45）、四向手动微调 |
| 规格库 | 中国常用 10 档 / 签证 9 档 / 其他 3 档，支持自定义（mm 或 px，按 300 DPI 换算） |
| 换底 | MediaPipe Selfie Segmentation + 联合双边蒙版精修 + 溢色去除；白 / 蓝 / 红 / 浅灰 / 学信网浅蓝 / 任意自定义色 |
| 磨皮 | 自写 WebGL 双边滤波 shader，只作用于人脸椭圆（边缘羽化）；强度 0–30%（硬上限），平滑半径 1–5px |
| 合规检测 | 人脸检测 / 人脸居中 / 五官比例 / 亮度 / 背景纯色 / 磨皮强度，三级结论 + 颜色·图标·文字三重编码 |
| 导出 | JPEG，质量 0.92→0.65 自动下调；支持目标大小（不限 / 20–40KB 学信网 / 40–100KB / 100–200KB）；文件名英文+时间戳 |

## 处理顺序

1. EXIF 方向矫正（`<img>` 解码，浏览器自动应用方向）
2. 人脸检测（Face Landmarker）
3. 裁剪（按规格与人脸位置）
4. 抠图（在原图上分割出人像蒙版）
5. 磨皮（限定人脸椭圆区域）
6. 合成到新背景
7. 合规检测
8. 导出

所有中间产物都在**输出像素尺寸**上计算（最大 1200×1800），既保证画质又避开 iOS Safari 的 16000×1000 像素画布上限。
原图先落到长边 ≤3600 的 master 画布（≈13MP），再逐级折半降采样，避免锯齿。

## 技术栈

- 零构建，纯静态 HTML / CSS / JS（IIFE + `window.IDP` 命名空间）
- 依赖全部走 CDN 并锁死版本：
  - `@mediapipe/tasks-vision@0.10.14`（jsdelivr 主 + unpkg 备，自动回退）
  - `heic2any@0.0.4`（HEIC 转换，仅在需要时按需注入）
- 模型文件**本地同源托管**（`assets/models/`），CDN 仅作回退：
  - `face_landmarker.task`（3.6MB，人脸关键点）
  - `selfie_segmenter.tflite`（244KB，人像分割）
  - 原因：模型官方源是 `storage.googleapis.com`，中国大陆不可直连；本地托管同时更快。
- 按需加载：打开页面只加载人脸检测模型；上传成功后后台静默预加载抠图模型。

## 磨皮参数

| 参数 | 取值 | 说明 |
|---|---|---|
| `sigma_space` | `radius × 0.6` | 规格给定；radius 1–5px，默认 3px |
| `sigma_color` | `0.08` | 强保边（≈20 灰阶），痣 / 疤 / 五官边缘不被跨越 |
| 强度 | 0–30% | 硬上限；实测映射到混合比例 ×3.33，≥28% 提示接近上限 |
| 级联 | 2 遍 | 单遍小核只够抹 1–2px 噪点，抹不动输出图上 5–9px 的真实痘痘 |

实测（二寸 413×579，注入已知幅度瑕疵逐像素测量）：

- 6px 痘痘：22% 时修复 **60.5%**，30% 时 **73.6%**
- 9px 痘痘：22% 时修复 **22.6%**，半径 5px 时 **27.6%**
- 3px 痣：22% 时改动 **−2.8%**（几乎不动）；4px 疤：**+4.6%**
- 五官强梯度保留 **95.5%**；脸部整体肤色 ΔE **0.14**；人脸椭圆外**逐像素零差异**

## 合规结论三级

- **通过（绿 ✓）**：正常下载
- **警告（橙 !）**：可下载，带提示
- **不通过（红 ✕）**：下载按钮置灰，并给出内联修正提示（保留一个低对比度的「仍要下载」逃生口，避免因为抠图判定失败而彻底卡死）

## 本地运行

任意静态服务器即可（不能用 `file://`，模型与多段脚本需要同源）：

```bash
cd IDPhoto
python -m http.server 8899
# 打开 http://127.0.0.1:8899/
```

## 部署

零构建，推送即部署。

- 仓库推送到 `main` → GitHub Actions（`.github/workflows/deploy.yml`）调用 `cloudflare/wrangler-action` 做 Pages Direct Upload
- 首次或手动部署：
  ```bash
  npx wrangler pages deploy . --project-name=id-photo --branch=main
  ```
- 需要仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

> 本项目使用 Cloudflare Pages **Direct Upload**（非 Git 集成）——该 Cloudflare 账号未安装 Pages 的 GitHub App，无法用 API 建 Git 集成项目。效果等同：push 后约 30 秒自动上线。

## 目录结构

```
IDPhoto/
├── index.html
├── css/style.css
├── js/
│   ├── main.js          主流程与界面接线
│   ├── faceDetect.js    Face Landmarker 加载与关键点解析
│   ├── bgRemove.js      Selfie Segmentation + 蒙版精修 + 溢色去除
│   ├── mopi.js          WebGL 双边滤波（含无 WebGL 的 CPU 兜底）
│   ├── crop.js          人脸构图与规格化输出
│   ├── compliance.js    六项合规检测
│   └── export.js        质量自适应导出
├── data/specs.js        规格库与底色
├── assets/models/       MediaPipe 模型（本地托管）
└── .github/workflows/deploy.yml
```

## 隐私

所有计算在浏览器完成。不上传照片、不做埋点、不写 Cookie、不加登录；唯一落盘的是用户自己点下载得到的 JPEG。
