/**
 * dsh-attachment-formats — 转换引擎探测（host side，v3）。
 *
 * 引擎优先级（env 可覆盖）：
 *   DSH_ATTACH_ENGINE=auto|python|builtin   PDF 文本层引擎
 *   DSH_ATTACH_OCR=auto|baidu|tesseract-js|off  扫描件 OCR 引擎（baidu 见 ocr-baidu.js）
 *
 * `python` 引擎 = 项目内 venv（.venv/Scripts/python.exe）+ pymupdf4llm；
 * 探测结果带 TTL 缓存，缺失时自动回退 builtin（pdfjs 文字层）。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENV_PYTHON = join(PROJECT_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
export const PY_SCRIPT = join(PROJECT_DIR, "lib", "py", "pymupdf4llm_convert.py");

const PROBE_TTL_MS = 5 * 60 * 1000;
let pythonProbe = { at: 0, available: false };

/** 探测 venv python + pymupdf4llm 是否可用（TTL 5 分钟缓存失败与成功）。 */
export async function probePythonEngine() {
  const now = Date.now();
  if (now - pythonProbe.at < PROBE_TTL_MS) return pythonProbe.available;
  pythonProbe = { at: now, available: false };
  if (!existsSync(VENV_PYTHON) || !existsSync(PY_SCRIPT)) return false;
  try {
    const { spawn } = await import("node:child_process");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(VENV_PYTHON, ["-c", "import pymupdf4llm, pymupdf"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 30_000
      });
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? 1));
    });
    pythonProbe.available = code === 0;
  } catch {
    pythonProbe.available = false;
  }
  return pythonProbe.available;
}

/** 读取引擎配置（每次请求时读取，允许运行时切换）。 */
export function enginePolicy() {
  const engine = (process.env.DSH_ATTACH_ENGINE ?? "auto").toLowerCase();
  const ocr = (process.env.DSH_ATTACH_OCR ?? "auto").toLowerCase();
  const baidu = {
    apiKey: (process.env.BAIDU_OCR_API_KEY ?? "").trim(),
    secretKey: (process.env.BAIDU_OCR_SECRET ?? "").trim(),
    accurate: process.env.DSH_ATTACH_OCR_ACCURATE === "1"
  };
  const vlm = {
    base: (process.env.DSH_ATTACH_VLM_BASE ?? "").trim(),
    key: (process.env.DSH_ATTACH_VLM_KEY ?? "").trim(),
    model: (process.env.DSH_ATTACH_VLM_MODEL ?? "").trim(),
    configured: (process.env.DSH_ATTACH_VLM_BASE ?? "").trim() !== "" && (process.env.DSH_ATTACH_VLM_MODEL ?? "").trim() !== ""
  };
  const docServer = (process.env.DSH_ATTACH_DOC_SERVER ?? "").trim();
  const ocrPolicy = ocr === "tesseract-js" || ocr === "baidu" || ocr === "deepseek" || ocr === "vlm" || ocr === "off" ? ocr : "auto";
  return {
    engine: engine === "builtin" || engine === "python" ? engine : "auto",
    ocr: ocrPolicy,
    baidu,
    vlm,
    deepseekAuto: process.env.DSH_ATTACH_VISION_AUTO !== "0",
    docServer: docServer === "" ? null : docServer
  };
}

/**
 * 带持久化配置的策略（设置页优先，env 回退）。
 * @param {string|undefined} cwd - 会话工作区，用于定位配置文件
 * @returns {Promise<ReturnType<typeof enginePolicy> & { settings: any }>}
 */
/** 经官方 credentials seam 解析引用（服务缺失/无值返回空串）。 */
async function credValue(ctxLike, ref) {
  try {
    const c = ctxLike?.get?.("credentials");
    if (c !== undefined && c !== null && typeof c.resolve === "function") {
      const hit = await c.resolve(ref);
      if (hit !== undefined && hit !== null && typeof hit.value === "string" && hit.value.trim() !== "") return hit.value.trim();
    }
  } catch {}
  return "";
}

