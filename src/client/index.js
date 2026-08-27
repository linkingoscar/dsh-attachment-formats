// 浏览器半区入口：__ModuleLoader__ 单文件 factory（由 tsdown 打包为 lib/client.js）。
//
// 1. conversation.input.left 回形针按钮；2. 文档级 drop/paste 拦截；
// 3. 转换图片经官方注入面按会话挂入草稿栏；4. 卡片发送时经官方 setDraft 合并；
// 5. settings.plugins.tab 缓存与供应商配置页。
import { initRuntime } from "./runtime.js";
import { activeSession, setActiveCtx, isComposerInputTarget } from "./session-state.js";
import { injectStyles } from "./ui/styles.js";
import { classifyFile } from "./contract.js";
import { intake, injectTexts, mergeChipsIntoDraft } from "./intake.js";
import { attachImagesOfficially, mergeDraftBlocksOfficially } from "./official-face.js";
import { AttachButton, AttachDock, ChipPill } from "./ui/components.js";
import { CacheSettings } from "./ui/settings-ui.js";

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
					if (transfer === null || transfer === undefined) return;
					if (!transfer.types.includes("Files")) return;
					const files = Array.from(transfer.files ?? []);
					if (files.length === 0) return;
					if (files.every((file) => classifyFile(file) === "native-image")) return; // 原生图片走内建管线
					event.preventDefault();
					event.stopImmediatePropagation();
					window.dispatchEvent(new Event("dragend")); // 复位内建 DropOverlay
					void intake(files);
				};
				const onPasteCapture = (event) => {
					const items = event.clipboardData?.items;
					if (items === undefined) return;
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
					void intake(files).then(() => {
						if (text.trim() !== "") injectTexts([{ name: "剪贴板", text, note: false }]);
					});
				};
				// 发送瞬间把文档卡片并入草稿（Enter 提交 / 主按钮点击），随后由原生提交发送
				const onKeyDownCapture = (event) => {
					if (event.key !== "Enter" || event.shiftKey) return;
					if (!isComposerInputTarget(event.target)) return;
					mergeChipsIntoDraft();
				};
				const onClickCapture = (event) => {
					const target = event.target;
					if (target === null || target === undefined || typeof target.closest !== "function") return;
					const card = target.closest("[data-composer-card]");
					if (card === null) return;
					const button = target.closest("button");
					if (button === null) return;
					const buttons = card.querySelectorAll("button");
					if (buttons.length === 0 || buttons[buttons.length - 1] !== button) return;
					if (button.querySelector("svg rect") !== null) return; // 停止按钮：不合并
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

			// rc.7+ 规范位置：插件功能页挂 Plugins 分区的 settings.plugins.tab
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "attach-cache",
				order: 50,
				label: "附件缓存"
			}, CacheSettings));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 测试出口：让 smoke-client 能真正 mount 组件（SSR），验证的不是"框架"而是"产品"
		exports.__components = { AttachButton, AttachDock, ChipPill, CacheSettings };
		// 测试出口：官方注入面调用（验证按会话寻址与回退语义）
		exports.__officialFaces = { attachImagesOfficially, mergeDraftBlocksOfficially };
		return module.exports;
	}
});
