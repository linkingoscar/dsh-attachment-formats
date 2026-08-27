/**
 * dsh-attachment-formats — DOCX → Markdown（host side，v0.6）。
 *
 * mammoth 的 HTML 输出（保留表格/标题结构）→ turndown + GFM 插件 →
 * Markdown（表格保留为 pipe 表）。图片丢弃；HTML 转空时回退 extractRawText。
 * 始终返回完整逻辑结果——截断策略只发生在最终 delivery tier（见 index.js）。
 */
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { loadArchiveSafely } from "./archive-budget.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);
turndown.remove(["script", "style", "img", "svg"]);

/**
 * Extract Markdown from an encoded .docx (tables preserved as pipe tables).
 * @param {Uint8Array} data - encoded DOCX (zip) bytes.
 * @returns {Promise<string>} markdown text (uncapped).
 */
export async function docxToText(data) {
  const buffer = Buffer.from(data);
  await loadArchiveSafely(buffer);
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) }
  );
  const markdown = turndown.turndown(html).replaceAll("\u0000", "");
  const trimmed = markdown.trim();
  if (trimmed !== "") return trimmed;
  // 兜底：结构极简的 docx 退回纯文本
  const { value: raw } = await mammoth.extractRawText({ buffer });
  return raw.replaceAll("\u0000", "");
}
