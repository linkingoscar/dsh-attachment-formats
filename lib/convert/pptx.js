/**
 * dsh-attachment-formats — PPTX → text (host side).
 *
 * Slides are unzipped and walked in presentation order; every `<a:t>` text
 * run is collected (titles, bodies, tables, group shapes, SmartArt runs —
 * anything backed by a text run). Speaker notes and embedded media are out
 * of scope for v1.
 */
import { loadArchiveSafely } from "./archive-budget.js";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/** Decode the XML named/numeric entities used inside OOXML text runs. */
function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Extract text from an encoded .pptx.
 * @param {Uint8Array} data - encoded PPTX (zip) bytes.
 * @returns {Promise<string>} per-slide sections, truncated by policy.
 */
export async function pptxToText(data) {
  const zip = await loadArchiveSafely(data);
  const slideNames = Object.keys(zip.files)
    .filter((name) => SLIDE_RE.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(SLIDE_RE.exec(a)[1], 10);
      const numB = Number.parseInt(SLIDE_RE.exec(b)[1], 10);
      return numA - numB;
    });

  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async("string");
    const lines = [];
    let match;
    while ((match = TEXT_RUN_RE.exec(xml)) !== null) {
      const line = decodeXmlEntities(match[1]).replace(/\s+/g, " ").trim();
      if (line !== "") lines.push(line);
    }
    slides.push(`[幻灯片 ${slides.length + 1}]\n${lines.join("\n")}`);
  }
  if (slides.length === 0) return "[未提取到文本：该演示文稿的幻灯片不包含文本运行]";
  // 完整逻辑结果——截断策略只发生在最终 delivery tier（见 index.js）
  return slides.join("\n\n");
}
