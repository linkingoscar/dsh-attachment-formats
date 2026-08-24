# 同类作品比对（GitHub 调研，2026-01）

调研对象分两层：**DeepSeek Harness（DSH）插件生态内的直接对标品**，以及
**Codex/Claude 生态里的文档摄入类 skill/流水线**（思路对标品）。

## 1. DSH 生态内（同一框架、同一 Web 输入框）

| 项目 | 机制 | 文档内容处理 | 优点 | 缺点 |
| --- | --- | --- | --- | --- |
| [omdsh-dev/dsh-drag-and-drop](https://github.com/omdsh-dev/dsh-drag-and-drop)（含 [AKIRACOD fork](https://github.com/AKIRACOD/dsh-drag-and-drop) 的芯片版 UX） | 拖文件/文件夹 → 主机端解析**真实绝对路径**插入草稿，不上传不复制 | **不转换**，模型用工具自取 | 零拷贝、零上传、对工作区文件最轻量；芯片 + 免打字直接发送 | 只适用于本机可解析路径的文件；PDF/Office 只是路径——文本模型读不了 PDF，等于"引用了打不开的文件"；无任何格式转换/限额/索引 |
| [l541402398/dsh-file-uploads](https://github.com/l541402398/dsh-file-uploads) | Files 按钮 → 任意文件上传到 `$DSH_HOME/uploads` → 提交时把**容器绝对路径**注入提示词 | 不转换 | 上传管理齐全（设置页列表/下载/删除/配额/防覆盖）；输入框干净 | 路径在**工作区外**（沙箱收紧时模型读不到）；同样不解决"PDF 文本模型不可读"；无分级、无出处坐标 |
| [omdsh-dev/dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | 输入框 `@` 搜索工作区路径 → 插入 `<workspace-reference>` 引用 | 不转换 | Codex 式引用体验、路径选择器做得好 | 仅限工作区内文件；引用后仍需模型自寻工具，PDF 依旧无解 |
| [Jesse-njx/dsh-cowork](https://github.com/Jesse-njx/dsh-cowork) | 给**模型**提供 `doc_read`/`doc_write` 工具（xlsx/pdf/docx/pptx/ipynb，cell 寻址） | 工具层按需读 | 与附件 UX 正交、可组合；分块读取专业 | 不是"附件输入"；用户必须先把文件放进工作区；与拖拽体验无关 |
| [HuanLinOTO/dsh-plugin-mineru](https://github.com/HuanLinOTO/dsh-plugin-mineru) | 暴露 MinerU 文档解析工具 | 重解析（OCR/公式/表格） | 解析质量高（v3 的候选后端） | 需要 MinerU 服务/依赖；工具层而非附件 UX |
| **本插件 dsh-attachment-formats** | 按钮/拖放/粘贴 → 浏览器取字节 → 主机端转换 → 图片走原生草稿栏、文本分级（直插/转存+索引卡） | **转换 + 分级**：PDF 文字层/Office 提取/长文本落盘索引卡/扫描件页图 | 见 §3 |

## 2. Codex / Claude 生态（思路对标，非 DSH 框架）

| 项目 | 机制 | 优点 | 缺点 |
| --- | --- | --- | --- |
| [neoncapy/doc2md](https://github.com/neoncapy/doc2md)（Claude Code） | Python 流水线：marker/docling/pymupdf4llm/MinerU 多抽取器 + 质量门回退 + 图片提取去重 + 可选 LLM 图片描述 + SHA-256 转换注册表 | **保真度天花板**：表格/标题/图都保留，扫描件有 OCR 路由，质量门控 | 重量级（Python + 多抽取器 + LibreOffice/pdftoppm），CLI/skill 工作流而非 GUI 附件体验；转换成本高（可选 LLM 描述还花 token） |
| [jseook11/codex-pdf-ocr-to-markdown-skill](https://github.com/jseook11/codex-pdf-ocr-to-markdown-skill) | PDF/图片 → `_ocr.md` 侧车文件 + 质量报告；页面路由 `text_only` / `visual_focus` / `verify_text_and_visual` / `full_vision_ocr` | 有文本层时零 OCR 开销、按需视觉复核的路由思想与我们一致；保留源文件 | Python 依赖 + 手动安装脚本；产生"旁路文件"污染目录；agent 驱动而非拖放 UX |
| [mcp-server-anydoc](https://www.npmjs.com/package/mcp-server-anydoc) | MCP 服务器解析任意文档 | 与任何 MCP 客户端组合 | 仅解析层；需要另配 MCP 接入与附件入口 |

## 3. 本插件相对它们的取舍

**强于生态内所有对标品的地方：**

1. **文本模型可用性**（用户当前实际处境）：DeepSeek 文本路线拒收图片，
   拖一个 PDF 只给路径/只转图都是死路；本插件 PDF 文字层提取是唯一让
   长文档在纯文本模型下真正可读的 DSH 方案。
2. **永不静默截断**：80k 字符分级 + 自适应上下文余量 + 索引卡 + 复用 DSH 原生 read 工具分页，
   出处坐标（行号/页码标记）在生态内独一份；路径派插件对"读多读少"完全
   不设防（模型可能一次性狂读或干脆跳过）。
3. **任意来源文件**：桌面/下载目录的文件直接可用；路径派插件只覆盖本机
   可解析路径，file-uploads 上传后路径在工作区外。
4. **零外部依赖开箱**：纯 Node（pdfjs/@napi-rs/canvas/mammoth/exceljs/jszip），
   无需 Python/poppler/tesseract/MinerU 服务；`sharp`/`canvas` 已为 optionalDependencies，按需加载。
5. **批量混合 + 内容寻址缓存 + 7 天清理 + 缓存管理页**：同文件重复拖入复用转换结果；设置页 `附件缓存` 支持按工作区分域、跨会话共享、过期自清。

**弱于对标品的地方（诚实清单，v0.10 后更新）：**

1. **OCR 质量已追平第一梯队**：内置 `tesseract.js`（置信度 45 门控）+ 8 家云 OCR（百度/阿里/腾讯/Azure/火山/DeepSeek Vision/通用 VLM）可配置，失败回退页面图；复杂表格仍可走外部 `doc-server`（Paddle/MinerU/Marker）。
2. **版式保真度**：已接 `pymupdf4llm`（≤40 页高保真，41-160 页按向量密度自适应，表格/标题保留）+ `mammoth→turndown+GFM` 表格管线；marker/docling/MinerU 仍可作为外部 doc-server 扩展。
3. **上传管理已补齐**：v0.6 起提供设置页缓存列表/删除/清空 + `.gitignore` 托管 + `/api/attach-formats/doctor` 自检；file-uploads 的配额/下载在 DSH 原生 `attachments/v1` 轨道上更强。
4. **字节上传成本已部分缓解**：大文件（≤64MB）走 base64 上传 + Worker 编码 + 进度条；512KB-16MB 文本可走零拷贝 `name+size+SHA-256` 同源引用，命中则不上传。
5. **单框架绑定**：只服务 DSH Web；doc2md/MCP 类可跨工具复用。

## 4. 结论：没有完全的同类，我们是"输入体验"与"文本模型可用性"的交集

- 路径派（drag-and-drop / at-file / file-uploads）：赢了"零拷贝"，输了
  "内容可用性"（尤其 PDF × 文本模型）。
- 转换派（doc2md / codex-pdf-skill / mineru / cowork）：赢了"保真度/
  OCR"，输了"零依赖、拖放即用、文本模型直读"。
- 本插件占了中间：拖放即用 + 文本优先分级 + 原生工具分页读取；v3 已把
  pymupdf4llm 接进缓存层（高保真）并内置 tesseract.js OCR，MinerU 等更强
  后端仍可作为可插拔扩展继续接入。
