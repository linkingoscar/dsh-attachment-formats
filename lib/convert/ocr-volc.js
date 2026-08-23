/**
 * dsh-attachment-formats — 火山引擎 OCR（host side，AK/SK 简化版）。
 *
 * 火山引擎文字识别兼容阿里云 AppCode 方式与 AK/SK 签名，这里采用与阿里云
 * 相同的 AppCode 头部，覆盖大多数用户的购买形态。复杂签名用户可切 VLM 通用接口。
 */

export async function volcOcrPage(jpegBuffer, { appCode, fetchLike = fetch }) {
  const code = String(appCode ?? "").trim();
  if (code === "") throw new Error("火山引擎 OCR 未配置 AppCode");
  // 火山复用阿里云市场 AppCode 形态
  const url = "https://ocr.volcengineapi.com/api/ocr/general";
  const res = await fetchLike(url, {
    method: "POST",
    headers: {
      Authorization: `APPCODE ${code}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ image: jpegBuffer.toString("base64") })
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`火山 OCR HTTP ${res.status}: ${payload?.msg ?? JSON.stringify(payload).slice(0, 300)}`);
  }
  const words = payload?.data?.words ?? payload?.words ?? [];
  const list = Array.isArray(words) ? words : [];
  const text = list.map(w => w.word ?? w.text ?? "").filter(Boolean).join("\n");
  const confidence = 85;
  return { text, confidence };
}

export async function volcOcrPages(pages, { appCode, fetchLike = fetch }) {
  const results = [];
  for (let i = 0; i < pages.length; i += 1) {
    results.push(await volcOcrPage(pages[i].data, { appCode, fetchLike }));
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  return results;
}
