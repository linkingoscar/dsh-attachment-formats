/**
 * dsh-attachment-formats — host half.
 *
 * POST /api/attach-formats/convert
 *
 *   body: {
 *     cwd: "<客户端上报的工作区，仅作 hint/日志>",  // 路径权威来自 sessionId
 *     sessionId: "<会话 id>",                     // host 由此解析 session.header.cwd
 *     files: [
 *       { name: "报告.pdf", kind: "pdf", data: "<base64>" },
 *       { name: "长文档.md", kind: "text-cache", data: "<base64>" },
 *       ...
 *     ]
 *   }
 *
 *   resp: { ok: true, results: [ <result> ] }，result 三种形态：
 *
 *   - { input, kind: "images", images: [...], warnings: [...] }
 *     图片结果（扫描件无 OCR 时的回退），沿用 v1 语义；
 *   - { input, kind: "text", text }
 *     文本结果（≤ 直插阈值），客户端直接注入草稿；
 *   - { input, kind: "index", card, docPath, pageCount, lineCount, charCount }
 *     大型文档：文本已落盘工作区 .dsh-attachments/<sha-16>/doc.md（+ 页面 PNG
 *     与 manifest.json、聚合 INDEX.md），card 为注入草稿的索引卡。
 *
 * 引擎（v3，env 可覆盖，见 convert/provider.js）：
 *   PDF 文本层：auto → python(pymupdf4llm，venv 可用时) → builtin(pdfjs)；
 *   扫描件 OCR：python(PyMuPDF+tesseract) → tesseract.js → 页面图回退。
 *
 * v2b：
 *   - `/attach list` 列出已转存文档；`/attach full <id|名称>` 把全文作为
 *     next-step 收件箱消息并入模型上下文（用户下一条消息生效）；
 *   - `directLimitChars`：客户端按 token-meter 上下文余量计算的直插上限，
 *     主机端用 min(8 万, 该值) 分流，杜绝直插顶爆上下文被 API 静默截尾。
 */
import { probePdfPageCount, renderPdfPages } from "./convert/pdf.js";
import { extractPdfText } from "./convert/pdftext.js";
import { docxToText } from "./convert/docx.js";
import { xlsxToText } from "./convert/xlsx.js";
import { pptxToText } from "./convert/pptx.js";
import { jsonTree, mdOutline } from "./convert/outline.js";
import { enginePolicy, enginePolicyWithSettings, probeLibreOffice, probePandoc, probePythonEngine, runPythonPdf } from "./convert/provider.js";
import { OCR_PAGE_CAP } from "./convert/ocr.js";
import { runOcrChain } from "./convert/ocr-registry.js";
import { docServerConvert } from "./convert/doc-server.js";
import { tiffToPngPages } from "./convert/tiff.js";
import { convertPandocFormat } from "./convert/pandoc.js";
import { libreOfficeConvert } from "./convert/libreoffice.js";
import {
  cacheSize, checkGitignore, cleanupCache, clearCache, ensureCacheMigrated, listCachedDocs, readCachedDoc,
  readCachedTextIfValid, removeCachedDocs, resolveCacheRoot, resolveWorkspaceFile,
  sha256Of, shortHashOf, touchCachedDoc, patchCachedManifest, writeCache,
  CACHE_SCHEMA_VERSION
} from "./cache.js";
import {
  b64decode, b64encode, baseNameOf, extensionOf,
  FALLBACK_IMAGE_LIMITS, imageLimitsOf, MAX_FILE_BYTES, renderByteBudgetOf, sniffKind
} from "./convert/util.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = require("../package.json").version;

const name = "dsh-attachment-formats";
const inject = ["webServer", "commands", "connection"];

/** 读设置页的缓存选址（home=DSH_HOME 默认 / workspace=工作区 opt-in）；失败回退 home。 */
async function cacheLocationOf(cwd, ctx) {
  try {
    const { loadCacheLocation } = await import("./settings.js");
    return await loadCacheLocation(cwd, ctx);
  } catch {
    return "home";
  }
}

/** 尝试注册官方 settings 缝（静默回退文件存储）。 */
async function ensureOfficialSettings(ctx) {
  try {
    const { registerOfficialSettings } = await import("./settings.js");
    await registerOfficialSettings(ctx);
  } catch {}
}

// ---- 转换进度 job 表（内存态；客户端轮询，响应后即焚）---------------------
const progressJobs = new Map();
const PROGRESS_JOB_TTL_MS = 120_000;
function progressCreate(jobId) {
  if (typeof jobId !== "string" || jobId === "" || jobId.length > 64) return null;
  const job = { phase: "starting", label: "", done: 0, total: 0, updatedAt: Date.now() };
  progressJobs.set(jobId, job);
  return job;
}
function progressSweep() {
  const now = Date.now();
  for (const [id, job] of progressJobs) {
    if (now - job.updatedAt > PROGRESS_JOB_TTL_MS) progressJobs.delete(id);
  }
}
function progressUpdate(job, phase, label, done, total) {
  if (job === null) return;
  job.phase = phase;
  if (label !== undefined) job.label = label;
  if (done !== undefined) job.done = done;
  if (total !== undefined) job.total = total;
  job.updatedAt = Date.now();
}

const ROUTE_PATH = "/api/attach-formats/convert";
/** Hard cap on the JSON request body (base64 inflates raw bytes by ~4/3). */
const MAX_BODY_BYTES = 160 * 1024 * 1024;
/** 直插草稿的文本上限；超过则走索引卡模式（v2b：上下文余量可进一步压低）。 */
const DIRECT_TEXT_CHARS = 80_000;
/** directLimitChars 的合法下界（过低一律视为无效，回退默认）。 */
const DIRECT_LIMIT_MIN = 4_000;
/** `/attach full` 并入上下文的最大字符数（超出显式截断，绝不静默）。 */
const FULL_EXPAND_CHARS = 300_000;
/** 缓存页图的最大页数（文本层不受此限）。 */
const CACHE_PNG_PAGE_CAP = 100;
/** 缓存页图渲染宽度（视觉补充，不需要高分辨率）。 */
const CACHE_PNG_WIDTH = 1100;
/** OCR 置信度门控：低于此值视为识别失败（回退页面图），避免注入乱码文本。 */
const OCR_MIN_CONFIDENCE = 45;
/** OCR 页图渲染宽度（识别精度需要更高分辨率）。 */
const OCR_PNG_WIDTH = 2000;
/** python 引擎的尝试上限：≤40 页无条件高保真；40-160 页由 python 按内容复杂度（向量密度）自行决定是否让位给 pdfjs。 */
const PYTHON_ATTEMPT_LIMIT = 160;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Reuse the host's launch-token/Host/Origin policy when the alpha API exposes it. */
function rejectUnauthorizedRequest(ctx, req, res) {
  let connection;
  try {
    connection = ctx.connection ?? ctx.get?.("connection");
  } catch {
    connection = undefined;
  }
  if (typeof connection?.requestRejection !== "function") return false;
  const status = connection.requestRejection(req);
  if (status === undefined) return false;
  sendJson(res, status, { ok: false, error: { code: status === 401 ? "unauthorized" : "forbidden", message: "请求未通过 Harness 连接认证" } });
  return true;
}

