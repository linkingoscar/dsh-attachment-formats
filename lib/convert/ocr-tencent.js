/**
 * dsh-attachment-formats — 腾讯云 OCR（host side，TC3-HMAC-SHA256）。
 *
 * 零依赖（Node crypto+fetch）。使用通用文字识别接口 GeneralBasicOCR。
 * 免费额度：1,000 次/月。失败回退本地 OCR。
 */

import { createHash, createHmac } from "node:crypto";

const HOST = "ocr.tencentcloudapi.com";
const SERVICE = "ocr";
const VERSION = "2018-11-19";
const ACTION = "GeneralBasicOCR";

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function hmacSha256(key, msg) {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

/**
 * @param {Buffer} jpegBuffer
 * @param {{ secretId: string, secretKey: string, region?: string, fetchLike?: typeof fetch }} opts
 * @returns {Promise<{ text: string, confidence: number }>}
 */
export async function tencentOcrPage(jpegBuffer, { secretId, secretKey, region = "ap-guangzhou", fetchLike = fetch }) {
  const id = String(secretId ?? "").trim();
  const key = String(secretKey ?? "").trim();
  if (id === "" || key === "") throw new Error("腾讯云 OCR 未配置 SecretId/SecretKey");
  const payload = JSON.stringify({ ImageBase64: jpegBuffer.toString("base64") });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const httpRequestMethod = "POST";
  const canonicalUri = "/";
  const canonicalQuerystring = "";
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedPayload = sha256Hex(payload);
  const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmacSha256(`TC3${key}`, date);
  const kService = hmacSha256(kDate, SERVICE);
  const kSigning = hmacSha256(kService, "tc3_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetchLike(`https://${HOST}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: HOST,
      "X-TC-Action": ACTION,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": VERSION,
      "X-TC-Region": region,
      Authorization: authorization
    },
    body: payload
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.Response?.Error) {
    throw new Error(`腾讯云 OCR 失败: ${data?.Response?.Error?.Message ?? JSON.stringify(data).slice(0, 400)}`);
  }
  const detections = data?.Response?.TextDetections ?? [];
  const text = (Array.isArray(detections) ? detections : []).map(d => d.DetectedText ?? "").filter(Boolean).join("\n");
  // 腾讯未直接给行置信度，取 AdvancedConfidence 的平均
  const confs = detections.filter(d => Number.isFinite(d.AdvancedInfo?.Parag?.WordConfidence)).map(d => d.AdvancedInfo.Parag.WordConfidence);
  const confidence = confs.length > 0 ? (confs.reduce((a, b) => a + b, 0) / confs.length) * 100 : 85;
  return { text, confidence };
}

export async function tencentOcrPages(pages, { secretId, secretKey, region, fetchLike = fetch }) {
  const results = [];
  for (let i = 0; i < pages.length; i += 1) {
    results.push(await tencentOcrPage(pages[i].data, { secretId, secretKey, region, fetchLike }));
    if (i < pages.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}
