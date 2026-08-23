/**
 * dsh-attachment-formats — v0.6 P0 冒烟测试。
 *
 * 覆盖：DOCX 表格保真（turndown+GFM）、TIFF（sharp）、epub/odt zip 兜底、
 * pandoc 通道（条件）、LibreOffice 旧 .doc 转换（条件）、PDF 书签大纲（条件）。
 * 运行：npm run smoke:p0
 */
import sharp from "sharp";
import JSZip from "jszip";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import * as plugin from "../lib/index.js";
import { docxToText } from "../lib/convert/docx.js";
import { tiffToPngPages } from "../lib/convert/tiff.js";
import { convertPandocFormat } from "../lib/convert/pandoc.js";
import { probeLibreOffice, probePandoc, runPythonPdf, VENV_PYTHON } from "../lib/convert/provider.js";
import { libreOfficeConvert } from "../lib/convert/libreoffice.js";
import { extractPdfText } from "../lib/convert/pdftext.js";
import { resolveCacheRoot, writeCache, shortHashOf, sha256Of } from "../lib/cache.js";
import { existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "dsh-p0-"));

let failures = 0;
let skipped = 0;
function check(label, ok, extra = "") {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label} ${extra}`);
  }
}
function skip(label) {
  skipped += 1;
  console.log(`skip  ${label}`);
}

/** 带表格的 DOCX 夹具。 */
async function buildDocxWithTable() {
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
  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body>" +
      "<w:p><w:r><w:t>标题段落</w:t></w:r></w:p>" +
      `<w:tbl><w:tr>${cell("姓名")}${cell("分数")}</w:tr><w:tr>${cell("张三")}${cell("95")}</w:tr></w:tbl>` +
      "</w:body></w:document>"
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** 最小 epub 夹具。 */
async function buildEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.xhtml" media-type="application/xhtml+xml"/></rootfiles></container>'
  );
  zip.file(
    "OEBPS/content.xhtml",
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>章节一</h1><p>正文内容 ABC</p></body></html>'
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** 最小 odt 夹具。 */
async function buildOdt() {
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text");
  zip.file(
    "content.xml",
    '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">开放文档标题</text:h><text:p>开放文档正文 XYZ</text:p></office:text></office:body></office:document-content>'
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

console.log("\n== DOCX 表格保真（turndown+GFM）==");
{
  const fixture = await buildDocxWithTable();
  const text = await docxToText(new Uint8Array(fixture));
  check("段落保留", text.includes("标题段落"));
  check("表格转为 markdown 管道表", text.includes("|") && text.includes("姓名") && text.includes("张三") && text.includes("95"), text.slice(0, 300));
}

console.log("\n== TIFF（sharp）==");
{
  const tiff = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } }).tiff().toBuffer();
  const { pages, total, rendered } = await tiffToPngPages(tiff);
  check("单页 TIFF → 1 PNG", pages.length === 1 && total === 1 && rendered === 1);
  check("PNG 魔数", pages[0].mediaType === "image/png" && pages[0].data[0] === 0x89 && pages[0].data[1] === 0x50);
  check("尺寸 64x64", pages[0].width === 64 && pages[0].height === 64, `${pages[0].width}x${pages[0].height}`);
}

console.log("\n== epub/odt zip 兜底（无 pandoc 路径）==");
{
  const epub = await buildEpub();
  const text = await convertPandocFormat(epub, "epub", null);
  check("epub 兜底含章节与正文", text.includes("章节一") && text.includes("正文内容 ABC"), text.slice(0, 200));
  const odt = await buildOdt();
  const odtText = await convertPandocFormat(odt, "odt", null);
  check("odt 兜底含标题与正文", odtText.includes("开放文档标题") && odtText.includes("开放文档正文 XYZ"), odtText.slice(0, 200));
}

console.log("\n== pandoc 通道（条件）==");
{
  const pandoc = await probePandoc();
  if (pandoc === null) {
    skip("pandoc 未安装");
  } else {
    const epub = await buildEpub();
    const text = await convertPandocFormat(epub, "epub", pandoc.path);
    check("pandoc epub → markdown", text.includes("章节一") && text.includes("正文内容 ABC"), text.slice(0, 200));
  }
}

console.log("\n== LibreOffice 旧 .doc（条件）==");
{
  const soffice = await probeLibreOffice();
  if (soffice === null) {
    skip("LibreOffice 未安装");
  } else {
    const fixtureDocx = readFileSync(join(root, "temp", "fixture.docx"));
    // 先用 soffice 反向生成 .doc 夹具（docx → doc）
    const src = join(temp, "input.docx");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(src, fixtureDocx);
    const reverse = spawnSync(soffice.path, ["--headless", "--convert-to", "doc", "--outdir", temp, src], {
      windowsHide: true, timeout: 120_000, stdio: "ignore"
    });
    const legacy = join(temp, "input.doc");
    if (reverse.status === 0 && existsSync(legacy)) {
      const converted = await libreOfficeConvert(readFileSync(legacy), "doc", soffice.path);
      check("doc → docx 格式", converted.format === "docx");
      const text = await docxToText(new Uint8Array(converted.data));
      check("内容保留", text.includes("你好 DOCX 冒烟测试"), text.slice(0, 200));
    } else {
      check("soffice 反向生成 .doc 夹具", false, `exit=${reverse.status}`);
    }
  }
}

console.log("\n== PDF 书签大纲（条件：venv）==");
{
  if (!existsSync(VENV_PYTHON)) {
    skip("venv 未安装");
  } else {
    // 用 pymupdf 生成带书签的三页 PDF
    const pdfPath = join(temp, "toc.pdf");
    const script = [
      "import pymupdf",
      "doc = pymupdf.open()",
      "for i in range(3):",
      "    page = doc.new_page()",
      "    page.insert_text((72, 720), f'Page {i+1} body text')",
      "doc.set_toc([[1, 'Section One', 1], [1, 'Section Two', 2], [2, 'Sub A', 3]])",
      `doc.save(r'${pdfPath.replace(/\\/g, "\\\\")}')`
    ].join("\n");
    const built = spawnSync(VENV_PYTHON, ["-c", script], { windowsHide: true, timeout: 60_000, stdio: "ignore" });
    if (built.status === 0 && existsSync(pdfPath)) {
      const bytes = new Uint8Array(readFileSync(pdfPath));
      const extracted = await extractPdfText(bytes);
      check(
        "pdfjs 读到书签大纲",
        extracted.outline.some((line) => line.includes("Section One")) && extracted.outline.some((line) => line.includes("Section Two")),
        JSON.stringify(extracted.outline.slice(0, 6))
      );
      const pythonResult = await runPythonPdf(bytes);
      check("python 引擎返回 toc", pythonResult.ok === true && Array.isArray(pythonResult.toc) && pythonResult.toc.length === 3, JSON.stringify(pythonResult.toc));
    } else {
      check("pymupdf 生成书签夹具", false, `exit=${built.status}`);
    }
  }
}

console.log("\n== 百度 OCR provider（fake fetch 单测，无网络）==");
{
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/oauth/2.0/token")) {
      return { json: async () => ({ access_token: "TOKEN123", expires_in: 2592000 }) };
    }
    if (url.includes("/accurate_basic")) {
      return {
        json: async () => ({
          words_result: [
            { words: "第一行", probability: { average: 0.92 } },
            { words: "第二行", probability: { average: 0.88 } }
          ],
          words_result_num: 2
        })
      };
    }
    return { json: async () => ({ error_code: 17, error_msg: "Open api daily request limit reached" }) };
  };
  const { baiduOcrPages, BaiduQuotaError } = await import("../lib/convert/ocr-baidu.js");
  const results = await baiduOcrPages([{ data: Buffer.from("fakejpeg") }], {
    apiKey: "k", secretKey: "s", accurate: true, fetchLike: fakeFetch
  });
  check("百度 OCR 解析结果", results.length === 1 && results[0].text.includes("第一行") && results[0].text.includes("第二行"));
  check("置信度换算 90", Math.abs(results[0].confidence - 90) < 0.5, String(results[0].confidence));
  let quota = false;
  try {
    await baiduOcrPages([{ data: Buffer.from("x") }], { apiKey: "k", secretKey: "s", accurate: false, fetchLike: fakeFetch });
  } catch (error) {
    quota = error instanceof BaiduQuotaError;
  }
  check("配额错误映射 BaiduQuotaError", quota);
  const tokenCallsBefore = calls.filter((c) => c.url.includes("/oauth/2.0/token")).length;
  await baiduOcrPages([{ data: Buffer.from("y") }], { apiKey: "k", secretKey: "s", accurate: true, fetchLike: fakeFetch });
  check("token 缓存复用", calls.filter((c) => c.url.includes("/oauth/2.0/token")).length === tokenCallsBefore);
}

console.log("\n== 内容自适应引擎（条件：venv）==");
{
  if (!existsSync(VENV_PYTHON)) {
    skip("venv 未安装");
  } else {
    // 45 页纯文字 PDF → python 应主动让位（skipped）
    const textPdf = join(temp, "text45.pdf");
    const scriptText = [
      "import pymupdf",
      "doc = pymupdf.open()",
      "for i in range(45):",
      "    page = doc.new_page()",
      "    page.insert_text((72, 720), f'Section {i} plain text content')",
      "    page.insert_text((72, 690), 'more plain body text')",
      `doc.save(r'${textPdf.replace(/\\/g, "\\\\")}')`
    ].join("\n");
    const builtText = spawnSync(VENV_PYTHON, ["-c", scriptText], { windowsHide: true, timeout: 60_000, stdio: "ignore" });
    if (builtText.status === 0 && existsSync(textPdf)) {
      const result = await runPythonPdf(new Uint8Array(readFileSync(textPdf)));
      check("纯文字 45 页 → python 主动让位", result.ok === true && result.skipped === true && result.reason === "low-vector-density", JSON.stringify({ ok: result.ok, skipped: result.skipped, reason: result.reason }));
    } else {
      check("生成纯文字 45 页夹具", false, `exit=${builtText.status}`);
    }

    // 45 页矢量密集 PDF（每页 30 个矩形）→ python 应完整转换
    const vectorPdf = join(temp, "vector45.pdf");
    const scriptVector = [
      "import pymupdf",
      "doc = pymupdf.open()",
      "for i in range(45):",
      "    page = doc.new_page()",
      "    page.insert_text((72, 720), f'Table {i} with grid')",
      "    for r in range(30):",
      "        page.draw_rect(pymupdf.Rect(60 + r * 10, 60 + r * 10, 120 + r * 10, 120 + r * 10))",
      `doc.save(r'${vectorPdf.replace(/\\/g, "\\\\")}')`
    ].join("\n");
    const builtVector = spawnSync(VENV_PYTHON, ["-c", scriptVector], { windowsHide: true, timeout: 60_000, stdio: "ignore" });
    if (builtVector.status === 0 && existsSync(vectorPdf)) {
      const result = await runPythonPdf(new Uint8Array(readFileSync(vectorPdf)));
      check("矢量密集 45 页 → python 完整转换", result.ok === true && result.skipped !== true && result.hasTextLayer === true && Array.isArray(result.pages) && result.pages.length === 45, JSON.stringify({ ok: result.ok, skipped: result.skipped, pages: Array.isArray(result.pages) ? result.pages.length : 0 }));
    } else {
      check("生成矢量密集 45 页夹具", false, `exit=${builtVector.status}`);
    }
  }
}

console.log("\n== P2：路由级（doc-server / VLM / 缓存管理 / 零拷贝解析）==");
{
  const cacheTemp = mkdtempSync(join(tmpdir(), "dsh-p0-cache-"));
  const sessionCwds = { "test-session": temp, "cache-session": cacheTemp };
  const routes = [];
  const ctx = {
    effect(callback) {
      callback();
      return () => {};
    },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    commands: { register() { return () => {}; } },
    get(name) {
      return name === "sessions" ? { get: (id) => ({ header: { cwd: sessionCwds[id] ?? temp } }) } : undefined;
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} }
  };
  plugin.apply(ctx);

  const call = async (path, { method = "GET", body = null } = {}) => {
    const pathname = path.split("?")[0];
    const handler = routes.find((route) => route.path === pathname)?.handler;
    if (handler === undefined) return { status: 0, body: null };
    const req = new Readable({
      read() {
        if (body !== null) this.push(Buffer.from(body));
        this.push(null);
      }
    });
    req.method = method;
    req.url = path;
    let status = 0;
    let response = "";
    const res = {
      writeHead(code) { status = code; },
      end(chunk) { response = String(chunk); }
    };
    await handler(req, res);
    return { status, body: JSON.parse(response || "null") };
  };

  /** 无文本层 PDF（灰矩形）。extraContent 追加到内容流，让夹具字节可区分。 */
  const buildBlankPdf = (extraContent = "") => {
    const content = `q 0.5 0.5 0.5 RG 72 72 100 100 re f Q ${extraContent}`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
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
  };

  const previousEnv = {
    engine: process.env.DSH_ATTACH_ENGINE,
    ocr: process.env.DSH_ATTACH_OCR,
    docServer: process.env.DSH_ATTACH_DOC_SERVER,
    vlmBase: process.env.DSH_ATTACH_VLM_BASE,
    vlmModel: process.env.DSH_ATTACH_VLM_MODEL,
    vlmKey: process.env.DSH_ATTACH_VLM_KEY,
    dshHome: process.env.DSH_HOME
  };
  // v0.9 隔离：DSH_HOME 指向测试目录，home 模式缓存不落真实用户目录
  process.env.DSH_HOME = temp;
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const realFetch = globalThis.fetch;

  // ---- doc-server --------------------------------------------------------
  process.env.DSH_ATTACH_ENGINE = "builtin";
  process.env.DSH_ATTACH_OCR = "off";
  process.env.DSH_ATTACH_DOC_SERVER = "http://fake-doc-server";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/convert")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, markdown: "# 外部解析标题\n服务产出的 markdown 内容" }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  {
    const fixture = buildBlankPdf();
    const { body } = await call("/api/attach-formats/convert", {
      method: "POST",
      body: JSON.stringify({ sessionId: "test-session", cwd: temp, files: [{ name: "报告.pdf", kind: "pdf", data: fixture.toString("base64") }] })
    });
    const result = body?.results?.[0];
    check("doc-server → text 引擎标记", result?.kind === "text" && result?.engine === "doc-server", JSON.stringify(result?.error ?? result?.kind));
    check("doc-server 内容", String(result?.text).includes("服务产出的 markdown 内容"));
  }
  delete process.env.DSH_ATTACH_DOC_SERVER;

  // ---- VLM OCR（扫描件 → vlm 通道）---------------------------------------
  process.env.DSH_ATTACH_OCR = "vlm";
  process.env.DSH_ATTACH_VLM_BASE = "http://fake-vlm";
  process.env.DSH_ATTACH_VLM_MODEL = "fake-vision-model";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "VLM 转录的文字内容" } }] })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  {
    const blank = buildBlankPdf("q 0.5 0.5 0.5 RG 150 150 50 50 re f Q"); // 与 doc-server 用例字节不同，避免缓存命中
    const { body } = await call("/api/attach-formats/convert", {
      method: "POST",
      body: JSON.stringify({ sessionId: "test-session", cwd: temp, files: [{ name: "扫描.pdf", kind: "pdf", data: blank.toString("base64") }] })
    });
    const result = body?.results?.[0];
    check("vlm OCR → text", result?.kind === "text", `got ${result?.kind} ${JSON.stringify(result?.warnings ?? result?.error ?? "")}`);
    check("vlm 引擎标记", result?.engine === "vlm" && result?.ocr === true, `engine=${result?.engine}`);
    check("vlm 内容", String(result?.text).includes("VLM 转录的文字内容"));
  }
  delete process.env.DSH_ATTACH_VLM_BASE;
  delete process.env.DSH_ATTACH_VLM_MODEL;

  // ---- 缓存管理路由 ------------------------------------------------------
  // 使用独立 cacheTemp（sessionId=cache-session），与前面转换用例的缓存隔离
  {
    const { root } = resolveCacheRoot(cacheTemp, "home");
    const seeded = Buffer.from("缓存管理测试内容");
    await writeCache({ root, rel: null }, shortHashOf(seeded), "缓存文档.md", "text", [
      { name: "doc.md", data: seeded }
    ], { charCount: seeded.length, lineCount: 1, docFile: "doc.md" });
    const list = await call(`/api/attach-formats/cache?sessionId=cache-session&cwd=${encodeURIComponent(cacheTemp)}`);
    check("cache list 有文档", list.body?.ok === true && list.body.docs.length === 1 && list.body.docs[0].name === "缓存文档.md");
    check("cache size > 0", list.body?.sizeBytes > 0, String(list.body?.sizeBytes));
    const id = list.body.docs[0].id;
    const del = await call("/api/attach-formats/cache/delete", { method: "POST", body: JSON.stringify({ sessionId: "cache-session", cwd: cacheTemp, ids: [id] }) });
    check("cache delete", del.body?.ok === true && del.body.removed.includes(id));
    const afterDelete = await call(`/api/attach-formats/cache?sessionId=cache-session&cwd=${encodeURIComponent(cacheTemp)}`);
    check("cache 删除后为空", afterDelete.body?.docs.length === 0);
    let indexAfterDel = "";
    try { indexAfterDel = readFileSync(join(root, "INDEX.md"), "utf8"); } catch { /* ignore */ }
    check("删除后 INDEX 无 ghost 行", !indexAfterDel.includes("缓存文档.md"), indexAfterDel.slice(0, 200));
    await writeCache({ root, rel: null }, shortHashOf(seeded), "再种一个.md", "text", [
      { name: "doc.md", data: seeded }
    ], { charCount: seeded.length, lineCount: 1, docFile: "doc.md" });
    let indexAfterSeed = "";
    try { indexAfterSeed = readFileSync(join(root, "INDEX.md"), "utf8"); } catch { /* ignore */ }
    check("重建 INDEX 含再种文档", indexAfterSeed.includes("再种一个.md"), indexAfterSeed.slice(0, 200));
    check("INDEX 含转存时间列", /20\d\d-\d\d-\d\d \d\d:\d\d:\d\d/.test(indexAfterSeed), indexAfterSeed.slice(0, 200));
    const cleared = await call("/api/attach-formats/cache/clear", { method: "POST", body: JSON.stringify({ sessionId: "cache-session", cwd: cacheTemp }) });
    check("cache clear", cleared.body?.ok === true && cleared.body.cleared === 1, JSON.stringify(cleared.body));
  }

  // ---- 工作区零拷贝解析（名+大小+完整 SHA-256 同源判定）-------------------
  {
    const sub = join(temp, "subdir");
    mkdirSync(sub, { recursive: true });
    const big = "x".repeat(700 * 1024); // 700KB，超过 512KB 阈值
    writeFileSync(join(sub, "大文件.md"), big);
    const hash = sha256Of(Buffer.from(big));
    // 同名同大小的不同内容（silent substitution 陷阱）：哈希必须把候选过滤掉
    const subB = join(temp, "subdir-b");
    mkdirSync(subB, { recursive: true });
    writeFileSync(join(subB, "大文件.md"), "y".repeat(700 * 1024));
    const resolve = await call(`/api/attach-formats/resolve?sessionId=test-session&cwd=${encodeURIComponent(temp)}&name=${encodeURIComponent("大文件.md")}&size=${Buffer.byteLength(big)}&hash=${hash}`);
    check("resolve 哈希命中同源文件", resolve.body?.ok === true && resolve.body.found === true && resolve.body.rel === "subdir/大文件.md", JSON.stringify(resolve.body));
    const otherHash = sha256Of(Buffer.from("y".repeat(700 * 1024)));
    const substitute = await call(`/api/attach-formats/resolve?sessionId=test-session&cwd=${encodeURIComponent(temp)}&name=${encodeURIComponent("大文件.md")}&size=${Buffer.byteLength(big)}&hash=${otherHash}`);
    check("同源判定区分同名同大小不同内容", substitute.body?.ok === true && substitute.body.found === true && substitute.body.rel === "subdir-b/大文件.md", JSON.stringify(substitute.body));
    const noHash = await call(`/api/attach-formats/resolve?sessionId=test-session&cwd=${encodeURIComponent(temp)}&name=${encodeURIComponent("大文件.md")}&size=${Buffer.byteLength(big)}`);
    check("无 hash 不判定同源", noHash.body?.ok === true && noHash.body.found === false, JSON.stringify(noHash.body));
    const miss = await call(`/api/attach-formats/resolve?sessionId=test-session&cwd=${encodeURIComponent(temp)}&name=${encodeURIComponent("不存在.md")}&size=1&hash=${hash}`);
    check("resolve 未命中", miss.body?.ok === true && miss.body.found === false);
  }

  globalThis.fetch = realFetch;
  restoreEnv();
  try { rmSync(cacheTemp, { recursive: true, force: true }); } catch { /* ignore */ }
}

try { rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${failures === 0 ? "P0 冒烟全部通过 ✅" : `${failures} 项失败 ❌`}${skipped > 0 ? `（${skipped} 项跳过）` : ""}`);
if (failures > 0) process.exitCode = 1;
