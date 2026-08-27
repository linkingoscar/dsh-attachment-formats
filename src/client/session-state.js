// 会话状态单例：apply 注入 sessionsService/ctx，插槽 inject 回写 sessionId。
import { DIRECT_TEXT_CHARS } from "./contract.js";

function composerTextarea() {
	const el = document.querySelector("[data-composer-card] textarea");
	return el instanceof HTMLTextAreaElement ? el : null;
}
/**
 * v0.1.1 使用 textarea；v0.1.2-alpha.1 起编辑器改为 Lexical contenteditable。
 * 这里只做定位/可用性判断，草稿写入仍优先走官方 conversation.input surface。
 */
/** @returns {HTMLTextAreaElement|HTMLElement|null} */
function composerInput() {
	return composerTextarea() ?? /** @type {HTMLElement|null} */ (
		document.querySelector("[data-composer-card] [data-composer-input]")
	);
}
function composerReady() {
	const el = /** @type {HTMLTextAreaElement|HTMLElement|null} */ (composerInput());
	if (el === null) return false;
	if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
	return el.getAttribute?.("aria-disabled") !== "true"
		&& (el.isContentEditable === true || el.getAttribute?.("contenteditable") === "true");
}
function isComposerInputTarget(target) {
	if (target === null || target === undefined) return false;
	const input = composerInput();
	if (input === null) return false;
	if (target === input) return true;
	return typeof target.closest === "function" && target.closest("[data-composer-input]") === input;
}

// 官方注入面上下文（apply 经 setActiveCtx 注入；official-face 只读）。
// 宿主 ctx 形状远超本插件所需，any 是诚实的边界声明。
/** @type {any} */
export let activeCtx = null;
export function setActiveCtx(ctx) {
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
let activeSession = { sessionId: undefined, cwd: undefined, sessionsService: undefined };
function shellCurrentSessionId() {
	const { sessionsService } = activeSession;
	if (sessionsService === undefined) return undefined;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		return typeof snapshot?.current === "string" && snapshot.current !== "" ? snapshot.current : undefined;
	} catch {
		return undefined;
	}
}
function resolveSessionId(explicit) {
	if (typeof explicit === "string" && explicit !== "") return explicit;
	return shellCurrentSessionId() ?? activeSession.sessionId;
}
function currentCwd() {
	const { sessionsService } = activeSession;
	if (sessionsService === undefined) return undefined;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		const id = resolveSessionId(undefined);
		return snapshot?.byId?.[id]?.cwd ?? undefined;
	} catch {
		return undefined;
	}
}
/** 供 intake 取单调序号（ESM 导入方不可直接改写 let）。 */
let intakeSeq = 0;
export function nextIntakeSeq() {
  return ++intakeSeq;
}
export function peekIntakeSeq() {
  return intakeSeq;
}

/** 当前会话输入 phase（adjudicating/submitting 视为忙——原生 drop 会拒绝）。 */
function currentSessionPhase(sessionId) {
	try {
		const svc = activeSession.sessionsService;
		if (svc === undefined || sessionId === undefined) return undefined;
		const binding = svc.binding?.(sessionId);
		const input = binding?.hooks?.input ?? svc.provideInfo?.(sessionId)?.hooks?.input;
		return input?.getSnapshot?.()?.phase;
	} catch {
		return undefined;
	}
}
/** 等当前会话空闲再投喂图片（忙时原生管线会拒绝合成 drop，图片会流到其它空闲会话）。 */
function waitForSessionIdle(sessionId, timeoutMs = 15_000) {
	return new Promise((/** @type {(value: void) => void} */ resolve) => {
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

// ---- v2b：上下文余量感知的直插上限 -------------------------------
// 读 token-meter 的 contextPressure 投影（contextWindow × projectedTokens），
// 换算为保守字符预算（中文 ≈1.5 字符/token）；缺数据回退固定阈值。
function contextBudgetChars() {
	const { sessionsService } = activeSession;
	const sessionId = resolveSessionId(undefined);
	if (sessionsService === undefined || sessionId === undefined) return undefined;
	try {
		const face = sessionsService.binding(sessionId)?.session?.projections?.faceOf?.("contextPressure");
		const snapshot = face?.getSnapshot?.();
		if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") return undefined;
		const windowTokens = snapshot.contextWindow;
		const usedTokens = Number.isFinite(snapshot.projectedTokens) ? snapshot.projectedTokens : snapshot.surfaceTokens;
		if (!Number.isFinite(windowTokens) || !Number.isFinite(usedTokens)) return undefined;
		const reserve = Math.max(2000, windowTokens * 0.15);
		const remaining = windowTokens - usedTokens - reserve;
		if (remaining <= 0) return 4000; // 余量耗尽：一律索引卡
		return Math.max(4000, Math.floor(remaining * 1.5));
	} catch {
		return undefined;
	}
}
function currentDirectLimit() {
	const budget = contextBudgetChars();
	return budget === undefined ? DIRECT_TEXT_CHARS : Math.min(DIRECT_TEXT_CHARS, budget);
}


export { composerTextarea, composerInput, composerReady, isComposerInputTarget, activeSession, currentSessionId, shellCurrentSessionId, resolveSessionId, currentCwd, currentSessionPhase, waitForSessionIdle, currentDirectLimit };
