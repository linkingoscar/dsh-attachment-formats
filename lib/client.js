//#region src/client/runtime.js
let useState;
let useEffect;
let useRef;
let useCallback;
let useSyncExternalStore;
let jsx;
let jsxs;
let Fragment;
let Tooltip;
let IconPaperclipOutline16;
function initRuntime(require) {
	const react = require("react");
	const jsxRuntime = require("react/jsx-runtime");
	const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
	useState = react.useState;
	useEffect = react.useEffect;
	useRef = react.useRef;
	useCallback = react.useCallback;
	useSyncExternalStore = react.useSyncExternalStore;
	jsx = jsxRuntime.jsx;
	jsxs = jsxRuntime.jsxs;
	Fragment = jsxRuntime.Fragment;
	Tooltip = primitives.Tooltip;
	IconPaperclipOutline16 = primitives.IconPaperclipOutline16;
}

//#endregion
//#region src/client/contract.js
const ROUTE_PATH = "/api/attach-formats/convert";
const MAX_TEXT_BYTES = 2097152;
const MAX_TEXT_CHARS = 3e5;
/** 文本直插草稿的阈值；超过则上传主机走索引卡模式（T2）。 */
const DIRECT_TEXT_CHARS = 8e4;
/** 长文本上传主机的字节上限。 */
const MAX_CACHE_BYTES = 16777216;
const RASTER_PIXEL_CAP = 8e6;
const NATIVE_IMAGE_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	"txt",
	"md",
	"markdown",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"ndjson",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"log",
	"xml",
	"html",
	"htm",
	"css",
	"scss",
	"less",
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"tsx",
	"py",
	"java",
	"kt",
	"kts",
	"c",
	"h",
	"cpp",
	"hpp",
	"cc",
	"cs",
	"go",
	"rs",
	"rb",
	"php",
	"swift",
	"scala",
	"sql",
	"r",
	"lua",
	"pl",
	"dart",
	"ex",
	"exs",
	"elm",
	"hs",
	"clj",
	"fs",
	"fsx",
	"vue",
	"svelte",
	"graphql",
	"gql",
	"proto",
	"sh",
	"bat",
	"cmd",
	"ps1",
	"dockerfile",
	"makefile",
	"cmake",
	"gradle",
	"properties",
	"gitignore",
	"gitattributes",
	"editorconfig",
	"tex",
	"rst"
]);
const ACCEPT = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
	"image/avif",
	"image/svg+xml",
	"image/x-icon",
	"image/tiff",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/epub+zip",
	"application/vnd.oasis.opendocument.text",
	"application/rtf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/xml",
	".js",
	".ts",
	".jsx",
	".tsx",
	".py",
	".java",
	".go",
	".rs",
	".c",
	".h",
	".cpp",
	".cs",
	".rb",
	".php",
	".sh",
	".bat",
	".ps1",
	".sql",
	".yaml",
	".yml",
	".toml",
	".ini",
	".log",
	".vue",
	".svelte",
	".css",
	".scss",
	".html",
	".graphql",
	".doc",
	".xls",
	".ppt",
	".tiff",
	".tif",
	".epub",
	".odt",
	".rtf"
].join(",");
function extensionOf(name) {
	const base = String(name ?? "").toLowerCase();
	const dot = base.lastIndexOf(".");
	if (dot < 0 || dot === base.length - 1) return "";
	return base.slice(dot + 1);
}
function baseNameOf(name) {
	const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "attachment";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}
