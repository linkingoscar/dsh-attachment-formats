// 接收管线：分类 → 本地/主机转换 → 芯片/图片分流 → 官方注入（回退合成 drop）。
import { DIRECT_TEXT_CHARS, MAX_CACHE_BYTES, MAX_TEXT_BYTES, b64ToBytes, classifyFile } from "./contract.js";
import {
  composerTextarea, composerReady, currentSessionId, resolveSessionId, currentCwd,
  currentDirectLimit, currentSessionPhase, waitForSessionIdle, nextIntakeSeq, peekIntakeSeq,
} from "./session-state.js";
import { setBus, addChips, setChips, busState, chipsState } from "./bus.js";
import { attachImagesOfficially, mergeDraftBlocksOfficially, inputShellOf } from "./official-face.js";
import { convertRemote, resolveWorkspaceRef, fileToPngFile, fileToText } from "./browser-convert.js";

// ---- injection into the native pipeline ------------------------------
function redispatchDrop(files) {
	const dt = new DataTransfer();
	for (const file of files) dt.items.add(file);
	let event;
	try {
		event = new DragEvent("drop", { bubbles: false, cancelable: true, dataTransfer: dt });
	} catch {
		event = new Event("drop", { bubbles: false, cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: dt });
	}
	document.dispatchEvent(event);
}
function injectTexts(notes) {
	const el = composerTextarea();
	if (el === null) return false;
	const blocks = notes
		.map(({ name, text, note, raw }) => (raw
			? `\n\n${text}`
			: note
				? `\n\n[附件说明: ${name}]\n${text}`
				: `\n\n[附件: ${name}]\n${text}`))
		.join("");
	const current = el.value;
	const next = current.trim() === "" ? blocks.replace(/^\n+/, "") : current + blocks;
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
	setter.call(el, next);
	// 合并自检：DOM 值未生效说明桥接失败——绝不静默丢内容
	if (el.value !== next) return false;
	el.setSelectionRange(next.length, next.length);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	try {
		el.focus({ preventScroll: false });
	} catch {
		/* focus is best-effort */
	}
	return true;
}

// ---- send-time merge（发送瞬间把文档卡片并入草稿，再走原生提交）----
/**
 * 把卡片并入当前会话草稿：官方 setDraft 优先，DOM 桥接兜底。
 * @returns {boolean} true=已并入；false=忙或失败（卡片保留）
 */
