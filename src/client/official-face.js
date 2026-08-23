// 官方注入面（dsh v0.1.1+：ctx.conversation 公开服务）。
// createDraftImages + input.for(scope) 按 sessionId 精确寻址，
// 替代广播式合成 drop 与 DOM 文本桥接；两者均降级为回退路径。
import { activeCtx, activeSession } from "./session-state.js";

function conversationFace() {
	const ctx = activeCtx;
	if (ctx === null || ctx === undefined) return undefined;
	try {
		return ctx.conversation; // cordis Service tracker：属性读取触发绑定
	} catch {
		return undefined;
	}
}
function inputShellOf(sessionId) {
	if (sessionId === undefined) return undefined;
	try {
		const scope = activeSession.sessionsService?.scope?.(sessionId);
		if (scope === undefined) return undefined;
		return conversationFace()?.input?.for?.(scope);
	} catch {
		return undefined;
	}
}
/**
 * 经官方面把图片文件挂入指定会话的草稿栏。
 * @returns {boolean|null} true=成功；false=面可用但被拒（忙）；null=面不可用
 */
function attachImagesOfficially(files, sessionId) {
	const conversation = conversationFace();
	if (conversation === undefined || typeof conversation.createDraftImages !== "function") return null;
	const shell = inputShellOf(sessionId);
	if (shell === undefined || typeof shell.addImages !== "function") return null;
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
	if (!ok && typeof conversation.releaseDraftImages === "function") {
		try {
			conversation.releaseDraftImages(created);
		} catch {
			/* best-effort cleanup */
		}
	}
	return ok;
}
/**
 * 经官方 setDraft 把文本块并入草稿（机器正规写路径，plain 相才接受）。
 * @returns {boolean|null} true=已并入；false=忙/命令认领中；null=面不可用
 */
function mergeDraftBlocksOfficially(blocks, sessionId) {
	const shell = inputShellOf(sessionId);
	if (shell === undefined || typeof shell.setDraft !== "function" || shell.state === undefined) return null;
	try {
		const state = shell.state.getSnapshot();
		if (state.phase !== "plain") return false; // 命令认领态并入会污染命令参数
		const current = typeof state.draft === "string" ? state.draft : "";
		shell.setDraft(current.trim() === "" ? blocks.replace(/^\n+/, "") : current + blocks);
		return true;
	} catch {
		return null;
	}
}


export { conversationFace, inputShellOf, attachImagesOfficially, mergeDraftBlocksOfficially };