function bytesToBase64(bytes) {
	let binary = "";
	const chunk = 32768;
	for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	return btoa(binary);
}
function b64ToBytes(data) {
	const binary = atob(String(data ?? ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
function classifyFile(file) {
	const type = (file.type || "").toLowerCase();
	const ext = extensionOf(file.name);
	if (NATIVE_IMAGE_TYPES.has(type)) return "native-image";
	if (type === "application/pdf" || ext === "pdf") return "pdf";
	if (ext === "docx" || ext === "xlsx" || ext === "pptx") return ext;
	if (ext === "doc" || ext === "xls" || ext === "ppt") return ext;
	if (ext === "epub" || ext === "odt" || ext === "rtf") return ext;
	if (ext === "tiff" || ext === "tif" || type === "image/tiff") return "tiff";
	if (ext === "svg" || type === "image/svg+xml") return "browser-image";
	if (type.startsWith("image/")) return "browser-image";
	if (TEXT_EXTENSIONS.has(ext) || type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type === "application/x-yaml" || type === "application/javascript") return "text";
	return "unsupported";
}

//#endregion
//#region src/client/session-state.js
function composerTextarea() {
	const el = document.querySelector("[data-composer-card] textarea");
	return el instanceof HTMLTextAreaElement ? el : null;
}
function composerReady() {
	const el = composerTextarea();
	if (el === null) return false;
	return !el.disabled && !el.readOnly;
}
/** @type {any} */
let activeCtx = null;
function setActiveCtx(ctx) {
	activeCtx = ctx;
}
function currentSessionId() {
	return shellCurrentSessionId() ?? activeSession.sessionId;
}
/**
* 会话状态单例：sessionsService 由 apply 注入（客户端 runtime 的 ISessions，
* 形状远超本插件所需，any 边界声明）；sessionId/cwd 由插槽 inject 回写。
* @type {{ sessionId: string | undefined, cwd: string | undefined, sessionsService: any }}
*/
let activeSession = {
	sessionId: void 0,
	cwd: void 0,
	sessionsService: void 0
};
function shellCurrentSessionId() {
	const { sessionsService } = activeSession;
	if (sessionsService === void 0) return void 0;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		return typeof snapshot?.current === "string" && snapshot.current !== "" ? snapshot.current : void 0;
	} catch {
		return;
	}
}
function resolveSessionId(explicit) {
	if (typeof explicit === "string" && explicit !== "") return explicit;
	return shellCurrentSessionId() ?? activeSession.sessionId;
}
function currentCwd() {
	const { sessionsService } = activeSession;
	if (sessionsService === void 0) return void 0;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		const id = resolveSessionId(void 0);
		return snapshot?.byId?.[id]?.cwd ?? void 0;
	} catch {
		return;
	}
}
/** 供 intake 取单调序号（ESM 导入方不可直接改写 let）。 */
let intakeSeq = 0;
function nextIntakeSeq() {
	return ++intakeSeq;
}
function peekIntakeSeq() {
	return intakeSeq;
}
/** 当前会话输入 phase（adjudicating/submitting 视为忙——原生 drop 会拒绝）。 */
function currentSessionPhase(sessionId) {
	try {
		const svc = activeSession.sessionsService;
		if (svc === void 0 || sessionId === void 0) return void 0;
		return ((svc.binding?.(sessionId))?.hooks?.input ?? svc.provideInfo?.(sessionId)?.hooks?.input)?.getSnapshot?.()?.phase;
	} catch {
		return;
	}
}
/** 等当前会话空闲再投喂图片（忙时原生管线会拒绝合成 drop，图片会流到其它空闲会话）。 */
function waitForSessionIdle(sessionId, timeoutMs = 15e3) {
	return new Promise((resolve) => {
		const busy = (phase) => phase === "adjudicating" || phase === "submitting";
		if (!busy(currentSessionPhase(sessionId))) {
			resolve();
			return;
		}
		const deadline = Date.now() + timeoutMs;
		const timer = setInterval(() => {
			const phase = currentSessionPhase(sessionId);
			if (!busy(phase) || Date.now() > deadline) {
				clearInterval(timer);
				resolve();
			}
		}, 250);
	});
}
function contextBudgetChars() {
	const { sessionsService } = activeSession;
	const sessionId = resolveSessionId(void 0);
	if (sessionsService === void 0 || sessionId === void 0) return void 0;
	try {
		const snapshot = (sessionsService.binding(sessionId)?.session?.projections?.faceOf?.("contextPressure"))?.getSnapshot?.();
		if (snapshot === null || snapshot === void 0 || typeof snapshot !== "object") return void 0;
		const windowTokens = snapshot.contextWindow;
		const usedTokens = Number.isFinite(snapshot.projectedTokens) ? snapshot.projectedTokens : snapshot.surfaceTokens;
		if (!Number.isFinite(windowTokens) || !Number.isFinite(usedTokens)) return void 0;
		const reserve = Math.max(2e3, windowTokens * .15);
		const remaining = windowTokens - usedTokens - reserve;
		if (remaining <= 0) return 4e3;
		return Math.max(4e3, Math.floor(remaining * 1.5));
	} catch {
		return;
	}
}
function currentDirectLimit() {
	const budget = contextBudgetChars();
	return budget === void 0 ? DIRECT_TEXT_CHARS : Math.min(DIRECT_TEXT_CHARS, budget);
}

//#endregion
//#region src/client/ui/styles.js
function injectStyles() {
	if (document.getElementById("dsh-attachment-formats-styles")) return;
	const el = document.createElement("style");
	el.id = "dsh-attachment-formats-styles";
	el.textContent = [
		".dshaf-btn{width:32px;height:32px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}",
		".dshaf-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
		".dshaf-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
		".dshaf-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset);flex:none}",
		".dshaf-bar{background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 92%, var(--dsw-alias-label-primary,#e6e8ee));border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.4));border-radius:12px;align-items:center;gap:10px;min-height:36px;margin:0 auto;padding:4px 10px 4px 12px;display:flex}",
		".dshaf-bar-error{border-color:var(--dsw-alias-state-error-primary)}",
		".dshaf-lead{color:var(--dsw-alias-label-tertiary);flex:none;width:16px;place-items:center;display:grid}",
		".dshaf-spinner{box-sizing:border-box;width:14px;height:14px;border:2px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:dshaf-spin .8s linear infinite;display:inline-block}",
		"@keyframes dshaf-spin{to{transform:rotate(360deg)}}",
		".dshaf-text{min-width:0;flex-direction:column;flex:1;display:flex}",
		".dshaf-label{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:18px;overflow:hidden}",
		".dshaf-detail{color:var(--dsw-alias-label-secondary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:16px;overflow:hidden}",
		".dshaf-close{width:24px;height:24px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}",
		".dshaf-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
		".dshaf-chipbar{box-sizing:border-box;background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 92%, var(--dsw-alias-label-primary,#e6e8ee));border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.35));border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.12);align-items:center;gap:8px;min-height:44px;max-height:96px;overflow-y:auto;margin:0 auto 8px;padding:7px 10px;display:flex;flex-wrap:wrap}",
		".dshaf-chipbar-hint{color:var(--dsw-alias-label-tertiary,#8b93a5);flex:none;font-size:11px;font-weight:500;letter-spacing:.02em;line-height:30px;padding-left:4px;padding-right:2px;text-transform:uppercase}",
		".dshaf-chip{background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 80%, var(--dsw-alias-label-primary,#e6e8ee));border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.3));border-radius:8px;align-items:center;gap:7px;max-width:320px;height:28px;padding:0 6px 0 10px;display:inline-flex}",
		".dshaf-chip:hover{border-color:var(--dsw-alias-border-l2,rgba(127,140,160,.55))}",
		".dshaf-chip-icon{flex:none;font-size:12px;line-height:1;opacity:.9}",
		".dshaf-chip-text{min-width:0;align-items:baseline;gap:6px;display:flex}",
		".dshaf-chip-name{color:var(--dsw-alias-label-primary,#e6e8ee);white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:450;line-height:28px;max-width:200px;overflow:hidden}",
		".dshaf-chip-meta{color:var(--dsw-alias-label-tertiary,#8b93a5);white-space:nowrap;font-size:11px;line-height:28px;font-variant-numeric:tabular-nums;font-feature-settings:\"tnum\"}",
		".dshaf-chip-remove{width:20px;height:20px;color:var(--dsw-alias-label-tertiary,#8b93a5);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;justify-content:center;align-items:center;padding:0;font-size:10px;line-height:1;display:inline-flex}",
		".dshaf-chip-remove:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e6e8ee)}",
		".dshaf-chip-send{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary,#4c8dff) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4c8dff) 16%, var(--dsw-specific-input-major,#1f2430));color:var(--dsw-alias-state-business-primary,#7fb0ff);cursor:pointer;border-radius:10px;flex:none;height:30px;padding:0 14px;font-size:12px;font-weight:600;line-height:28px}",
		".dshaf-chip-send:hover{background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4c8dff) 28%, var(--dsw-specific-input-major,#1f2430))}",
		".dshaf-settings{display:flex;flex-direction:column;gap:12px;max-width:760px}",
		".dshaf-settings-head{display:flex;justify-content:space-between;align-items:center;gap:12px}",
		".dshaf-settings-title{min-width:0;flex-direction:column;display:flex}",
		".dshaf-settings-name{color:var(--dsw-alias-label-primary,#e6e8ee);font-size:15px;font-weight:600;line-height:22px}",
		".dshaf-settings-sub{color:var(--dsw-alias-label-secondary,#aab0bd);font-size:12px;line-height:18px}",
		".dshaf-settings-btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.4));background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 88%, var(--dsw-alias-label-primary,#e6e8ee));color:var(--dsw-alias-label-primary,#e6e8ee);cursor:pointer;border-radius:8px;flex:none;height:30px;padding:0 12px;font-size:12px;line-height:28px}",
		".dshaf-settings-btn:hover{border-color:var(--dsw-alias-border-l2,rgba(127,140,160,.65))}",
		".dshaf-settings-btn:disabled{opacity:.5;cursor:default}",
		".dshaf-settings-error{color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px;line-height:18px}",
		".dshaf-settings-note{color:var(--dsw-alias-state-success-primary,#3fb950);font-size:12px;line-height:18px}",
		".dshaf-settings-empty{color:var(--dsw-alias-label-secondary,#aab0bd);font-size:13px;line-height:20px;border:1px dashed var(--dsw-alias-border-l1,rgba(127,140,160,.4));border-radius:10px;padding:16px}",
		".dshaf-settings-list{flex-direction:column;gap:8px;display:flex}",
		".dshaf-settings-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.4));background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 90%, var(--dsw-alias-label-primary,#e6e8ee));border-radius:10px;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;display:flex}",
		".dshaf-settings-rowtext{min-width:0;flex-direction:column;flex:1;display:flex}",
		".dshaf-settings-rowname{color:var(--dsw-alias-label-primary,#e6e8ee);white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}",
		".dshaf-settings-rowmeta{color:var(--dsw-alias-label-tertiary,#8b93a5);white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:16px;overflow:hidden}",
		".dshaf-settings-group{border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.25));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 94%, var(--dsw-alias-label-primary,#e6e8ee))}",
		".dshaf-settings-group-title{color:var(--dsw-alias-label-primary,#e6e8ee);font-size:13px;font-weight:600;line-height:20px}",
		".dshaf-settings-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
		".dshaf-settings-label{color:var(--dsw-alias-label-secondary,#aab0bd);font-size:12px;line-height:20px;min-width:90px}",
		".dshaf-settings-select{flex:1;min-width:160px;height:30px;border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.35));border-radius:8px;background:var(--dsw-specific-input-major,#1f2430);color:var(--dsw-alias-label-primary,#e6e8ee);padding:0 8px;font-size:12px}",
		".dshaf-settings-input{flex:1;min-width:160px;height:30px;border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.35));border-radius:8px;background:var(--dsw-specific-input-major,#1f2430);color:var(--dsw-alias-label-primary,#e6e8ee);padding:0 10px;font-size:12px}",
		".dshaf-settings-input::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a5)}",
		".dshaf-settings-subgroup{border-left:2px solid var(--dsw-alias-border-l1,rgba(127,140,160,.2));padding-left:12px;margin-left:2px;display:flex;flex-direction:column;gap:8px}",
		".dshaf-settings-hint{color:var(--dsw-alias-label-tertiary,#8b93a5);font-size:11px;line-height:16px}",
		".dshaf-settings-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#aab0bd);cursor:pointer}",
		".dshaf-chip-clickable{cursor:pointer}",
		".dshaf-chip-clickable:hover{background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 70%, var(--dsw-alias-label-primary,#e6e8ee))}",
		".dshaf-lightbox{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.55));backdrop-filter:var(--dsw-mask-blur,blur(4px));display:flex;align-items:center;justify-content:center;padding:24px}",
		".dshaf-lightbox-body{background:var(--dsw-specific-input-major,#1f2430);border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.4));border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);max-width:min(920px,92vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}",
		".dshaf-lightbox-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:13px;flex:none}",
		".dshaf-lightbox-close{width:26px;height:26px;color:var(--dsw-alias-label-tertiary,#8b93a5);cursor:pointer;background:0 0;border:none;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}",
		".dshaf-lightbox-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e6e8ee)}",
		".dshaf-lightbox-img{display:block;max-width:100%;max-height:70vh;object-fit:contain;margin:0 auto;background:#fff}",
		".dshaf-lightbox-nav{display:flex;justify-content:center;gap:10px;padding:10px;flex:none}",
		".dshaf-lightbox-nav button{border:1px solid var(--dsw-alias-border-l1,rgba(127,140,160,.4));background:color-mix(in srgb, var(--dsw-specific-input-major,#1f2430) 88%, var(--dsw-alias-label-primary,#e6e8ee));color:var(--dsw-alias-label-primary,#e6e8ee);cursor:pointer;border-radius:8px;height:28px;padding:0 12px;font-size:12px}",
		".dshaf-lightbox-nav button:disabled{opacity:.4;cursor:default}",
		"@media (prefers-reduced-motion: reduce){.dshaf-spinner{animation:none}}"
	].join("\n");
	document.head.appendChild(el);
}

//#endregion
//#region src/client/bus.js
let busState = null;
const busListeners = /* @__PURE__ */ new Set();
function setBus(patch) {
	busState = patch === null ? null : {
		seq: Date.now(),
		...patch
	};
	for (const listener of busListeners) listener();
}
function subscribeBus(listener) {
	busListeners.add(listener);
	return () => {
		busListeners.delete(listener);
	};
}
function useBusState() {
	return useSyncExternalStore(subscribeBus, () => busState, () => null);
}
let chipsState = {
	sessionId: void 0,
	items: []
};
const chipsListeners = /* @__PURE__ */ new Set();
function setChips(items, sessionId) {
	chipsState = {
		sessionId,
		items
	};
	for (const listener of chipsListeners) listener();
}
function subscribeChips(listener) {
	chipsListeners.add(listener);
	return () => {
		chipsListeners.delete(listener);
	};
}
function useChipsState() {
	return useSyncExternalStore(subscribeChips, () => chipsState, () => ({
		sessionId: void 0,
		items: []
	}));
}
let chipSeq = 0;
function addChips(entries, sessionId) {
	const next = [...chipsState.sessionId === sessionId ? chipsState.items : []];
	for (const entry of entries) next.push({
		key: `chip-${++chipSeq}`,
		chars: entry.text.length,
		...entry
	});
	setChips(next, sessionId);
}
function removeChip(key) {
	const sessionId = currentSessionId();
	const next = (chipsState.sessionId === sessionId ? chipsState.items : []).filter((item) => item.key !== key);
	setChips(next, sessionId);
	if (next.length === 0 && busState !== null && busState.phase === "done") setBus(null);
}

//#endregion
//#region src/client/official-face.js
function conversationFace() {
	const ctx = activeCtx;
	if (ctx === null || ctx === void 0) return void 0;
	try {
		return ctx.conversation;
	} catch {
		return;
	}
}
function inputShellOf(sessionId) {
	if (sessionId === void 0) return void 0;
	try {
		const scope = activeSession.sessionsService?.scope?.(sessionId);
		if (scope === void 0) return void 0;
		return conversationFace()?.input?.for?.(scope);
	} catch {
		return;
	}
}
/**
* 经官方面把图片文件挂入指定会话的草稿栏。
* @returns {boolean|null} true=成功；false=面可用但被拒（忙）；null=面不可用
*/
function attachImagesOfficially(files, sessionId) {
	const conversation = conversationFace();
	if (conversation === void 0 || typeof conversation.createDraftImages !== "function") return null;
	const shell = inputShellOf(sessionId);
	if (shell === void 0 || typeof shell.addImages !== "function") return null;
	let created = null;
	try {
		created = conversation.createDraftImages(files);
	} catch {
		return null;
	}
	let ok = false;
	try {
		ok = shell.addImages(created.map((image) => image.id)) !== false;
	} catch {
		ok = false;
	}
	if (!ok && typeof conversation.releaseDraftImages === "function") try {
		conversation.releaseDraftImages(created);
	} catch {}
	return ok;
}
/**
* 经官方 setDraft 把文本块并入草稿（机器正规写路径，plain 相才接受）。
* @returns {boolean|null} true=已并入；false=忙/命令认领中；null=面不可用
*/
function mergeDraftBlocksOfficially(blocks, sessionId) {
	const shell = inputShellOf(sessionId);
	if (shell === void 0 || typeof shell.setDraft !== "function" || shell.state === void 0) return null;
	try {
		const state = shell.state.getSnapshot();
		if (state.phase !== "plain") return false;
		const current = typeof state.draft === "string" ? state.draft : "";
		shell.setDraft(current.trim() === "" ? blocks.replace(/^\n+/, "") : current + blocks);
		return true;
	} catch {
		return null;
	}
}

//#endregion
//#region src/client/browser-convert.js
function loadImage(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(/* @__PURE__ */ new Error("图片解码失败"));
		img.src = url;
	});
}
function canvasToPngFile(canvas, name) {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				resolve(null);
				return;
			}
			resolve(new File([blob], name, { type: "image/png" }));
		}, "image/png");
	});
}
function drawIntoPng(source, width, height, name) {
	const scale = Math.min(1, Math.sqrt(RASTER_PIXEL_CAP / Math.max(1, width * height)));
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const context = canvas.getContext("2d");
	if (context === null) return Promise.resolve(null);
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, w, h);
	try {
		context.drawImage(source, 0, 0, w, h);
	} catch {
		return Promise.resolve(null);
	}
	return canvasToPngFile(canvas, name);
}
async function fileToPngFile(file) {
	const name = `${baseNameOf(file.name) || "image"}.png`;
	if ((file.type || "").toLowerCase() === "image/svg+xml" || extensionOf(file.name) === "svg") {
		const text = await file.text();
		const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
		try {
			const img = await loadImage(url);
			return await drawIntoPng(img, img.naturalWidth || img.width || 1024, img.naturalHeight || img.height || 1024, name);
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	let bitmap = null;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		const url = URL.createObjectURL(file);
		try {
			const img = await loadImage(url);
			return await drawIntoPng(img, img.naturalWidth || img.width, img.naturalHeight || img.height, name);
		} catch {
			return null;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	try {
		return await drawIntoPng(bitmap, bitmap.width, bitmap.height, name);
	} finally {
		bitmap.close();
	}
}
function countReplacement(text) {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 65533) count += 1;
	return count;
}
async function fileToText(file) {
	if (file.size > 2097152) throw new Error(`文本文件过大（超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)}MB），未附加`);
	const bytes = new Uint8Array(await file.arrayBuffer());
	const head = bytes.subarray(0, Math.min(8192, bytes.length));
	let nuls = 0;
	for (const byte of head) if (byte === 0) nuls += 1;
	if (nuls > head.length * .02) throw new Error("文件看起来是二进制内容，未按文本附加");
	let text = new TextDecoder("utf-8").decode(bytes);
	const utf8Broken = countReplacement(text);
	if (utf8Broken > Math.min(64, Math.max(8, text.length * .005))) try {
		const alt = new TextDecoder("gb18030").decode(bytes);
		if (countReplacement(alt) < utf8Broken) text = alt;
	} catch {}
	if (text.length > 3e5) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[内容过长，已截断]`;
	return text;
}
/** 浏览器本地 SHA-256（完整内容哈希，供 host 同源判定；不可用时返回 null）。 */
async function fileSha256(file) {
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}
/**
* 工作区零拷贝：按「文件名 + 字节数 + 完整 SHA-256」询问主机是否有
* 同源文件（P2-1）。name+size 只是候选过滤，哈希相等才算同源——
* 同名同大小的不同内容绝不挂成 workspace ref。
*/
async function resolveWorkspaceRef(file, cwd, sessionId) {
	try {
		const hash = await fileSha256(file);
		if (hash === null) return null;
		const params = new URLSearchParams({
			name: file.name,
			size: String(file.size),
			hash
		});
		if (cwd !== void 0) params.set("cwd", cwd);
		if (sessionId !== void 0) params.set("sessionId", sessionId);
		const response = await fetch(`/api/attach-formats/resolve?${params.toString()}`, { signal: AbortSignal.timeout(4e3) });
		if (!response.ok) return null;
		const payload = await response.json();
		if (payload?.ok !== true || payload?.found !== true || typeof payload.rel !== "string") return null;
		return payload.rel;
	} catch {
		return null;
	}
}
async function convertRemote(file, kind, cwd, sessionId, directLimit, hooks = {}) {
	const data = await bytesToBase64Async(new Uint8Array(await file.arrayBuffer()));
	let response;
	try {
		response = await new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", ROUTE_PATH);
			xhr.responseType = "text";
			if (typeof hooks.onUploadPercent === "function") xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) hooks.onUploadPercent(Math.min(99, Math.round(event.loaded / event.total * 90)));
			};
			xhr.onload = () => resolve({
				ok: xhr.status >= 200 && xhr.status < 300,
				status: xhr.status,
				text: xhr.response
			});
			xhr.onerror = () => reject(/* @__PURE__ */ new Error("network"));
			xhr.send(JSON.stringify({
				cwd,
				sessionId,
				directLimitChars: directLimit,
				jobId: hooks.jobId,
				files: [{
					name: file.name,
					kind,
					data
				}]
			}));
		});
	} catch {
		throw new Error("转换服务不可用（主机插件未加载？）");
	}
	if (!response.ok) throw new Error(`转换服务错误 (HTTP ${response.status})`);
	const payload = JSON.parse(response.text);
	if (!payload || payload.ok !== true) throw new Error(payload?.error?.message ?? "转换服务返回异常");
	const result = Array.isArray(payload.results) ? payload.results[0] : null;
	if (result === null || result === void 0) throw new Error("转换服务未返回结果");
	if (result.kind === "error") throw new Error(result.error?.message ?? "转换失败");
	return result;
}
const B64_WORKER_SRC = "self.onmessage=(e)=>{try{const u8=new Uint8Array(e.data.buf);let binary=\"\";const chunk=0x8000;for(let o=0;o<u8.length;o+=chunk)binary+=String.fromCharCode.apply(null,u8.subarray(o,o+chunk));self.postMessage({b64:btoa(binary)});}catch(err){self.postMessage({err:String(err&&err.message||err)});}};";
let b64WorkerUrl = null;
/**
* Worker 内做 base64 编码；环境不支持 Worker（vm 冒烟/老浏览器）时回退同步。
* @param {Uint8Array} bytes
* @returns {Promise<string>}
*/
function bytesToBase64Async(bytes) {
	if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return Promise.resolve(bytesToBase64(bytes));
	try {
		if (b64WorkerUrl === null) b64WorkerUrl = URL.createObjectURL(new Blob([B64_WORKER_SRC], { type: "text/javascript" }));
		return new Promise((resolve) => {
			const worker = new Worker(b64WorkerUrl);
			worker.onmessage = (event) => {
				worker.terminate();
				if (event.data && typeof event.data.b64 === "string") resolve(event.data.b64);
				else resolve(bytesToBase64(bytes));
			};
			worker.onerror = () => {
				worker.terminate();
				resolve(bytesToBase64(bytes));
			};
			const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			worker.postMessage({ buf }, [buf]);
		});
	} catch {
		return Promise.resolve(bytesToBase64(bytes));
	}
}

//#endregion
//#region src/client/intake.js
function redispatchDrop(files) {
	const dt = new DataTransfer();
	for (const file of files) dt.items.add(file);
	let event;
	try {
		event = new DragEvent("drop", {
			bubbles: false,
			cancelable: true,
			dataTransfer: dt
		});
	} catch {
		event = new Event("drop", {
			bubbles: false,
			cancelable: true
		});
		Object.defineProperty(event, "dataTransfer", { value: dt });
	}
	document.dispatchEvent(event);
}
function injectTexts(notes) {
	const el = composerTextarea();
	if (el === null) return false;
	const blocks = notes.map(({ name, text, note, raw }) => raw ? `\n\n${text}` : note ? `\n\n[附件说明: ${name}]\n${text}` : `\n\n[附件: ${name}]\n${text}`).join("");
	const current = el.value;
	const next = current.trim() === "" ? blocks.replace(/^\n+/, "") : current + blocks;
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	if (typeof setter !== "function") return false;
	setter.call(el, next);
	if (el.value !== next) return false;
	el.setSelectionRange(next.length, next.length);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	try {
		el.focus({ preventScroll: false });
	} catch {}
	return true;
}
/**
* 把卡片并入当前会话草稿：官方 setDraft 优先，DOM 桥接兜底。
* @returns {boolean} true=已并入；false=忙或失败（卡片保留）
*/
function mergeChipsIntoDraft() {
	const sessionId = currentSessionId();
	const mine = chipsState.sessionId === sessionId ? chipsState.items : [];
	if (mine.length === 0) return true;
	const blocks = mine.map((item) => item.raw ? `\n\n${item.text}` : item.note ? `\n\n[附件说明: ${item.name}]\n${item.text}` : `\n\n[附件: ${item.name}]\n${item.text}`).join("");
	const official = mergeDraftBlocksOfficially(blocks, sessionId);
	if (official !== null) {
		if (official === false) {
			setBus({
				phase: "error",
				label: "输入框正忙，卡片暂未并入",
				detail: "等当前回复完成或命令取消后再按发送；卡片内容已保留"
			});
			return false;
		}
		setChips([], sessionId);
		if (busState !== null && busState.phase === "done") setBus(null);
		return true;
	}
	const el = composerTextarea();
	if (el === null || el.disabled || el.readOnly) return false;
	const phase = currentSessionPhase(sessionId);
	if (phase === "adjudicating" || phase === "submitting" || phase === "claimed") return false;
	if (!injectTexts(mine.map((item) => ({
		name: item.name,
		text: item.text,
		note: item.kind === "note",
		raw: item.kind === "card" || item.kind === "ref"
	})))) {
		setBus({
			phase: "error",
			label: "卡片内容未能并入输入框",
			detail: "请使用卡片条的「发送」按钮重试；若仍失败，先移除卡片后手动复制内容"
		});
		return false;
	}
	setChips([], sessionId);
	if (busState !== null && busState.phase === "done") setBus(null);
	return true;
}
function sendChipsNow() {
	if (!mergeChipsIntoDraft()) return;
	const shell = inputShellOf(currentSessionId());
	if (shell !== void 0 && typeof shell.submit === "function") try {
		shell.submit();
		return;
	} catch {}
	const el = composerTextarea();
	if (el === null) return;
	try {
		el.focus({ preventScroll: false });
	} catch {}
	el.dispatchEvent(new KeyboardEvent("keydown", {
		key: "Enter",
		code: "Enter",
		keyCode: 13,
		which: 13,
		bubbles: true,
		cancelable: true
	}));
}
async function intake(files, explicitSessionId) {
	const seq = nextIntakeSeq();
	if (files.length === 0) return;
	if (!composerReady()) {
		setBus({
			phase: "error",
			label: "无法接收附件",
			detail: "请先选择/创建工作区，并等待当前回复完成后再试"
		});
		return;
	}
	const cwd = currentCwd();
	const sessionId = resolveSessionId(explicitSessionId);
	const directLimit = currentDirectLimit();
	const images = [];
	const chips = [];
	const failedNames = [];
	let firstError = null;
	let budgetTiered = false;
	setBus({
		phase: "working",
		label: files.length === 1 ? `正在处理 ${files[0].name}` : `正在处理 ${files.length} 个文件`,
		detail: ""
	});
	for (const file of files) {
		const kind = classifyFile(file);
		try {
			switch (kind) {
				case "native-image":
					images.push(file);
					break;
				case "browser-image": {
					setBus({
						phase: "working",
						label: file.name,
						detail: "正在转换为图片…"
					});
					const png = await fileToPngFile(file);
					if (png !== null) images.push(png);
					else setBus({
						phase: "error",
						label: file.name,
						detail: "图片解码失败，已跳过"
					});
					break;
				}
				case "text": {
					if (file.size > 16777216) throw new Error(`文件过大（超过 ${Math.round(MAX_CACHE_BYTES / 1024 / 1024)}MB），未附加`);
					if (file.size > 524288) {
						setBus({
							phase: "working",
							label: file.name,
							detail: "正在校验工作区同源文件…"
						});
						const ref = await resolveWorkspaceRef(file, cwd, sessionId);
						if (ref !== null) {
							chips.push({
								name: file.name,
								kind: "ref",
								text: `[附件引用: ${file.name}]\n工作区文件: ${ref}\n（内容未上传；用 read 工具按行读取，行号即出处坐标）`,
								tagExtra: "引用"
							});
							break;
						}
					}
					if (file.size <= 2097152) {
						setBus({
							phase: "working",
							label: file.name,
							detail: "正在读取文本…"
						});
						const text = await fileToText(file);
						if (text.length <= directLimit) {
							chips.push({
								name: file.name,
								kind: "text",
								text
							});
							break;
						}
						if (text.length <= 8e4) budgetTiered = true;
						setBus({
							phase: "working",
							label: file.name,
							detail: text.length <= 8e4 ? "上下文余量不足，正在转存并生成索引…" : "文档较大，正在转存并生成索引…"
						});
						const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit);
						if (cached.kind === "index") chips.push({
							name: file.name,
							kind: "card",
							text: cached.card,
							tagExtra: text.length <= 8e4 ? "余量不足" : void 0
						});
						else if (cached.kind === "text") chips.push({
							name: file.name,
							kind: "text",
							text: cached.text
						});
						else throw new Error("长文本转存失败");
						break;
					}
					setBus({
						phase: "working",
						label: file.name,
						detail: "文档较大，正在上传转存并生成索引…"
					});
					const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit);
					if (cached.kind === "index") chips.push({
						name: file.name,
						kind: "card",
						text: cached.card
					});
					else if (cached.kind === "text") chips.push({
						name: file.name,
						kind: "text",
						text: cached.text
					});
					else throw new Error("长文本转存失败");
					break;
				}
				case "pdf":
				case "docx":
				case "xlsx":
				case "pptx":
				case "doc":
				case "xls":
				case "ppt":
				case "epub":
				case "odt":
				case "rtf": {
					setBus({
						phase: "working",
						label: file.name,
						detail: kind === "pdf" ? "正在提取文字层…" : "正在提取文本…"
					});
					const jobId = kind === "pdf" ? `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : void 0;
					let pollTimer = null;
					if (jobId !== void 0) pollTimer = setInterval(async () => {
						try {
							const p = await (await fetch(`/api/attach-formats/progress?jobId=${encodeURIComponent(jobId)}`)).json();
							if (p?.found === true && p.phase === "working" && p.label) setBus({
								phase: "working",
								label: file.name,
								detail: p.label
							});
						} catch {}
					}, 600);
					let result;
					try {
						result = await convertRemote(file, kind, cwd, sessionId, directLimit, {
							jobId,
							onUploadPercent: (pct) => setBus({
								phase: "working",
								label: file.name,
								detail: `上传中 ${pct}%`
							})
						});
					} finally {
						if (pollTimer !== null) clearInterval(pollTimer);
					}
					if (result.kind === "images") {
						for (const image of result.images) images.push(new File([b64ToBytes(image.data)], image.name, { type: image.mediaType }));
						if (Array.isArray(result.warnings) && result.warnings.length > 0) chips.push({
							name: file.name,
							kind: "note",
							text: result.warnings.join("\n")
						});
					} else if (result.kind === "text") {
						const isVision = typeof result.engine === "string" && result.engine.includes("deepseek");
						chips.push({
							name: file.name,
							kind: "text",
							text: result.text,
							tagExtra: isVision ? "视觉" : void 0
						});
					} else if (result.kind === "index") {
						if (result.tierReason === "budget") budgetTiered = true;
						const visionTag = typeof result.engine === "string" && result.engine.includes("deepseek") ? "视觉" : void 0;
						const budgetTag = result.tierReason === "budget" ? "余量不足" : void 0;
						const tagExtra = visionTag && budgetTag ? `${visionTag}·${budgetTag}` : visionTag ?? budgetTag;
						chips.push({
							name: file.name,
							kind: "card",
							text: result.card,
							tagExtra,
							preview: result.hasPageImages === true && typeof result.id === "string" ? {
								id: result.id,
								pageCount: result.pageCount ?? 0
							} : null
						});
					}
					break;
				}
				case "tiff": {
					setBus({
						phase: "working",
						label: file.name,
						detail: "正在转换为图片…"
					});
					const result = await convertRemote(file, kind, cwd, sessionId, directLimit, { onUploadPercent: (pct) => setBus({
						phase: "working",
						label: file.name,
						detail: `上传中 ${pct}%`
					}) });
					if (result.kind === "images") {
						for (const image of result.images) images.push(new File([b64ToBytes(image.data)], image.name, { type: image.mediaType }));
						if (Array.isArray(result.warnings) && result.warnings.length > 0) chips.push({
							name: file.name,
							kind: "note",
							text: result.warnings.join("\n")
						});
					} else if (result.kind === "error") throw new Error(result.error?.message ?? "TIFF 转换失败");
					break;
				}
				default: {
					failedNames.push(file.name);
					const message = `暂不支持该格式${file.type === "" ? "" : `（${file.type}）`}，已跳过`;
					if (firstError === null) firstError = message;
					setBus({
						phase: "error",
						label: file.name,
						detail: message
					});
				}
			}
		} catch (error) {
			failedNames.push(file.name);
			if (firstError === null) firstError = error instanceof Error ? error.message : String(error);
			setBus({
				phase: "error",
				label: file.name,
				detail: error instanceof Error ? error.message : String(error)
			});
		}
	}
	if (seq !== peekIntakeSeq()) return;
	if (images.length > 0) {
		const readyLabel = images.length === 1 ? "图片已就绪" : `${images.length} 张图片已就绪`;
		let attached = attachImagesOfficially(images, sessionId);
		if (attached === false) {
			setBus({
				phase: "working",
				label: readyLabel,
				detail: "等待当前会话空闲后附加…"
			});
			await waitForSessionIdle(sessionId);
			if (seq !== peekIntakeSeq()) return;
			attached = attachImagesOfficially(images, sessionId);
		}
		if (attached === null) {
			setBus({
				phase: "working",
				label: readyLabel,
				detail: "等待当前会话空闲后附加…"
			});
			await waitForSessionIdle(sessionId);
			if (seq !== peekIntakeSeq()) return;
			redispatchDrop(images);
		} else if (attached === false) {
			failedNames.push("(图片)");
			if (firstError === null) firstError = "当前会话仍忙，图片未附加，请稍后重试";
			setBus({
				phase: "error",
				label: "图片附加失败",
				detail: firstError
			});
		}
	}
	if (chips.length > 0) addChips(chips, sessionId);
	const parts = [];
	if (images.length > 0) parts.push(`${images.length} 张图片`);
	if (chips.length > 0) parts.push(`${chips.length} 个文档卡片`);
	if (parts.length === 0 && failedNames.length > 0) {
		setBus({
			phase: "error",
			label: "附件处理失败",
			detail: firstError ?? "转换失败"
		});
		return;
	}
	setBus({
		phase: "done",
		label: parts.length > 0 ? `已挂载 ${parts.join("、")}${failedNames.length > 0 ? `；${failedNames.length} 个文件失败` : ""}，输入框保持干净，发送时自动并入消息` : "附件处理完成",
		detail: budgetTiered ? "部分文档因上下文余量不足转为索引卡（可用 read 工具按需读取，或 /attach full 并入全文）" : ""
	});
}

