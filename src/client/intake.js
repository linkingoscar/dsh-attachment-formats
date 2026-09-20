// 接收管线：分类 → 本地/主机转换 → 芯片/图片分流 → 按原会话官方注入。
import { DIRECT_TEXT_CHARS, MAX_CACHE_BYTES, MAX_TEXT_BYTES, b64ToBytes, classifyFile } from "./contract.js";
import {
  composerTextarea, composerInput, composerReady, currentSessionId, resolveSessionId, currentCwd,
  currentDirectLimit, currentSessionPhase, waitForSessionIdle, nextIntakeSeq, peekIntakeSeq,
  beginIntake, activeSession,
} from "./session-state.js";
import { setBus, addChips, setChips, getBusState, getChipsState } from "./bus.js";
import { attachFilesOfficially, mergeDraftBlocksOfficially, inputShellOf } from "./official-face.js";
import { convertRemote, resolveWorkspaceRef, fileToPngFile, fileToText } from "./browser-convert.js";

// ---- injection into the native pipeline ------------------------------
function injectTexts(notes, sessionId = currentSessionId()) {
	const el = composerTextarea(sessionId);
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
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
	const setter = descriptor?.set;
	if (typeof setter !== "function") return false; // 描述符缺失：桥接失败，卡片保留
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
function mergeChipsIntoDraft(sessionId = currentSessionId()) {
	const mine = getChipsState(sessionId).items;
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
			}, sessionId);
			return false;
		}
		setChips([], sessionId);
		if (getBusState(sessionId)?.phase === "done") setBus(null, sessionId);
		return true;
	}
	// 回退：DOM 桥接（未发布契约；命令认领/忙态一律保留卡片）
	const el = composerTextarea(sessionId);
	if (el === null || el.disabled || el.readOnly) return false;
	const phase = currentSessionPhase(sessionId);
	if (phase === "adjudicating" || phase === "submitting" || phase === "claimed") return false;
	const merged = injectTexts(mine.map((item) => ({
		name: item.name,
		text: item.text,
		note: item.kind === "note",
		raw: item.kind === "card" || item.kind === "ref"
	})), sessionId);
	if (!merged) {
		setBus({
			phase: "error",
			label: "卡片内容未能并入输入框",
			detail: "请使用卡片条的「发送」按钮重试；若仍失败，先移除卡片后手动复制内容"
		}, sessionId);
		return false;
	}
	setChips([], sessionId);
	if (getBusState(sessionId)?.phase === "done") setBus(null, sessionId);
	return true;
}
function sendChipsNow(sessionId = currentSessionId()) {
	if (!mergeChipsIntoDraft(sessionId)) return;
	const el = composerInput(sessionId);
	if (el !== null) {
		try { el.focus({ preventScroll: false }); } catch { /* Focus is best-effort. */ }
		// Let the native keymap resolve busy queue/steer preferences and upload gates.
		el.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter", code: "Enter", keyCode: 13, which: 13,
			bubbles: true, cancelable: true
		}));
		return;
	}
	const shell = inputShellOf(sessionId);
	if (shell !== undefined && typeof shell.submit === "function") {
		try {
			shell.submit();
			return;
		} catch {
			/* No mounted editor; the draft remains available for retry. */
		}
	}
}

