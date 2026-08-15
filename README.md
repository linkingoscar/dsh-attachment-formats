# dsh-attachment-formats — Attachment Format Expansion (Codex-style)

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.6.4-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--attachment--formats-181717)](https://github.com/linkingoscar/dsh-attachment-formats)

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web plugin that
makes the composer accept many more attachment formats, Codex-style. Zero core-package
changes: a pure plugin that reuses the harness-native image draft rail, upload limits,
history rendering and model request pipeline.

## Supported formats

| File | Handling | Destination |
| --- | --- | --- |
| PNG / JPEG / WebP / GIF | native pipeline (plugin not involved) | image draft rail (native) |
| **PDF (with text layer)** | text-layer extraction (≤40 pages via the pymupdf4llm high-fidelity engine; larger/unavailable falls back to pdfjs) | full text on a **document card** (merged on send); over-limit → workspace spill + index card |
| **PDF (scanned / no text layer)** | tesseract.js OCR (accepted only at confidence ≥45), falls back to page images | OCR success → text channel; failure → image draft rail (vision models only) |
| **Word (.docx) / Excel (.xlsx) / PPT (.pptx)** | text extraction — docx via mammoth HTML → turndown, **tables kept as Markdown pipe tables** | document card (merged on send); over-limit → spill + index card |
| **Legacy .doc / .xls / .ppt** | LibreOffice headless → docx/xlsx/pptx → standard Office pipeline (needs `soffice`; clear error when absent) | document card (merged on send) |
| **epub / odt / rtf** | pandoc → Markdown (probe on PATH); epub/odt fall back to jszip+turndown without pandoc; rtf requires pandoc | document card (merged on send) |
| **TIFF (.tiff/.tif)** | sharp (libvips) → PNG pages (multi-page, ≤20) | native image draft rail |
| txt / md / json / code | read in the browser (UTF-8, GB18030 fallback) | document card (merged on send); over-limit → spill + index card |
| BMP / ICO / AVIF / SVG etc. | browser decode → canvas → PNG | native image draft rail |
| iWork / audio-video / archives | — (not yet supported; explicit notice, skipped) | — |

## Document cards (Codex-style mounting, composer stays clean)

Text-like attachments that are dragged in or picked are **not stuffed into the input
box**: their content mounts as a **document card** above the composer (file name +
character count + full-text/index label, individually removable), while images keep
flowing into the native image draft rail. You type normally, and **at the moment of
sending** the plugin merges the card content into the message (with
`[attachment: <file name>]` provenance markers) before the native submit — your prompt
always stays on top and no content is lost:

- each card has a **send** button: send documents even without typing anything;
- pressing Enter / the native send button merges the cards first, then submits;
- cards are not merged while the model is mid-reply (they stay put for later).

## Long documents (index-card mode, never silently truncated)

Text beyond 80k characters and long multi-page PDFs are **not stuffed into the message**.
Instead:

1. the host spills them into the session workspace `.dsh-attachments/<sha-16>/`
   (content-addressed, reused on re-drop, auto-cleaned after ~7 days of no access):
   - `doc.md` — PDF text layer assembled per page (leading `<!-- pN -->` markers),
     Office-extracted text, long text as-is (long JSON is prettified to `doc.json`);
   - `pages/pNN.png` — rendered page images (≤100 pages, for vision models via
     `read_image`; rendered lazily, only when the index-card path needs them);
   - `manifest.json` — source, page/line/char counts, engine, full source SHA-256
     and the converter-policy fingerprint (engine/OCR/doc-server switches invalidate
     the cache automatically);
   - `INDEX.md` (cache root) — the aggregated list of every spilled document in this
     workspace.
2. the message carries only a few-hundred-token **index card**: page/line/char counts,
   an outline (PDF heading heuristics, md headings, JSON first-level key tree) and
   reading pointers.
3. the model reads page-by-page with the stock `read` tool (offset/limit, line numbers
   as coordinates) — full summaries read through (no dropped tails), targeted lookups
   jump by outline; missing content is an explicit tool failure, never silent loss.

Design rationale and evidence: `docs/design-longdoc.md`; comparison with similar work:
`docs/alternatives.md`. Upgrades for current limitations (researched GitHub solutions
and v0.6 roadmap): `docs/upgrade-v6.md`.

## Engines & OCR (v3)

- **PDF text engine**: `auto` (default) → the venv's pymupdf4llm for ≤40 pages
  (high-fidelity tables/headings); pdfjs (seconds) for larger documents or when the
  venv is missing. Env: `DSH_ATTACH_ENGINE=auto|python|builtin`.
- **Scanned-PDF OCR**: python (PyMuPDF, needs system tesseract) → tesseract.js (pure JS;
  first use downloads the ~24MB eng/chi_sim language data into `vendor/tessdata/`).
  Confidence below 45 falls back to page images with a clear reason. Env:
  `DSH_ATTACH_OCR=auto|baidu|tesseract-js|off` (see below).

## Fidelity & format coverage

- **DOCX tables**: mammoth HTML → turndown + GFM plugin — tables survive as Markdown
  pipe tables (replaces the old cell-by-cell reading order).
- **TIFF**: decoded by sharp (libvips prebuilt binary) into PNG pages, multi-page
  supported (≤20 pages per file).
- **epub / odt / rtf**: pandoc (probed on PATH) converts to Markdown; without pandoc,
  epub/odt fall back to in-process jszip + turndown, rtf reports a clear install hint.
- **Legacy .doc / .xls / .ppt**: LibreOffice headless (`soffice`, probed on PATH plus
  the usual Windows install locations) converts to the modern OOXML format first, then
  the standard Office pipeline runs. Each run uses an isolated `UserInstallation`
  profile to avoid lock conflicts.
- **PDF outlines**: bookmark TOCs (`get_toc` / pdfjs `getOutline`) now feed the index
  card's outline first; the font-size heuristic is only the fallback. Empty-bookmark
  PDFs are unaffected.

## Cloud OCR & content-adaptive engine (zero new heavyweight deps)

- **Baidu OCR API** (preferred scanned-PDF OCR, free tier: 1,000 calls/month for
  personal accounts / 2,000 for enterprise on both 标准版 and 高精度版, per the
  official free-quota page): pages are sent as JPEG via plain HTTPS — no new
  dependencies. Configure via env:
  - `BAIDU_OCR_API_KEY` / `BAIDU_OCR_SECRET` (console → 文字识别 → create app);
  - `DSH_ATTACH_OCR=auto|baidu|tesseract-js|off` (auto = Baidu when credentials
    exist, else local tesseract.js);
  - `DSH_ATTACH_OCR_ACCURATE=1` for the high-accuracy endpoint (separate free
    quota).
  Quota exhausted / API failure → automatic fallback to local tesseract.js with a
  note; forced `baidu` mode reports the reason instead.
- **Remote VLM OCR** (optional, token-billed): `DSH_ATTACH_VLM_BASE` /
  `DSH_ATTACH_VLM_MODEL` (+ optional `DSH_ATTACH_VLM_KEY`) point at any
  OpenAI-compatible vision endpoint (olmOCR-2, GLM-4V, Qwen-VL…). Pages are
  transcribed one by one via chat/completions. OCR chain: Baidu → VLM →
  tesseract.js (or force with `DSH_ATTACH_OCR=vlm`).
- **Content-adaptive PDF engine**: documents of 41–160 pages now let the Python
  engine decide by vector density (sampled `get_drawings`) — text-heavy manuals
  skip the slow high-fidelity pass and go straight to the fast pdfjs engine, while
  table/graphic-heavy documents still get pymupdf4llm. ≤40 pages are unchanged.

## External doc server, cache page & workspace zero-copy

- **External document parser** (optional): `DSH_ATTACH_DOC_SERVER=<base URL>`
  points at a parser service (PP-StructureV3 `paddleocr serve`, MinerU, or any
  shim). Contract: `POST {base}/convert` with multipart field `file` →
  `{ "ok": true, "markdown": "..." }`. When configured, PDFs go to the server
  first; any failure falls through to the local engine chain.
- **Attachment cache settings page**: Settings → 附件缓存 lists every spilled
  document (size/engine/time) with per-item delete and clear-all, backed by
  `GET /api/attach-formats/cache` + `POST .../cache/delete` + `POST .../cache/clear`.
- **Workspace zero-copy**: text files between 512KB and 16MB are first resolved
  against the session workspace: the browser reads the file locally to compute its
  full SHA-256, then `GET /api/attach-formats/resolve` asks the host to confirm a
  same-source file by **name + size + full SHA-256** (bounded ~2.5s walk skipping
  dependency dirs). A hit mounts a 📎 reference card — the **content is not
  uploaded** (only the name, size and hash are sent); the model reads the path with
  its `read` tool. A miss falls back to the normal upload pipeline. Files over 16MB
  are rejected outright (no zero-copy attempt).

## Context adaptation & full-text command (v2b)

- **Adaptive merge limit**: the client reads the token-meter `contextPressure` projection
  (model context window × current usage); the full-text merge limit becomes
  min(80k chars, headroom × 1.5) — when headroom is short, the card automatically turns
  into an index card with a status-bar note, so merged content can never blow up the
  context and get silently truncated by the API. A missing projection falls back to the
  fixed 80k threshold.
- **`/attach` command** (composer slash menu, host-registered):
  - `/attach list` — list the spilled documents in this workspace (id/name/size/engine);
  - `/attach full <id|name>` — merge the full text into model context as a next-step
    message (**takes effect on the next message**, current turn untouched); 300k-char cap
    with an explicit truncation notice — never silent loss. `read` still works afterwards
    for line-precise lookup.

## Interactions

- **Paperclip button**: composer tool row (`conversation.input.left`), opens a
  multi-select file picker whose `accept` list covers every format in the table above.
- **Drag & drop**: drop a PDF / Office / text file anywhere on the page.
- **Paste**: copy a file and Ctrl+V into the composer (or the whole page).

Native image drag/paste stays on the harness built-in pipeline; when a single drop mixes
other formats in, the plugin takes over the whole batch (converts first, then hands the
produced images back to the built-in draft rail as a "synthetic drop").

## Architecture

```
dsh-attachment-formats/
├── lib/
│   ├── index.js          # host half: POST /api/attach-formats/convert + engine routing
│   ├── client.js         # browser half: button/drop interception/synthetic drop/text injection/status bar
│   ├── cache.js          # workspace .dsh-attachments spill/manifest/INDEX.md/cleanup
│   ├── py/pymupdf4llm_convert.py  # venv high-fidelity engine (subprocess call)
│   └── convert/
│       ├── util.js       # magic-byte sniffing (pdf/tiff/OLE/rtf/zip), base64, truncation
│       ├── provider.js   # engine/binary detection (venv python, pandoc, LibreOffice) + subprocess bridges
│       ├── pdftext.js    # pdfjs text-layer extraction: line assembly/header-footer dedup/bookmark TOC
│       ├── outline.js    # md heading outline, JSON first-level key tree
│       ├── ocr.js        # tesseract.js OCR (traineddata download cache/confidence)
│       ├── pdf.js        # pdfjs-dist + @napi-rs/canvas → PNG/JPEG pages
│       ├── docx.js       # mammoth HTML → turndown+GFM → Markdown (tables preserved)
│       ├── xlsx.js       # exceljs → tab-separated text
│       ├── pptx.js       # jszip + a:t text runs → per-slide text
│       ├── tiff.js       # sharp (libvips) → PNG pages
│       ├── pandoc.js     # pandoc → Markdown + epub/odt zip fallback
│       └── libreoffice.js # legacy .doc/.xls/.ppt → modern OOXML
├── .venv/                # (optional) pymupdf4llm engine (generated by setup, not committed)
├── vendor/tessdata/      # OCR language-data cache (downloaded on first use, not committed)
├── docs/                 # design-longdoc.md / alternatives.md / upgrade-v6.md
├── scripts/smoke-*.mjs   # five offline smoke suites (converters/router/client/OCR/P0)
└── cordis.patch.yml
```

- The host route re-sniffs magic bytes and never trusts the client-declared kind; 160MB
  request cap and 64MB per-file cap; `cwd` is read by the client from session state and
  sent with the request (it decides where the spill lands).
- Tiered thresholds: full-text merge cap 80k chars (v2b lowers it adaptively by context
  headroom); spill page images ≤100 pages (1100px wide; PNG over the per-image byte
  budget falls back to JPEG); scanned-page image cap follows the deployment limit; OCR
  ≤20 pages per run (2000px wide), confidence <45 falls back to page images.
- Document-card content is merged into the React controlled input through a DOM event
  bridge at send time (same path as the native submit); the image path is fully
  independent and untouched.
- Conversion progress/errors show in a temporary status bar above the composer
  (`conversation.input.dock`); success auto-hides after 6s, errors can be dismissed.

## Installation

From GitHub (recommended):

```powershell
dsh plugin --profile web add github:linkingoscar/dsh-attachment-formats
```

Local development:

```powershell
cd path\to\dsh-attachment-formats
npm install            # host dependencies (first time)
# optional: high-fidelity PDF engine (pymupdf4llm, self-contained venv)
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install pymupdf4llm
npm run smoke          # offline smoke tests (optional)
dsh plugin --profile web add link:path\to\dsh-attachment-formats
```

Restart `dsh web` (close the page → the desktop shortcut auto-restarts, or re-run
`dsh web`) and refresh the browser. OCR language data downloads automatically on the
first scanned-PDF recognition (≈24MB, cached in `vendor/tessdata/`, offline-ready
afterwards).

## Known limitations

- OCR (tesseract.js) quality is limited on low-resolution scans and complex tables;
  insufficient confidence falls back to page images with an explicit note — garbled text
  is never injected. Higher-quality OCR (RapidOCR/MinerU/PaddleOCR) can be added as
  pluggable backends later (see `docs/upgrade-v6.md`).
- The pymupdf4llm high-fidelity engine handles ≤40-page PDFs only (larger documents use
  the fast pdfjs engine); table/formula reconstruction is good but not typesetting-grade
  — layout details can be cross-checked against page images.
- Scanned PDFs without a text layer can only go the page-image route when OCR is
  unavailable or fails (vision models can read them).
- Legacy `.doc/.xls/.ppt` require LibreOffice (`soffice`); `rtf` requires pandoc;
  `epub/odt` work out of the box but pandoc (if installed) gives better fidelity.
  Missing binaries produce clear, actionable errors — nothing is silently dropped.
- DOCX formulas and embedded images are not extracted (tables, headings and text are).
- XLSX outputs displayed text/results only; charts and comments are not extracted.
- Outlines prefer bookmark TOCs; PDFs without bookmarks fall back to font-size
  heuristics (weak on documents without strong heading styling) — the index card still
  carries line/page counts and reading pointers.
- iWork and archives are not converted yet.
- Attachments are attributed to the shell's **current conversation** (the one being
  viewed). Text/document cards therefore land in the dialog you are looking at.
  Converted page images go through the harness's native drop pipeline: if the current
  conversation is mid-reply it temporarily refuses drops, so the plugin waits for it
  to become idle before feeding the images. With several conversations open at once,
  other *idle* conversations may also accept that same synthetic drop — a harness-level
  behavior the plugin cannot scope; prefer attaching images with a single conversation
  open (text/code files are unaffected: they always stay in the current dialog).