//#endregion
//#region src/client/ui/components.js
function fileUrl(id, name) {
	const params = new URLSearchParams({
		id,
		name
	});
	const cwd = currentCwd();
	const sessionId = activeSession?.sessionId;
	if (cwd !== void 0) params.set("cwd", cwd);
	if (sessionId !== void 0) params.set("sessionId", sessionId);
	return `/api/attach-formats/file?${params.toString()}`;
}
function PreviewLightbox({ preview, onClose }) {
	const [state, setState] = useState({
		loading: true,
		pages: [],
		idx: 0,
		error: null
	});
	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				const manifest = await (await fetch(fileUrl(preview.id, "manifest.json"))).json();
				const pages = (Array.isArray(manifest?.files) ? manifest.files : []).filter((name) => /^pages\/p\d+\.(png|jpg)$/.test(name)).sort();
				if (!alive) return;
				if (pages.length === 0) throw new Error("该文档没有可预览的页面图");
				setState({
					loading: false,
					pages,
					idx: 0,
					error: null
				});
			} catch (error) {
				if (alive) setState({
					loading: false,
					pages: [],
					idx: 0,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		})();
		return () => {
			alive = false;
		};
	}, [preview.id]);
	useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
			else if (event.key === "ArrowLeft") setState((s) => ({
				...s,
				idx: Math.max(0, s.idx - 1)
			}));
			else if (event.key === "ArrowRight") setState((s) => ({
				...s,
				idx: Math.min(s.pages.length - 1, s.idx + 1)
			}));
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const pageName = state.pages[state.idx];
	return jsxs("div", {
		className: "dshaf-lightbox",
		onClick: onClose,
		role: "dialog",
		"aria-label": `预览 ${preview.id}`,
		children: [jsxs("div", {
			className: "dshaf-lightbox-body",
			onClick: (e) => e.stopPropagation(),
			children: [
				jsxs("div", {
					className: "dshaf-lightbox-head",
					children: [jsx("span", { children: state.loading ? "加载中…" : state.error !== null ? state.error : `第 ${state.idx + 1} / ${state.pages.length} 页` }), jsx("button", {
						type: "button",
						className: "dshaf-lightbox-close",
						"aria-label": "关闭预览",
						onClick: onClose,
						children: "✕"
					})]
				}),
				state.loading || state.error !== null ? null : jsx("img", {
					className: "dshaf-lightbox-img",
					src: fileUrl(preview.id, pageName),
					alt: `第 ${state.idx + 1} 页`
				}),
				state.error === null && state.pages.length > 1 ? jsxs("div", {
					className: "dshaf-lightbox-nav",
					children: [jsx("button", {
						type: "button",
						disabled: state.idx === 0,
						onClick: () => setState((s) => ({
							...s,
							idx: s.idx - 1
						})),
						children: "上一页"
					}), jsx("button", {
						type: "button",
						disabled: state.idx >= state.pages.length - 1,
						onClick: () => setState((s) => ({
							...s,
							idx: s.idx + 1
						})),
						children: "下一页"
					})]
				}) : null
			]
		})]
	});
}
function ChipPill({ item, onPreview }) {
	const tag = item.kind === "card" ? "索引" : item.kind === "note" ? "说明" : item.kind === "ref" ? "引用" : "全文";
	const base = item.chars >= 1e3 ? `${(item.chars / 1e3).toFixed(1)}k 字符 · ${tag}` : `${item.chars} 字符 · ${tag}`;
	const meta = item.tagExtra === void 0 ? base : `${base} · ${item.tagExtra}`;
	const icon = item.kind === "card" ? "🗂" : item.kind === "ref" ? "📎" : "📄";
	const clickable = item.kind === "card" && item.preview !== null && item.preview !== void 0;
	return jsxs("div", {
		className: clickable ? "dshaf-chip dshaf-chip-clickable" : "dshaf-chip",
		title: clickable ? `${item.name}（${tag}）— 点击预览页面图` : `${item.name}（${tag}）`,
		role: clickable ? "button" : void 0,
		tabIndex: clickable ? 0 : void 0,
		onClick: clickable ? () => onPreview(item.preview) : void 0,
		onKeyDown: clickable ? (e) => {
			if (e.key === "Enter" || e.key === " ") onPreview(item.preview);
		} : void 0,
		children: [
			jsx("span", {
				className: "dshaf-chip-icon",
				children: icon
			}),
			jsxs("span", {
				className: "dshaf-chip-text",
				children: [jsx("span", {
					className: "dshaf-chip-name",
					children: item.name
				}), jsx("span", {
					className: "dshaf-chip-meta",
					children: meta
				})]
			}),
			jsx("button", {
				type: "button",
				className: "dshaf-chip-remove",
				"aria-label": `移除 ${item.name}`,
				title: "移除",
				onClick: (e) => {
					e.stopPropagation();
					removeChip(item.key);
				},
				children: "✕"
			})
		]
	}, item.key);
}
function AttachDock({ sessionId }) {
	const state = useBusState();
	const chips = useChipsState();
	const [previewItem, setPreviewItem] = useState(null);
	const mine = chips.sessionId === sessionId ? chips.items : [];
	const showStatus = state !== null && !(mine.length > 0 && state.phase === "done");
	useEffect(() => {
		if (state === null || state.phase !== "done" || mine.length > 0) return;
		const timer = setTimeout(() => setBus(null), 3e3);
		return () => clearTimeout(timer);
	}, [
		state?.seq,
		state?.phase,
		mine.length
	]);
	if (state === null && mine.length === 0) return null;
	const error = state !== null && state.phase === "error";
	return jsx("div", {
		className: "dshaf-dock",
		children: [
			mine.length > 0 ? jsxs("div", {
				className: "dshaf-chipbar",
				children: [
					jsx("span", {
						className: "dshaf-chipbar-hint",
						children: "附件"
					}),
					...mine.map((item) => jsx(ChipPill, {
						item,
						onPreview: setPreviewItem
					}, item.key)),
					jsx("button", {
						type: "button",
						className: "dshaf-chip-send",
						title: "把文档卡片并入消息并发送",
						onClick: sendChipsNow,
						children: "发送"
					})
				]
			}, "chips") : null,
			showStatus ? jsx("div", {
				"data-dshaf-phase": state.phase,
				children: jsxs("div", {
					className: `dshaf-bar${error ? " dshaf-bar-error" : ""}`,
					children: [
						jsx("span", {
							className: "dshaf-lead",
							children: state.phase === "working" ? jsx("span", {
								className: "dshaf-spinner",
								"aria-hidden": true
							}) : error ? "⚠" : "✓"
						}),
						jsxs("div", {
							className: "dshaf-text",
							children: [jsx("div", {
								className: "dshaf-label",
								children: state.label
							}), state.detail ? jsx("div", {
								className: "dshaf-detail",
								children: state.detail
							}) : null]
						}),
						error ? jsx("button", {
							type: "button",
							className: "dshaf-close",
							"aria-label": "关闭提示",
							onClick: () => setBus(null),
							children: "✕"
						}) : null
					]
				})
			}, "status") : null,
			previewItem !== null ? jsx(PreviewLightbox, {
				preview: previewItem,
				onClose: () => setPreviewItem(null)
			}, "lightbox") : null
		]
	});
}
function AttachButton({ sessionId }) {
	const inputRef = useRef(null);
	return jsxs(Fragment, { children: [jsx("input", {
		ref: inputRef,
		type: "file",
		multiple: true,
		accept: ACCEPT,
		style: { display: "none" },
		"aria-hidden": true,
		tabIndex: -1,
		onChange: (event) => {
			const files = Array.from(event.target.files ?? []);
			event.target.value = "";
			if (files.length > 0) intake(files, sessionId);
		}
	}), jsx(Tooltip, {
		label: "添加附件（图片 / PDF / Word / Excel / PPT / 文本·代码）",
		side: "top",
		delayMs: 500,
		children: jsx("button", {
			type: "button",
			className: "dshaf-btn",
			"aria-label": "添加附件",
			title: sessionId === void 0 ? "添加附件" : void 0,
			onMouseDown: (event) => {
				event.preventDefault();
			},
			onClick: () => {
				inputRef.current?.click();
			},
			children: jsx(IconPaperclipOutline16, { size: 14 })
		})
	})] });
}

