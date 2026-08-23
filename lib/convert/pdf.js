/**
 * dsh-attachment-formats — PDF → PNG/JPEG page renderer (host side).
 *
 * Codex-style handling: a PDF attachment becomes one image per page, rendered
 * through pdfjs-dist onto an @napi-rs/canvas surface, then fed back into the
 * harness' native image pipeline. Page count is capped by the deployment
 * image policy (never more than one message may carry).
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PDF_PAGE_CAP, FALLBACK_IMAGE_LIMITS, imageLimitsOf, renderByteBudgetOf } from "./util.js";
import { loadCanvas } from "../optional.js";

// pdf.js in Node reads its standard font data and CMaps through fs paths
// (NodeStandardFontDataFactory / NodeCMapReaderFactory); without these URLs
// PDFs that rely on the 14 standard fonts render blank glyphs.
const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
const SEP = process.platform === "win32" ? "\\" : "/";
const STANDARD_FONT_DATA_URL = join(PDFJS_DIR, "standard_fonts") + SEP;
const CMAP_URL = join(PDFJS_DIR, "cmaps") + SEP;

/** Target render size: legible for vision models, well below the pixel cap. */
const MAX_RENDER_WIDTH = 1600;
const MAX_RENDER_HEIGHT = 2400;
const MIN_RENDER_SCALE = 0.2;
const MAX_RENDER_SCALE = 2;
/** JPEG quality used when a page exceeds the per-image byte budget as PNG. */
const JPEG_QUALITY = 85;

/**
 * Canvas factory pdf.js uses for offscreen pattern rendering; the context
 * comes from @napi-rs/canvas (optionalDependencies, lazy-loaded).
 */
let _createCanvas = null;
let _canvasFactory = null;

async function ensureCanvasFactory() {
  if (_canvasFactory !== null) return _canvasFactory;
  const loaded = await loadCanvas();
  if (!loaded.ok) {
    const hint =
      loaded.state === "missing"
        ? "PDF 渲染需要 @napi-rs/canvas（未安装），请执行 npm install --include=optional @napi-rs/canvas 后重试"
        : `canvas 加载失败（${String(loaded.error?.message ?? loaded.error)}）`;
    throw new Error(hint);
  }
  _createCanvas = loaded.createCanvas;
  _canvasFactory = {
    create(width, height) {
      const canvas = _createCanvas(Math.max(1, width), Math.max(1, height));
      const context = canvas.getContext("2d");
      return { canvas, context };
    },
    reset(canvasAndContext, width, height) {
      canvasAndContext.canvas.width = Math.max(1, width);
      canvasAndContext.canvas.height = Math.max(1, height);
    },
    destroy(canvasAndContext) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  };
  return _canvasFactory;
}

/** 快速探测 PDF 页数（只解析文档结构，不渲染页面）。 */
export async function probePdfPageCount(data) {
  const doc = await getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true
  }).promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

/**
 * Render the first `pageCap` pages of an encoded PDF to raster images.
 * @param {Uint8Array} data - encoded PDF bytes.
 * @param {{ pageCap?: number, maxImageBytes?: number, maxWidth?: number, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ pages: Array<{ data: Uint8Array, mediaType: string, width: number, height: number }>, total: number, rendered: number }>}
 */
export async function renderPdfPages(data, options = {}) {
  const pageCap = options.pageCap ?? PDF_PAGE_CAP;
  const maxImageBytes = options.maxImageBytes ?? FALLBACK_IMAGE_LIMITS.maxImageBytes;
  const targetWidth = options.maxWidth ?? MAX_RENDER_WIDTH;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const canvasFactory = await ensureCanvasFactory();

  const doc = await getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    canvasFactory
  }).promise;

  try {
    const total = doc.numPages;
    const rendered = Math.min(total, Math.max(1, pageCap));
    const pages = [];
    for (let pageNumber = 1; pageNumber <= rendered; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(
        targetWidth / Math.max(1, base.width),
        MAX_RENDER_HEIGHT / Math.max(1, base.height),
        MAX_RENDER_SCALE
      );
      const scale = Math.max(MIN_RENDER_SCALE, fit);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));

      const surface = canvasFactory.create(width, height);
      const context = surface.context;
      // PDFs carry no intrinsic paper background — paint white first.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      await page.render({
        canvas: surface.canvas,
        canvasContext: context,
        viewport,
        canvasFactory
      }).promise;

      let image = surface.canvas.toBuffer("image/png");
      let mediaType = "image/png";
      if (image.length > maxImageBytes) {
        // Photo-heavy page: fall back to JPEG within the byte budget.
        image = await surface.canvas.encode("jpeg", JPEG_QUALITY);
        mediaType = "image/jpeg";
      }
      canvasFactory.destroy(surface);
      page.cleanup();
      pages.push({ data: new Uint8Array(image), mediaType, width, height });
      onProgress?.(pages.length, total);
    }
    return { pages, total, rendered };
  } finally {
    await doc.destroy();
  }
}

/**
 * Full admission-aware wrapper used by the convert route: caps pages by the
 * deployment image policy and returns an explicit truncation warning.
 * @param {Uint8Array} data - encoded PDF bytes.
 * @param {object} ctx - cordis context carrying the attachments service.
 */
export async function convertPdf(ctx, data) {
  const limits = imageLimitsOf(ctx);
  const pageCap = Math.min(PDF_PAGE_CAP, limits.maxImagesPerMessage);
  const result = await renderPdfPages(data, {
    pageCap,
    maxImageBytes: renderByteBudgetOf(ctx)
  });
  const truncated = result.total > result.rendered;
  return {
    pages: result.pages,
    warnings: truncated
      ? [`PDF 共 ${result.total} 页，本次仅附加前 ${result.rendered} 页（受单条消息图片上限限制）。`]
      : []
  };
}
