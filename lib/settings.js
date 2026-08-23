/**
 * dsh-attachment-formats — 持久化配置（host side）。
 *
 * 单插件 <50M 约束：全部供应商均为轻量 fetch 实现，不捆 Python/模型。
 * 配置落盘位置：优先 DSH_HOME/storages/attachment-formats-config.json，
 * 无 DSH_HOME 时回退 cwd/.dsh-attachments/config.json（与缓存同根，便于迁移）。
 * 密钥字段以明文落盘（0600 权限尽力），返回给前端时脱敏。
 */

import { join, isAbsolute } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";

const CONFIG_FILE = "attachment-formats-config.json";

function configPath(cwd) {
  const dshHome = (process.env.DSH_HOME ?? "").trim();
  if (dshHome !== "" && isAbsolute(dshHome)) {
    return join(dshHome, "storages", CONFIG_FILE);
  }
  if (typeof cwd === "string" && cwd !== "" && isAbsolute(cwd)) {
    return join(cwd, ".dsh-attachments", CONFIG_FILE);
  }
  return join(process.cwd(), CONFIG_FILE);
}

const DEFAULTS = {
  version: 1,
  engine: "auto",
  cacheLocation: "home",
  ocr: {
    provider: "auto",
    deepseekAuto: true,
    baidu: { apiKey: "", secretKey: "", accurate: false },
    aliyun: { accessKeyId: "", accessKeySecret: "", endpoint: "" },
    tencent: { secretId: "", secretKey: "", region: "ap-guangzhou" },
    azure: { endpoint: "", apiKey: "" },
    volc: { accessKey: "", secretKey: "", endpoint: "" },
    deepseek: { key: "", base: "", model: "" },
    vlm: { base: "", key: "", model: "" }
  },
  docServer: {
    provider: "auto",
    url: ""
  }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalize(raw) {
  const out = clone(DEFAULTS);
  if (raw === null || typeof raw !== "object") return out;
  if (typeof raw.engine === "string") {
    const v = raw.engine.toLowerCase();
    if (v === "auto" || v === "python" || v === "builtin") out.engine = v;
  }
  if (raw.cacheLocation === "workspace") out.cacheLocation = "workspace";
  const ocr = raw.ocr;
  if (ocr !== null && typeof ocr === "object") {
    const p = typeof ocr.provider === "string" ? ocr.provider.toLowerCase() : "";
    const allowed = new Set(["auto", "baidu", "aliyun", "tencent", "azure", "volc", "deepseek", "vlm", "tesseract-js", "off"]);
    if (allowed.has(p)) out.ocr.provider = p;
    // legacy: DSH_ATTACH_OCR style top-level ocr string
    if (typeof raw.ocr === "string" && allowed.has(raw.ocr.toLowerCase())) {
      out.ocr.provider = raw.ocr.toLowerCase();
    }
    if (typeof ocr.deepseekAuto === "boolean") out.ocr.deepseekAuto = ocr.deepseekAuto;
    for (const key of ["baidu", "aliyun", "tencent", "azure", "volc", "deepseek", "vlm"]) {
      if (ocr[key] !== null && typeof ocr[key] === "object") {
        for (const field of Object.keys(DEFAULTS.ocr[key])) {
          const val = ocr[key][field];
          if (typeof val === "string") out.ocr[key][field] = val.trim();
          else if (typeof val === "boolean") out.ocr[key][field] = val;
        }
      }
    }
  }
  // 兼容旧 env 形态的 docServer 字符串
  if (typeof raw.docServer === "string") {
    out.docServer.url = raw.docServer.trim();
    out.docServer.provider = out.docServer.url ? "custom" : "auto";
  } else if (raw.docServer !== null && typeof raw.docServer === "object") {
    const p = typeof raw.docServer.provider === "string" ? raw.docServer.provider.toLowerCase() : "";
    const allowed = new Set(["auto", "custom", "paddle", "mineru", "marker", "docling", "off"]);
    if (allowed.has(p)) out.docServer.provider = p;
    if (typeof raw.docServer.url === "string") out.docServer.url = raw.docServer.url.trim();
  }
  return out;
}

async function readConfigFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadSettings(cwd) {
  const path = configPath(cwd);
  const file = await readConfigFile(path);
  // 兼容：尝试另一落盘位置
  if (file === null) {
    const alt = typeof cwd === "string" && isAbsolute(cwd) ? join(cwd, ".dsh-attachments", CONFIG_FILE) : null;
    if (alt !== null && alt !== path) {
      const altFile = await readConfigFile(alt);
      if (altFile !== null) return normalize(altFile);
    }
  }
  if (file === null) return clone(DEFAULTS);
  return normalize(file);
}

/** 读取配置文档（含 revision；对齐官方 settings 的乐观锁语义）。 */
export async function loadSettingsDoc(cwd) {
  const path = configPath(cwd);
  const file = await readConfigFile(path);
  const revision = Number.isFinite(file?.revision) ? file.revision : 0;
  const config = file === null ? clone(DEFAULTS) : normalize(file);
  return { config, revision };
}

function settingsConflictError() {
  const e = new Error("配置已被其他窗口修改，请刷新设置页后重试");
  e.code = "settings-conflict";
  return e;
}

/**
 * 保存配置。`expectedRevision` 提供时做乐观锁校验，冲突抛
 * code="settings-conflict"（调用方映射 409）。
 */
export async function saveSettings(cwd, patch, expectedRevision) {
  const path = configPath(cwd);
  const doc = await loadSettingsDoc(cwd);
  if (Number.isFinite(expectedRevision) && expectedRevision !== doc.revision) {
    throw settingsConflictError();
  }
  const current = doc.config;
  const next = normalize({ ...current, ...patch, ocr: { ...current.ocr, ...(patch.ocr ?? {}) }, docServer: { ...current.docServer, ...(patch.docServer ?? {}) } });
  // 深合并 ocr 子对象（保留未提及字段；显式传空字符串视为清除）
  if (patch.ocr) {
    for (const k of Object.keys(patch.ocr)) {
      if (patch.ocr[k] !== null && typeof patch.ocr[k] === "object" && DEFAULTS.ocr[k]) {
        next.ocr[k] = { ...current.ocr[k], ...patch.ocr[k] };
        for (const f of Object.keys(next.ocr[k])) {
          if (typeof next.ocr[k][f] === "string") next.ocr[k][f] = next.ocr[k][f].trim();
        }
      } else if (typeof patch.ocr[k] === "string" || typeof patch.ocr[k] === "boolean") {
        next.ocr[k] = patch.ocr[k];
      }
    }
    if (typeof patch.ocr.provider === "string") next.ocr.provider = patch.ocr.provider.toLowerCase();
    if (typeof patch.ocr.deepseekAuto === "boolean") next.ocr.deepseekAuto = patch.ocr.deepseekAuto;
  }
  if (patch.docServer) {
    if (typeof patch.docServer.provider === "string") next.docServer.provider = patch.docServer.provider.toLowerCase();
    if (typeof patch.docServer.url === "string") next.docServer.url = patch.docServer.url.trim();
  }
  if (typeof patch.engine === "string") {
    const v = patch.engine.toLowerCase();
    if (v === "auto" || v === "python" || v === "builtin") next.engine = v;
  }
  if (patch.cacheLocation === "home" || patch.cacheLocation === "workspace") next.cacheLocation = patch.cacheLocation;
  const nextRevision = doc.revision + 1;
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify({ revision: nextRevision, ...next }, null, 2) + "\n", "utf8");
  try {
    await import("node:fs").then(m => m.promises.rename(tmp, path));
  } catch {
    await writeFile(path, JSON.stringify({ revision: nextRevision, ...next }, null, 2) + "\n", "utf8");
  }
  try {
    await chmod(path, 0o600);
  } catch {}
  // 同步写另一位置以兼容旧读取路径（尽力；不带 revision，避免双源 CAS 漂移）
  if (typeof cwd === "string" && isAbsolute(cwd)) {
    const alt = join(cwd, ".dsh-attachments", CONFIG_FILE);
    if (alt !== path) {
      try {
        await mkdir(join(alt, ".."), { recursive: true });
        await writeFile(alt, JSON.stringify({ revision: nextRevision, ...next }, null, 2) + "\n", "utf8");
      } catch {}
    }
  }
  next.revision = nextRevision;
  return next;
}