export async function enginePolicyWithSettings(cwd, ctxLike) {
  const base = enginePolicy();
  try {
    const { loadSettings } = await import("../settings.js");
    const cfg = await loadSettings(cwd);
    // engine
    if (cfg.engine && cfg.engine !== "auto") base.engine = cfg.engine;
    else if (cfg.engine === "auto") base.engine = "auto";
    // ocr provider: 设置页 provider 优先于 env
    const provider = String(cfg.ocr?.provider ?? "auto").toLowerCase();
    const allowed = new Set(["auto", "baidu", "aliyun", "tencent", "azure", "volc", "deepseek", "vlm", "tesseract-js", "off"]);
    if (allowed.has(provider) && provider !== "auto") base.ocr = provider;
    // 合并各供应商凭据：设置页非空则覆盖 env
    if (cfg.ocr?.baidu?.apiKey) base.baidu.apiKey = cfg.ocr.baidu.apiKey;
    if (cfg.ocr?.baidu?.secretKey) base.baidu.secretKey = cfg.ocr.baidu.secretKey;
    if (typeof cfg.ocr?.baidu?.accurate === "boolean") base.baidu.accurate = cfg.ocr.baidu.accurate;
    if (base.baidu.apiKey === "") base.baidu.apiKey = await credValue(ctxLike, "DSH_ATTACH_BAIDU_API_KEY");
    if (base.baidu.secretKey === "") base.baidu.secretKey = await credValue(ctxLike, "DSH_ATTACH_BAIDU_SECRET");
    // 扩展供应商通过 settings 透传
    base.aliyun = {
      appCode: String(cfg.ocr?.aliyun?.accessKeyId ?? cfg.ocr?.aliyun?.appCode ?? "").trim() || String(cfg.ocr?.aliyun?.accessKeySecret ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_ALIYUN_APPCODE"),
      raw: cfg.ocr?.aliyun ?? {}
    };
    base.tencent = {
      secretId: String(cfg.ocr?.tencent?.secretId ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_TENCENT_SECRET_ID"),
      secretKey: String(cfg.ocr?.tencent?.secretKey ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_TENCENT_SECRET_KEY"),
      region: String(cfg.ocr?.tencent?.region ?? "ap-guangzhou").trim() || "ap-guangzhou"
    };
    base.azure = {
      endpoint: String(cfg.ocr?.azure?.endpoint ?? "").trim(),
      apiKey: String(cfg.ocr?.azure?.apiKey ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_AZURE_KEY")
    };
    base.volc = {
      appCode: String(cfg.ocr?.volc?.accessKey ?? cfg.ocr?.volc?.appCode ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_VOLC_APPCODE")
    };
    base.deepseek = {
      key: String(cfg.ocr?.deepseek?.key ?? "").trim() || await credValue(ctxLike, "DSH_ATTACH_DEEPSEEK_KEY"),
      base: String(cfg.ocr?.deepseek?.base ?? "").trim(),
      model: String(cfg.ocr?.deepseek?.model ?? "").trim()
    };
    // auto 模式下是否允许视觉（设置页开关优先于 env，默认开）
    base.deepseekAuto = cfg.ocr?.deepseekAuto !== false && base.deepseekAuto !== false;
    // vlm 来自设置页覆盖 env
    if (cfg.ocr?.vlm?.base) base.vlm.base = cfg.ocr.vlm.base.trim();
    if (cfg.ocr?.vlm?.key) base.vlm.key = cfg.ocr.vlm.key.trim();
    if (base.vlm.key === "") base.vlm.key = await credValue(ctxLike, "DSH_ATTACH_VLM_KEY");
    if (cfg.ocr?.vlm?.model) base.vlm.model = cfg.ocr.vlm.model.trim();
    base.vlm.configured = base.vlm.base !== "" && base.vlm.model !== "";
    // docServer: 设置页 url 优先
    const docUrl = String(cfg.docServer?.url ?? "").trim();
    if (docUrl !== "") base.docServer = docUrl;
    // 兼容旧 env 的 docServer 仍有效（enginePolicy 已读）
    base._settings = cfg;
    return base;
  } catch {
    return base;
  }
}

/**
 * 运行 venv 内的 PDF 转换脚本。
 * @param {Buffer} pdfBytes - 编码 PDF。
 * @returns {Promise<{ok:true, engine:string, pages:string[], pageCount:number, hasTextLayer:boolean, toc?: Array<[number,string,number]>} | {ok:false, error:string}>}
 */
export async function runPythonPdf(pdfBytes) {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const dir = mkdtempSync(pathJoin(tmpdir(), "dsh-attach-py-"));
  const pdfPath = pathJoin(dir, "input.pdf");
  const outPath = pathJoin(dir, "result.json");
  writeFileSync(pdfPath, pdfBytes);
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(VENV_PYTHON, [PY_SCRIPT, pdfPath, outPath], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 180_000
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exit !== 0) return { ok: false, error: `python engine exited with code ${exit}` };
    const raw = readFileSync(outPath, "utf8");
    const result = JSON.parse(raw);
    if (result.ok !== true) return { ok: false, error: result.error ?? "python engine failed" };
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---- 外部二进制探测（P0：pandoc / LibreOffice）--------------------------

/** 探针缓存（TTL 10 分钟，与 python 探测同思路）。 */
const binProbes = new Map();
async function probeBinary(key, candidates, ttlMs = 10 * 60 * 1000) {
  const cached = binProbes.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < ttlMs) return cached.path;
  let found = null;
  for (const candidate of candidates) {
    const executable = candidate();
    if (executable === null) continue;
    try {
      const { spawn } = await import("node:child_process");
      const ok = await new Promise((resolve) => {
        const child = spawn(executable.path, executable.args, {
          windowsHide: true,
          stdio: "ignore",
          timeout: 20_000
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0 || code === 1)); // --version 正常退出码 0
      });
      if (ok) {
        found = executable;
        break;
      }
    } catch {
      /* 下一个候选 */
    }
  }
  binProbes.set(key, { at: now, path: found });
  return found;
}

/** 探测 pandoc（PATH 优先）。 */
export async function probePandoc() {
  return probeBinary("pandoc", [() => ({ path: "pandoc", args: ["--version"] })]);
}

/** 探测 LibreOffice soffice（PATH + Windows 常见安装路径）。 */
export function libreOfficeCandidates() {
  const candidates = [];
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA
  ].filter((root) => typeof root === "string" && root !== "");
  for (const root of roots) {
    candidates.push(() => {
      const path = join(root, "LibreOffice", "program", "soffice.exe");
      return existsSync(path) ? { path, args: ["--version"] } : null;
    });
  }
  candidates.push(() => ({ path: "soffice", args: ["--version"] }));
  return candidates;
}
export async function probeLibreOffice() {
  return probeBinary("soffice", libreOfficeCandidates());
}
