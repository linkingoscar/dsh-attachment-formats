// 宿主服务与按会话寻址的输入框、转换生命周期。
import { DIRECT_TEXT_CHARS } from "./contract.js";

function composerRoot(sessionId) {
	const markers = document.querySelectorAll?.("[data-dshaf-session]") ?? [];
	for (const marker of markers) {
		if (marker.getAttribute("data-dshaf-session") === sessionId) return marker.closest("[data-composer-card]");
	}
	// Old hosts expose one current composer; never borrow another session's editor.
	return typeof activeSession.sessionsService?.retain !== "function" && sessionId === currentSessionId()
		? document : null;
}
function composerTextarea(sessionId = currentSessionId()) {
	const el = composerRoot(sessionId)?.querySelector("[data-composer-card] textarea, textarea");
	return el instanceof HTMLTextAreaElement ? el : null;
}
/**
 * v0.1.1 使用 textarea；v0.1.2-alpha.1 起编辑器改为 Lexical contenteditable。
 * 这里只做定位/可用性判断，草稿写入仍优先走官方 conversation.input surface。
 */
/** @returns {HTMLTextAreaElement|HTMLElement|null} */
function composerInput(sessionId = currentSessionId()) {
	return composerTextarea(sessionId) ?? /** @type {HTMLElement|null} */ (
		composerRoot(sessionId)?.querySelector("[data-composer-input]") ?? null
	);
}
function composerReady(sessionId = currentSessionId()) {
	const el = /** @type {HTMLTextAreaElement|HTMLElement|null} */ (composerInput(sessionId));
	if (el === null) return false;
	if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
	return el.getAttribute?.("aria-disabled") !== "true"
		&& (el.isContentEditable === true || el.getAttribute?.("contenteditable") === "true");
}
function isComposerInputTarget(target) {
	if (target === null || target === undefined) return false;
	const input = composerInput(eventSessionId(target));
	if (input === null) return false;
	if (target === input) return true;
	return typeof target.closest === "function" && target.closest("[data-composer-input]") === input;
}

/** Target the enclosing conversation; page-level intake defaults to the main view. */
function eventSessionId(target) {
	const region = target?.closest?.("[data-composer-card], [data-conversation-content]");
	if (region) {
		const id = region.querySelector?.("[data-dshaf-session]")?.getAttribute("data-dshaf-session");
		if (typeof id === "string" && id !== "") return id;
		if (typeof activeSession.sessionsService?.retain === "function") return undefined;
	}
	return currentSessionId();
}

// 官方注入面上下文（apply 经 setActiveCtx 注入；official-face 只读）。
// 宿主 ctx 形状远超本插件所需，any 是诚实的边界声明。
/** @type {any} */
export let activeCtx = null;
export function setActiveCtx(ctx) {
  activeCtx = ctx;
}

function currentSessionId() {
	return shellCurrentSessionId();
}

/**
 * 会话状态单例：sessionsService 由 apply 注入（客户端 runtime 的 ISessions，
 * 形状远超本插件所需，any 边界声明）。会话 ID 由插槽或 mainView 引用确定。
 * @type {{ sessionsService: any }}
 */
let activeSession = { sessionsService: undefined };
function shellCurrentSessionId() {
	const { sessionsService } = activeSession;
	if (sessionsService === undefined) return undefined;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		return Object.values(snapshot?.byId ?? {}).find((row) => (/** @type {any} */ (row).retainedBy?.mainView ?? 0) > 0)?.id
			?? (typeof snapshot?.current === "string" && snapshot.current !== "" ? snapshot.current : undefined);
	} catch {
		return undefined;
	}
}
function resolveSessionId(explicit) {
	if (explicit !== undefined) return typeof explicit === "string" && explicit !== "" ? explicit : undefined;
	return currentSessionId();
}
function currentCwd(sessionId) {
	const { sessionsService } = activeSession;
	if (sessionsService === undefined) return undefined;
	try {
		const snapshot = sessionsService.list.getSnapshot();
		const id = resolveSessionId(sessionId);
		return snapshot?.byId?.[id]?.cwd ?? undefined;
	} catch {
		return undefined;
	}
}
/** 每个会话独立的 intake 序号；新任务只取消同一会话里的旧任务。 */
const intakeSeqBySession = new Map();
export function nextIntakeSeq(sessionId) {
	const key = sessionId ?? "__unbound__";
	const next = (intakeSeqBySession.get(key) ?? 0) + 1;
	intakeSeqBySession.set(key, next);
	// 会话切换很多时避免单例状态无限增长。
	while (intakeSeqBySession.size > 32) {
		const oldest = intakeSeqBySession.keys().next().value;
		if (oldest === undefined) break;
		intakeSeqBySession.delete(oldest);
	}
	return next;
}
export function peekIntakeSeq(sessionId) {
	return intakeSeqBySession.get(sessionId ?? "__unbound__") ?? 0;
}