async function intake(files, explicitSessionId) {
	if (files.length === 0) return;
	const sessionId = resolveSessionId(explicitSessionId);
	const seq = nextIntakeSeq(sessionId);
	let operation;
	const updateStatus = (patch) => {
		if (!operation?.signal.aborted && seq === peekIntakeSeq(sessionId)) setBus(patch, sessionId);
	};
	if (sessionId === undefined || !composerReady(sessionId)) {
		updateStatus({
			phase: "error",
			label: "无法接收附件",
			detail: "请先选择/创建工作区，并等待当前回复完成后再试"
		});
		return;
	}
	try {
		operation = beginIntake(sessionId);
		if (operation.ready !== undefined) await operation.ready;
		const { signal } = operation;
		if (signal.aborted) return;
		const cwd = currentCwd(sessionId);
		const directLimit = currentDirectLimit(sessionId);
		const images = [];
		const nativeFiles = [];
		let attachedCount = 0;
		const chips = [];
		const failedNames = [];
		let firstError = null;
		let budgetTiered = false;
		updateStatus({
			phase: "working",
			label: files.length === 1 ? `正在处理 ${files[0].name}` : `正在处理 ${files.length} 个文件`,
			detail: ""
		});
		for (const file of files) {
			if (signal.aborted) return;
			const kind = classifyFile(file);
			try {
				switch (kind) {
					case "native-image": {
						images.push(file);
						break;
					}
					case "browser-image": {
						updateStatus({ phase: "working", label: file.name, detail: "正在转换为图片…" });
						const png = await fileToPngFile(file);
						if (png !== null) images.push(png);
						else throw new Error("图片解码失败，未附加");
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
							updateStatus({ phase: "working", label: file.name, detail: "正在校验工作区同源文件…" });
							const ref = await resolveWorkspaceRef(file, cwd, sessionId, signal);
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
							updateStatus({ phase: "working", label: file.name, detail: "正在读取文本…" });
							const text = await fileToText(file);
							if (text.length <= directLimit) {
								chips.push({ name: file.name, kind: "text", text });
								break;
							}
							// 超过上下文预算：上传主机落盘 + 索引卡，杜绝顶爆上下文
							if (text.length <= DIRECT_TEXT_CHARS) budgetTiered = true;
							updateStatus({
								phase: "working",
								label: file.name,
								detail: text.length <= DIRECT_TEXT_CHARS ? "上下文余量不足，正在转存并生成索引…" : "文档较大，正在转存并生成索引…"
							});
							const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit, { signal });
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
						updateStatus({ phase: "working", label: file.name, detail: "文档较大，正在上传转存并生成索引…" });
						const cached = await convertRemote(file, "text-cache", cwd, sessionId, directLimit, { signal });
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
						updateStatus({
							phase: "working",
							label: file.name,
							detail: kind === "pdf" ? "正在提取文字层…" : "正在提取文本…"
						});
						// PDF 走主机 job 通道：轮询页级进度（渲染/OCR 页号）；其余仅上传进度
						const jobId = kind === "pdf" ? `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined;
						let pollTimer = null;
						if (jobId !== undefined) {
							pollTimer = setInterval(async () => {
								try {
									const r = await fetch(`/api/attach-formats/progress?jobId=${encodeURIComponent(jobId)}`, { signal });
									const p = await r.json();
									if (p?.found === true && p.phase === "working" && p.label) {
										updateStatus({ phase: "working", label: file.name, detail: p.label });
									}
								} catch { /* 轮询失败忽略：主请求自有结果 */ }
							}, 600);
						}
						let result;
						try {
							result = await convertRemote(file, kind, cwd, sessionId, directLimit, {
								jobId, signal,
								onUploadPercent: (pct) => updateStatus({ phase: "working", label: file.name, detail: `上传中 ${pct}%` })
							});
						} finally {
							if (pollTimer !== null) clearInterval(pollTimer);
						}
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
								tagExtra,
								preview: result.hasPageImages === true && typeof result.id === "string" ? { id: result.id, pageCount: result.pageCount ?? 0 } : null
							});
						}
						break;
					}
					case "tiff": {
						updateStatus({ phase: "working", label: file.name, detail: "正在转换为图片…" });
						const result = await convertRemote(file, kind, cwd, sessionId, directLimit, {
							signal,
							onUploadPercent: (pct) => updateStatus({ phase: "working", label: file.name, detail: `上传中 ${pct}%` })
						});
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
						nativeFiles.push(file);
					}
				}
			} catch (error) {
				failedNames.push(file.name);
				if (firstError === null) firstError = error instanceof Error ? error.message : String(error);
				updateStatus({
					phase: "error",
					label: file.name,
					detail: error instanceof Error ? error.message : String(error)
				});
			}
		}
		if (signal.aborted || seq !== peekIntakeSeq(sessionId)) return;
		const attachments = [...images, ...nativeFiles];
		if (attachments.length > 0) {
			// A retained conversion may outlive its last view. Do not report success
			// for native drafts that would be disposed when our temporary retain ends.
			const attach = () => typeof activeSession.sessionsService?.retain === "function" && composerInput(sessionId) === null
				? null : attachFilesOfficially(attachments, sessionId);
			let attached = attach();
			if (attached === false) {
				updateStatus({ phase: "working", label: "附件已就绪", detail: "等待原会话空闲后附加…" });
				await waitForSessionIdle(sessionId, 15_000, signal);
				if (signal.aborted || seq !== peekIntakeSeq(sessionId)) return;
				attached = attach();
			}
			if (attached === true) {
				attachedCount = attachments.length;
			} else {
				failedNames.push(...attachments.map((file) => file.name));
				firstError ??= attached === null
					? "原会话的附件接口不可用，未附加；请回到原会话重试或使用原生上传按钮"
					: "原会话未接受附件，请稍后重试";
			}
		}
		if (chips.length > 0) addChips(chips, sessionId);
		const parts = [];
		if (attachedCount > 0) parts.push(`${attachedCount} 个原生附件`);
		if (chips.length > 0) parts.push(`${chips.length} 个文档卡片`);
		if (parts.length === 0 && failedNames.length > 0) {
			updateStatus({ phase: "error", label: "附件处理失败", detail: firstError ?? "转换失败" });
			return;
		}
		updateStatus({
			phase: failedNames.length > 0 ? "error" : "done",
			label: parts.length > 0
				? `已挂载 ${parts.join("、")}${failedNames.length > 0 ? `；${failedNames.length} 个文件失败` : ""}，输入框保持干净，发送时自动并入消息`
				: "附件处理完成",
			detail: firstError ?? (budgetTiered ? "部分文档因上下文余量不足转为索引卡（可用 read 工具按需读取，或 /attach full 并入全文）" : "")
		});
	} catch (error) {
		updateStatus({ phase: "error", label: "附件处理失败", detail: error instanceof Error ? error.message : String(error) });
	} finally {
		if (operation?.signal.aborted && seq === peekIntakeSeq(sessionId) && getBusState(sessionId)?.phase === "working") {
			setBus({ phase: "error", label: "附件处理已取消", detail: "请回到原会话重新添加文件" }, sessionId);
		}
		operation?.release();
	}
}


export { injectTexts, mergeChipsIntoDraft, sendChipsNow, intake };
