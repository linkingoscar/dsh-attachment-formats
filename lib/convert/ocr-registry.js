/**
 * dsh-attachment-formats — OCR 提供商注册表（host side）。
 *
 * 把 lib/index.js 中 6 段几乎相同的 `loadSharp -> jpeg -> xxxOcrPages` 模板收敛为
 * 声明式 registry，新增供应商只需加一项。优先级与原链一致：
 *   baidu -> vlm -> aliyun -> tencent -> azure -> volc -> deepseek -> tesseract
 * `auto` 时按此顺序尝试首个可用；显式 provider 时仅试对应项。
 * 始终保持失败静默回退，不阻断主流程。
 */
import { loadSharp } from "../optional.js";
import { baiduOcrPages } from "./ocr-baidu.js";
import { aliyunOcrPages } from "./ocr-aliyun.js";
import { tencentOcrPages } from "./ocr-tencent.js";
import { azureOcrPages } from "./ocr-azure.js";
import { volcOcrPages } from "./ocr-volc.js";
import { vlmOcrPages } from "./ocr-vlm.js";
import { deepseekOcrPages, resolveDeepSeekKey } from "./ocr-deepseek.js";
import { ocrPages } from "./ocr.js";

async function toJpegPages(rendered) {
  const loaded = await loadSharp();
  if (!loaded.ok) return rendered.pages.map((page) => ({ data: Buffer.from(page.data) }));
  const out = [];
  for (const page of rendered.pages) {
    try {
      const buf = await loaded.mod(Buffer.from(page.data)).jpeg({ quality: 85 }).toBuffer();
      out.push({ data: buf });
    } catch {
      out.push({ data: Buffer.from(page.data) });
    }
  }
  return out;
}

function sectionsFrom(results) {
  const sections = results
    .map((entry, index) => ({ index, text: String(entry.text ?? "").trim() }))
    .filter((entry) => entry.text !== "")
    .map((entry) => `<!-- p${entry.index + 1} -->\n${entry.text}`);
  const chars = results.reduce((sum, entry) => sum + String(entry.text ?? "").length, 0);
  const confidence = results.length > 0
    ? results.reduce((sum, entry) => sum + (Number.isFinite(entry.confidence) ? entry.confidence : 0), 0) / results.length
    : 0;
  return { text: sections.join("\n\n"), chars, confidence };
}

/**
 * 按 policy 尝试 OCR 链，成功返回首个可用结果，全部失败返回 null。
 * @param {{ pages: Array<{data:Uint8Array}>, total:number }} rendered - 已渲染页
 * @param {ReturnType<import("./provider.js").enginePolicy>} policy
 * @param {any} ctx - cordis ctx 供 deepseek key 解析与日志
 * @param {{ onPage?: Function }} hooks
 * @returns {Promise<{ text:string, chars:number, confidence:number, engine:string, note:string|null }|null>}
 */
