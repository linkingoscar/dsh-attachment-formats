/**
 * dsh-attachment-formats — 可选原生依赖探测（按需付费，不阻断安装）。
 *
 * `sharp` / `@napi-rs/canvas` 体积大且平台敏感，已迁 `optionalDependencies`。
 * 这里做三态探测：ok / missing（未安装）/ broken（二进制不匹配），调用方
 * 永远降级而非崩溃。
 */

let sharpState = "unprobed";
let sharpMod = null;
let sharpError = null;

/**
 * 按需加载 sharp。
 * @returns {Promise<{ ok: true, mod: any } | { ok: false, state: "missing"|"broken", error: unknown }>}
 */
export async function loadSharp() {
  if (sharpState !== "unprobed") {
    return sharpState === "ok"
      ? { ok: true, mod: sharpMod }
      : { ok: false, state: sharpState, error: sharpError };
  }
  try {
    const mod = await import("sharp");
    sharpMod = mod.default ?? mod;
    sharpState = "ok";
    return { ok: true, mod: sharpMod };
  } catch (error) {
    sharpError = error;
    const msg = String(error?.message ?? "");
    const code = error?.code;
    const isMissing =
      code === "MODULE_NOT_FOUND" ||
      /Cannot find (package|module).*sharp/.test(msg) ||
      /Could not load the "sharp" module/.test(msg);
    sharpState = isMissing ? "missing" : "broken";
    return { ok: false, state: sharpState, error };
  }
}

export function sharpStatus() {
  return { state: sharpState, error: sharpError };
}

let canvasState = "unprobed";
let canvasMod = null;
let canvasError = null;

/**
 * 按需加载 @napi-rs/canvas 的 createCanvas。
 * @returns {Promise<{ ok: true, createCanvas: Function } | { ok: false, state: string, error: unknown }>}
 */
export async function loadCanvas() {
  if (canvasState !== "unprobed") {
    return canvasState === "ok"
      ? { ok: true, createCanvas: canvasMod }
      : { ok: false, state: canvasState, error: canvasError };
  }
  try {
    const mod = await import("@napi-rs/canvas");
    canvasMod = mod.createCanvas ?? mod.default?.createCanvas ?? null;
    if (typeof canvasMod !== "function") throw new Error("createCanvas not found");
    canvasState = "ok";
    return { ok: true, createCanvas: canvasMod };
  } catch (error) {
    canvasError = error;
    const msg = String(error?.message ?? "");
    const code = error?.code;
    const isMissing =
      code === "MODULE_NOT_FOUND" ||
      /Cannot find (package|module).*canvas/.test(msg);
    canvasState = isMissing ? "missing" : "broken";
    return { ok: false, state: canvasState, error };
  }
}

export function canvasStatus() {
  return { state: canvasState, error: canvasError };
}
