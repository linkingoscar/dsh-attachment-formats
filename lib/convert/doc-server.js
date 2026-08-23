/**
 * dsh-attachment-formats — 外部文档解析服务（host side，v0.6）。
 *
 * DSH_ATTACH_DOC_SERVER=<base URL> 指向一个文档解析服务（如 PP-StructureV3
 * `paddleocr serve`、MinerU、或任意包装了下列契约的网关）。零依赖（multipart
 * 走 Node 原生 FormData/Blob）。
 *
 * 契约（POST multipart）：
 *   POST {base}/convert
 *     file   : 文件字节（字段名 "file"）
 *     format : "pdf" | "docx" | ...（可选）
 *   → 200 JSON { ok: true, markdown: "..." } | { ok: false, error: "..." }
 */
const TIMEOUT_MS = 300_000;

/**
 * 校验外部解析服务 URL（SSRF 防护）：
 *   - 仅允许 http/https（禁 file:/ftp:/data: 等）；
 *   - 禁 userinfo（user:pass@host 形式可夹带凭据/绕过解析）；
 *   - 必须可解析出 hostname。
 * 内网/localhost 地址默认允许（自建 MinerU/PaddleOCR 就跑在本机），
 * 这是用户在设置页显式配置的可信端点，非外部输入。
 * @param {string} raw - 用户配置的 base URL。
 * @returns {string} 规范化（去尾斜杠）后的 URL。
 */
export function validateDocServerUrl(raw) {
  const text = String(raw ?? "").trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`文档解析服务地址无效: ${text.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`文档解析服务仅支持 http/https（收到 ${parsed.protocol}）`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("文档解析服务地址不应包含 user:pass@ 凭据");
  }
  if (parsed.hostname === "") {
    throw new Error("文档解析服务地址缺少主机名");
  }
  return text.replace(/\/+$/, "");
}

/**
 * 调用外部解析服务把文档转成 Markdown。
 * @param {Buffer} bytes - 源文件字节。
 * @param {string} name - 文件名（用于 multipart 字段）。
 * @param {string} baseUrl - DSH_ATTACH_DOC_SERVER（去尾斜杠）。
 * @param {typeof fetch} [fetchLike] - 测试注入。
 * @returns {Promise<{ markdown: string }>}
 */
export async function docServerConvert(bytes, name, baseUrl, fetchLike = fetch) {
  const base = validateDocServerUrl(baseUrl);
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  form.append("format", "pdf");
  const response = await fetchLike(`${base}/convert`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null || typeof payload !== "object") {
    throw new Error(`文档解析服务错误 (HTTP ${response.status}): ${payload?.error ?? payload?.detail ?? "unknown"}`);
  }
  if (payload.ok !== true || typeof payload.markdown !== "string") {
    throw new Error(payload.error ?? "文档解析服务返回格式异常");
  }
  return { markdown: payload.markdown };
}