- The "merge on send" for document cards bridges into the React controlled input over
  DOM events — an adaptation to an unpublished harness API; if a core upgrade breaks it,
  the symptom is "card content didn't enter the message", and the card's **send** button
  is the fallback (synthetic Enter path). The image path is never affected.

## Releases

- **[v0.6.4](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.4)**
  (latest) — session-correct attachments & verified zero-copy: attachments now
  attribute to the shell's current conversation (no more cards/images landing in
  another dialog); converted images wait for the current conversation to become
  idle before the synthetic drop; workspace zero-copy is confirmed by name + size +
  full SHA-256 (no silent substitution), >16MB is rejected outright; INDEX.md cells
  are escaped, INDEX rebuilds are serialized per workspace, cache hits keep the
  source-count fields, legacy-Office manifests carry the `libreoffice+builtin`
  engine label.
- **[v0.6.3](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.3)**
  — cache lifecycle hardening: v0.6.1 8-hex cache dirs are now swept by
  cleanup/clear (no invisible orphans), JSON spill keeps source vs artifact sizes
  separate (tiering uses the spilled `doc.*` size), page images materialize lazily
  when a cache hit downgrades to index mode, INDEX.md is fully rebuilt from live
  manifests (no ghost rows, populated timestamps), legacy `.doc/.xls/.ppt` cache
  keys use the original OLE bytes so hits skip LibreOffice, atomic manifest/INDEX
  writes.
