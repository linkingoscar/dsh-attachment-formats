/**
 * dsh-attachment-formats — OCR 通道冒烟测试（v3）。
 *
 * 1. 用画布生成一张高清"扫描件"（白底黑字）→ JPEG → 内嵌为无文本层 PDF；
 * 2. 走真实路由（DSH_ATTACH_ENGINE=builtin / OCR=auto）验证：
 *    文字层缺失 → tesseract.js OCR → kind:"text" 且内容可读；
 * 3. 噪声图（无法识别）→ 置信度门控回退 kind:"images" + 警告；
 * 4. 两个 text-cache 落盘后 .dsh-attachments/INDEX.md 聚合索引包含两者。
 * traineddata 缺失（离线）时 OCR 用例跳过而非失败。
 * 运行：npm run smoke:ocr
 */
import { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import * as plugin from "../lib/index.js";
import { disposeOcr, TESSDATA_DIR } from "../lib/convert/ocr.js";

const testCwd = mkdtempSync(join(tmpdir(), "dsh-ocr-test-"));
// v0.9 隔离：DSH_HOME 指向临时目录（防读真实凭据/写真实目录），
// 预置 workspace 模式使 INDEX.md 断言继续成立。
const testHome = mkdtempSync(join(tmpdir(), "dsh-ocr-home-"));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = testHome;
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(testHome, "storages"), { recursive: true });
  writeFileSync(
    join(testHome, "storages", "attachment-formats-config.json"),
    JSON.stringify({ revision: 1, cacheLocation: "workspace" })
  );
}

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

const engReady = existsSync(join(TESSDATA_DIR, "eng.traineddata.gz"));
const chiReady = existsSync(join(TESSDATA_DIR, "chi_sim.traineddata.gz"));

/** 画布文字 → JPEG → 无文本层 PDF（模拟扫描件）。 */
function buildScannedPdf(textLines) {
  const canvas = createCanvas(1800, 2400);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1800, 2400);
  context.fillStyle = "#111111";
  context.font = "bold 120px serif";
  textLines.forEach((line, index) => {
    context.fillText(line, 120, 300 + index * 220);
  });
  const jpeg = canvas.toBuffer("image/jpeg", 92);
  return embedJpegPdf(jpeg, 1800, 2400);
}

