/**
 * dsh-attachment-formats — 阿里云 OCR（host side，AppCode 简化版）。
 *
 * 阿里云文字识别有多种鉴权（AK/SK 签名、AppCode）。这里采用最易用的
 * AppCode 方式：用户在阿里云市场购买 OCR 服务后获得 AppCode，前端填入
 * accessKeyId 即为 AppCode，请求头 Authorization: APPCODE xxx。
 * 若用户填的是 AK/SK，提示改用 AppCode 或切 VLM 通用接口。
 *
 * 零依赖，失败回退本地 OCR。
 */

const ALIYUN_ENDPOINTS = {
  general: "https://ocr-api.cn-hangzhou.aliyuncs.com/ocrservice/general",
  accurate: "https://ocr-api.cn-hangzhou.aliyuncs.com/ocrservice/accurate"
};

/**
 * @param {Buffer} jpegBuffer
 * @param {{ appCode: string, accurate?: boolean, fetchLike?: typeof fetch }} opts
 * @returns {Promise<{ text: string, confidence: number }>}
 */
export async function aliyunOcrPage(jpegBuffer, { appCode, accurate = false, fetchLike = fetch }) {
  const code = String(appCode ?? "").trim();
  if (code === "") throw new Error("阿里云 OCR 未配置 AppCode");
  // 兼容：若填的是 AK/SK（形如 LTAI...），给明确指引
  if (/^LTAI/i.test(code)) {
    throw new Error("检测到阿里云 AccessKey，请改填 AppCode（阿里云市场 → 已购买服务 → AppCode），或改用 VLM 通用接口");
  }
  const url = accurate ? ALIYUN_ENDPOINTS.accurate : ALIYUN_ENDPOINTS.general;
  const body = JSON.stringify({ image: jpegBuffer.toString("base64") });
  const res = await fetchLike(url, {
    method: "POST",
    headers: {
      Authorization: `APPCODE ${code}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`阿里云 OCR HTTP ${res.status}: ${payload?.msg ?? payload?.error ?? JSON.stringify(payload).slice(0, 300)}`);
  }
  // 兼容两种返回：{data:{words:[]}} 或 {prism_wordsInfo:[]}
  const words = payload?.data?.words ?? payload?.prism_wordsInfo ?? payload?.words ?? [];
  const list = Array.isArray(words) ? words : [];
  const text = list.map(w => w.word ?? w.text ?? "").filter(Boolean).join("\n");
  const confidences = list.filter(w => Number.isFinite(w.probConfidence ?? w.confidence)).map(w => w.probConfidence ?? w.confidence);
  const confidence = confidences.length > 0 ? (confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100 : 85;
  return { text, confidence };
}

export async function aliyunOcrPages(pages, { appCode, accurate = false, fetchLike = fetch }) {
  const results = [];
  for (let i = 0; i < pages.length; i += 1) {
    results.push(await aliyunOcrPage(pages[i].data, { appCode, accurate, fetchLike }));
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  return results;
}
