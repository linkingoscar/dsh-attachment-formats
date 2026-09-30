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
import { archiveTarget, readArchiveXml, xmlElements } from "./archive-xml.js";

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

/** epub 兜底：container → OPF manifest/spine, preserving publication reading order. */
async function epubFallback(bytes) {
  const zip = await loadArchiveSafely(bytes);
  const container = await readArchiveXml(zip, "META-INF/container.xml");
  const rootfile = xmlElements(container, "rootfile").find(node => node.getAttribute("media-type") === "application/oebps-package+xml");
  if (!rootfile) throw new Error("epub missing OPF rootfile");
  const opfName = archiveTarget("container.xml", rootfile.getAttribute("full-path"));
  const opf = await readArchiveXml(zip, opfName);
  const manifest = xmlElements(opf, "manifest")[0];
  const spine = xmlElements(opf, "spine")[0];
  if (!manifest || !spine) throw new Error("epub missing manifest/spine");
  const items = new Map(xmlElements(manifest, "item").map(node => [node.getAttribute("id"), node]));
  const sections = [];
  for (const ref of xmlElements(spine, "itemref")) {
    // Auxiliary non-linear content and navigation documents are not main reading order.
    if (ref.getAttribute("linear") === "no") continue;
    const id = ref.getAttribute("idref");
    const item = items.get(id);
    if (!item) throw new Error(`epub spine references missing item: ${id}`);
    if (item.getAttribute("properties").split(/\s+/).includes("nav")) continue;
    if (!["application/xhtml+xml", "text/html"].includes(item.getAttribute("media-type"))) {
      throw new Error(`epub unsupported spine media type: ${item.getAttribute("media-type")}`);
    }
    const name = archiveTarget(opfName, item.getAttribute("href"));
    const entry = zip.file(name);
    if (entry === null) throw new Error(`epub missing chapter: ${name}`);
    const markdown = turndown.turndown(await entry.async("string")).trim();
    if (markdown !== "") sections.push(`<!-- ${name} -->\n${markdown}`);
  }
  return sections.join("\n\n");
}

/** odt 兜底：content.xml 的 text:p / text:h 文本节点。 */
async function odtFallback(bytes) {
  const zip = await loadArchiveSafely(bytes);
  const entry = zip.file("content.xml");
  if (entry === null) throw new Error("odt 缺少 content.xml");
  const document = await readArchiveXml(zip, "content.xml");
  const lines = [];
  const namespace = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
  // One document-order walk, not separate heading/paragraph passes.
  for (const block of xmlElements(document, "*", namespace)) {
    if (block.localName !== "h" && block.localName !== "p") continue;
    const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const level = Number.parseInt(block.getAttributeNS(namespace, "outline-level"), 10);
    const depth = Number.isFinite(level) ? Math.max(1, Math.min(6, level)) : 2;
    lines.push(block.localName === "h" ? `${"#".repeat(depth)} ${text}` : text);
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
