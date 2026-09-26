# 证件照生成器（ID Photo）

纯前端证件照制作工具。上传照片 → 拖动构图 → 选规格 → 下载，全过程在浏览器本地完成，**照片不上传任何服务器**。

- 线上地址：https://id-photo-3kh.pages.dev
- 仓库：https://github.com/peidongl98/id-photo

## 功能

| 模块 | 说明 |
|---|---|
| 上传 | 点击 / 拖拽 / 粘帖 / 手机拍照；JPG、PNG、HEIC；按 EXIF 方向自动摆正 |
| 人脸检测 | MediaPipe Face Landmarker（468 关键点），自动算裁剪框 |
| 拖动调参 | 直接拖动取景框移动构图，滚轮 / 双指缩放；拖动零延迟（纯几何，不重算），松手 300ms 后出低分辨率预览 |
| 双层处理 | 预览层最长边 600px（拖动结束 300ms 触发）；输出层原分辨率（只在点下载时跑，带进度条） |
| 规格库 | 23 档，**每档独立 faceRatio / centerY / topMargin**；支持自定义（mm 或 px） |
| 构图约束 | 头顶留白 ≥ topMargin（低于自动下拉）、下巴到画面下边 ≥ 10%，头顶绝不出框 |
| 换底 | **MODNet**（ONNX + onnxruntime-web，连续 alpha matte，发丝自然）→ 失败自动降级 MediaPipe Selfie Segmentation；含溢色去除与联合双边蒙版精修 |
| 磨皮 | 自写 WebGL 双边滤波，只作用于人脸椭圆；强度 0–30%（硬上限），平滑半径 1–5px |
| 合规检测 | 人脸检测 / 人脸居中 / 五官比例 / 亮度 / 背景纯色 / 磨皮强度，三级结论 + 颜色·图标·文字三重编码 |
| 导出 | JPEG 0.92→0.65 自动下调；目标大小（不限 / 20–40KB 学信网 / 40–100KB / 100–200KB） |

## 处理顺序

1. EXIF 方向矫正（`<img>` 解码，浏览器自动应用方向）
2. 人脸检测（Face Landmarker）
3. 裁剪（读当前规格的 faceRatio / centerY / topMargin，叠加拖拽偏移与缩放，再做构图约束）
4. 抠图（MODNet，用原图，得到 alpha matte）
5. 磨皮（限定人脸椭圆，用 Face Landmarker 关键点）
6. 合成到新背景
7. 合规检测
8. 导出

预览层在**输出尺寸的等比缩小版**上跑完整管线（最长边 ≤600）；输出层用规格原始像素（最大 1200×1800）。
原图先落到长边 ≤3600 的 master 画布（≈13MP），再逐级折半降采样 —— 既防锯齿，也避开 iOS Safari 的 16MP 画布上限。

## 技术栈

- 零构建，纯静态 HTML / CSS / JS（IIFE + `window.IDP` 命名空间）
- 依赖全部走 CDN 并锁死版本：
  - `@mediapipe/tasks-vision@0.10.14`（jsdelivr 主 + unpkg 备，自动回退）
  - `onnxruntime-web@1.20.0`（MODNet 运行时；`numThreads=1`，不依赖 COOP/COEP）
  - `heic2any@0.0.4`（HEIC 转换，按需注入）
- 模型文件**本地同源托管**（`assets/models/`）：
  - `face_landmarker.task` 3.6MB（人脸关键点）
  - `modnet.onnx` 6.6MB（高精度抠图）
  - `selfie_segmenter.tflite` 244KB（降级抠图）
  - 原因：官方源是 `storage.googleapis.com` / `huggingface.co`，中国大陆不可直连；同源托管同时更快。
- 按需加载：打开页面只加载人脸检测模型；**MODNet 只在用户点「高精度抠图」时下载**（带进度条），之后由 HTTP 缓存。

## 各规格构图参数

`faceRatio` = 人脸（头顶到下巴）占画面高度；`centerY` = 脸部中心垂直位置；`topMargin` = 头顶最小留白。