export async function runOcrChain(rendered, policy, ctx, hooks = {}) {
  if (rendered.pages.length === 0) return null;
  const want = (name) => policy.ocr === name || policy.ocr === "auto";
  // 预转换一次 jpeg（各云 OCR 均需 jpeg；tesseract 用原图，deepseek 也用 jpeg）
  let jpegCache = null;
  const getJpeg = async () => {
    if (jpegCache === null) jpegCache = await toJpegPages(rendered);
    return jpegCache;
  };

  // Baidu
  if (policy.baidu?.apiKey && policy.baidu?.secretKey && want("baidu")) {
    try {
      const jpegPages = await getJpeg();
      const results = await baiduOcrPages(jpegPages, {
        apiKey: policy.baidu.apiKey,
        secretKey: policy.baidu.secretKey,
        accurate: !!policy.baidu.accurate
      });
      const { text, chars, confidence } = sectionsFrom(results);
      return {
        text, chars, confidence,
        engine: `baidu${policy.baidu.accurate ? "-accurate" : ""}`,
        note: "百度 OCR（免费额度 1000 次/月）"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: baidu OCR failed: ${message}`);
      if (policy.ocr === "baidu") return { text: "", chars: 0, confidence: 0, engine: "baidu", note: `百度 OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // VLM (generic)
  if (policy.vlm?.configured && want("vlm")) {
    try {
      const jpegPages = await getJpeg();
      const results = await vlmOcrPages(jpegPages, {
        base: policy.vlm.base,
        key: policy.vlm.key,
        model: policy.vlm.model
      });
      const { text, chars, confidence } = sectionsFrom(results);
      return { text, chars, confidence, engine: "vlm", note: `远程 VLM OCR（${policy.vlm.model}，按 token 计费）` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: vlm OCR failed: ${message}`);
      if (policy.ocr === "vlm") return { text: "", chars: 0, confidence: 0, engine: "vlm", note: `VLM OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // Aliyun
  if (policy.aliyun?.appCode && want("aliyun")) {
    try {
      const jpegPages = await getJpeg();
      const results = await aliyunOcrPages(jpegPages, { appCode: policy.aliyun.appCode });
      const { text, chars, confidence } = sectionsFrom(results);
      return { text, chars, confidence, engine: "aliyun", note: "阿里云 OCR（AppCode）" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: aliyun OCR failed: ${message}`);
      if (policy.ocr === "aliyun") return { text: "", chars: 0, confidence: 0, engine: "aliyun", note: `阿里云 OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // Tencent
  if (policy.tencent?.secretId && policy.tencent?.secretKey && want("tencent")) {
    try {
      const jpegPages = await getJpeg();
      const results = await tencentOcrPages(jpegPages, {
        secretId: policy.tencent.secretId,
        secretKey: policy.tencent.secretKey,
        region: policy.tencent.region
      });
      const { text, chars, confidence } = sectionsFrom(results);
      return { text, chars, confidence, engine: "tencent", note: "腾讯云 OCR" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: tencent OCR failed: ${message}`);
      if (policy.ocr === "tencent") return { text: "", chars: 0, confidence: 0, engine: "tencent", note: `腾讯云 OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // Azure
  if (policy.azure?.apiKey && policy.azure?.endpoint && want("azure")) {
    try {
      const jpegPages = await getJpeg();
      const results = await azureOcrPages(jpegPages, { endpoint: policy.azure.endpoint, apiKey: policy.azure.apiKey });
      const { text, chars, confidence } = sectionsFrom(results);
      return { text, chars, confidence, engine: "azure", note: "Azure Document Intelligence" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: azure OCR failed: ${message}`);
      if (policy.ocr === "azure") return { text: "", chars: 0, confidence: 0, engine: "azure", note: `Azure OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // Volc
  if (policy.volc?.appCode && want("volc")) {
    try {
      const jpegPages = await getJpeg();
      const results = await volcOcrPages(jpegPages, { appCode: policy.volc.appCode });
      const { text, chars, confidence } = sectionsFrom(results);
      return { text, chars, confidence, engine: "volc", note: "火山引擎 OCR" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.logger?.warn?.(`dsh-attachment-formats: volc OCR failed: ${message}`);
      if (policy.ocr === "volc") return { text: "", chars: 0, confidence: 0, engine: "volc", note: `火山 OCR 不可用（${message}），已回退`, failed: true };
    }
  }
  // DeepSeek Vision
  const dsExplicit = policy.ocr === "deepseek";
  const dsAutoOk = policy.deepseekAuto !== false;
  if ((dsExplicit || (policy.ocr === "auto" && dsAutoOk))) {
    let dsKey = "";
    try {
      dsKey = await resolveDeepSeekKey(policy.deepseek?.key || policy.vlm?.key || "", ctx);
    } catch {}
    if (dsExplicit || dsKey !== "") {
      try {
        const jpegPages = await getJpeg();
        const results = await deepseekOcrPages(jpegPages, {
          key: dsKey,
          base: policy.deepseek?.base ?? "",
          model: policy.deepseek?.model ?? "",
          ctxLike: ctx
        });
        const { text, chars, confidence } = sectionsFrom(results);
        return {
          text, chars, confidence,
          engine: "deepseek-vision",
          note: "已用 DeepSeek Vision 转录（deepseek-v4-flash-vision-exp，表格已转 GFM，按 token 计费）"
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx?.logger?.warn?.(`dsh-attachment-formats: deepseek OCR failed: ${message}`);
        if (dsExplicit) return { text: "", chars: 0, confidence: 0, engine: "deepseek-vision", note: `DeepSeek Vision 不可用（${message}），已回退`, failed: true };
      }
    }
  }
  // Local tesseract
  if (policy.ocr === "auto" || policy.ocr === "tesseract-js") {
    try {
      const local = await ocrPages(rendered.pages, { onPage: hooks.onPage });
      return {
        text: local.text,
        chars: local.chars,
        confidence: local.confidence,
        engine: "tesseract-js",
        note: null
      };
    } catch (error) {
      ctx?.logger?.warn?.(`dsh-attachment-formats: tesseract OCR failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  return null;
}
