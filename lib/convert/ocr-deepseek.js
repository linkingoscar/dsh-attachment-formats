/**
 * dsh-attachment-formats — DeepSeek Vision OCR（host side，零配置）。
 *
 * 复用宿主已配的 DeepSeek API Key（`~/.dsh/.credentials.yaml`），无需额外
 * base/model 配置。模型固定 deepseek-v4-flash-vision-exp（dsh@0.1.1-rc.1 起
 * 进 llm-deepseek 目录），prompt 约束表格用 GFM 管道表。
 * 失败回退本地 tesseract.js。
 */

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash-vision-exp";
const PROMPT = "你是高保真文档转录器。逐字转录这张扫描页面上的全部文字，按阅读顺序输出，保留段落与换行；表格必须转为 GFM Markdown 管道表（表头+分隔行+数据行）。只输出页面文字/表格本身，不要任何解释。";

/**
 * 解析 DeepSeek API Key（优先级：显式传入 → 宿主 credentials 服务 →
 * .credentials.yaml 文件 → env）。credentials 面是官方正道（覆盖
 * env/managed store/.env 三层），文件解析仅作服务缺失时的回退。
 * @param {string} explicitKey - 设置页/env 显式配置的 Key（可空）。
 * @param {{ get?: Function }} [ctxLike] - cordis ctx（用于读 credentials 服务）。
 * @returns {Promise<string>} 空字符串表示未找到。
 */
export async function resolveDeepSeekKey(explicitKey, ctxLike) {
  if (typeof explicitKey === "string" && explicitKey.trim() !== "") return explicitKey.trim();
  // 1) 官方 credentials 服务（dsh@rc.1+：resolve 覆盖 env/managed store/.env）
  try {
    const creds = ctxLike?.get?.("credentials");
    if (creds !== undefined && creds !== null && typeof creds.resolve === "function") {
      const hit = await creds.resolve("DEEPSEEK_API_KEY");
      if (hit !== undefined && hit !== null && typeof hit.value === "string" && hit.value.trim() !== "") {
        return hit.value.trim();
      }
    }
  } catch {
    /* 服务缺失：走文件回退 */
  }
  // 2) 文件回退（credentials 服务不可用时；极简解析，格式变化即失效）
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const dshHome = (process.env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
    const raw = await readFile(join(dshHome, ".credentials.yaml"), "utf8").catch(() => null);
    if (raw !== null) {
      const m = raw.match(/deepseek[^:\n]*:\s*([^\n#]+)/i) ?? raw.match(/api_key\s*:\s*([^\n#]+)/i);
      if (m) {
        const cand = m[1].trim().replace(/^["']|["']$/g, "");
        if (cand.length > 10) return cand;
      }
    }
  } catch {}
  // 3) env 兜底
  const env = (process.env.DEEPSEEK_API_KEY ?? process.env.DSH_ATTACH_VLM_KEY ?? "").trim();
  return env || "";
}

export async function deepseekOcrPage(jpeg, { key, base, model, ctxLike, fetchLike = fetch }) {
  const apiKey = await resolveDeepSeekKey(key, ctxLike);
  if (apiKey === "") throw new Error("DeepSeek Vision 未配置 API Key（请先在 dsh 模型设置页配 DeepSeek，或在插件设置页填 Key）");
  const b = (typeof base === "string" && base.trim() !== "" ? base.trim() : DEEPSEEK_BASE).replace(/\/+$/, "");
  const m = (typeof model === "string" && model.trim() !== "" ? model.trim() : DEEPSEEK_MODEL);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${apiKey}` };
  const res = await fetchLike(`${b}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: m,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } }
        ]
      }],
      max_tokens: 4096,
      temperature: 0
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload === null || typeof payload !== "object") {
    throw new Error(`DeepSeek Vision 错误 (HTTP ${res.status})`);
  }
  const text = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  // 空结果视为低置信度，由调用方回退
  return { text, confidence: text === "" ? 0 : 90 };
}

export async function deepseekOcrPages(pages, { key, base, model, ctxLike, fetchLike = fetch } = {}) {
  const results = [];
  for (let i = 0; i < pages.length; i += 1) {
    results.push(await deepseekOcrPage(pages[i].data, { key, base, model, ctxLike, fetchLike }));
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  return results;
}
