/**
 * dsh-attachment-formats — PDF 文本层提取（host side，v2a）。
 *
 * 用 pdfjs `getTextContent` 逐页提取文本层，按页组装为带页码标记的
 * Markdown；页眉/页脚按"多页同位置重复出现"启发式去重；标题按字号相对
 * 正文的倍数粗检。产物是文字优先通道的主输入（无损、纯文本模型可用），
 * 页面渲染图仅作视觉补充（见 pdf.js）。
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
const SEP = process.platform === "win32" ? "\\" : "/";
const STANDARD_FONT_DATA_URL = join(PDFJS_DIR, "standard_fonts") + SEP;
const CMAP_URL = join(PDFJS_DIR, "cmaps") + SEP;

/** 判定"文本层存在"：总字符 ≥10 且页均 ≥10 字符（扫描件/图纸远低于此）。 */
export const MIN_TEXT_LAYER_CHARS = 10;

/**
 * @typedef {Object} PdfTextResult
 * @property {string} markdown - 带页码标记的整文 Markdown。
 * @property {number} pageCount - 总页数。
 * @property {number} charCount - 文本字符数（含标记）。
 * @property {number} lineCount - 总行数。
 * @property {string[]} outline - 粗检标题行（去页码），可为空。
 * @property {number[]} textPages - Pages with nonempty extracted text, not a visual-completeness claim.
 * @property {boolean} hasTextLayer - 是否通过文本层阈值。
 */

/**
 * 提取 PDF 文本层并组装结构化文本。
 * @param {Uint8Array} data - 编码后的 PDF 字节。
 * @returns {Promise<PdfTextResult>}
 */
export async function extractPdfText(data) {
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
    const pageCount = doc.numPages;
    // v0.6 P0：书签目录（getOutline）优先作为大纲，缺失时回退字号启发式
    let bookmarkOutline = [];
    try {
      const items = await doc.getOutline();
      for (const item of items ?? []) {
        const pageNumber = await resolveOutlinePage(doc, item.dest).catch(() => null);
        if (pageNumber !== null && typeof item.title === "string" && item.title.trim() !== "") {
          bookmarkOutline.push(`p${pageNumber} ${item.title.trim().slice(0, 60)}`);
        }
        if (bookmarkOutline.length >= 40) break;
      }
    } catch {
      bookmarkOutline = [];
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push({ number: pageNumber, items: content.items ?? [] });
      page.cleanup();
    }
    return assemblePdfText(pages, pageCount, bookmarkOutline);
  } finally {
    await doc.destroy();
  }
}

/** 把书签目标解析为 1-based 页码（命名目标等无法解析时返回 null）。 */
async function resolveOutlinePage(doc, dest) {
  if (Array.isArray(dest)) {
    const ref = dest[0];
    if (ref !== null && ref !== undefined && typeof ref === "object" && Number.isFinite(ref.num)) {
      const index = await doc.getPageIndex(ref);
      return index + 1;
    }
  }
  return null;
}

/** 归一化一行文本：去空白、数字折叠（用于页眉页脚重复判定）。 */
function normalizeForRepeat(text) {
  return text.replace(/\s+/g, "").replace(/\d+/g, "N");
}

