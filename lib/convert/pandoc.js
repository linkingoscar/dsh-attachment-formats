/**
 * dsh-attachment-formats — pandoc 通道与 zip 兜底（host side，v0.6 P0）。
 *
 * epub / odt / rtf → Markdown：
 *   - pandoc 可用时：子进程 `pandoc -f <fmt> -t gfm`（表格/标题保真）；
 *   - pandoc 缺失时：epub/odt 用 jszip + turndown/文本提取兜底；rtf 无兜底，
 *     返回明确错误。
 */
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { loadArchiveSafely } from "./archive-budget.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);
turndown.remove(["script", "style", "img", "svg"]);

/**
 * 用 pandoc 子进程转换（输入/输出都走临时文件，避免管道捕获）。
 * @param {Buffer} bytes - 源文件字节。
 * @param {string} format - pandoc 输入格式（epub|odt|rtf）。
 * @param {string} pandocPath - 探测到的 pandoc 可执行文件路径。
 */
export async function pandocToMarkdown(bytes, format, pandocPath) {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const dir = mkdtempSync(pathJoin(tmpdir(), "dsh-attach-pandoc-"));
  const input = pathJoin(dir, `input.${format === "odt" ? "odt" : format}`);
  const output = pathJoin(dir, "output.md");
  writeFileSync(input, bytes);
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(pandocPath, ["-f", format, "-t", "gfm", input, "-o", output], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 120_000
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exit !== 0) throw new Error(`pandoc exited with code ${exit}`);
    if (!existsSync(output)) throw new Error("pandoc 未生成输出");
    return readFileSync(output, "utf8");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** zip 容器内按扩展名收集文本候选文件。 */
async function zipTextFiles(bytes, predicate) {
  const zip = await loadArchiveSafely(bytes);
  const names = Object.keys(zip.files)
    .filter((name) => predicate(name))
    .filter((name) => !zip.files[name].dir)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const parts = [];
  for (const name of names) {
    const raw = await zip.file(name).async("string");
    parts.push({ name, raw });
  }
  return parts;
}

/** epub 兜底：xhtml 章节 → turndown → Markdown。 */
async function epubFallback(bytes) {
  const chapters = await zipTextFiles(bytes, (name) => /\.(xhtml|html|htm)$/i.test(name));
  const sections = [];
  for (const chapter of chapters) {
    const markdown = turndown.turndown(chapter.raw).trim();
    if (markdown !== "") sections.push(`<!-- ${chapter.name} -->\n${markdown}`);
  }
  const text = sections.join("\n\n");
  return text;
}

/** odt 兜底：content.xml 的 text:p / text:h 文本节点。 */
async function odtFallback(bytes) {
  const zip = await loadArchiveSafely(bytes);
  const entry = zip.file("content.xml");
  if (entry === null) throw new Error("odt 缺少 content.xml");
  const xml = await entry.async("string");
  const lines = [];
  const headingRe = /<text:h[^>]*>([\s\S]*?)<\/text:h>/g;
  const paraRe = /<text:p[^>]*>([\s\S]*?)<\/text:p>/g;
  const strip = (value) => value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  let match;
  const blocks = [];
  while ((match = headingRe.exec(xml)) !== null) blocks.push({ kind: "h", text: strip(match[1]) });
  while ((match = paraRe.exec(xml)) !== null) blocks.push({ kind: "p", text: strip(match[1]) });
  // 简单按出现顺序重建（text:h/text:p 混在正文里，顺序不可靠但可读）
  for (const block of blocks) {
    if (block.text === "") continue;
    lines.push(block.kind === "h" ? `## ${block.text}` : block.text);
  }
  return lines.join("\n\n");
}

/**
 * 统一入口：epub/odt/rtf → Markdown 文本。
 * @param {Buffer} bytes - 源字节。
 * @param {"epub"|"odt"|"rtf"} format - 源格式。
 * @param {string|null} pandocPath - pandoc 可执行文件（探测结果，可为 null）。
 */
export async function convertPandocFormat(bytes, format, pandocPath) {
  if (pandocPath !== null) return pandocToMarkdown(bytes, format, pandocPath);
  if (format === "epub") return epubFallback(bytes);
  if (format === "odt") return odtFallback(bytes);
  throw new Error("RTF 需要 pandoc 才能转换（未检测到 pandoc，请安装 https://pandoc.org 后重试）");
}