- **[v0.6.2](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.2)**
  — cache correctness & fast path: 16-hex cache ids with full SHA-256 in the
  manifest, converter-policy fingerprint (engine/OCR/doc-server switches invalidate
  the cache), index cards rebuilt from structured metadata on every hit (no filename
  bleed-through), TTL counts model `read` access via file atime, page images rendered
  lazily (clean small PDFs skip rasterization), 2–16 MB text files reach the host
  spill instead of being rejected, React key warnings eliminated, Node >=20, CI
  actions upgraded to v7.
- **[v0.6.1](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.1)**
  — correctness & engineering fixes: attachment-dock crash fix (`useCallback`
  reference), converters no longer pre-truncate (never-silent-truncation restored
  end-to-end), session-derived workspace authority for all routes, XLSX empty-column
  coordinate fix, true conversion cache keyed by source hash, cache TTL based on last
  access, verified merge into the composer draft; added ESLint, CI (Node 20/22) and
  component-level smoke tests.
- **[v0.6.0](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.6.0)**
  — fidelity & format coverage (DOCX tables, TIFF, epub/odt/rtf, legacy
  Office, PDF bookmark outlines), Baidu OCR API + remote VLM OCR + external doc
  server, content-adaptive engine, attachment cache settings page, workspace
  zero-copy references.
- **[v0.5.0](https://github.com/linkingoscar/dsh-attachment-formats/releases/tag/v0.5.0)**
  — document cards, index-card spill, `/attach list|full`, adaptive merge limit,
  pymupdf4llm/pdfjs engines, tesseract.js OCR.

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)