function mergeChipsIntoDraft() {
	const sessionId = currentSessionId();
	const mine = chipsState.sessionId === sessionId ? chipsState.items : [];
	if (mine.length === 0) return true;
	const blocks = mine.map((item) => (
		item.raw ? `\n\n${item.text}`
			: item.note ? `\n\n[附件说明: ${item.name}]\n${item.text}`
				: `\n\n[附件: ${item.name}]\n${item.text}`
	)).join("");
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
	// 回退：DOM 桥接（未发布契约；命令认领/忙态一律保留卡片）
	const el = composerTextarea();
	if (el === null || el.disabled || el.readOnly) return false;
	const phase = currentSessionPhase(sessionId);
	if (phase === "adjudicating" || phase === "submitting" || phase === "claimed") return false;
	const merged = injectTexts(mine.map((item) => ({
		name: item.name,
		text: item.text,
		note: item.kind === "note",
		raw: item.kind === "card" || item.kind === "ref"
	})));
	if (!merged) {
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
	if (shell !== undefined && typeof shell.submit === "function") {
		try {
			shell.submit();
			return;
		} catch {
			/* fall through to the synthetic-Enter path */
		}
	}
	const el = composerTextarea();
	if (el === null) return;
	try {
		el.focus({ preventScroll: false });
	} catch {
		/* focus is best-effort */
	}
	// 合成 Enter：即使原生发送按钮因空草稿被禁用，键盘提交路径也有效
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
				case "native-image": {
					images.push(file);
					break;
				}
				case "browser-image": {
					setBus({ phase: "working", label: file.name, detail: "正在转换为图片…" });
					const png = await fileToPngFile(file);
					if (png !== null) images.push(png);
					else setBus({ phase: "error", label: file.name, detail: "图片解码失败，已跳过" });
					break;
				}
				case "text": {
					// 超过主机转存上限：无法零拷贝、也无法上传（零拷贝哈希会读
					// 整个文件，>16MB 时成本过高，直接拒绝）
					if (file.size > MAX_CACHE_BYTES) {
						throw new Error(`文件过大（超过 ${Math.round(MAX_CACHE_BYTES / 1024 / 1024)}MB），未附加`);
					}
					// 工作区零拷贝（P2-1）：较大文本文件先按「名 + 大小 + 完整
					// SHA-256」解析同源路径，命中则挂「引用」卡片，不读内容、
					// 不上传字节，模型用 read 工具读取。
					if (file.size > 512 * 1024) {
						setBus({ phase: "working", label: file.name, detail: "正在校验工作区同源文件…" });
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
					// ≤2MB：本地解码判断直插还是转存；2–16MB：本地不再解码
					// （避免大文本拖慢浏览器），直接交主机 text-cache 全量落盘。
					if (file.size <= MAX_TEXT_BYTES) {
						setBus({ phase: "working", label: file.name, detail: "正在读取文本…" });
						const text = await fileToText(file);
						if (text.length <= directLimit) {
							chips.push({ name: file.name, kind: "text", text });
							break;
						}
						// 超过上下文预算：上传主机落盘 + 索引卡，杜绝顶爆上下文
						if (text.length <= DIRECT_TEXT_CHARS) budgetTiered = true;
						setBus({
							phase: "working",
							label: file.name,
							detail: text.length <= DIRECT_TEXT_CHARS ? "上下文余量不足，正在转存并生成索引…" : "文档较大，正在转存并生成索引…"
						});
						const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit);
						if (cached.kind === "index") {
							chips.push({
								name: file.name,
								kind: "card",
								text: cached.card,
								tagExtra: text.length <= DIRECT_TEXT_CHARS ? "余量不足" : undefined
							});
						} else if (cached.kind === "text") {
							chips.push({ name: file.name, kind: "text", text: cached.text });
						} else {
							throw new Error("长文本转存失败");
						}
						break;
					}
					// 2MB < size ≤ 16MB：直接交主机（工作区外的大文本也能完整转存）
					setBus({ phase: "working", label: file.name, detail: "文档较大，正在上传转存并生成索引…" });
					const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit);
					if (cached.kind === "index") {
						chips.push({ name: file.name, kind: "card", text: cached.card });
					} else if (cached.kind === "text") {
						chips.push({ name: file.name, kind: "text", text: cached.text });
					} else {
						throw new Error("长文本转存失败");
					}
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
						detail: kind === "pdf" ? "正在提取文字层…" : kind === "tiff" ? "正在转换为图片…" : "正在提取文本…"
					});
					const result = await convertRemote(file, kind, cwd, sessionId, directLimit);
					if (result.kind === "images") {
						for (const image of result.images) {
							images.push(new File([b64ToBytes(image.data)], image.name, { type: image.mediaType }));
						}
						if (Array.isArray(result.warnings) && result.warnings.length > 0) {
							chips.push({ name: file.name, kind: "note", text: result.warnings.join("\n") });
						}
					} else if (result.kind === "text") {
						const isVision = typeof result.engine === "string" && result.engine.includes("deepseek");
						chips.push({ name: file.name, kind: "text", text: result.text, tagExtra: isVision ? "视觉" : undefined });
					} else if (result.kind === "index") {
						if (result.tierReason === "budget") budgetTiered = true;
						const isVision = typeof result.engine === "string" && result.engine.includes("deepseek");
						const visionTag = isVision ? "视觉" : undefined;
						const budgetTag = result.tierReason === "budget" ? "余量不足" : undefined;
						const tagExtra = visionTag && budgetTag ? `${visionTag}·${budgetTag}` : (visionTag ?? budgetTag);
						chips.push({
							name: file.name,
							kind: "card",
							text: result.card,
							tagExtra
						});
					}
					break;
				}
				case "tiff": {
					setBus({ phase: "working", label: file.name, detail: "正在转换为图片…" });
					const result = await convertRemote(file, kind, cwd, sessionId, directLimit);
					if (result.kind === "images") {
						for (const image of result.images) {
							images.push(new File([b64ToBytes(image.data)], image.name, { type: image.mediaType }));
						}
						if (Array.isArray(result.warnings) && result.warnings.length > 0) {
							chips.push({ name: file.name, kind: "note", text: result.warnings.join("\n") });
						}
					} else if (result.kind === "error") {
						throw new Error(result.error?.message ?? "TIFF 转换失败");
					}
					break;
				}
				default: {
					failedNames.push(file.name);
					const message = `暂不支持该格式${file.type === "" ? "" : `（${file.type}）`}，已跳过`;
					if (firstError === null) firstError = message;
					setBus({ phase: "error", label: file.name, detail: message });
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
		// 优先官方注入面：按当前会话精确寻址，多会话互不串扰；
		// 忙时被拒 → 等空闲重试一次；面不可用 → 合成 drop 兜底。
		let attached = attachImagesOfficially(images, sessionId);
		if (attached === false) {
			setBus({ phase: "working", label: readyLabel, detail: "等待当前会话空闲后附加…" });
			await waitForSessionIdle(sessionId);
			if (seq !== peekIntakeSeq()) return;
			attached = attachImagesOfficially(images, sessionId);
		}
		if (attached === null) {
			setBus({ phase: "working", label: readyLabel, detail: "等待当前会话空闲后附加…" });
			await waitForSessionIdle(sessionId);
			if (seq !== peekIntakeSeq()) return;
			redispatchDrop(images); // 旧版宿主兜底：交原生管线裁决
		} else if (attached === false) {
			failedNames.push("(图片)");
			if (firstError === null) firstError = "当前会话仍忙，图片未附加，请稍后重试";
			setBus({ phase: "error", label: "图片附加失败", detail: firstError });
		}
	}
	if (chips.length > 0) addChips(chips, sessionId);
	const parts = [];
	if (images.length > 0) parts.push(`${images.length} 张图片`);
	if (chips.length > 0) parts.push(`${chips.length} 个文档卡片`);
	if (parts.length === 0 && failedNames.length > 0) {
		setBus({ phase: "error", label: "附件处理失败", detail: firstError ?? "转换失败" });
		return;
	}
	setBus({
		phase: "done",
		label: parts.length > 0
			? `已挂载 ${parts.join("、")}${failedNames.length > 0 ? `；${failedNames.length} 个文件失败` : ""}，输入框保持干净，发送时自动并入消息`
			: "附件处理完成",
		detail: budgetTiered ? "部分文档因上下文余量不足转为索引卡（可用 read 工具按需读取，或 /attach full 并入全文）" : ""
	});
}


export { redispatchDrop, injectTexts, mergeChipsIntoDraft, sendChipsNow, intake };