//#endregion
//#region src/client/ui/settings-ui.js
function CacheSettings() {
	const [state, setState] = useState({
		loading: true,
		docs: [],
		sizeBytes: 0,
		error: null,
		busy: null
	});
	const [cfg, setCfg] = useState(null);
	const [cfgSaving, setCfgSaving] = useState(false);
	const [cfgError, setCfgError] = useState(null);
	const [cfgNote, setCfgNote] = useState(null);
	const cfgRevisionRef = useRef(0);
	const refresh = useCallback(async () => {
		setState((current) => ({
			...current,
			loading: true,
			error: null
		}));
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const params = new URLSearchParams();
			if (cwd !== void 0) params.set("cwd", cwd);
			if (sessionId !== void 0) params.set("sessionId", sessionId);
			const query = params.toString();
			const url = `/api/attach-formats/cache${query === "" ? "" : `?${query}`}`;
			const payload = await (await fetch(url)).json();
			if (payload?.ok !== true) throw new Error(payload?.error?.message ?? "读取缓存失败");
			setState({
				loading: false,
				docs: payload.docs ?? [],
				sizeBytes: payload.sizeBytes ?? 0,
				error: null,
				busy: null
			});
		} catch (error) {
			setState({
				loading: false,
				docs: [],
				sizeBytes: 0,
				error: error instanceof Error ? error.message : String(error),
				busy: null
			});
		}
	}, []);
	const refreshCfg = useCallback(async () => {
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const params = new URLSearchParams();
			if (cwd !== void 0) params.set("cwd", cwd);
			if (sessionId !== void 0) params.set("sessionId", sessionId);
			const url = `/api/attach-formats/settings${params.toString() ? `?${params}` : ""}`;
			const p = await (await fetch(url)).json();
			if (p?.ok === true && p.config) {
				setCfg(p.config);
				cfgRevisionRef.current = typeof p.revision === "number" ? p.revision : 0;
			}
		} catch {}
	}, []);
	useEffect(() => {
		refresh();
		refreshCfg();
	}, [refresh, refreshCfg]);
	const act = useCallback(async (path, body = {}) => {
		setState((current) => ({
			...current,
			busy: path
		}));
		try {
			const payload = await (await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					cwd: currentCwd(),
					sessionId: activeSession?.sessionId,
					...body
				})
			})).json();
			if (payload?.ok !== true) throw new Error(payload?.error?.message ?? "操作失败");
		} catch (error) {
			setState((current) => ({
				...current,
				error: error instanceof Error ? error.message : String(error)
			}));
		} finally {
			await refresh();
		}
	}, [refresh]);
	const saveCfg = useCallback(async (patch) => {
		setCfgSaving(true);
		setCfgError(null);
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const p = await (await fetch("/api/attach-formats/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					cwd,
					sessionId,
					expectedRevision: cfgRevisionRef.current,
					...patch
				})
			})).json();
			if (p?.ok !== true) throw new Error(p?.error?.message ?? "保存失败");
			setCfg(p.config);
			cfgRevisionRef.current = typeof p.revision === "number" ? p.revision : cfgRevisionRef.current + 1;
			const moved = typeof p.secretsMoved === "number" ? p.secretsMoved : 0;
			if (moved > 0) {
				setCfgNote(`已把 ${moved} 个密钥移入 dsh 凭据库（配置文件仅保留引用，删除后可重新填写）`);
				setTimeout(() => setCfgNote(null), 6e3);
			}
		} catch (e) {
			setCfgError(e instanceof Error ? e.message : String(e));
			refreshCfg();
		} finally {
			setCfgSaving(false);
		}
	}, [refreshCfg]);
	const sizeText = state.sizeBytes >= 1048576 ? `${(state.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(state.sizeBytes / 1024)} KB`;
	const fmt = (value) => {
		if (value === null || value === void 0) return "—";
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	};
	const ocrProviders = [
		{
			v: "auto",
			l: "自动（已配置的优先）"
		},
		{
			v: "deepseek",
			l: "DeepSeek Vision（零配置，复用宿主 Key）⭐"
		},
		{
			v: "baidu",
			l: "百度 OCR（免费 1000 次/月）"
		},
		{
			v: "aliyun",
			l: "阿里云 OCR（AppCode）"
		},
		{
			v: "tencent",
			l: "腾讯云 OCR"
		},
		{
			v: "azure",
			l: "Azure Document Intelligence"
		},
		{
			v: "volc",
			l: "火山引擎 OCR"
		},
		{
			v: "vlm",
			l: "通用 VLM（Qwen-VL / GPT-4o / GLM-4V）"
		},
		{
			v: "tesseract-js",
			l: "本地 tesseract.js（离线，~5MB）"
		},
		{
			v: "off",
			l: "关闭 OCR（仅页面图）"
		}
	];
	const docProviders = [
		{
			v: "auto",
			l: "自动（有 URL 则用）"
		},
		{
			v: "custom",
			l: "自定义服务"
		},
		{
			v: "paddle",
			l: "PaddleOCR PP-StructureV3"
		},
		{
			v: "mineru",
			l: "MinerU"
		},
		{
			v: "marker",
			l: "Marker"
		},
		{
			v: "docling",
			l: "Docling"
		},
		{
			v: "off",
			l: "关闭外部解析"
		}
	];
	const ocrHelp = {
		deepseek: "零配置：自动复用 dsh 已配的 DeepSeek API Key（.credentials.yaml），表格自动转 GFM；无需另配，失败回退本地",
		baidu: "百度智能云 → 文字识别 → 创建应用，填 API Key / Secret Key",
		aliyun: "阿里云市场 → 购买 OCR 服务 → 填 AppCode（Authorization: APPCODE xxx）",
		tencent: "腾讯云 → 文字识别 → 填 SecretId / SecretKey，Region 如 ap-guangzhou",
		azure: "Azure Portal → Document Intelligence → 填 Endpoint（https://xxx.cognitiveservices.azure.com）与 Key",
		volc: "火山引擎 → 文字识别 → 填 AppCode",
		vlm: "任意 OpenAI 兼容视觉接口（base 如 https://api.openai.com/v1，model 如 gpt-4o）"
	};
	return jsx("div", {
		className: "dshaf-settings",
		children: [
			jsxs("div", {
				className: "dshaf-settings-head",
				children: [jsxs("div", {
					className: "dshaf-settings-title",
					children: [jsx("div", {
						className: "dshaf-settings-name",
						children: "附件缓存"
					}), jsx("div", {
						className: "dshaf-settings-sub",
						children: state.loading ? "读取中…" : `${state.docs.length} 个已转存文档 · 共 ${sizeText}（约 7 天未访问自动清理）`
					})]
				}), jsx("button", {
					type: "button",
					className: "dshaf-settings-btn",
					disabled: state.busy !== null || state.loading,
					onClick: () => void act("/api/attach-formats/cache/clear"),
					children: "全部清空"
				})]
			}, "head"),
			cfg !== null ? jsxs("div", {
				className: "dshaf-settings-field",
				children: [jsx("label", {
					className: "dshaf-settings-label",
					children: "缓存位置"
				}), jsx("select", {
					className: "dshaf-settings-select",
					value: cfg.cacheLocation ?? "home",
					onChange: (e) => {
						const v = e.target.value;
						setCfg((c) => ({
							...c,
							cacheLocation: v
						}));
						saveCfg({ cacheLocation: v });
					},
					children: [jsx("option", {
						value: "home",
						children: "用户目录（DSH_HOME，默认，不污染工作区）"
					}, "home"), jsx("option", {
						value: "workspace",
						children: "工作区（.dsh-attachments/，模型可用相对路径读取）"
					}, "workspace")]
				})]
			}, "cache-loc") : null,
			state.error !== null ? jsx("div", {
				className: "dshaf-settings-error",
				children: state.error
			}, "error") : null,
			state.docs.length === 0 && !state.loading ? jsx("div", {
				className: "dshaf-settings-empty",
				children: "还没有转存的文档——拖入超过 8 万字符的文本或长 PDF 后会出现在这里。"
			}, "empty") : jsx("div", {
				className: "dshaf-settings-list",
				children: state.docs.map((doc) => jsxs("div", {
					className: "dshaf-settings-row",
					children: [jsxs("div", {
						className: "dshaf-settings-rowtext",
						children: [jsx("div", {
							className: "dshaf-settings-rowname",
							children: doc.name
						}), jsx("div", {
							className: "dshaf-settings-rowmeta",
							children: `${doc.id} · ${doc.pageCount > 0 ? `${doc.pageCount} 页` : `${doc.lineCount} 行`} · ${doc.charCount} 字符 · ${fmt(doc.createdAt)}`
						})]
					}), jsx("button", {
						type: "button",
						className: "dshaf-settings-btn",
						disabled: state.busy !== null,
						onClick: () => void act("/api/attach-formats/cache/delete", { ids: [doc.id] }),
						children: "删除"
					})]
				}, doc.id))
			}, "list"),
			jsxs("div", {
				className: "dshaf-settings-group",
				children: [jsx("div", {
					className: "dshaf-settings-group-title",
					children: "外部服务（可选，<50M 约束：仅轻量 fetch，不捆重模型）"
				}), cfg === null ? jsx("div", {
					className: "dshaf-settings-sub",
					children: "读取配置中…"
				}) : jsxs(Fragment, { children: [
					jsxs("div", {
						className: "dshaf-settings-field",
						children: [jsx("label", {
							className: "dshaf-settings-label",
							children: "OCR 供应商"
						}), jsx("select", {
							className: "dshaf-settings-select",
							value: cfg.ocr?.provider ?? "auto",
							onChange: (e) => {
								const v = e.target.value;
								setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										provider: v
									}
								}));
								saveCfg({ ocr: { provider: v } });
							},
							children: ocrProviders.map((o) => jsx("option", {
								value: o.v,
								children: o.l
							}, o.v))
						})]
					}),
					(cfg.ocr?.provider === "baidu" || cfg.ocr?.provider === "auto") && cfg.ocr?.baidu ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.baidu
							}),
							jsxs("div", {
								className: "dshaf-settings-field",
								children: [jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "百度 API Key",
									value: cfg.ocr.baidu.apiKey ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											baidu: {
												...c.ocr.baidu,
												apiKey: e.target.value
											}
										}
									}))
								}), jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "百度 Secret Key",
									type: "password",
									value: cfg.ocr.baidu.secretKey ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											baidu: {
												...c.ocr.baidu,
												secretKey: e.target.value
											}
										}
									}))
								})]
							}),
							jsxs("label", {
								className: "dshaf-settings-check",
								children: [jsx("input", {
									type: "checkbox",
									checked: !!cfg.ocr.baidu.accurate,
									onChange: (e) => {
										const v = e.target.checked;
										setCfg((c) => ({
											...c,
											ocr: {
												...c.ocr,
												baidu: {
													...c.ocr.baidu,
													accurate: v
												}
											}
										}));
										saveCfg({ ocr: { baidu: { accurate: v } } });
									}
								}), jsx("span", { children: "高精度版（独立免费额度）" })]
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { baidu: cfg.ocr.baidu } }),
								children: cfgSaving ? "保存中…" : "保存百度配置"
							})
						]
					}, "baidu") : null,
					cfg.ocr?.provider === "auto" ? jsxs("label", {
						className: "dshaf-settings-check",
						children: [jsx("input", {
							type: "checkbox",
							checked: cfg.ocr?.deepseekAuto !== false,
							onChange: (e) => {
								const v = e.target.checked;
								setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										deepseekAuto: v
									}
								}));
								saveCfg({ ocr: { deepseekAuto: v } });
							}
						}), jsx("span", { children: "auto 时启用 DeepSeek Vision（检测到 Key 即用，按 token 计费）" })]
					}, "ds-auto") : null,
					cfg.ocr?.provider === "deepseek" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.deepseek
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "API Key（留空自动复用宿主 DeepSeek Key）",
								type: "password",
								value: cfg.ocr.deepseek?.key ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										deepseek: {
											...c.ocr.deepseek,
											key: e.target.value
										}
									}
								}))
							}),
							jsxs("div", {
								className: "dshaf-settings-field",
								children: [jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "Base（默认 https://api.deepseek.com）",
									value: cfg.ocr.deepseek?.base ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											deepseek: {
												...c.ocr.deepseek,
												base: e.target.value
											}
										}
									}))
								}), jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "Model（默认 deepseek-v4-flash-vision-exp）",
									value: cfg.ocr.deepseek?.model ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											deepseek: {
												...c.ocr.deepseek,
												model: e.target.value
											}
										}
									}))
								})]
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { deepseek: cfg.ocr.deepseek } }),
								children: cfgSaving ? "保存中…" : "保存 DeepSeek 配置"
							})
						]
					}, "deepseek") : null,
					cfg.ocr?.provider === "aliyun" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.aliyun
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "AppCode（阿里云市场 → 已购服务 → AppCode）",
								value: cfg.ocr.aliyun?.accessKeyId ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										aliyun: {
											...c.ocr.aliyun,
											accessKeyId: e.target.value
										}
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { aliyun: cfg.ocr.aliyun } }),
								children: cfgSaving ? "保存中…" : "保存阿里云配置"
							})
						]
					}, "aliyun") : null,
					cfg.ocr?.provider === "tencent" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.tencent
							}),
							jsxs("div", {
								className: "dshaf-settings-field",
								children: [jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "SecretId",
									value: cfg.ocr.tencent?.secretId ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											tencent: {
												...c.ocr.tencent,
												secretId: e.target.value
											}
										}
									}))
								}), jsx("input", {
									className: "dshaf-settings-input",
									placeholder: "SecretKey",
									type: "password",
									value: cfg.ocr.tencent?.secretKey ?? "",
									onChange: (e) => setCfg((c) => ({
										...c,
										ocr: {
											...c.ocr,
											tencent: {
												...c.ocr.tencent,
												secretKey: e.target.value
											}
										}
									}))
								})]
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "Region（默认 ap-guangzhou）",
								value: cfg.ocr.tencent?.region ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										tencent: {
											...c.ocr.tencent,
											region: e.target.value
										}
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { tencent: cfg.ocr.tencent } }),
								children: cfgSaving ? "保存中…" : "保存腾讯云配置"
							})
						]
					}, "tencent") : null,
					cfg.ocr?.provider === "azure" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.azure
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "Endpoint（https://xxx.cognitiveservices.azure.com）",
								value: cfg.ocr.azure?.endpoint ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										azure: {
											...c.ocr.azure,
											endpoint: e.target.value
										}
									}
								}))
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "API Key",
								type: "password",
								value: cfg.ocr.azure?.apiKey ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										azure: {
											...c.ocr.azure,
											apiKey: e.target.value
										}
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { azure: cfg.ocr.azure } }),
								children: cfgSaving ? "保存中…" : "保存 Azure 配置"
							})
						]
					}, "azure") : null,
					cfg.ocr?.provider === "volc" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.volc
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "AppCode",
								value: cfg.ocr.volc?.accessKey ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										volc: {
											...c.ocr.volc,
											accessKey: e.target.value
										}
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { volc: cfg.ocr.volc } }),
								children: cfgSaving ? "保存中…" : "保存火山配置"
							})
						]
					}, "volc") : null,
					cfg.ocr?.provider === "vlm" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: ocrHelp.vlm
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "Base URL（https://api.openai.com/v1）",
								value: cfg.ocr.vlm?.base ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										vlm: {
											...c.ocr.vlm,
											base: e.target.value
										}
									}
								}))
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "Model（如 gpt-4o / qwen-vl-max / glm-4v）",
								value: cfg.ocr.vlm?.model ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										vlm: {
											...c.ocr.vlm,
											model: e.target.value
										}
									}
								}))
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "API Key（可选）",
								type: "password",
								value: cfg.ocr.vlm?.key ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									ocr: {
										...c.ocr,
										vlm: {
											...c.ocr.vlm,
											key: e.target.value
										}
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ ocr: { vlm: cfg.ocr.vlm } }),
								children: cfgSaving ? "保存中…" : "保存 VLM 配置"
							})
						]
					}, "vlm") : null,
					jsxs("div", {
						className: "dshaf-settings-field",
						children: [jsx("label", {
							className: "dshaf-settings-label",
							children: "文档解析服务"
						}), jsx("select", {
							className: "dshaf-settings-select",
							value: cfg.docServer?.provider ?? "auto",
							onChange: (e) => {
								const v = e.target.value;
								setCfg((c) => ({
									...c,
									docServer: {
										...c.docServer,
										provider: v
									}
								}));
								saveCfg({ docServer: { provider: v } });
							},
							children: docProviders.map((o) => jsx("option", {
								value: o.v,
								children: o.l
							}, o.v))
						})]
					}),
					cfg.docServer?.provider !== "auto" && cfg.docServer?.provider !== "off" ? jsxs("div", {
						className: "dshaf-settings-subgroup",
						children: [
							jsx("div", {
								className: "dshaf-settings-hint",
								children: "POST {URL}/convert  multipart field file → { ok:true, markdown:\"...\" }（兼容 PaddleOCR/MinerU/Marker/Docling）"
							}),
							jsx("input", {
								className: "dshaf-settings-input",
								placeholder: "服务地址（如 http://localhost:8000）",
								value: cfg.docServer?.url ?? "",
								onChange: (e) => setCfg((c) => ({
									...c,
									docServer: {
										...c.docServer,
										url: e.target.value
									}
								}))
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: cfgSaving,
								onClick: () => void saveCfg({ docServer: cfg.docServer }),
								children: cfgSaving ? "保存中…" : "保存解析服务"
							})
						]
					}, "doc") : null,
					cfgError ? jsx("div", {
						className: "dshaf-settings-error",
						children: cfgError
					}) : null,
					cfgNote ? jsx("div", {
						className: "dshaf-settings-note",
						children: cfgNote
					}) : null
				] })]
			}, "suppliers")
		]
	});
}