export function redactForClient(cfg) {
  const out = clone(cfg);
  const mask = (s) => {
    if (typeof s !== "string" || s === "") return "";
    if (s.length <= 4) return "****";
    return `${s.slice(0, 2)}****${s.slice(-2)}`;
  };
  out.ocr.baidu.apiKey = mask(out.ocr.baidu.apiKey);
  out.ocr.baidu.secretKey = mask(out.ocr.baidu.secretKey);
  out.ocr.aliyun.accessKeyId = mask(out.ocr.aliyun.accessKeyId);
  out.ocr.aliyun.accessKeySecret = mask(out.ocr.aliyun.accessKeySecret);
  out.ocr.tencent.secretId = mask(out.ocr.tencent.secretId);
  out.ocr.tencent.secretKey = mask(out.ocr.tencent.secretKey);
  out.ocr.azure.apiKey = mask(out.ocr.azure.apiKey);
  out.ocr.volc.accessKey = mask(out.ocr.volc.accessKey);
  out.ocr.volc.secretKey = mask(out.ocr.volc.secretKey);
  out.ocr.deepseek.key = mask(out.ocr.deepseek.key);
  out.ocr.vlm.key = mask(out.ocr.vlm.key);
  return out;
}

export function defaults() {
  return clone(DEFAULTS);
}

/** 读缓存选址（"home" | "workspace"），失败回退 "home"。 */
export async function loadCacheLocation(cwd) {
  try {
    const cfg = await loadSettings(cwd);
    return cfg.cacheLocation === "workspace" ? "workspace" : "home";
  } catch {
    return "home";
  }
}
