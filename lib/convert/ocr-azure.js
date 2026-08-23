/**
 * dsh-attachment-formats — Azure Document Intelligence OCR（host side）。
 *
 * 零依赖（Node fetch），按页调用 Read API（2024-02-29-preview）。
 * 配置：endpoint（如 https://xxx.cognitiveservices.azure.com）+ apiKey。
 * 免费层：500 页/月，超出按量计费；端点错误时抛错回退本地 OCR。
 */

function normalizeEndpoint(raw) {
  return String(raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * 提交一页并轮询结果。
 * @param {Buffer} jpegBuffer - JPEG 字节
 * @param {{ endpoint: string, apiKey: string, fetchLike?: typeof fetch }} opts
 * @returns {Promise<{ text: string, confidence: number }>}
 */
export async function azureOcrPage(jpegBuffer, { endpoint, apiKey, fetchLike = fetch }) {
  const base = normalizeEndpoint(endpoint);
  if (base === "" || apiKey === "") throw new Error("Azure OCR 未配置 endpoint/apiKey");
  const url = `${base}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-02-29-preview`;
  const init = await fetchLike(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/octet-stream"
    },
    body: jpegBuffer
  });
  if (!init.ok) {
    const body = await init.text().catch(() => "");
    throw new Error(`Azure OCR 提交失败 HTTP ${init.status}: ${body.slice(0, 300)}`);
  }
  const opLocation = init.headers.get("operation-location") ?? init.headers.get("Operation-Location");
  if (!opLocation) throw new Error("Azure OCR 未返回 operation-location");
  // 轮询
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(r => setTimeout(r, attempt < 3 ? 800 : 1500));
    const poll = await fetchLike(opLocation, {
      headers: { "Ocp-Apim-Subscription-Key": apiKey }
    });
    if (!poll.ok) {
      const body = await poll.text().catch(() => "");
      throw new Error(`Azure OCR 轮询失败 HTTP ${poll.status}: ${body.slice(0, 300)}`);
    }
    const payload = await poll.json();
    const status = String(payload?.status ?? "").toLowerCase();
    if (status === "succeeded") {
      // 优先 content（整页文本），否则拼 paragraphs
      let text = "";
      if (typeof payload?.analyzeResult?.content === "string") {
        text = payload.analyzeResult.content;
      } else if (Array.isArray(payload?.analyzeResult?.paragraphs)) {
        text = payload.analyzeResult.paragraphs.map(p => p.content ?? "").join("\n");
      } else if (Array.isArray(payload?.analyzeResult?.pages)) {
        text = payload.analyzeResult.pages.map(pg => (pg.lines ?? []).map(l => l.content ?? "").join("\n")).join("\n");
      }
      // 置信度：取所有 words 的平均
      let sum = 0, count = 0;
      const words = payload?.analyzeResult?.pages?.flatMap(pg => pg.words ?? []) ?? [];
      for (const w of words) {
        if (typeof w.confidence === "number") { sum += w.confidence; count += 1; }
      }
      const confidence = count > 0 ? (sum / count) * 100 : 85;
      return { text: String(text ?? "").trim(), confidence };
    }
    if (status === "failed") {
      throw new Error(`Azure OCR 处理失败: ${payload?.error?.message ?? "unknown"}`);
    }
  }
  throw new Error("Azure OCR 轮询超时");
}

/**
 * 逐页识别（顺序，尊重服务限流）。
 */
export async function azureOcrPages(pages, { endpoint, apiKey, fetchLike = fetch }) {
  const results = [];
  for (let i = 0; i < pages.length; i += 1) {
    results.push(await azureOcrPage(pages[i].data, { endpoint, apiKey, fetchLike }));
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 600));
  }
  return results;
}
