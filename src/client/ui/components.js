// composer 组件：回形针按钮 + 芯片条/状态条 dock。
import { useEffect, useRef, jsx, jsxs, Fragment, Tooltip, IconPaperclipOutline16 } from "../runtime.js";
import { ACCEPT } from "../contract.js";
import { useBusState, useChipsState, setBus, removeChip } from "../bus.js";
import { sendChipsNow, intake } from "../intake.js";

// ---- attachment dock：文档卡片条 + 状态条 -------------------------------
function ChipPill({ item }) {
	const tag = item.kind === "card" ? "索引" : item.kind === "note" ? "说明" : item.kind === "ref" ? "引用" : "全文";
	const base = item.chars >= 1000
		? `${(item.chars / 1000).toFixed(1)}k 字符 · ${tag}`
		: `${item.chars} 字符 · ${tag}`;
	const meta = item.tagExtra === undefined ? base : `${base} · ${item.tagExtra}`;
	const icon = item.kind === "card" ? "🗂" : item.kind === "ref" ? "📎" : "📄";
	return jsxs("div", {
		className: "dshaf-chip",
		title: `${item.name}（${tag}）`,
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
				onClick: () => removeChip(item.key),
				children: "✕"
			})
		]
	}, item.key);
}
function AttachDock({ sessionId }) {
	const state = useBusState();
	const chips = useChipsState();
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
						...mine.map((item) => jsx(ChipPill, { item }, item.key)),
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
