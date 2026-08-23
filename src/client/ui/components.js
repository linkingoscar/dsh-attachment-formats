// composer 组件：回形针按钮 + 芯片条/状态条 dock + 卡片页图灯箱。
import { useState, useEffect, useRef, jsx, jsxs, Fragment, Tooltip, IconPaperclipOutline16 } from "../runtime.js";
import { ACCEPT } from "../contract.js";
import { useBusState, useChipsState, setBus, removeChip } from "../bus.js";
import { sendChipsNow, intake } from "../intake.js";
import { currentCwd, activeSession } from "../session-state.js";

// ---- 卡片页图灯箱（Codex 式预览：点卡片看渲染页）-------------------------
function fileUrl(id, name) {
	const params = new URLSearchParams({ id, name });
	const cwd = currentCwd();
	const sessionId = activeSession?.sessionId;
	if (cwd !== undefined) params.set("cwd", cwd);
	if (sessionId !== undefined) params.set("sessionId", sessionId);
	return `/api/attach-formats/file?${params.toString()}`;
}

function PreviewLightbox({ preview, onClose }) {
	const [state, setState] = useState({ loading: true, pages: [], idx: 0, error: null });
	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				const r = await fetch(fileUrl(preview.id, "manifest.json"));
				const manifest = await r.json();
				const pages = (Array.isArray(manifest?.files) ? manifest.files : [])
					.filter((name) => /^pages\/p\d+\.(png|jpg)$/.test(name))
					.sort();
				if (!alive) return;
				if (pages.length === 0) throw new Error("该文档没有可预览的页面图");
				setState({ loading: false, pages, idx: 0, error: null });
			} catch (error) {
				if (alive) setState({ loading: false, pages: [], idx: 0, error: error instanceof Error ? error.message : String(error) });
			}
		})();
		return () => { alive = false; };
	}, [preview.id]);
	useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
			else if (event.key === "ArrowLeft") setState((s) => ({ ...s, idx: Math.max(0, s.idx - 1) }));
			else if (event.key === "ArrowRight") setState((s) => ({ ...s, idx: Math.min(s.pages.length - 1, s.idx + 1) }));
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
		children: [
			jsxs("div", {
				className: "dshaf-lightbox-body",
				onClick: (e) => e.stopPropagation(),
				children: [
					jsxs("div", { className: "dshaf-lightbox-head", children: [
						jsx("span", { children: state.loading ? "加载中…" : state.error !== null ? state.error : `第 ${state.idx + 1} / ${state.pages.length} 页` }),
						jsx("button", { type: "button", className: "dshaf-lightbox-close", "aria-label": "关闭预览", onClick: onClose, children: "✕" })
					] }),
					state.loading || state.error !== null
						? null
						: jsx("img", { className: "dshaf-lightbox-img", src: fileUrl(preview.id, pageName), alt: `第 ${state.idx + 1} 页` }),
					state.error === null && state.pages.length > 1
						? jsxs("div", { className: "dshaf-lightbox-nav", children: [
							jsx("button", { type: "button", disabled: state.idx === 0, onClick: () => setState((s) => ({ ...s, idx: s.idx - 1 })), children: "上一页" }),
							jsx("button", { type: "button", disabled: state.idx >= state.pages.length - 1, onClick: () => setState((s) => ({ ...s, idx: s.idx + 1 })), children: "下一页" })
						] })
						: null
				]
			})
		]
	});
}