/** 组装页级行数据（PDF 用户坐标：y 向上，origin 左下）。 */
function assemblePdfText(pages, pageCount, bookmarkOutline = []) {
  // ---- 每页行装配 ------------------------------------------------------
  const pageLines = []; // pageLines[i] = [{ text, x, y, size }]
  for (const page of pages) {
    const items = page.items;
    if (items.length === 0) {
      pageLines.push([]);
      continue;
    }
    const sizes = [];
    for (const item of items) {
      const size = Math.hypot(item.transform?.[2] ?? 0, item.transform?.[3] ?? 0);
      if (size > 0.5) sizes.push(size);
    }
    sizes.sort((a, b) => a - b);
    const medianSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 10;
    const tolerance = Math.max(2.5, medianSize * 0.45);

    const lines = [];
    for (const item of items) {
      const text = (item.str ?? "").replace(/\s+/g, " ");
      if (text.trim() === "") continue;
      const size = Math.hypot(item.transform?.[2] ?? 0, item.transform?.[3] ?? 0);
      const x = item.transform?.[4] ?? 0;
      const y = item.transform?.[5] ?? 0;
      let line = lines.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
      if (line === undefined) {
        line = { parts: [], y, size };
        lines.push(line);
      }
      line.parts.push({ x, text, size });
      if (size > line.size) line.size = size;
    }
    const assembled = lines
      .sort((a, b) => b.y - a.y)
      .map((line) => {
        line.parts.sort((a, b) => a.x - b.x);
        const avg = line.parts.reduce((sum, part) => sum + part.text.length, 0) / Math.max(1, line.parts.length);
        const gap = Math.max(1.2 * avg * line.size * 0.5, line.size * 3);
        let text = "";
        let previousX = null;
        for (const part of line.parts) {
          if (text === "") text = part.text;
          else if (previousX !== null && part.x - previousX > gap) text += "\t" + part.text;
          else text += " " + part.text;
          previousX = part.x + part.text.length * line.size * 0.5;
        }
        return { text: text.replace(/\s+/g, " ").trim(), y: line.y, size: line.size };
      })
      .filter((line) => line.text !== "");
    pageLines.push(assembled);
  }

  // ---- 页眉/页脚去重 ----------------------------------------------------
  const repeatMap = new Map(); // normalized -> { count, text, yRatio }
  for (const lines of pageLines) {
    if (lines.length === 0) continue;
    const minY = Math.min(...lines.map((line) => line.y));
    const maxY = Math.max(...lines.map((line) => line.y));
    const seen = new Set();
    for (const line of lines) {
      const yRatio = maxY === minY ? 0.5 : (line.y - minY) / (maxY - minY);
      const band = yRatio < 0.06 || yRatio > 0.94; // 只考虑页首/页尾带
      if (!band) continue;
      const key = `${normalizeForRepeat(line.text)}@${yRatio.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = repeatMap.get(key);
      if (entry === undefined) repeatMap.set(key, { count: 1, text: line.text, yRatio });
      else {
        entry.count += 1;
        if (line.text.length < entry.text.length) entry.text = line.text;
      }
    }
  }
  const repeats = new Set();
  for (const [key, entry] of repeatMap.entries()) {
    // 至少出现在 60% 的页（≥3 页文档），且文本短（页码/栏目标题类）。
    if (entry.count >= Math.max(3, Math.ceil(pageCount * 0.6)) && entry.text.length <= 80) {
      repeats.add(key);
    }
  }

  // ---- 标题粗检 -----------------------------------------------------------
  const bodySizes = [];
  for (const lines of pageLines) {
    for (const line of lines) bodySizes.push(line.size);
  }
  bodySizes.sort((a, b) => a - b);
  const bodyMedian = bodySizes.length > 0 ? bodySizes[Math.floor(bodySizes.length / 2)] : 10;

  const outline = [];
  const sections = [];
  const textPages = [];
  let charCount = 0;
  let lineCount = 0;
  for (const page of pages) {
    const lines = pageLines[page.number - 1] ?? [];
    const minY = lines.length > 0 ? Math.min(...lines.map((line) => line.y)) : 0;
    const maxY = lines.length > 0 ? Math.max(...lines.map((line) => line.y)) : 0;
    const body = [];
    for (const line of lines) {
      const yRatio = maxY === minY ? 0.5 : (line.y - minY) / (maxY - minY);
      const key = `${normalizeForRepeat(line.text)}@${yRatio.toFixed(3)}`;
      if (repeats.has(key)) continue;
      body.push(line);
    }
    const markdown = body.map((line) => line.text).join("\n").trim();
    if (markdown !== "") {
      textPages.push(page.number);
      sections.push(`<!-- p${page.number} -->\n${markdown}`);
      charCount += markdown.length;
      lineCount += body.length + 1;
    }
    // 标题：字号明显大于正文、且较短
    for (const line of body) {
      if (line.size >= bodyMedian * 1.3 && line.text.length <= 60) {
        outline.push({ page: page.number, text: line.text });
      }
    }
  }
  const outlineTexts = [];
  const seenOutline = new Set();
  for (const entry of outline) {
    const key = normalizeForRepeat(entry.text);
    if (seenOutline.has(key)) continue;
    seenOutline.add(key);
    outlineTexts.push(`p${entry.page} ${entry.text}`);
  }
  // 书签目录优先（≥2 条才采信）；否则回退字号启发式
  const outlineFinal = bookmarkOutline.length >= 2 ? bookmarkOutline : outlineTexts;
  return {
    markdown: sections.join("\n\n"),
    pageCount,
    textPages,
    charCount,
    lineCount,
    outline: outlineFinal.slice(0, 40),
    hasTextLayer: charCount >= MIN_TEXT_LAYER_CHARS && charCount / Math.max(1, pageCount) >= 10
  };
}