/** Read the request body up to `cap` bytes; rejects beyond the cap. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        done = true;
        reject(new Error(`请求体超过上限 ${Math.round(cap / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function fail(code, message) {
  return { kind: "error", error: { code, message } };
}

function formatCount(count) {
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)} 万`;
  return String(count);
}

/** 从提取文本中识别分节行（工作表/幻灯片标题）作为大纲。 */
function sectionOutline(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*\[(工作表|幻灯片)[^\]]*\]\s*$/.exec(lines[i]);
    if (match !== null) entries.push({ line: i + 1, text: match[0].trim() });
  }
  return entries;
}

/** 组装注入草稿的索引卡（几百 token 量级）。 */
function buildIndexCard({
  input, base, docFile, pageCount, lineCount, charCount,
  outline = [], tree = null, hasPageImages = false, notes = [], aggregateIndex = true
}) {
  const lines = [
    `[附件索引: ${input}]`,
    `- 文档已转存: ${base}/${docFile}（${pageCount > 0 ? `${pageCount} 页 / ` : ""}${formatCount(charCount)} 字符 / ${formatCount(lineCount)} 行）`,
    `- 读取方式: 用 read 工具分页读取（offset/limit，行号即出处坐标）；需要全文时逐段读完即可，不会丢尾部`
  ];
  if (hasPageImages) {
    lines.push(`- 页面图: ${base}/pages/pNN.png，需要看版式/图表时用 read_image 读取（仅视觉模型可用）`);
  }
  if (aggregateIndex) {
    lines.push(`- 缓存清单: ${base}/../INDEX.md（本工作区全部已转存文档）`);
  }
  if (tree !== null) {
    const parts = [];
    for (const child of tree.children ?? []) parts.push(`${child.key}(${child.summary})`);
    lines.push(`- JSON 结构: ${tree.type}${parts.length > 0 ? ` — ${parts.slice(0, 24).join(", ")}${parts.length > 24 ? ", …" : ""}` : ""}`);
  }
  if (outline.length > 0) {
    const items = outline.slice(0, 18).map((entry) => (typeof entry.line === "number" ? `L${entry.line} ${entry.text}` : entry.text));
    lines.push(`- 大纲: ${items.join(" · ")}${outline.length > 18 ? " · …" : ""}`);
  }
  for (const note of notes) lines.push(`- 注意: ${note}`);
  return lines.join("\n");
}

/** 大纲条目统一为 { line?, text }，便于 manifest 结构化存储与命中后重建卡片。 */
function normalizeOutline(outline) {
  return (Array.isArray(outline) ? outline : []).map((entry) => (
    typeof entry === "string"
      ? { text: entry }
      : { line: Number.isFinite(entry?.line) ? entry.line : undefined, text: String(entry?.text ?? "") }
  ));
}

/**
 * 转换策略指纹（缓存键的一部分）：引擎/OCR/doc-server 配置或外部二进制
 * 可用性变化时指纹随之变化，旧缓存自动失效、重新走当前引擎——绝不
 * 让"昨天的 tesseract 结果"挡住"今天配好的 VLM"。不写入任何密钥本身，
 * 只写是否配置/模型名等非敏感摘要。
 */
function policySummary(policy) {
  return {
    engine: policy.engine,
    ocr: policy.ocr,
    baidu: policy.baidu.apiKey !== "" && policy.baidu.secretKey !== ""
      ? (policy.baidu.accurate ? "baidu-accurate" : "baidu")
      : "off",
    aliyun: policy.aliyun?.appCode ? "aliyun" : "off",
    tencent: policy.tencent?.secretId && policy.tencent?.secretKey ? "tencent" : "off",
    azure: policy.azure?.apiKey && policy.azure?.endpoint ? "azure" : "off",
    volc: policy.volc?.appCode ? "volc" : "off",
    deepseek: policy.deepseek?.key || policy.vlm?.key ? "deepseek" : "off",
    vlm: policy.vlm.configured ? `vlm:${policy.vlm.model}` : "off",
    docServer: policy.docServer ?? "off"
  };
}
async function converterFingerprint(kind) {
  const components = [CACHE_SCHEMA_VERSION, PLUGIN_VERSION, kind];
  if (kind === "pdf") {
    const policy = enginePolicy();
    components.push(
      JSON.stringify(policySummary(policy)),
      `python:${policy.engine !== "builtin" && await probePythonEngine().catch(() => false)}`
    );
  } else if (kind === "epub" || kind === "odt" || kind === "rtf") {
    components.push(`pandoc:${(await probePandoc().catch(() => null)) !== null}`);
  } else if (kind === "doc" || kind === "xls" || kind === "ppt") {
    components.push(`soffice:${(await probeLibreOffice().catch(() => null)) !== null}`);
  }
  return createHash("sha256").update(components.join("|")).digest("hex").slice(0, 16);
}

/** 文本结果（任一引擎产出）→ 直插或转存+索引卡（v2b：按上下文余量分流）。 */
async function textResultToResponse(ctx, bytes, input, cwd, textResult, directLimit) {
  const { markdown, pageCount, charCount, lineCount, outline, engine, ocr, notes = [] } = textResult;
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  const direct = charCount <= limit;
  const tierReason = charCount > DIRECT_TEXT_CHARS ? "size" : "budget";
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd, await cacheLocationOf(cwd, ctx));
  const base = rel === null ? join(root, id) : `${rel}/${id}`;
  // 落盘全量文本（不截断）——目录即转换缓存，命中可跳过引擎；
  // 页面图惰性生成：直插快路径不渲染任何页面（几十毫秒的常见小 PDF
  // 不应为了"可能用不上"的视觉补充额外付出整本光栅化）。
  const files = [{ name: "doc.md", data: Buffer.from(markdown, "utf8") }];
  let hasPageImages = false;
  if (!direct && pageCount > 0 && pageCount <= CACHE_PNG_PAGE_CAP) {
    try {
      const rendered = await renderPdfPages(bytes, {
        pageCap: pageCount,
        maxImageBytes: renderByteBudgetOf(ctx),
        maxWidth: CACHE_PNG_WIDTH
      });
      rendered.pages.forEach((page, index) => {
        files.push({
          name: `pages/p${String(index + 1).padStart(2, "0")}.${page.mediaType === "image/jpeg" ? "jpg" : "png"}`,
          data: Buffer.from(page.data)
        });
      });
      hasPageImages = rendered.pages.length > 0;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: page-image rendering failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }
  const cardNotes = [
    ...(ocr ? ["文本来自 OCR 识别，可能有误差；请用页面图（read_image，需视觉模型）对照核实关键数字。"] : []),
    ...notes
  ];
  // 只缓存结构化 metadata，不缓存 card 字符串：命中时永远用当前 input
  // 重建索引卡，同名不同字节/同字节不同名的文件展示都不会串。
  await writeCache({ root, rel }, id, input, "pdf", files, {
    sourceHash: sha256Of(bytes),
    converterFingerprint: await converterFingerprint("pdf"),
    pageCount,
    lineCount,
    charCount,
    hasPageImages,
    outline: normalizeOutline(outline),
    engine: engine ?? "builtin",
    ocr: ocr ?? false,
    docFile: "doc.md",
    notes: cardNotes
  });
  void cleanupCache(root);
  if (direct) {
    const text = notes.length > 0 ? `${markdown}\n\n[附件说明] ${notes.join("；")}` : markdown;
    return { input, kind: "text", text, pageCount, charCount, engine, ocr };
  }
  return {
    input,
    kind: "index",
    id,
    hasPageImages,
    card: buildIndexCard({
      input,
      base,
      docFile: "doc.md",
      pageCount,
      lineCount,
      charCount,
      outline: normalizeOutline(outline),
      hasPageImages,
      notes: cardNotes
    }),
    docPath: `${base}/doc.md`,
    pageCount,
    lineCount,
    charCount,
    engine,
    ocr: ocr ?? false,
    tierReason
  };
}

