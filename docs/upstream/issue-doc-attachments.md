# 上游 Issue 草案：文档型附件（doc-attachments）服务，避免插件重复造 spill 轨道

- **目标仓库**：`deepseek-ai/dsh`
- **类型**：enhancement（基础设施 / 公共能力）
- **状态**：草案，待以本人 GitHub 账号提交

## 背景（English）

Several third-party plugins need to attach **documents** (PDF, docx, xlsx, pptx,
long text, images) to the composer. Each one ends up re-implementing the same
"spill to indexed card when too large" rail because the host only provides a
**native image** AttachmentStore (`AttachmentStoreKind.Native`):

- canonical encoding of the attachment block (`[附件: name]\n<doc>` vs
  `[图片: name]\n<image_ref>`);
- the "index card + detail" pattern (short summary inline, full content via
  dedicated view) to keep KV-cache pressure bounded;
- zero-copy transfer of large page-image arrays into the model turn;
- lifecycle / cache / "already indexed" dedup.

`dsh-attachment-formats` implemented all of the above and confirmed it works
against dsh v0.1.0 / rc.2. But every new document plugin will rebuild the same
rail — a small, stable host primitive would remove that duplication.

## 提案（English）

Add a document attachment primitive to the host (name TBD, e.g.
`AttachmentStoreKind.Doc` or a `docAttachments` service) that provides:

1. A canonical, documented block encoding for documents (decoupled from the
   image-only `[图片]` form), so different plugins produce byte-identical blocks.
2. A host-rendered "index card + detail" UI for attachments that exceed a
   configurable size/cache budget — plugin supplies the summary + a content
   handle, host renders the card.
3. A zero-copy handoff for large image arrays (already proven via
   `createDraftImages` + `addImages`) exposed for document-derived images.
4. Lifecycle hooks: dedup by content hash, cache location under a single
   `DSH_HOME` root, and an "already indexed" fast path.

Plugins keep full freedom for *how* they produce the document text/ocr; the host
only owns the *transport + presentation* rail.

## 中文摘要

多个第三方插件都需要把**文档**（PDF/docx/xlsx/pptx/长文本/图片）塞进 composer，
但宿主目前只有**原生图片**一种 AttachmentStore，于是每个插件都不得不重复实现
同一套"过大就降级为索引卡"的轨道——规范化编码块、索引卡+详情模式、大图零拷贝
投喂、生命周期/缓存/去重。`dsh-attachment-formats` 已完整实现并验证可用，但
每个新文档插件都会重造一遍。建议宿主新增一个**文档型附件原语**（名称待定，如
`AttachmentStoreKind.Doc` 或 `docAttachments` 服务），统一托管"传输 + 呈现"轨道，
插件只负责如何产出文档文本/OCR，宿主负责规范化编码、索引卡渲染、大图零拷贝、
缓存与去重。

## 现有实现可复用的经验（English）

- `classifyFile` + canonical block encoding (`[附件: name]\n...`) already shipped
  and battle-tested in this plugin's `src/client/contract.js` / `intake.js`.
- `createDraftImages` / `addImages` zero-copy path proven for page-image arrays.
- Index-card pattern keeps KV-cache pressure bounded; worth making a host default.

## 影响面 / 风险（English）

- Purely additive; existing native-image attachments unchanged.
- Host owns rendering → consistent UX across document plugins.
- Plugins retain OCR/parser choice; no lock-in.

## 验证方式（English）

1. A doc plugin registers via the new primitive with only a `toText`/`toImages`
   provider.
2. Host renders the index card + detail without plugin-specific UI code.
3. Large documents spill to index cards automatically at the configured budget.

---

> 提交前自检：先确认上游是否已有类似 RFC（搜索 "doc attachment" / "AttachmentStore
> Doc"）。若有则改为补充本插件实测经验到其讨论，而非开新 issue。
