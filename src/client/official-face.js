// 官方注入面：新版通用附件与旧版图片接口都按原 sessionId 精确寻址。
import { activeCtx, activeSession } from "./session-state.js";
import { NATIVE_IMAGE_TYPES } from "./contract.js";

function conversationFace() {
	const ctx = activeCtx;
	if (ctx === null || ctx === undefined) return undefined;
	try {
		// 新版宿主自身也通过 ctx.get 获取此服务；未注入的属性访问可能不可用。
		return typeof ctx.get === "function" ? ctx.get("conversation") : ctx.conversation;
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
 * 经官方面把附件挂入指定会话；旧版仅支持图片。
 * @returns {boolean|null} true=成功；false=面可用但被拒（忙）；null=面不可用
 */
function attachFilesOfficially(files, sessionId) {
	const conversation = conversationFace();
	if (conversation === undefined) return null;
	if (typeof sessionId !== "string" || sessionId === "") return null;
	if (typeof activeSession.sessionsService?.binding === "function"
		&& activeSession.sessionsService.binding(sessionId) === undefined) return null;
	const shell = inputShellOf(sessionId);
	if (shell === undefined) return null;
	const modern = typeof conversation.createDrafts === "function";
	const create = modern ? conversation.createDrafts : conversation.createDraftImages;
	const add = modern ? shell.addAttachments : shell.addImages;
	const release = modern ? conversation.releaseDraftAttachments : conversation.releaseDraftImages;
	if (typeof create !== "function" || typeof add !== "function" || typeof release !== "function") return null;
	if (!modern && files.some((file) => !NATIVE_IMAGE_TYPES.has(file.type))) return null;
	let created = null;
	try {
		created = modern ? create.call(conversation, sessionId, files) : create.call(conversation, files);
	} catch {
		return false;
	}
	let ok = false;
	try {
		ok = add.call(shell, created.map((attachment) => attachment.id)) === true;
	} catch {
		ok = false;
	}
	if (!ok) {
		try {
			release.call(conversation, created);
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


export { conversationFace, inputShellOf, attachFilesOfficially, mergeDraftBlocksOfficially };