/** 把 JPEG 内嵌为单页 PDF（无任何文本层）。 */
function embedJpegPdf(jpeg, width, height) {
  const imgObj = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`;
  const content = `q ${612} 0 0 ${792} 0 0 cm /Im1 Do Q`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    imgObj,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${i + 1} 0 obj\n${objs[i]}`;
    if (i === 3) pdf += jpeg.toString("binary") + "\nendstream\nendobj\n";
    else pdf += `\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

/** 噪声图扫描件（OCR 无法识别 → 门控回退）。 */
function buildNoisePdf() {
  const canvas = createCanvas(900, 1200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 900, 1200);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 40000; i += 1) {
    context.fillStyle = `rgb(${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${Math.floor(rand() * 255)})`;
    context.fillRect(Math.floor(rand() * 900), Math.floor(rand() * 1200), 6, 6);
  }
  const jpeg = canvas.toBuffer("image/jpeg", 90);
  return embedJpegPdf(jpeg, 900, 1200);
}

// ---- 假 ctx + 路由驱动 ---------------------------------------------------
const routes = [];
const ctx = {
  effect(callback) {
    callback();
    return () => {};
  },
  webServer: { register(route) { routes.push(route); return () => {}; } },
  commands: { register() { return () => {}; } },
  get(name) {
    return name === "sessions" ? { get: () => ({ header: { cwd: testCwd } }) } : undefined;
  },
  logger: console
};
plugin.apply(ctx);

const previousEngine = process.env.DSH_ATTACH_ENGINE;
const previousOcr = process.env.DSH_ATTACH_OCR;
process.env.DSH_ATTACH_ENGINE = "builtin"; // 固定引擎，避免 python 干扰 OCR 用例
process.env.DSH_ATTACH_OCR = "tesseract-js"; // 显式本地 OCR：隔离真实凭据（DeepSeek Vision auto 探测）

async function callRoute(files, extra = {}) {
  const handler = routes.find((route) => route.path === "/api/attach-formats/convert").handler;
  const body = JSON.stringify({ files, sessionId: "test-session", cwd: testCwd, ...extra });
  const req = new Readable({
    read() {
      this.push(Buffer.from(body));
      this.push(null);
    }
  });
  req.method = "POST";
  req.url = "/api/attach-formats/convert";
  let status = 0;
  let response = "";
  const res = {
    writeHead(code) { status = code; },
    end(chunk) { response = String(chunk); }
  };
  await handler(req, res);
  return { status, body: JSON.parse(response) };
}

console.log("\n== 扫描件 OCR（干净文字图）==");
if (engReady && chiReady) {
  const scanned = buildScannedPdf(["HELLO SCANNED WORLD", "CONTRACT NUMBER 2026-0814"]);
  const { status, body } = await callRoute([
    { name: "扫描合同.pdf", kind: "pdf", data: scanned.toString("base64") }
  ]);
  check("status 200", status === 200, `got ${status}`);
  const result = body.results?.[0];
  check("result kind text", result?.kind === "text", `got ${result?.kind} ${JSON.stringify(result?.error ?? "")}`);
  if (result?.kind === "text") {
    check("ocr engine flag", result.engine === "tesseract-js" && result.ocr === true, `engine=${result.engine}`);
    const upper = String(result.text).toUpperCase();
    check("recognized content", upper.includes("HELLO") && upper.includes("SCANNED"), result.text.slice(0, 160).replace(/\n/g, " / "));
  }
} else {
  skip("扫描件 OCR（traineddata 未缓存，离线跳过）");
}

console.log("\n== 噪声图（置信度门控 → images 回退）==");
if (engReady && chiReady) {
  const noise = buildNoisePdf();
  const { body } = await callRoute([
    { name: "噪声.pdf", kind: "pdf", data: noise.toString("base64") }
  ]);
  const result = body.results?.[0];
  check("noise → images fallback", result?.kind === "images", `got ${result?.kind}`);
  check("fallback has warning", Array.isArray(result.warnings) && result.warnings.join("").includes("置信度"), JSON.stringify(result.warnings));
} else {
  skip("噪声图门控（traineddata 未缓存，离线跳过）");
}

console.log("\n== 聚合索引 INDEX.md（多文档）==");
{
  const countCacheDirs = () => {
    // 无 traineddata（CI）时 OCR 用例全跳过，.dsh-attachments 可能尚未创建：ENOENT 视为 0
    try {
      return readdirSync(join(testCwd, ".dsh-attachments"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
      return 0;
    }
  };
  const before = countCacheDirs(); // 前面的 OCR 用例可能已落盘缓存，用增量断言
  const longA = "a".repeat(70_000) + "\n# 甲文档\n";
  const longB = "b".repeat(70_000) + "\n# 乙文档\n";
  await callRoute([{ name: "甲.md", kind: "text-cache", data: Buffer.from(longA).toString("base64") }]);
  await callRoute([{ name: "乙.md", kind: "text-cache", data: Buffer.from(longB).toString("base64") }]);
  const indexPath = join(testCwd, ".dsh-attachments", "INDEX.md");
  check("INDEX.md exists", existsSync(indexPath));
  if (existsSync(indexPath)) {
    const index = readFileSync(indexPath, "utf8");
    check("INDEX.md lists both docs", index.includes("甲.md") && index.includes("乙.md"));
  }
  const after = countCacheDirs();
  check("two new cache dirs", after - before === 2, `before=${before} after=${after}`);
}

process.env.DSH_ATTACH_ENGINE = previousEngine ?? undefined;
process.env.DSH_ATTACH_OCR = previousOcr ?? undefined;
if (process.env.DSH_ATTACH_ENGINE === undefined) delete process.env.DSH_ATTACH_ENGINE;
if (process.env.DSH_ATTACH_OCR === undefined) delete process.env.DSH_ATTACH_OCR;
if (previousDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousDshHome;
await disposeOcr(); // 终止常驻 worker，避免测试进程挂起
rmSync(testCwd, { recursive: true, force: true });
rmSync(testHome, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "OCR 冒烟全部通过 ✅" : `${failures} 项失败 ❌`}${skipped > 0 ? `（${skipped} 项跳过）` : ""}`);
if (failures > 0) process.exitCode = 1;