/**
 * 转换缓存命中（解析引擎之前调用）：同一源文件（完整 SHA-256）+ 同
 * schema + 同转换策略指纹 + 盘上产物齐全 → 直接用落盘文本/索引卡应答，
 * 跳过 pymupdf4llm/OCR 等昂贵引擎。未命中返回 null。
 */
export async function cachedTextResponse(ctx, bytes, input, cwd, limit, kind) {
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd, await cacheLocationOf(cwd, ctx));
  const hit = await readCachedTextIfValid(root, id, sha256Of(bytes));
  if (hit === null) return null;
  // 转换策略变化（换引擎/OCR/doc-server）→ 指纹不匹配 → 视为未命中重跑当前引擎
  if (hit.manifest.converterFingerprint !== await converterFingerprint(kind)) return null;
  void touchCachedDoc(root, id);
  const { manifest, text, docFile } = hit;
  const charCount = Number.isFinite(manifest.charCount) ? manifest.charCount : text.length;
  const pageCount = Number.isFinite(manifest.pageCount) ? manifest.pageCount : 0;
  const lineCount = Number.isFinite(manifest.lineCount) ? manifest.lineCount : text.split("\n").length;
  // 源文本口径（JSON pretty 后与产物不同）：命中与重新转换保持同样的响应 shape
  const sourceCharCount = Number.isFinite(manifest.sourceCharCount) ? manifest.sourceCharCount : undefined;
  const sourceLineCount = Number.isFinite(manifest.sourceLineCount) ? manifest.sourceLineCount : undefined;
  const engine = `${manifest.engine ?? "builtin"}(cache)`;
  const ocr = manifest.ocr === true;
  const absDir = join(root, id);
  const dir = rel === null ? absDir : `${rel}/${id}`;
  const limitNow = limit ?? DIRECT_TEXT_CHARS;
  const cardNotes = [
    ...(ocr ? ["文本来自 OCR 识别，可能有误差；请用页面图（read_image，需视觉模型）对照核实关键数字。"] : []),
    ...(Array.isArray(manifest.notes) ? manifest.notes : [])
  ];
  // 惰性补页面图：首次解析时直插（快路径）不会渲染页面；之后同一 PDF 因
  // 上下文预算变小而命中缓存、降级为 index 时，此刻才生成页面图并更新
  // manifest——保证同一输入同一最终 tier 的能力与历史无关。
  let hasPageImages = manifest.hasPageImages === true;
  if (charCount > limitNow && kind === "pdf" && !hasPageImages
    && pageCount > 0 && pageCount <= CACHE_PNG_PAGE_CAP) {
    try {
      const rendered = await renderPdfPages(bytes, {
        pageCap: pageCount,
        maxImageBytes: renderByteBudgetOf(ctx),
        maxWidth: CACHE_PNG_WIDTH
      });
      for (let index = 0; index < rendered.pages.length; index += 1) {
        const page = rendered.pages[index];
        await writeFile(
          join(absDir, "pages", `p${String(index + 1).padStart(2, "0")}.${page.mediaType === "image/jpeg" ? "jpg" : "png"}`),
          Buffer.from(page.data)
        );
      }
      if (rendered.pages.length > 0) {
        hasPageImages = true;
        void patchCachedManifest(root, id, { hasPageImages: true });
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: lazy page-image materialization failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }
  if (charCount <= limitNow) {
    const withNotes = cardNotes.length > 0
      ? `${text}\n\n[附件说明] ${cardNotes.join("；")}`
      : text;
    return { input, kind: "text", text: withNotes, pageCount, charCount, lineCount, sourceCharCount, sourceLineCount, engine, ocr };
  }
  return {
    input,
    kind: "index",
    id,
    hasPageImages,
    // 永远用当前 input 重建索引卡（缓存只存结构化 metadata，不存卡片字符串）
    card: buildIndexCard({
      input,
      base: dir,
      docFile,
      pageCount,
      lineCount,
      charCount,
      outline: normalizeOutline(manifest.outline),
      tree: manifest.tree ?? null,
      hasPageImages,
      notes: cardNotes
    }),
    docPath: `${dir}/${docFile}`,
    pageCount,
    lineCount,
    charCount,
    sourceCharCount,
    sourceLineCount,
    engine,
    ocr,
    tierReason: charCount > DIRECT_TEXT_CHARS ? "size" : "budget"
  };
}

/** 页面图回退（扫描件且 OCR 不可用/关闭时）。 */
async function imagesFallbackResponse(ctx, bytes, input, warnings) {
  const limits = imageLimitsOf(ctx);
  const pageCap = Math.min(FALLBACK_IMAGE_LIMITS.maxImagesPerMessage, limits.maxImagesPerMessage);
  const rendered = await renderPdfPages(bytes, { pageCap, maxImageBytes: renderByteBudgetOf(ctx) });
  if (rendered.pages.length === 0) return { input, ...fail("pdf-empty", "PDF 没有任何页面") };
  const stem = baseNameOf(input) || "pdf";
  const all = rendered.total > rendered.rendered
    ? [`PDF 共 ${rendered.total} 页，本次仅附加前 ${rendered.rendered} 页（受单条消息图片上限限制）。`, ...warnings]
    : [...warnings];
  return {
    input,
    kind: "images",
    warnings: all,
    images: rendered.pages.map((page, index) => ({
      name: `${stem}-p${index + 1}.${page.mediaType === "image/jpeg" ? "jpg" : "png"}`,
      mediaType: page.mediaType,
      width: page.width,
      height: page.height,
      data: b64encode(page.data)
    }))
  };
}

/** PDF：文字优先，v3 引擎链 doc-server → python(pymupdf4llm) → builtin(pdfjs) → OCR → 页图。 */
async function convertPdfFile(ctx, bytes, input, cwd, directLimit, progress = null) {
  const policy = await enginePolicyWithSettings(cwd, ctx);

  // ---- 缓存命中（先于一切解析引擎：同一源文件直接复用转换结果）-------
  const cached = await cachedTextResponse(ctx, bytes, input, cwd, directLimit, "pdf");
  if (cached !== null) return cached;
  progressUpdate(progress, "working", "解析 PDF 结构…");

  // ---- 引擎 0：外部文档解析服务（DSH_ATTACH_DOC_SERVER）----------------
  if (policy.docServer !== null) {
    try {
      const serverResult = await docServerConvert(bytes, input, policy.docServer);
      const markdown = serverResult.markdown.trim();
      if (markdown !== "") {
        const pageCount = await probePdfPageCount(bytes).catch(() => 0);
        return textResultToResponse(ctx, bytes, input, cwd, {
          markdown,
          pageCount,
          charCount: markdown.length,
          lineCount: markdown.split("\n").length,
          outline: mdOutline(markdown).map((entry) => `L${entry.line} ${entry.title}`),
          engine: "doc-server",
          ocr: false
        }, directLimit);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: doc server failed for ${input}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pythonAvailable = policy.engine !== "builtin" && await probePythonEngine().catch(() => false);

  // ---- 引擎 1/2：文本层提取 --------------------------------------------
  let textResult = null;
  let textError = null;
  if (pythonAvailable) {
    const probedPages = await probePdfPageCount(bytes).catch(() => null);
    if (probedPages !== null && probedPages <= PYTHON_ATTEMPT_LIMIT) {
      const result = await runPythonPdf(bytes).catch((error) => ({ ok: false, error: String(error) }));
      if (result.ok === true && result.hasTextLayer === true && Array.isArray(result.pages)) {
        const sections = result.pages
          .map((page, index) => ({ index, text: String(page ?? "").trim() }))
          .filter((entry) => entry.text !== "")
          .map((entry) => `<!-- p${entry.index + 1} -->\n${entry.text}`);
        const markdown = sections.join("\n\n");
        const charCount = markdown.length;
        // v0.6 P0：书签目录（toc）优先作为大纲；无书签回退 md 标题
        const tocOutline = (Array.isArray(result.toc) ? result.toc : [])
          .filter((entry) => Array.isArray(entry) && typeof entry[1] === "string" && Number.isFinite(entry[2]))
          .map((entry) => `p${entry[2]} ${entry[1].slice(0, 60)}`);
        const mdHeads = mdOutline(markdown).map((entry) => `L${entry.line} ${entry.title}`);
        textResult = {
          markdown,
          pageCount: result.pageCount,
          charCount,
          lineCount: markdown.split("\n").length,
          outline: tocOutline.length >= 2 ? tocOutline : mdHeads,
          engine: result.engine,
          ocr: result.ocr === true
        };
      } else if (result.ok === true && result.skipped === true) {
        // v0.6 内容自适应：大文档低向量密度 → python 主动让位，走 pdfjs 快速引擎
        ctx.logger?.info?.(`dsh-attachment-formats: python engine skipped ${input} (${result.reason ?? "low complexity"}, vectorScore=${result.vectorScore ?? "?"})`);
      } else if (result.ok === false) {
        textError = result.error;
        ctx.logger?.warn?.(`dsh-attachment-formats: python engine failed for ${input}: ${result.error}`);
      }
    } else if (probedPages !== null) {
      textError = `python 引擎仅处理 ≤${PYTHON_ATTEMPT_LIMIT} 页的 PDF，本文件 ${probedPages} 页改用内置引擎`;
    }
  }
  if (textResult === null && policy.engine !== "python") {
    try {
      const extracted = await extractPdfText(bytes);
      if (extracted.hasTextLayer) {
        textResult = {
          markdown: extracted.markdown,
          pageCount: extracted.pageCount,
          charCount: extracted.charCount,
          lineCount: extracted.lineCount,
          outline: extracted.outline,
          engine: "pdfjs",
          ocr: false
        };
      } else if (textError === null) {
        textError = "PDF 没有可用文本层";
      }
    } catch (error) {
      textError = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`dsh-attachment-formats: builtin text extraction failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }
  if (textResult !== null) return textResultToResponse(ctx, bytes, input, cwd, textResult, directLimit);

  // ---- 引擎 3：扫描件 OCR（registry 统一调度，auto 按 baidu->vlm->aliyun->tencent->azure->volc->deepseek->tesseract 顺序）----
  if (policy.ocr !== "off") {
    try {
      progressUpdate(progress, "working", "渲染扫描页…", 0, 1);
      const rendered = await renderPdfPages(bytes, {
        pageCap: OCR_PAGE_CAP,
        maxImageBytes: renderByteBudgetOf(ctx),
        maxWidth: OCR_PNG_WIDTH,
        onProgress: (done, total) => progressUpdate(progress, "working", "渲染扫描页 " + done + "/" + total + "…", done, total)
      });
      progressUpdate(progress, "working", "识别页面文字…", 0, rendered.pages.length);
      if (rendered.pages.length > 0) {
        const onPage = (index, total) => progressUpdate(progress, "working", "识别第 " + index + "/" + total + " 页…", index, total);
        const ocr = await runOcrChain(rendered, policy, ctx, { onPage });
        if (ocr && ocr.failed) {
          textError = ocr.note;
        } else if (ocr !== null) {
          if (ocr.chars >= Math.max(10, 10 * rendered.pages.length) && ocr.confidence >= OCR_MIN_CONFIDENCE) {
            return textResultToResponse(ctx, bytes, input, cwd, {
              markdown: ocr.text,
              pageCount: rendered.pages.length,
              charCount: ocr.chars,
              lineCount: ocr.text.split("\n").length,
              outline: [],
              engine: ocr.engine,
              ocr: true,
              notes: [
                ...(rendered.total > rendered.pages.length
                  ? ["OCR 仅处理前 " + rendered.pages.length + " 页（文档共 " + rendered.total + " 页）"]
                  : []),
                ...(ocr.note ? [ocr.note] : []),
                "OCR 平均置信度 " + Math.round(ocr.confidence)
              ]
            }, directLimit);
          }
          if (ocr.chars >= 10 && ocr.confidence < OCR_MIN_CONFIDENCE) {
            textError = "OCR 置信度过低（" + Math.round(ocr.confidence) + "），识别结果不可靠";
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.("dsh-attachment-formats: OCR failed for " + input);
      ctx.logger?.warn?.(error);
    }
  }

  // ---- 回退：页面图（仅视觉模型路线可用）-------------------------------
  const warnings = [];
  if (textError !== null) warnings.push(`${textError}。`);
  warnings.push("已按页面图片附加——仅视觉模型可以查看；如需文字可用性请安装 OCR（见插件 README）。");
  return imagesFallbackResponse(ctx, bytes, input, warnings);
}

/**
 * Office：提取文本，按上下文余量直插或落盘 + 索引卡（转换缓存 + 全量落盘）。
 * `cacheBytes` 为缓存身份字节：默认即提取输入；旧版 Office 传原始 OLE
 * 字节（转换前先查缓存，命中可直接跳过 LibreOffice）。
 * `engineLabel` 写入 manifest 与 response，保证 /attach list 等直接读
 * manifest 的口径一致（旧版 Office 为 libreoffice+builtin）。
 */
async function convertOfficeFile(ctx, bytes, input, cwd, extract, directLimit, kind, cacheBytes = bytes, engineLabel = "builtin") {
  // 缓存命中：跳过提取（重复拖入直接复用）
  const cached = await cachedTextResponse(ctx, cacheBytes, input, cwd, directLimit, kind);
  if (cached !== null) return cached;
  const text = await extract(bytes);
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  const tierReason = text.length > DIRECT_TEXT_CHARS ? "size" : "budget";
  const id = shortHashOf(cacheBytes);
  const { root, rel } = resolveCacheRoot(cwd, await cacheLocationOf(cwd, ctx));
  const outline = sectionOutline(text);
  const base = rel === null ? join(root, id) : `${rel}/${id}`;
  await writeCache({ root, rel }, id, input, "office", [
    { name: "doc.md", data: Buffer.from(text, "utf8") }
  ], {
    sourceHash: sha256Of(cacheBytes),
    converterFingerprint: await converterFingerprint(kind),
    charCount: text.length,
    lineCount: text.split("\n").length,
    outline,
    engine: engineLabel,
    docFile: "doc.md"
  });
  void cleanupCache(root);
  if (text.length <= limit) {
    return { input, kind: "text", text, charCount: text.length, lineCount: text.split("\n").length, engine: engineLabel };
  }
  return {
    input,
    kind: "index",
    id,
    hasPageImages: false,
    card: buildIndexCard({
      input,
      base,
      docFile: "doc.md",
      pageCount: 0,
      lineCount: text.split("\n").length,
      charCount: text.length,
      outline: outline.map((entry) => ({ line: entry.line, text: entry.text }))
    }),
    docPath: `${base}/doc.md`,
    lineCount: text.split("\n").length,
    charCount: text.length,
    engine: engineLabel,
    tierReason
  };
}

/** 长文本（客户端判定超直插阈值）：解码 + 落盘 + 结构索引（转换缓存 + 全量落盘）。 */
async function convertTextCache(ctx, bytes, input, cwd, directLimit) {
  // 缓存命中：跳过解码与格式化
  const cached = await cachedTextResponse(ctx, bytes, input, cwd, directLimit, "text");
  if (cached !== null) return cached;
  let text = Buffer.from(bytes).toString("utf8");
  let broken = 0;
  for (const ch of text) if (ch === "\uFFFD") broken += 1;
  if (broken > Math.min(128, Math.max(16, text.length * 0.01))) {
    try {
      const alt = new TextDecoder("gb18030").decode(bytes);
      let altBroken = 0;
      for (const ch of alt) if (ch === "\uFFFD") altBroken += 1;
      if (altBroken < broken) text = alt;
    } catch {
      /* keep utf-8 */
    }
  }
  if (text.trim() === "") return { input, ...fail("empty-file", "文件内容为空") };

  const ext = extensionOf(input);
  // 源文本口径（上传字节的解码结果）与落盘产物口径（doc.* 实际内容）分开：
  // JSON 会 pretty-print，产物长度/行数可能远大于源文本。delivery tier 一律
  // 用产物口径，否则 70k 源文本 pretty 成 120k 后仍可能被误判为可直插。
  const sourceCharCount = text.length;
  const sourceLineCount = text.split("\n").length;
  let docFile = "doc.md";
  let docData = text;
  let tree = null;
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") {
    try {
      const parsed = JSON.parse(text);
      tree = jsonTree(parsed);
      docFile = "doc.json";
      docData = JSON.stringify(parsed, null, 2);
    } catch {
      try {
        const rows = text.split("\n").filter((line) => line.trim() !== "");
        let parsedRows = 0;
        for (const row of rows) {
          try { JSON.parse(row); parsedRows += 1; } catch { /* not all rows json */ }
        }
        if (parsedRows === rows.length) {
          tree = { type: `jsonl(${rows.length} 行)` };
          docFile = "doc.jsonl";
          docData = text;
        }
      } catch {
        /* keep plain */
      }
    }
  }
  const artifactCharCount = docData.length;
  const artifactLineCount = docData.split("\n").length;
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd, await cacheLocationOf(cwd, ctx));
  const outline = ext === "md" || ext === "markdown" ? mdOutline(text) : [];
  const base = rel === null ? join(root, id) : `${rel}/${id}`;
  await writeCache({ root, rel }, id, input, "text", [
    { name: docFile, data: Buffer.from(docData, "utf8") }
  ], {
    sourceHash: sha256Of(bytes),
    converterFingerprint: await converterFingerprint("text"),
    charCount: artifactCharCount,
    lineCount: artifactLineCount,
    sourceCharCount,
    sourceLineCount,
    outline,
    tree,
    engine: "builtin",
    docFile
  });
  void cleanupCache(root);
  const card = buildIndexCard({
    input,
    base,
    docFile,
    pageCount: 0,
    lineCount: artifactLineCount,
    charCount: artifactCharCount,
    outline: outline.map((entry) => ({ line: entry.line, text: entry.title })),
    tree
  });
  return {
    input,
    kind: "index",
    id,
    hasPageImages: false,
    card,
    docPath: `${base}/${docFile}`,
    lineCount: artifactLineCount,
    charCount: artifactCharCount,
    sourceCharCount,
    sourceLineCount,
    tierReason: artifactCharCount > DIRECT_TEXT_CHARS ? "size" : "budget"
  };
}

/** 规范化客户端上报的直插上限（上下文余量感知，v2b）。 */
function normalizeDirectLimit(value) {
  if (!Number.isFinite(value)) return DIRECT_TEXT_CHARS;
  const rounded = Math.floor(value);
  if (rounded < DIRECT_LIMIT_MIN || rounded > DIRECT_TEXT_CHARS) return DIRECT_TEXT_CHARS;
  return rounded;
}

/** Convert one uploaded file into images / text / index (never two kinds). */
async function convertFile(ctx, file, cwd, directLimit, progress = null) {
  const input = typeof file?.name === "string" && file.name !== "" ? file.name : "attachment";
  if (file === null || typeof file !== "object" || typeof file.data !== "string" || file.data === "") {
    return { input, ...fail("empty-file", "文件内容为空") };
  }
  let bytes;
  try {
    bytes = b64decode(file.data);
  } catch {
    return { input, ...fail("bad-base64", "文件内容编码无效") };
  }
  if (bytes.length === 0) return { input, ...fail("empty-file", "文件内容为空") };
  if (bytes.length > MAX_FILE_BYTES) {
    return {
      input,
      ...fail("file-too-large", `文件超过上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`)
    };
  }
  const declared = typeof file.kind === "string" ? file.kind : "";
  const kind = declared === "text-cache" ? "text-cache" : sniffKind(bytes, input);
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  try {
    switch (kind) {
      case "pdf": return await convertPdfFile(ctx, bytes, input, cwd, limit, progress);
      case "docx": return await convertOfficeFile(ctx, bytes, input, cwd, docxToText, limit, "docx");
      case "xlsx": return await convertOfficeFile(ctx, bytes, input, cwd, xlsxToText, limit, "xlsx");
      case "pptx": return await convertOfficeFile(ctx, bytes, input, cwd, pptxToText, limit, "pptx");
      case "text-cache": return await convertTextCache(ctx, bytes, input, cwd, limit);
      case "tiff": {
        const { pages, total, rendered } = await tiffToPngPages(bytes);
        if (pages.length === 0) return { input, ...fail("tiff-empty", "TIFF 没有任何页面") };
        const stem = baseNameOf(input) || "tiff";
        return {
          input,
          kind: "images",
          warnings: total > rendered
            ? [`TIFF 共 ${total} 页，本次仅附加前 ${rendered} 页（受单条消息图片上限限制）。`]
            : [],
          images: pages.map((page, index) => ({
            name: `${stem}-p${index + 1}.png`,
            mediaType: page.mediaType,
            width: page.width,
            height: page.height,
            data: b64encode(page.data)
          }))
        };
      }
      case "epub":
      case "odt":
      case "rtf": {
        const pandoc = await probePandoc().catch(() => null);
        const extract = (data) => convertPandocFormat(data, kind, pandoc === null ? null : pandoc.path);
        return await convertOfficeFile(ctx, bytes, input, cwd, extract, limit, kind);
      }
      case "doc":
      case "xls":
      case "ppt": {
        // 缓存先于 LibreOffice：键为「用户上传的原始 OLE 字节」，命中直接
        // 复用转换产物，跳过最昂贵的 soffice 转换（conversion cache 语义完整）
        const cached = await cachedTextResponse(ctx, bytes, input, cwd, limit, kind);
        if (cached !== null) return cached;
        const soffice = await probeLibreOffice().catch(() => null);
        if (soffice === null) {
          return {
            input,
            ...fail("missing-libreoffice", `.${kind} 需要 LibreOffice 转换（未检测到 soffice，请安装 https://www.libreoffice.org 后重试）`)
          };
        }
        const converted = await libreOfficeConvert(bytes, kind, soffice.path);
        const extract = kind === "doc" ? docxToText : kind === "xls" ? xlsxToText : pptxToText;
        return await convertOfficeFile(ctx, converted.data, input, cwd, extract, limit, kind, bytes, "libreoffice+builtin");
      }
      default: {
        const ext = extensionOf(input);
        return {
          input,
          ...fail("unsupported-format", ext === "" ? "无法识别的文件格式" : `暂不支持 .${ext} 文件`)
        };
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-attachment-formats: conversion failed for ${input}`);
    ctx.logger?.warn?.(error);
    return { input, ...fail("conversion-failed", error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * `/attach` 命令（v2b）：
 *   /attach list              列出已转存文档
 *   /attach full <id|名称>    把全文作为 next-step 消息并入模型上下文
 *                             （下一条消息生效；超限显式截断，绝不静默）
 */
const ATTACH_USAGE = "用法: /attach list 或 /attach full <id|名称>";

function formatDocRow(doc) {
  const size = doc.pageCount > 0
    ? `${doc.pageCount} 页 / ${formatCount(doc.charCount)} 字符`
    : `${formatCount(doc.charCount)} 字符`;
  const flags = [doc.engine, doc.ocr ? "ocr" : null].filter(Boolean).join("/") || "builtin";
  return `- ${doc.id}  ${doc.name}  [${doc.kind}${flags ? ` / ${flags}` : ""}]  ${size}`;
}

export async function executeAttachCommand(ctx, invocation) {
  const cwd = invocation?.agent?.session?.header?.cwd;
  const raw = String(invocation?.rawInput ?? "").trim();
  const parts = raw.split(/\s+/).filter((part) => part !== "");
  const verb = parts[0] ?? "";
  const arg = parts.slice(1).join(" ").trim();

  if (verb === "" || verb === "list") {
    try {
      const docs = await listCachedDocs(cwd, await cacheLocationOf(cwd, ctx));
      if (docs.length === 0) {
        return { kind: "success", text: `当前工作区没有已转存的文档。拖入大文件后即可在此看到。\n${ATTACH_USAGE}` };
      }
      return {
        kind: "success",
        text: `已转存文档（${docs.length} 个）：\n${docs.map(formatDocRow).join("\n")}\n\n${ATTACH_USAGE}`
      };
    } catch (error) {
      return { kind: "error", text: `读取缓存失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (verb === "full") {
    if (arg === "") {
      return { kind: "error", text: `请指定文档：/attach full <id|名称>\n先运行 /attach list 查看可用文档。` };
    }
    try {
      const docs = await listCachedDocs(cwd, await cacheLocationOf(cwd, ctx));
      const query = arg.toLowerCase();
      const doc = docs.find((candidate) => candidate.id === query)
        ?? docs.find((candidate) => candidate.id.startsWith(query))
        ?? docs.find((candidate) => candidate.name.toLowerCase().includes(query))
        ?? null;
      if (doc === null) {
        return {
          kind: "error",
          text: `未找到匹配 "${arg}" 的文档。\n${docs.length > 0 ? `可用文档：${docs.map((d) => `${d.id}(${d.name})`).join("、")}` : "当前没有已转存文档。"}`
        };
      }
      const cached = await readCachedDoc(cwd, doc.id, await cacheLocationOf(cwd, ctx));
      let text = cached.text;
      let truncationNotice = null;
      if (text.length > FULL_EXPAND_CHARS) {
        truncationNotice = `\n\n…[全文过长已截断：原始 ${formatCount(text.length)} 字符，仅并入前 ${formatCount(FULL_EXPAND_CHARS)} 字符；剩余部分可用 read 工具按行读取 ${cached.docFile}]`;
        text = text.slice(0, FULL_EXPAND_CHARS);
      }
      const wrapped = `[附件全文: ${doc.name} (${doc.id})] — 由 /attach full 并入上下文\n\n${text}${truncationNotice ?? ""}`;
      const message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: wrapped }]
      };
      try {
        // inject = 非唤醒 next-step 注入（send(msg,"next-step",false) 的语义别名）
        invocation.agent.inject(message);
      } catch (error) {
        return { kind: "error", text: `并入上下文失败：${error instanceof Error ? error.message : String(error)}` };
      }
      return {
        kind: "success",
        text: `已将「${doc.name}」全文（${formatCount(text.length)} 字符${truncationNotice !== null ? "，超限部分已截断" : ""}）并入上下文，将在你的下一条消息中生效。\n仍需精读定位时可用 read 工具按行读取 ${cached.docFile}。`
      };
    } catch (error) {
      return { kind: "error", text: `读取文档失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { kind: "error", text: `未知子命令 "${verb}"。\n${ATTACH_USAGE}` };
}

/**
 * 工作区权威解析：sessionId → 主机侧 session.header.cwd。
 * 客户端上报的 cwd 只作展示/日志 hint，绝不作为路径 authority——
 * 会话驻留时用服务端解析结果；未提供 sessionId 时回退 DSH_HOME storages
 * （路径同样不由客户端决定）。
 * @returns {{ cwd: string|undefined, trustable: boolean }}
 */
function sessionCwd(ctx, sessionId, hint) {
  if (typeof sessionId === "string" && sessionId !== "") {
    try {
      const sessions = ctx.get("sessions");
      const session = sessions?.get?.(sessionId);
      const cwd = session?.header?.cwd;
      if (typeof cwd === "string" && cwd !== "") {
        if (typeof hint === "string" && hint !== "" && hint !== cwd) {
          ctx.logger?.warn?.(`dsh-attachment-formats: client cwd hint "${hint}" differs from session cwd "${cwd}"`);
        }
        return { cwd, trustable: true };
      }
    } catch {
      /* 服务缺失：按不可信处理 */
    }
    return { cwd: undefined, trustable: false }; // 会话在线但解析失败：拒绝 hint
  }
  return { cwd: undefined, trustable: true }; // 无会话：DSH_HOME storages 兜底
}

function apply(ctx) {
  // 官方 settings 缝注册（best-effort，失败静默回退文件）
  ctx.effect(() => {
    void ensureOfficialSettings(ctx);
    return () => {};
  }, "dsh-attachment-formats: official settings registration");

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
            return;
          }
          const body = await readBody(req, MAX_BODY_BYTES);
          const payload = JSON.parse(body.toString("utf8"));
          const files = Array.isArray(payload?.files) ? payload.files.slice(0, 24) : [];
          if (files.length === 0) {
            sendJson(res, 400, { ok: false, error: { code: "no-files", message: "未提供文件" } });
            return;
          }
          const { cwd, trustable } = sessionCwd(ctx, payload?.sessionId, payload?.cwd);
          if (!trustable) {
            sendJson(res, 400, { ok: false, error: { code: "session-not-resident", message: "会话未驻留，无法确定工作区（请切换会话后重试）" } });
            return;
          }
          progressSweep();
          const progress = progressCreate(typeof payload?.jobId === "string" ? payload.jobId : "");
          // v0.9 缓存迁 DSH_HOME：每个 cwd 首次转换前尝试一次性搬移旧目录
          await ensureCacheMigrated(cwd, await cacheLocationOf(cwd, ctx));
          const directLimit = normalizeDirectLimit(payload.directLimitChars);
          const results = [];
          for (const file of files) results.push(await convertFile(ctx, file, cwd, directLimit, progress));
          progressUpdate(progress, "done", "完成");
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: {
              code: "bad-request",
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    }),
    "dsh-attachment-formats: convert route"
  );

  // ---- 缓存管理（P1-3：设置页数据源）----------------------------------
  const queryCwd = (req) => {
    try {
      const value = new URL(req.url ?? "/", "http://x").searchParams.get("cwd");
      return typeof value === "string" && value !== "" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const { cwd, trustable } = sessionCwd(ctx, url.searchParams.get("sessionId") ?? undefined, queryCwd(req));
        if (!trustable) {
          sendJson(res, 400, { ok: false, error: { code: "session-not-resident", message: "会话未驻留，无法确定工作区" } });
          return;
        }
        const loc = await cacheLocationOf(cwd, ctx);
        await ensureCacheMigrated(cwd, loc);
        const docs = await listCachedDocs(cwd, loc).catch(() => []);
        const { root } = resolveCacheRoot(cwd, await cacheLocationOf(cwd, ctx));
        sendJson(res, 200, {
          ok: true,
          docs,
          sizeBytes: await cacheSize(root).catch(() => 0),
          root
        });
      }
    }),
    "dsh-attachment-formats: cache list route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache/delete",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
          const { cwd, trustable } = sessionCwd(ctx, body?.sessionId, body?.cwd);
          if (!trustable) {
            sendJson(res, 400, { ok: false, error: { code: "session-not-resident", message: "会话未驻留，无法确定工作区" } });
            return;
          }
          const removed = await removeCachedDocs(cwd, Array.isArray(body?.ids) ? body.ids : [], await cacheLocationOf(cwd, ctx));
          sendJson(res, 200, { ok: true, removed });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) } });
        }
      }
    }),
    "dsh-attachment-formats: cache delete route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache/clear",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
          const { cwd, trustable } = sessionCwd(ctx, body?.sessionId, body?.cwd);
          if (!trustable) {
            sendJson(res, 400, { ok: false, error: { code: "session-not-resident", message: "会话未驻留，无法确定工作区" } });
            return;
          }
          const cleared = await clearCache(cwd, await cacheLocationOf(cwd, ctx));
          sendJson(res, 200, { ok: true, cleared });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) } });
        }
      }
    }),
    "dsh-attachment-formats: cache clear route"
  );

  // ---- 工作区零拷贝解析（P2-1）-----------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/resolve",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const { cwd, trustable } = sessionCwd(ctx, url.searchParams.get("sessionId") ?? undefined, queryCwd(req));
          const name = url.searchParams.get("name") ?? "";
          const size = Number.parseInt(url.searchParams.get("size") ?? "", 10);
          const hash = url.searchParams.get("hash") ?? "";
          if (!trustable || name === "" || !Number.isFinite(size) || size < 0) {
            sendJson(res, 200, { ok: true, found: false });
            return;
          }
          // 同源判定必须带完整 SHA-256：name+size 只是候选过滤，
          // 内容哈希严格相等才返回 ref（避免同名同大小的静默替换）。
          const match = await resolveWorkspaceFile(cwd, name, size, { hash });
          sendJson(res, 200, { ok: true, found: match !== null, rel: match?.rel ?? null });
        } catch {
          sendJson(res, 200, { ok: true, found: false });
        }
      }
    }),
    "dsh-attachment-formats: workspace resolve route"
  );

  // ---- 转换进度轮询（内存 job 表；响应后由 TTL/下次 sweep 回收）----------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/progress",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const id = url.searchParams.get("jobId") ?? "";
          const job = progressJobs.get(id);
          if (job === undefined) {
            sendJson(res, 200, { ok: true, found: false });
            return;
          }
          sendJson(res, 200, { ok: true, found: true, ...job });
        } catch {
          sendJson(res, 200, { ok: true, found: false });
        }
      }
    }),
    "dsh-attachment-formats: progress route"
  );

  // ---- 缓存页图预览（卡片点击灯箱用；严格白名单防路径穿越）--------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/file",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const { cwd, trustable } = sessionCwd(ctx, url.searchParams.get("sessionId") ?? undefined, queryCwd(req));
          const id = url.searchParams.get("id") ?? "";
          const name = url.searchParams.get("name") ?? "";
          // id 必须是 16-hex 缓存目录；name 白名单：pages/pNN.png|jpg 或 manifest.json
          const idOk = /^[a-f0-9]{16}$/i.test(id);
          const nameOk = /^pages\/p\d{2,3}\.(png|jpg)$/.test(name) || name === "manifest.json";
          if (!trustable || !idOk || !nameOk) {
            sendJson(res, 404, { ok: false, error: { code: "not-found", message: "文件不存在" } });
            return;
          }
          const loc = await cacheLocationOf(cwd, ctx);
          const { root } = resolveCacheRoot(cwd, loc);
          const target = join(root, id, name);
          const data = await import("node:fs/promises").then((m) => m.readFile(target)).catch(() => null);
          if (data === null) {
            sendJson(res, 404, { ok: false, error: { code: "not-found", message: "文件不存在" } });
            return;
          }
          const mediaType = name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : "application/json";
          res.writeHead(200, { "content-type": mediaType, "cache-control": "no-store" });
          res.end(data);
        } catch {
          sendJson(res, 404, { ok: false, error: { code: "not-found", message: "文件不存在" } });
        }
      }
    }),
    "dsh-attachment-formats: file preview route"
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/doctor",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const { cwd } = sessionCwd(ctx, url.searchParams.get("sessionId") ?? undefined, queryCwd(req));
          const check = await checkGitignore(cwd);
          const cacheLocation = await cacheLocationOf(cwd, ctx);
          const { root } = resolveCacheRoot(cwd, cacheLocation);
          sendJson(res, 200, { ok: true, cwd: cwd ?? null, cacheLocation, cacheRoot: root, ...check });
        } catch {
          sendJson(res, 200, { ok: true, gitignored: true, reason: "check failed" });
        }
      }
    }),
    "dsh-attachment-formats: doctor route"
  );

  // ---- 设置页持久化（P1：外部 API 供应商可配置，不再依赖 env）----------
  // revision 乐观锁对齐官方 settings 写入围栏语义；冲突 409 settings-conflict。
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/settings",
      handler: async (req, res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const { cwd } = sessionCwd(ctx, url.searchParams.get("sessionId") ?? undefined, queryCwd(req));
        if (req.method === "GET") {
          try {
            const { loadSettingsDoc, redactForClient } = await import("./settings.js");
            const { config, revision } = await loadSettingsDoc(cwd, ctx);
            sendJson(res, 200, { ok: true, config: redactForClient(config), revision });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: { code: "load-failed", message: String(error) } });
          }
          return;
        }
        if (req.method === "POST") {
          try {
            const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8"));
            const { loadSettingsDoc, saveSettings, redactForClient } = await import("./settings.js");
            // 空 patch 视为读取
            if (body === null || typeof body !== "object" || Object.keys(body).length === 0) {
              const { config, revision } = await loadSettingsDoc(cwd, ctx);
              sendJson(res, 200, { ok: true, config: redactForClient(config), revision });
              return;
            }
            const expectedRevision = Number.isFinite(body?.expectedRevision) ? body.expectedRevision : undefined;
            const patch = { ...body };
            delete patch.expectedRevision;
            let next = await saveSettings(cwd, patch, expectedRevision, ctx);
            // 密钥双写：凭据服务可用时把非空密钥移入 credential store（配置文件只留引用），
            // env 遮蔽等写入失败时保留在配置文件（读取端 env 层本就优先）。
            const creds = ctx.get?.("credentials");
            let moved = 0;
            if (creds !== undefined && creds !== null && typeof creds.set === "function") {
              const SECRET_FIELDS = [
                [["ocr", "baidu", "apiKey"], "DSH_ATTACH_BAIDU_API_KEY"],
                [["ocr", "baidu", "secretKey"], "DSH_ATTACH_BAIDU_SECRET"],
                [["ocr", "aliyun", "accessKeyId"], "DSH_ATTACH_ALIYUN_APPCODE"],
                [["ocr", "tencent", "secretId"], "DSH_ATTACH_TENCENT_SECRET_ID"],
                [["ocr", "tencent", "secretKey"], "DSH_ATTACH_TENCENT_SECRET_KEY"],
                [["ocr", "azure", "apiKey"], "DSH_ATTACH_AZURE_KEY"],
                [["ocr", "volc", "accessKey"], "DSH_ATTACH_VOLC_APPCODE"],
                [["ocr", "deepseek", "key"], "DSH_ATTACH_DEEPSEEK_KEY"],
                [["ocr", "vlm", "key"], "DSH_ATTACH_VLM_KEY"]
              ];
              const clearPatch = {};
              for (const [path, ref] of SECRET_FIELDS) {
                const value = path.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), patch);
                if (typeof value === "string" && value.trim() !== "") {
                  try {
                    await creds.set(ref, value.trim());
                    clearPatch[path[0]] = clearPatch[path[0]] ?? {};
                    clearPatch[path[0]][path[1]] = clearPatch[path[0]][path[1]] ?? {};
                    clearPatch[path[0]][path[1]][path[2]] = "";
                    moved += 1;
                  } catch {
                    /* env 遮蔽（只读源）或服务拒绝：保留在配置文件 */
                  }
                }
              }
              if (moved > 0) next = await saveSettings(cwd, clearPatch, undefined, ctx);
            }
            sendJson(res, 200, { ok: true, config: redactForClient(next), revision: next.revision, secretsMoved: moved });
          } catch (error) {
            const code = error?.code === "settings-conflict" ? "settings-conflict" : "save-failed";
            sendJson(res, error?.code === "settings-conflict" ? 409 : 400, {
              ok: false,
              error: { code, message: error instanceof Error ? error.message : String(error) }
            });
          }
          return;
        }
        sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 GET/POST" } });
      }
    }),
    "dsh-attachment-formats: settings route"
  );

  ctx.effect(
    () => ctx.commands.register({
      name: "attach",
      description: "管理附件缓存：list 列出已转存文档，full <id|名称> 把全文并入上下文",
      input: { hint: "[list|full <id|名称>]", images: false },
      handler: (invocation) => executeAttachCommand(ctx, invocation)
    }),
    "dsh-attachment-formats: /attach command"
  );
}

export { name, inject, apply, rejectUnauthorizedRequest };
export { buildIndexCard, DIRECT_TEXT_CHARS };
