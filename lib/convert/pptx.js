/**
 * dsh-attachment-formats — PPTX → text (host side).
 *
 * Slides are unzipped and walked in presentation order; every `<a:t>` text
 * run is collected (titles, bodies, tables, group shapes, SmartArt runs —
 * anything backed by a text run). Speaker notes and embedded media are out
 * of scope for v1.
 */
import { loadArchiveSafely } from "./archive-budget.js";
import { archiveTarget, readArchiveXml, xmlElements } from "./archive-xml.js";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const TEXT_RUN_RE = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;

/** Decode the XML named/numeric entities used inside OOXML text runs. */
function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
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
  let slideNames = Object.keys(zip.files)
    .filter((name) => SLIDE_RE.test(name))
    .sort((a, b) => {
      const numA = Number.parseInt(SLIDE_RE.exec(a)[1], 10);
      const numB = Number.parseInt(SLIDE_RE.exec(b)[1], 10);
      return numA - numB;
    });

  // Numeric part filenames are storage IDs, not presentation order after slide reordering.
  if (zip.file("ppt/presentation.xml") !== null) {
    const presentation = await readArchiveXml(zip, "ppt/presentation.xml");
    const relationships = await readArchiveXml(zip, "ppt/_rels/presentation.xml.rels");
    const byId = new Map(xmlElements(relationships, "Relationship").map(node => [node.getAttribute("Id"), node]));
    const list = xmlElements(presentation, "sldIdLst")[0];
    slideNames = list ? xmlElements(list, "sldId").map(slide => {
      const id = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
        || slide.getAttributeNS("http://purl.oclc.org/ooxml/officeDocument/relationships", "id");
      const relationship = byId.get(id);
      if (!relationship || !/\/slide$/.test(relationship.getAttribute("Type"))
          || relationship.getAttribute("TargetMode").toLowerCase() === "external") {
        throw new Error(`invalid PPTX slide relationship: ${id}`);
      }
      const name = archiveTarget("ppt/presentation.xml", relationship.getAttribute("Target"));
      if (zip.file(name) === null) throw new Error(`PPTX missing slide: ${name}`);
      return name;
    }) : [];
  }

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