/** 当前会话输入 phase（adjudicating/submitting 视为忙——原生 drop 会拒绝）。 */
function currentSessionPhase(sessionId) {
	try {
		const svc = activeSession.sessionsService;
		if (svc === undefined || sessionId === undefined) return undefined;
		const binding = svc.binding?.(sessionId);
		const conversation = typeof activeCtx?.get === "function" ? activeCtx.get("conversation") : activeCtx?.conversation;
		const scope = binding?.ctx ?? svc.scope?.(sessionId);
		const input = (scope === undefined ? undefined : conversation?.input?.for?.(scope)?.state)
			?? binding?.hooks?.input ?? svc.provideInfo?.(sessionId)?.hooks?.input;
		return input?.getSnapshot?.()?.phase;
	} catch {
		return undefined;
	}
}
/** 等原会话结束 admission 事务后重试定向挂载；超时后由接口再次裁决。 */
function waitForSessionIdle(sessionId, timeoutMs = 15_000, signal) {
	return new Promise((/** @type {(value: void) => void} */ resolve) => {
		const busy = (phase) => phase === "adjudicating" || phase === "submitting";
		if (signal?.aborted || !busy(currentSessionPhase(sessionId))) {
			resolve();
			return;
		}
		const deadline = Date.now() + timeoutMs;
		const finish = () => { clearInterval(timer); signal?.removeEventListener("abort", finish); resolve(); };
		const timer = setInterval(() => {
			const phase = currentSessionPhase(sessionId);
			if (!busy(phase) || Date.now() > deadline) {
				finish();
			}
		}, 250);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

const pendingIntakes = new Map();
/** Retain the original session until conversion settles; re-entry cancels only that session. */
function beginIntake(sessionId) {
	pendingIntakes.get(sessionId)?.release();
	const controller = new AbortController();
	const reference = activeSession.sessionsService?.retain?.(sessionId, {
		source: "dsh-attachment-formats", signal: controller.signal
	});
	let released = false;
	const operation = {
		signal: controller.signal,
		ready: reference?.ready,
		release() {
			if (released) return;
			released = true;
			controller.abort();
			reference?.release();
			if (pendingIntakes.get(sessionId) === operation) pendingIntakes.delete(sessionId);
		}
	};
	pendingIntakes.set(sessionId, operation);
	return operation;
}
/** Stop asynchronous client work before a plugin disable/reload releases its services. */
function disposeIntakes() {
	for (const operation of pendingIntakes.values()) operation.release();
}

// ---- v2b：上下文余量感知的直插上限 -------------------------------
// 读 token-meter 的 contextPressure 投影（contextWindow × projectedTokens），
// 换算为保守字符预算（中文 ≈1.5 字符/token）；缺数据回退固定阈值。
function contextBudgetChars(explicitSessionId) {
	const { sessionsService } = activeSession;
	const sessionId = resolveSessionId(explicitSessionId);
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
function currentDirectLimit(sessionId) {
	const budget = contextBudgetChars(sessionId);
	return budget === undefined ? DIRECT_TEXT_CHARS : Math.min(DIRECT_TEXT_CHARS, budget);
}


export { composerTextarea, composerInput, composerReady, isComposerInputTarget, eventSessionId, activeSession, currentSessionId, shellCurrentSessionId, resolveSessionId, currentCwd, currentSessionPhase, waitForSessionIdle, currentDirectLimit, beginIntake, disposeIntakes };
