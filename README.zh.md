# dsh-attachment-formats — 附件格式扩展（Codex 风格兼容）

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.6.4-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--attachment--formats-181717)](https://github.com/linkingoscar/dsh-attachment-formats)

让 DeepSeek Harness Web 的输入框像 Codex 一样接收更多文件格式。不改动任何
核心包：纯插件实现，沿用 Harness 原生的图片草稿栏、上传限额校验、历史渲染
与模型请求管道。

[English](README.md) | 中文

## 支持的格式

| 文件 | 处理方式 | 去向 |
| --- | --- | --- |
| PNG / JPEG / WebP / GIF | 原生管线，本插件不介入 | 图片草稿栏（原生） |
| **PDF（有文本层）** | 文字层提取（≤40 页用 pymupdf4llm 高保真引擎，更大/不可用时 pdfjs 兜底） | 全文挂**文档卡片**（发送时并入消息）；超限转存工作区 + 索引卡片 |
| **PDF（扫描件/无文本层）** | tesseract.js OCR（置信度 ≥45 才采用），失败回退页面图 | OCR 成功走文本通道；失败 → 图片草稿栏（仅视觉模型） |
| **Word (.docx) / Excel (.xlsx) / PPT (.pptx)** | 提取文本——docx 经 mammoth HTML → turndown，**表格保留为 Markdown 管道表** | 文档卡片（发送时并入）；超限转存 + 索引卡片 |
| **旧 .doc / .xls / .ppt** | LibreOffice headless → docx/xlsx/pptx → 标准 Office 管线（需 `soffice`，缺失时明确报错） | 文档卡片（发送时并入） |
| **epub / odt / rtf** | pandoc → Markdown（PATH 探测）；无 pandoc 时 epub/odt 走 jszip+turndown 兜底；rtf 需 pandoc | 文档卡片（发送时并入） |
| **TIFF (.tiff/.tif)** | sharp（libvips）→ PNG 页（多页支持，≤20 页） | 原生图片草稿栏 |
| txt / md / json / 代码等 | 浏览器本地读取（UTF-8，回退 GB18030） | 文档卡片（发送时并入）；超限转存 + 索引卡片 |
| BMP / ICO / AVIF / SVG 等 | 浏览器解码后画布转 PNG | 原生图片草稿栏 |
| iWork / 音视频 / 压缩包 | —（暂不支持，明确提示并跳过） | — |

## 文档卡片（Codex 式挂载，输入框保持干净）

拖入/选择的**文本类附件不会塞进输入框**：内容挂成输入框上方的一枚**文档卡片**
（文件名 + 字符数 + 全文/索引标签，可单独移除），图片照旧进原生图片草稿栏。
你正常在输入框打字提问，**发送瞬间**插件把卡片内容并入消息（带
`[附件: 文件名]` 出处标记）再走原生提交——提问位置永远在最上面，内容也
一字不丢：

- 卡片条自带**发送**按钮：只挂文档不输入文字也能一键发出；
- 按 Enter / 点原生发送按钮：卡片自动并入后再提交；
- 模型忙于回复时不会合并（卡片保留，稍后再发）。

## 长文档（索引卡模式，永不静默截断）

超过 8 万字符的文本、多页长 PDF：**不塞进消息**，而是

1. 主机端转存到会话工作区 `.dsh-attachments/<sha-16>/`（内容寻址，重复拖入
   复用；约 7 天未访问自动清理）：
   - `doc.md` —— PDF 文字层按页组装（页首 `<!-- pN -->` 页码标记）、
     Office 提取文本、长文本原样（长 JSON 自动格式化落盘为 `doc.json`）；
   - `pages/pNN.png` —— 页面渲染图（≤100 页，视觉模型用 `read_image` 补充
     查看版式/图表；惰性生成，只有走索引卡路径才渲染）；
   - `manifest.json` —— 来源、页数、行数、字符数、引擎、完整源文件
     SHA-256 与转换策略指纹（换引擎/OCR/doc-server 自动让旧缓存失效）；
   - `INDEX.md`（缓存根）—— 本工作区全部已转存文档的聚合清单。
2. 消息里只挂一张几百 token 的**索引卡片**：页/行/字符数、大纲（PDF 标题粗检、
   md 标题、JSON 第一层键树）、以及读取指引。
3. 模型用 DSH 现成 `read` 工具分页读取（offset/limit，行号即出处坐标）——
   总结全文就逐段读完（不丢尾部），查细节就按大纲跳读；缺内容时是显式的
   工具失败，不会静默丢失。

设计取舍与业界取证见 `docs/design-longdoc.md`；同类作品比对见
`docs/alternatives.md`。

## 引擎与 OCR（v3）

- **PDF 文本引擎**：auto（默认）→ ≤40 页用 venv 内 pymupdf4llm（表格/标题
  高保真），更大文档或 venv 缺失时 pdfjs（秒级）。env：`DSH_ATTACH_ENGINE=
  auto|python|builtin`。
- **扫描件 OCR**：百度云 API（见下）→ python（PyMuPDF，需系统
  tesseract）→ tesseract.js（纯 JS，首次使用下载 eng/chi_sim 语言包 ~24MB
  缓存到 `vendor/tessdata/`）。置信度 <45 时自动回退页面图并说明原因。
  env：`DSH_ATTACH_OCR=auto|baidu|tesseract-js|off`。

## 保真度与格式覆盖

- **DOCX 表格**：mammoth HTML → turndown + GFM 插件，表格保留为 Markdown
  管道表（替代旧的逐单元格阅读顺序输出）。
- **TIFF**：sharp（libvips 预编译）解码为 PNG 页，支持多页（单文件 ≤20 页）。
- **epub / odt / rtf**：pandoc（PATH 探测）转 Markdown；无 pandoc 时 epub/odt
  走进程内 jszip + turndown 兜底，rtf 给出明确安装提示。
- **旧 .doc / .xls / .ppt**：LibreOffice headless（探测 PATH 及 Windows 常见
  安装路径）先转现代 OOXML，再走标准 Office 管线；每次转换使用独立
  `UserInstallation` profile 避免锁冲突。
- **PDF 大纲**：书签目录（`get_toc` / pdfjs `getOutline`）优先作为索引卡大纲，
  字号启发式仅作回退；无书签的 PDF 行为不变。

## 云端 OCR 与内容自适应引擎（零重量级新依赖）

- **百度 OCR API**（扫描件识别首选，免费额度：通用文字识别标准版/高精度版
  个人认证 1,000 次/月、企业 2,000 次/月，官方免费额度页数据）：页面以 JPEG
  经纯 HTTPS 上传——**零新增依赖**。通过环境变量配置：
  - `BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET`（百度智能云控制台 → 文字识别 →
    创建应用获得）；
  - `DSH_ATTACH_OCR=auto|baidu|tesseract-js|off`（auto = 有凭据即用百度，
    否则本地 tesseract.js）；
  - `DSH_ATTACH_OCR_ACCURATE=1` 使用高精度版（独立免费额度）。
  配额耗尽/调用失败 → 自动回退本地 tesseract.js 并注明；强制 `baidu` 模式
  则直接说明原因。
- **远程 VLM OCR**（可选，按 token 计费）：`DSH_ATTACH_VLM_BASE` /
  `DSH_ATTACH_VLM_MODEL`（可选 `DSH_ATTACH_VLM_KEY`）指向任意 OpenAI 兼容
  视觉端点（olmOCR-2、GLM-4V、Qwen-VL…），逐页经 chat/completions 转录。
  OCR 链路：百度 → VLM → tesseract.js（`DSH_ATTACH_OCR=vlm` 可强制）。
- **内容自适应 PDF 引擎**：41–160 页的文档由 python 引擎按向量密度（采样
  `get_drawings`）自行决策——纯文字手册跳过耗时的高保真转换直走 pdfjs 快速
  引擎；表格/图形密集文档仍走 pymupdf4llm。≤40 页行为不变。

## 外部解析服务、缓存管理页与工作区零拷贝

- **外部文档解析服务**（可选）：`DSH_ATTACH_DOC_SERVER=<base URL>` 指向解析
  服务（PP-StructureV3 `paddleocr serve`、MinerU 或任意包装网关）。契约：
  `POST {base}/convert` multipart 字段 `file` → `{ "ok": true, "markdown": "..." }`。
  配置后 PDF 优先走服务，任何失败自动回落本地引擎链。
- **附件缓存设置页**：设置 → 附件缓存，列出全部已转存文档（规模/引擎/时间），
  支持逐条删除与全部清空；数据源 `GET /api/attach-formats/cache`、
  `POST .../cache/delete`、`POST .../cache/clear`。
- **工作区零拷贝**：512KB～16MB 的文本文件先做工作区同源解析——浏览器本地读
  完整文件算出 SHA-256，再经 `GET /api/attach-formats/resolve` 让主机按
  「文件名 + 字节数 + 完整 SHA-256」确认同源文件（~2.5s 限时、跳过依赖目录）。
  命中则挂 📎 引用卡片——**不上传内容**（只传文件名、大小与哈希，为算哈希
  本地会读一遍文件），模型用 `read` 工具直接读该路径；未命中回落常规上传转存。
  超过 16MB 直接拒绝，不再尝试零拷贝。

## 上下文自适应与全文命令（v2b）

- **自适应并入上限**：客户端读 token-meter 的 `contextPressure` 投影
  （模型上下文窗口 × 当前占用），全文卡片并入上限 = min(8 万字符, 余量×1.5)——
  余量不足时自动转索引卡并在状态条说明，从源头杜绝"并入顶爆上下文被
  API 静默截尾"；投影缺失时回退固定 8 万阈值。
- **`/attach` 命令**（输入框斜杠菜单，主机端注册）：
  - `/attach list` —— 列出本工作区已转存文档（id/名称/规模/引擎）；
  - `/attach full <id|名称>` —— 把全文作为 next-step 消息并入模型上下文
    （**下一条消息生效**，不打断当前对话）；上限 30 万字符，超限显式截断
    说明，绝不静默丢内容。之后仍可用 `read` 工具按行精读定位。

## 交互入口

- **回形针按钮**：输入栏工具行（`conversation.input.left`），打开文件选择器，
  支持多选；`accept` 列表覆盖上表全部格式。
- **拖放**：把 PDF / Office / 文本文件直接拖到页面任意位置。
- **粘贴**：复制文件后 Ctrl+V 到输入框（或整页粘贴）。

原生图片拖放/粘贴仍由 Harness 内建管线处理；只要一次拖放里混入其它格式，
本插件接管整个批次（先转换，再以「合成 drop」把产出的图片交还给内建草稿栏）。

## 架构

```
projects/dsh-attachment-formats/
├── lib/
│   ├── index.js          # 主机半区：POST /api/attach-formats/convert + 引擎路由
│   ├── client.js         # 浏览器半区：按钮/拖放拦截/合成 drop/文本注入/状态条
│   ├── cache.js          # 工作区 .dsh-attachments 落盘/manifest/INDEX.md/清理
│   ├── py/pymupdf4llm_convert.py  # venv 高保真引擎（子进程调用）
│   └── convert/
│       ├── util.js       # 魔数嗅探（pdf/tiff/OLE/rtf/zip）、base64、文本截断
│       ├── provider.js   # 引擎/二进制探测（venv python、pandoc、LibreOffice）+ 子进程桥
│       ├── pdftext.js    # pdfjs 文字层提取：行组装/页眉页脚去重/书签目录
│       ├── outline.js    # md 标题大纲、JSON 第一层键树
│       ├── ocr.js        # tesseract.js OCR（traineddata 下载缓存/置信度）
│       ├── pdf.js        # pdfjs-dist + @napi-rs/canvas → PNG/JPEG 页
│       ├── docx.js       # mammoth HTML → turndown+GFM → Markdown（表格保留）
│       ├── xlsx.js       # exceljs → 制表符文本
│       ├── pptx.js       # jszip + a:t 文本运行 → 每页文本
│       ├── tiff.js       # sharp（libvips）→ PNG 页
│       ├── pandoc.js     # pandoc → Markdown + epub/odt zip 兜底
│       └── libreoffice.js # 旧 .doc/.xls/.ppt → 现代 OOXML
├── .venv/                # （可选）pymupdf4llm 高保真引擎（setup 生成，不入库）
├── vendor/tessdata/      # OCR 语言包缓存（首次使用下载，不入库）
├── docs/                 # design-longdoc.md / alternatives.md / upgrade-v6.md
├── scripts/smoke-*.mjs   # 五套离线冒烟（转换器/路由/客户端/OCR/P0）
└── cordis.patch.yml
```

- 主机路由重新嗅探魔数，不信任客户端声明的 kind；请求体 160MB 上限、单文件
  64MB 上限；`cwd` 由客户端从会话状态读取后随请求上报（决定缓存落盘位置）。
- 分级阈值：全文卡片并入上限 8 万字符（v2b 按上下文余量自适应压低）；缓存
  页图 ≤100 页（1100px 宽，PNG 超单图字节预算回退 JPEG）；扫描件页图上限
  沿用部署限额；OCR 单次 ≤20 页（2000px 宽），置信度 <45 回退页面图。
- 文档卡片内容在发送瞬间经 DOM 事件桥合并进 React 受控输入框（与原生提交
  同路径）；图片路径完全独立、不受影响。
- 转换进度/错误显示在输入框上方的临时状态条（`conversation.input.dock`），
  成功 6 秒后自动消失，错误可手动关闭。

## 安装

从 GitHub 安装（推荐）：

```powershell
dsh plugin --profile web add github:linkingoscar/dsh-attachment-formats
```

本地开发安装：

```powershell
cd path\to\dsh-attachment-formats
npm install            # 安装主机端依赖（首次）
# 可选：高保真 PDF 引擎（pymupdf4llm，venv 自包含）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install pymupdf4llm
npm run smoke          # 离线冒烟测试（可选）
dsh plugin --profile web add link:path\to\dsh-attachment-formats
```

重启 `dsh web`（关闭页面 → 快捷方式自动重启，或重新运行 `dsh web`），刷新
浏览器页面后生效。OCR 语言包在第一次识别扫描件时自动下载（约 24MB，缓存于
`vendor/tessdata/`，之后离线可用）。

## 已知限制

- OCR（tesseract.js）对低清扫描件、复杂表格质量有限；置信度不足会自动回退
  页面图并明确说明，绝不注入乱码文本。更高质量 OCR（RapidOCR/MinerU/
  PaddleOCR）可作为后续可插拔后端（见 `docs/upgrade-v6.md`）。
- pymupdf4llm 高保真引擎仅处理 ≤40 页 PDF（更大用 pdfjs 快速引擎）；表格/
  公式重建质量好但仍非排版级还原，版式细节可用页面图对照。
- 无文本层且 OCR 不可用/失败的扫描件只能走页面图（视觉模型可用）。
- 旧 `.doc/.xls/.ppt` 需要 LibreOffice（`soffice`）；`rtf` 需要 pandoc；
  `epub/odt` 开箱即用，但装有 pandoc 时保真度更高。缺失的二进制会给出
  明确可操作的错误——绝不静默丢弃。
- DOCX 的公式与内嵌图片不提取（表格、标题、正文保留）。
- XLSX 只输出「显示文本/结果」，图表、批注不提取。
- 大纲优先用书签目录；无书签的 PDF 回退字号启发式（对无标题样式的文档较弱），
  索引卡仍提供行数/页数与读取指引。
- iWork、压缩包等暂不转换。
- 附件归属当前对话：文本/文档卡片一定落在你正在看的这个对话框（按 shell
  的「当前会话」解析，不再依赖插槽渲染顺序）。转换出的页面图片走 Harness
  原生 drop 管线——当前会话回复中时会暂时拒绝 drop，插件会等它空闲再投喂；
  若同时开着多个对话，其它**空闲**的对话也可能接住同一合成 drop（Harness
  层面的行为，插件无法圈定范围），建议附图片时只开一个对话（文本/代码文件
  不受影响，始终留在当前对话）。
- 文档卡片的"发送时合并"走 DOM 事件桥接到 React 受控输入框，属于对
  Harness 未公开 API 的适配；核心包升级后若失效，症状是「卡片内容没进
  消息」，此时可用卡片条的**发送**按钮兜底（合成 Enter 路径），图片路径
  始终不受影响。

## 发布版本

- **[v0.6.4](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.4)**
  （最新）—— 会话归属正确与零拷贝校验：附件按 shell 当前会话归属（不再出现
  卡片/图片跑到别的对话框）；转换图片等当前会话空闲再投喂；工作区零拷贝改
  「文件名 + 字节数 + 完整 SHA-256」同源确认（杜绝同名同大小静默替换），
  >16MB 直接拒绝；INDEX 单元格转义、重建按工作区串行化；缓存命中保留
  source 口径字段；旧版 Office manifest 标注 `libreoffice+builtin` 引擎。
- **[v0.6.3](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.3)**
  —— 缓存生命周期加固：v0.6.1 的 8-hex 遗留缓存目录在清理/清空时
  一并扫除（不再有不可见孤儿）；JSON 转存区分源文本与落盘产物尺寸（分流
  按产物口径）；缓存命中降级为索引卡时惰性补齐页面图；INDEX.md 改由合法
  manifest 全量重建（无 ghost 行、转存时间列修复）；旧版 .doc/.xls/.ppt
  缓存键改用原始 OLE 字节，命中直接跳过 LibreOffice；manifest/INDEX 原子写。
- **[v0.6.2](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.2)**
  —— 缓存正确性与快路径：缓存目录 16 hex + manifest 存完整
  SHA-256；转换策略指纹（换引擎/OCR/doc-server 自动让旧缓存失效）；索引卡
  命中时按结构化 metadata 用当前文件名重建（不再串名）；TTL 纳入模型直接
  read 的文件访问时间；页面图惰性生成（干净小 PDF 不再被整本光栅化拖慢）；
  2–16MB 文本可走主机转存不再被拒；消除 React key 警告；Node >=20；CI
  actions 升级 v7。
- **[v0.6.1](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.1)**
  —— 正确性与工程化修复：附件条崩溃修复（`useCallback` 引用缺失）、
  转换器不再预截断（端到端恢复「永不静默截断」）、路由统一以会话派生的
  工作区为准、XLSX 空列坐标修复、按源文件哈希命中的真转换缓存、TTL 以最后
  访问时间为准、合并进草稿时回读校验；新增 ESLint、CI（Node 20/22）与
  组件级冒烟测试。
- **[v0.6.0](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.0)**
  —— 保真度与格式覆盖（DOCX 表格、TIFF、epub/odt/rtf、旧版 Office、
  PDF 书签大纲）、百度 OCR + 远程 VLM OCR + 外部文档解析服务、内容自适应引擎、
  附件缓存设置页、工作区零拷贝引用。
- **[v0.5.0](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.5.0)**
  —— 文档卡片、索引卡转存、`/attach list|full`、自适应并入上限、
  pymupdf4llm/pdfjs 引擎、tesseract.js OCR。

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)
