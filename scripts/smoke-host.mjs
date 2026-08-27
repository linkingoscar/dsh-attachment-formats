/**
 * dsh-attachment-formats — 离线冒烟测试（不依赖运行中的 dsh）。
 *
 * 在项目内生成最小 fixture（PDF/docx/xlsx/pptx），逐一跑主机端转换器，
 * 校验产物（PNG 魔数、页面尺寸、文本标记），并把中间产物写到 temp/。
 * 运行：npm run smoke
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { renderPdfPages } from "../lib/convert/pdf.js";
import { extractPdfText } from "../lib/convert/pdftext.js";
import { mdOutline, jsonTree } from "../lib/convert/outline.js";
import { docxToText } from "../lib/convert/docx.js";
import { xlsxToText } from "../lib/convert/xlsx.js";
import { pptxToText } from "../lib/convert/pptx.js";
import { sniffKind } from "../lib/convert/util.js";
import { assertArchiveBudget } from "../lib/convert/archive-budget.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = join(root, "temp");
mkdirSync(temp, { recursive: true });

let failures = 0;
function check(label, ok, extra = "") {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label} ${extra}`);
  }
}

console.log("== 压缩文档安全预算 ==");
{
  let rejected = false;
  try {
    assertArchiveBudget({ files: { "huge.xml": { name: "huge.xml", dir: false, _data: { uncompressedSize: 65 * 1024 * 1024 } } } }, 1024);
  } catch (error) {
    rejected = error?.code === "archive-budget-exceeded";
  }
  check("超大解压条目在 entry.async 前拒绝", rejected);
}

/** 手工构建一个 xref 完全正确的单页 PDF（Helvetica 标准字体）。 */
function buildPdf() {
  const content = "BT /F1 24 Tf 72 720 Td (Hello PDF page 1) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

async function buildDocx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>"
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>"
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body>" +
      "<w:p><w:r><w:t>你好 DOCX 冒烟测试</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>" +
      "</w:body></w:document>"
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildXlsx() {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("数据");
  data.addRow(["名称", "数量"]);
  data.addRow(["苹果", 3]);
  data.addRow(["香蕉", 5]);
  const note = workbook.addWorksheet("备注");
  note.addRow(["冒烟测试"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 列间隙夹具：A、C 有值而 B 为空——验证矩形网格不漂移。 */
async function buildXlsxGap() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("间隙");
  const row = sheet.getRow(1);
  row.getCell(1).value = "左";
  row.getCell(3).value = "右";
  const second = sheet.getRow(2);
  second.getCell(1).value = "甲";
  second.getCell(2).value = "乙";
  second.getCell(3).value = "丙";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 超大 DOCX（~36 万字符，验证转换器不截断）。 */
async function buildHugeDocx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>"
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>"
  );
  const paragraphs = [];
  for (let i = 0; i < 14000; i += 1) {
    paragraphs.push(`<w:p><w:r><w:t>段落 ${i}：全文不截断验证内容。abcdefghijklmnopqrstuvwxyz</w:t></w:r></w:p>`);
  }
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs.join("")}</w:body></w:document>`
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildPptx() {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>标题一</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>" +
      "</p:sld>"
  );
  zip.file(
    "ppt/slides/slide2.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页 &amp; 内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>" +
      "</p:sld>"
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const fixtures = {};
fixtures.pdf = buildPdf();
fixtures.docx = await buildDocx();
fixtures.xlsx = await buildXlsx();
fixtures.pptx = await buildPptx();

for (const [ext, buffer] of Object.entries(fixtures)) {
  const kind = sniffKind(buffer, `fixture.${ext}`);
  check(`sniff ${ext} → ${kind}`, kind === ext, `got ${kind}`);
  writeFileSync(join(temp, `fixture.${ext}`), buffer);
}

console.log("\n== PDF ==");
{
  const result = await renderPdfPages(fixtures.pdf, { pageCap: 3 });
  check("pdf pages = 1", result.pages.length === 1, `got ${result.pages.length}`);
  check("pdf total = 1", result.total === 1, `got ${result.total}`);
  const page = result.pages[0];
  check(
    "pdf png magic",
    page.mediaType === "image/png" && page.data[0] === 0x89 && page.data[1] === 0x50 && page.data[2] === 0x4e && page.data[3] === 0x47
  );
  check("pdf page dimensions", page.width > 100 && page.height > 100, `${page.width}x${page.height}`);
  // 内容校验：页面必须真的画出了文字（防止字体数据缺失时输出空白页）
  {
    const img = await loadImage(page.data);
    const canvas = createCanvas(img.width, img.height);
    const context = canvas.getContext("2d");
    context.drawImage(img, 0, 0);
    const pixels = context.getImageData(0, 0, img.width, img.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 200) dark += 1;
    }
    check("pdf page has visible text", dark > (pixels.length / 4) * 0.001, `dark=${dark}`);
  }
  writeFileSync(join(temp, "pdf-page-1.png"), page.data);
}

console.log("\n== PDF 文本层（v2a）==");
{
  const result = await extractPdfText(fixtures.pdf);
  check("pdf text layer present", result.hasTextLayer === true, `chars=${result.charCount}`);
  check("pdf text pageCount", result.pageCount === 1, `got ${result.pageCount}`);
  check("pdf text has marker", result.markdown.includes("<!-- p1 -->"));
  check("pdf text has content", result.markdown.includes("Hello PDF page 1"));
  writeFileSync(join(temp, "pdf-text.md"), result.markdown, "utf8");
}

console.log("\n== 大纲与 JSON 键树（v2a）==");
{
  const outline = mdOutline("# 总标题\n\n## 第一节\n正文\n## 第二节\n正文\n### 子节\n");
  check("md outline entries", outline.length === 4 && outline[0].title === "总标题" && outline[1].line === 3 && outline[1].title === "第一节");
  const tree = jsonTree({ users: [1, 2, 3], meta: { a: 1, b: 2 }, name: "x" });
  check("json tree type", tree.type.startsWith("object(3"));
  check("json tree children", tree.children.length === 3 && tree.children[0].key === "users" && tree.children[0].summary === "array(3)");
}

console.log("\n== DOCX ==");
{
  const text = await docxToText(fixtures.docx);
  check("docx has zh paragraph", text.includes("你好 DOCX 冒烟测试"));
  check("docx has en paragraph", text.includes("Second paragraph."));
  writeFileSync(join(temp, "docx.txt"), text, "utf8");
}

console.log("\n== XLSX ==");
{
  const text = await xlsxToText(fixtures.xlsx);
  check("xlsx sheet header", text.includes("[工作表: 数据]"));
  check("xlsx rows", text.includes("苹果") && text.includes("3") && text.includes("香蕉") && text.includes("5"));
  check("xlsx second sheet", text.includes("[工作表: 备注]") && text.includes("冒烟测试"));
  writeFileSync(join(temp, "xlsx.txt"), text, "utf8");
}

console.log("\n== PPTX ==");
{
  const text = await pptxToText(fixtures.pptx);
  check("pptx slide 1", text.includes("[幻灯片 1]") && text.includes("标题一"));
  check("pptx slide 2 + entities", text.includes("[幻灯片 2]") && text.includes("第二页 & 内容"));
  writeFileSync(join(temp, "pptx.txt"), text, "utf8");
}

console.log("\n== 修复验证：XLSX 列坐标不漂移 ==");
{
  const text = await xlsxToText(await buildXlsxGap());
  const firstRow = text.split("\n")[1] ?? "";
  check("A、C 有值 B 为空 → 保留空列（左\\t\\t右）", firstRow === "左\t\t右", JSON.stringify(firstRow));
  check("第二行完整", text.includes("甲\t乙\t丙"));
}

console.log("\n== 修复验证：DOCX 转换器不截断 ==");
{
  const text = await docxToText(new Uint8Array(await buildHugeDocx()));
  check("36 万字符 docx 返回全文（>300k）", text.length > 300_000, `len=${text.length}`);
}

console.log("\n== 修复验证：缓存 TTL 按 lastAccessedAt 续期 ==");
{
  const { cleanupCache, writeCache, shortHashOf, sha256Of } = await import("../lib/cache.js");
  const seeded = Buffer.from("ttl 测试内容");
  const id = shortHashOf(seeded);
  check("目录 id 16 hex / 完整哈希 64 hex", /^[a-f0-9]{16}$/.test(id) && /^[a-f0-9]{64}$/.test(sha256Of(seeded)), id);
  const cacheTemp = join(temp, "ttl-cache");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cacheTemp, { recursive: true });
  await writeCache({ root: cacheTemp, rel: ".dsh-attachments" }, id, "ttl.md", "text", [
    { name: "doc.md", data: seeded }
  ], { sourceHash: sha256Of(seeded), charCount: seeded.length, lineCount: 1, docFile: "doc.md" });
  // 把 manifest 的 lastAccessedAt 拨到"刚刚"、目录 mtime 拨到 30 天前（模拟频繁访问的旧目录）
  const { writeFileSync: wfs, utimesSync } = await import("node:fs");
  const manifestPath = join(cacheTemp, id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.lastAccessedAt = new Date().toISOString();
  wfs(manifestPath, JSON.stringify(manifest));
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(join(cacheTemp, id), old, old);
  await cleanupCache(cacheTemp);
  check("频繁访问的旧目录不会被误删", existsSync(join(cacheTemp, id, "doc.md")));
}

console.log("\n== 修复验证：TTL 纳入主文档 atime（模型直接 read 续期）==");
{
  const { cleanupCache, writeCache, shortHashOf, sha256Of } = await import("../lib/cache.js");
  const seeded = Buffer.from("atime 测试内容");
  const id = shortHashOf(seeded);
  const cacheTemp = join(temp, "atime-cache");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cacheTemp, { recursive: true });
  await writeCache({ root: cacheTemp, rel: ".dsh-attachments" }, id, "atime.md", "text", [
    { name: "doc.md", data: seeded }
  ], { sourceHash: sha256Of(seeded), charCount: seeded.length, lineCount: 1, docFile: "doc.md" });
  // 全部写回 30 天前（manifest 从未被插件 touch），但 doc.md 的 atime 是"刚刚"
  // ——模拟模型绕过插件直接用 read 工具读 doc.md 的情况。
  const { writeFileSync: wfs, utimesSync } = await import("node:fs");
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const fresh = new Date();
  const manifestPath = join(cacheTemp, id, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.lastAccessedAt = old.toISOString();
  wfs(manifestPath, JSON.stringify(manifest));
  utimesSync(join(cacheTemp, id), old, old);
  utimesSync(join(cacheTemp, id, "doc.md"), fresh, old);
  await cleanupCache(cacheTemp);
  check("模型直接 read 过的文档不被误删", existsSync(join(cacheTemp, id, "doc.md")));
}

console.log("\n== 修复验证：INDEX 单元格转义（管道符/换行）==");
{
  const { writeCache, shortHashOf, sha256Of } = await import("../lib/cache.js");
  const idxRoot = join(temp, "index-escape");
  const seeded = Buffer.from("escape");
  await writeCache({ root: idxRoot, rel: ".dsh-attachments" }, shortHashOf(seeded), "财务|最终版.md", "text", [
    { name: "doc.md", data: seeded }
  ], { sourceHash: sha256Of(seeded), charCount: seeded.length, lineCount: 1, docFile: "doc.md" });
  const idx = readFileSync(join(idxRoot, "INDEX.md"), "utf8");
  check("管道符被转义（不炸列）", idx.includes("财务\\|最终版.md") && !idx.includes("财务|最终版.md"), idx.slice(0, 200));
  const seeded2 = Buffer.from("escape2");
  await writeCache({ root: idxRoot, rel: ".dsh-attachments" }, shortHashOf(seeded2), "换行\n名.md", "text", [
    { name: "doc.md", data: seeded2 }
  ], { sourceHash: sha256Of(seeded2), charCount: seeded2.length, lineCount: 1, docFile: "doc.md" });
  const idx2 = readFileSync(join(idxRoot, "INDEX.md"), "utf8");
  check("换行被折叠为空格", idx2.includes("换行 名.md") && !idx2.includes("换行\n名.md"), idx2.slice(0, 260));
}

console.log("\n== 修复验证：v0.6.1 sha-8 遗留目录被清理（不再成为不可见孤儿）==");
{
  const { cleanupCache, clearCache } = await import("../lib/cache.js");
  const { mkdirSync, writeFileSync: wf2 } = await import("node:fs");
  // cleanupCache 直接收缓存根目录
  const legacyRoot = join(temp, "legacy-cache");
  mkdirSync(join(legacyRoot, "a1b2c3d4"), { recursive: true });
  wf2(join(legacyRoot, "a1b2c3d4", "doc.md"), "legacy");
  await cleanupCache(legacyRoot);
  check("cleanup 删除 sha-8 遗留目录", !existsSync(join(legacyRoot, "a1b2c3d4")));
  // clearCache 收的是工作区 cwd（内部解析 .dsh-attachments）；显式 workspace 模式
  const legacyWorkspace = join(temp, "legacy-workspace");
  mkdirSync(join(legacyWorkspace, ".dsh-attachments", "deadbeef"), { recursive: true });
  wf2(join(legacyWorkspace, ".dsh-attachments", "deadbeef", "doc.md"), "legacy");
  const clearedLegacy = await clearCache(legacyWorkspace, "workspace");
  check("clear 删除 sha-8 遗留目录", clearedLegacy >= 1 && !existsSync(join(legacyWorkspace, ".dsh-attachments", "deadbeef")), `cleared=${clearedLegacy}`);
}

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
console.log(`产物目录: ${temp}`);
if (failures > 0) process.exitCode = 1;