//#endregion
//#region src/client/index.js
window.__ModuleLoader__.load({
	id: "dsh-attachment-formats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		initRuntime(require);
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			setActiveCtx(ctx);
			injectStyles();
			activeSession.sessionsService = ctx.sessions;
			ctx.effect(() => {
				const onDropCapture = (event) => {
					const transfer = event.dataTransfer;
					if (transfer === null || transfer === void 0) return;
					if (!transfer.types.includes("Files")) return;
					const files = Array.from(transfer.files ?? []);
					if (files.length === 0) return;
					if (files.every((file) => classifyFile(file) === "native-image")) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					window.dispatchEvent(new Event("dragend"));
					intake(files);
				};
				const onPasteCapture = (event) => {
					const items = event.clipboardData?.items;
					if (items === void 0) return;
					const files = [];
					for (const item of items) {
						if (item.kind !== "file") continue;
						const file = item.getAsFile();
						if (file !== null) files.push(file);
					}
					if (files.length === 0) return;
					if (files.every((file) => classifyFile(file) === "native-image")) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					const text = event.clipboardData?.getData("text/plain") ?? "";
					intake(files).then(() => {
						if (text.trim() !== "") injectTexts([{
							name: "剪贴板",
							text,
							note: false
						}]);
					});
				};
				const onKeyDownCapture = (event) => {
					if (event.key !== "Enter" || event.shiftKey) return;
					if (event.target !== composerTextarea()) return;
					mergeChipsIntoDraft();
				};
				const onClickCapture = (event) => {
					const target = event.target;
					if (target === null || target === void 0 || typeof target.closest !== "function") return;
					const card = target.closest("[data-composer-card]");
					if (card === null) return;
					const button = target.closest("button");
					if (button === null) return;
					const buttons = card.querySelectorAll("button");
					if (buttons.length === 0 || buttons[buttons.length - 1] !== button) return;
					if (button.querySelector("svg rect") !== null) return;
					mergeChipsIntoDraft();
				};
				document.addEventListener("drop", onDropCapture, true);
				document.addEventListener("paste", onPasteCapture, true);
				document.addEventListener("keydown", onKeyDownCapture, true);
				document.addEventListener("click", onClickCapture, true);
				return () => {
					document.removeEventListener("drop", onDropCapture, true);
					document.removeEventListener("paste", onPasteCapture, true);
					document.removeEventListener("keydown", onKeyDownCapture, true);
					document.removeEventListener("click", onClickCapture, true);
				};
			}, "dsh-attachment-formats: drop/paste/send interception");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "attach-formats",
				order: 20,
				inject: (sessionId) => {
					activeSession.sessionId = sessionId;
					return { sessionId };
				}
			}, AttachButton));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "attach-formats",
				order: 60,
				inject: (sessionId) => ({ sessionId })
			}, AttachDock));
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "attach-cache",
				order: 50,
				label: "附件缓存"
			}, CacheSettings));
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.__components = {
			AttachButton,
			AttachDock,
			ChipPill,
			CacheSettings
		};
		exports.__officialFaces = {
			attachImagesOfficially,
			mergeDraftBlocksOfficially
		};
		return module.exports;
	}
});

//#endregion