// ---- attachment dock：文档卡片条 + 状态条 -------------------------------
function ChipPill({ item, onPreview }) {
	const tag = item.kind === "card" ? "索引" : item.kind === "note" ? "说明" : item.kind === "ref" ? "引用" : "全文";
	const base = item.chars >= 1000
		? `${(item.chars / 1000).toFixed(1)}k 字符 · ${tag}`
		: `${item.chars} 字符 · ${tag}`;
	const meta = item.tagExtra === undefined ? base : `${base} · ${item.tagExtra}`;
	const icon = item.kind === "card" ? "🗂" : item.kind === "ref" ? "📎" : "📄";
	const clickable = item.kind === "card" && item.preview !== null && item.preview !== undefined;
	return jsxs("div", {
		className: clickable ? "dshaf-chip dshaf-chip-clickable" : "dshaf-chip",
		title: clickable ? `${item.name}（${tag}）— 点击预览页面图` : `${item.name}（${tag}）`,
		role: clickable ? "button" : undefined,
		tabIndex: clickable ? 0 : undefined,
		onClick: clickable ? () => onPreview(item.preview) : undefined,
		onKeyDown: clickable ? (e) => { if (e.key === "Enter" || e.key === " ") onPreview(item.preview); } : undefined,
		children: [
			jsx("span", { className: "dshaf-chip-icon", children: icon }),
			jsxs("span", {
				className: "dshaf-chip-text",
				children: [
					jsx("span", { className: "dshaf-chip-name", children: item.name }),
					jsx("span", { className: "dshaf-chip-meta", children: meta })
				]
			}),
			jsx("button", {
				type: "button",
				className: "dshaf-chip-remove",
				"aria-label": `移除 ${item.name}`,
				title: "移除",
				onClick: (e) => { e.stopPropagation(); removeChip(item.key); },
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
	// 有卡片时不显示"已挂载"完成提示（卡片条本身就是状态，避免两条堆叠）
	const showStatus = state !== null && !(mine.length > 0 && state.phase === "done");
	useEffect(() => {
		if (state === null || state.phase !== "done" || mine.length > 0) return;
		const timer = setTimeout(() => setBus(null), 3000);
		return () => clearTimeout(timer);
	}, [state?.seq, state?.phase, mine.length]);
	if (state === null && mine.length === 0) return null;
	const error = state !== null && state.phase === "error";
	return jsx("div", {
		className: "dshaf-dock",
		children: [
			mine.length > 0
				? jsxs("div", {
					className: "dshaf-chipbar",
					children: [
						jsx("span", { className: "dshaf-chipbar-hint", children: "附件" }),
						...mine.map((item) => jsx(ChipPill, { item, onPreview: setPreviewItem }, item.key)),
						jsx("button", {
							type: "button",
							className: "dshaf-chip-send",
							title: "把文档卡片并入消息并发送",
							onClick: sendChipsNow,
							children: "发送"
						})
					]
				}, "chips")
				: null,
			showStatus
				? jsx("div", {
					"data-dshaf-phase": state.phase,
					children: jsxs("div", {
						className: `dshaf-bar${error ? " dshaf-bar-error" : ""}`,
						children: [
							jsx("span", {
								className: "dshaf-lead",
								children: state.phase === "working"
									? jsx("span", { className: "dshaf-spinner", "aria-hidden": true })
									: error
										? "⚠"
										: "✓"
							}),
							jsxs("div", {
								className: "dshaf-text",
								children: [
									jsx("div", { className: "dshaf-label", children: state.label }),
									state.detail
										? jsx("div", { className: "dshaf-detail", children: state.detail })
										: null
								]
							}),
							error
								? jsx("button", {
									type: "button",
									className: "dshaf-close",
									"aria-label": "关闭提示",
									onClick: () => setBus(null),
									children: "✕"
								})
								: null
						]
					})
				}, "status")
				: null,
			previewItem !== null
				? jsx(PreviewLightbox, { preview: previewItem, onClose: () => setPreviewItem(null) }, "lightbox")
				: null
		]
	});
}

// ---- attach button ------------------------------------------------------
function AttachButton({ sessionId }) {
	const inputRef = useRef(null);
	return jsxs(Fragment, {
		children: [
			jsx("input", {
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
					if (files.length > 0) void intake(files, sessionId);
				}
			}),
			jsx(Tooltip, {
				label: "添加附件（图片 / PDF / Word / Excel / PPT / 文本·代码）",
				side: "top",
				delayMs: 500,
				children: jsx("button", {
					type: "button",
					className: "dshaf-btn",
					"aria-label": "添加附件",
					title: sessionId === undefined ? "添加附件" : undefined,
					onMouseDown: (event) => {
						event.preventDefault();
					},
					onClick: () => {
						inputRef.current?.click();
					},
					children: jsx(IconPaperclipOutline16, { size: 14 })
				})
			})
		]
	});
}


export { ChipPill, AttachDock, AttachButton };