| 规格 | faceRatio | centerY | topMargin |
|---|---|---|---|
| 一寸 / 小一寸 / 大一寸 / 二寸 / 小二寸 / 大二寸 / 驾驶证 | 0.65 | 0.42 | 0.05 |
| 身份证 / 中国护照 | 0.67 | 0.42 | 0.05 |
| 高考·学信网 | 0.65 | 0.45 | 0.06 |
| 美国签证 | 0.60 | 0.45 | 0.08 |
| 申根签证 | 0.70 | 0.42 | 0.05 |
| 日本签证 / 印度电子签证 | 0.65 | 0.45 | 0.05 |
| 韩国 / 英国 / 加拿大 / 澳大利亚 / 新加坡签证 | 0.65 | 0.42 | 0.05 |
| 三寸 / 四寸 / 五寸 | 0.65 | 0.42 | 0.05 |
| 自定义 | 0.65 | 0.42 | 0.05 |

实测 23 档在各自默认参数下：头顶留白全部 ≥ 规格值（最紧 7.0%）、人脸占比与规格误差 ≤0.03、下巴留白全部 ≥10%。

## 磨皮参数

| 参数 | 取值 | 说明 |
|---|---|---|
| `sigma_space` | `radius × 0.6` | 规格给定；radius 1–5px，默认 3px |
| `sigma_color` | `0.08` | 强保边（≈20 灰阶），痣 / 疤 / 五官边缘不被跨越 |
| 强度 | 0–30% | 硬上限；映射到混合比例 ×3.33，≥28% 提示接近上限 |
| 级联 | 2 遍 | 单遍小核只够抹 1–2px 噪点，抹不动输出图上 5–9px 的真实痘痘 |

实测（二寸 413×579，注入已知幅度瑕疵逐像素测量，22% / radius 3）：

- 6px 痘痘淡化 **105%**、9px 痘痘 **16%**（均值 **60.7%**）
- 3px 痣 **−1.9%**、4px 疤 **8.9%**（均值 3.5%，即对比度保留 **96.5%**）
- 选择性 **17.1×**；斑心峰值几乎不动（痘 −5.3% / 痣疤 −6.8%）—— 结构还在，只是边缘变柔
- 五官强梯度保留 **100.9%**；脸部整体肤色 ΔE **0.13**；人脸椭圆外**逐像素零差异**

## 抠图：MODNet vs 标准

| 指标 | MediaPipe Selfie Segmentation | MODNet |
|---|---|---|
| 过渡带像素占比 | 1.05% | **10.58%** |
| 过渡带平均梯度 | 0.702（硬） | **0.170（柔）** |

过渡带占比高一个数量级、梯度低一个数量级 —— 就是"发丝边缘自然、无锯齿"的量化表现。

## 合规结论三级

- **通过（绿 ✓）**：正常下载
- **警告（橙 !）**：可下载，带提示
- **不通过（红 ✕）**：下载按钮置灰 + 内联修正提示（保留一个低对比度「仍要下载」逃生口，避免因判定失败彻底卡死）

## 本地运行

```bash
cd IDPhoto
python -m http.server 8899
# 打开 http://127.0.0.1:8899/
```

（不能用 `file://`：模型与多段脚本需要同源。）

## 部署

零构建，推送即部署。仓库推送到 `main` → GitHub Actions（`.github/workflows/deploy.yml`）调用 `cloudflare/wrangler-action` 做 Pages Direct Upload。

```bash
npx wrangler pages deploy . --project-name=id-photo --branch=main
```

需要仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

> 本项目使用 Cloudflare Pages **Direct Upload**（非 Git 集成）——该账号未安装 Pages 的 GitHub App，无法用 API 建 Git 集成项目。效果等同：push 后约 30–40 秒自动上线。

## 目录结构

```
IDPhoto/
├── index.html
├── css/style.css            含抽屉式移动端排版
├── js/
│   ├── main.js              主流程 / 拖动调参 / 双层处理 / 抽屉
│   ├── faceDetect.js        Face Landmarker
│   ├── bgRemove.js          MODNet + 降级 + 蒙版精修 + 溢色去除
│   ├── mopi.js              WebGL 双边滤波（含 CPU 兜底）
│   ├── crop.js              构图参数与约束
│   ├── compliance.js        六项合规检测
│   └── export.js            质量自适应导出
├── data/specs.js            23 档规格 + 独立构图参数
├── assets/models/           MediaPipe + MODNet 模型（本地托管）
└── .github/workflows/deploy.yml
```

## 隐私

所有计算在浏览器完成。不上传照片、不做埋点、不写 Cookie、不加登录；唯一落盘的是用户自己点下载得到的 JPEG。
