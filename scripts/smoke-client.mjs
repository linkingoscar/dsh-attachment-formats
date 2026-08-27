/**
 * dsh-attachment-formats — 客户端 bundle 冒烟（Node vm 沙箱模拟浏览器）。
 *
 * 验证 lib/client.js 能作为 window.__ModuleLoader__ 模块加载，且 apply(ctx)
 * 能在最小 slots/effect/document 桩上完整执行（插槽注册 + 拖放/粘贴监听），
 * 不真正渲染 React。运行：npm run smoke:client
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToString } from "react-dom/server";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

let failures = 0;
function check(label, ok, extra = "") {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label} ${extra}`);
  }
}

// ---- 浏览器环境桩 --------------------------------------------------------
const documentListeners = [];
const HTMLTextAreaElementStub = function HTMLTextAreaElement() {};
let queriedTextarea = null; // 可切换的假输入框
let queriedComposerInput = null;
const documentStub = {
  getElementById: () => null,
  createElement: (tag) => ({ tagName: tag, textContent: "", dataset: {} }),
  head: { appendChild: () => {} },
  querySelector: (selector) => selector.endsWith("textarea") ? queriedTextarea : queriedComposerInput,
  addEventListener: (type, fn, capture) => documentListeners.push({ type, capture: !!capture, fn }),
  removeEventListener: () => {},
  dispatchEvent: () => true
};
const windowStub = {
  __ModuleLoader__: {
    load({ factory }) {
      windowStub.__loaded = factory((id) => {
        if (id === "react") return React;
        if (id === "react/jsx-runtime") return jsxRuntime;
        if (id === "@deepseek-ai/dsh-client-ui-primitives") {
          return { Tooltip: () => null, IconPaperclipOutline16: () => null };
        }
        throw new Error(`unexpected require: ${id}`);
      });
    }
  },
  addEventListener: () => {},
  dispatchEvent: () => true,
  HTMLTextAreaElement: HTMLTextAreaElementStub,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  }
};
Object.defineProperty(HTMLTextAreaElementStub.prototype, "value", {
  get() {
    return this._dshafValue ?? "";
  },
  set(next) {
    this._dshafValue = String(next);
  },
  configurable: true
});

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  DragEvent: class DragEvent {
    constructor(type) {
      this.type = type;
    }
  },
  DataTransfer: class DataTransfer {
    constructor() {
      this.items = { add: () => {} };
    }
  },
  console,
  setTimeout,
  clearTimeout,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  TextDecoder,
  TextEncoder,
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
  HTMLTextAreaElement: HTMLTextAreaElementStub
});
try {
  vm.runInContext(source, context, { filename: "client.js" });
  check(
    "client bundle loads",
    typeof windowStub.__loaded === "object" && windowStub.__loaded !== null && typeof windowStub.__loaded.apply === "function"
  );
} catch (error) {
  check("client bundle loads", false, error.stack);
  process.exitCode = 1;
  throw error;
}

const clientModule = windowStub.__loaded;
check("client exports apply/inject", typeof clientModule?.apply === "function" && Array.isArray(clientModule?.inject));

// ---- 假 slots ctx（inject 立即执行声明回调；register 记录选项）--------------
const registered = [];
// shell「当前会话」可变快照：测试通过切换 current 验证附件会话路由
const shellSnapshot = { current: "s1", byId: {} };
const ctx = {
  effect(callback) {
    callback();
    return () => {};
  },
  sessions: {
    list: { getSnapshot: () => shellSnapshot },
    binding: () => ({
      session: { projections: { faceOf: () => ({ getSnapshot: () => null }) } },
      hooks: { input: { getSnapshot: () => ({ phase: "idle" }) } }
    }),
    provideInfo: () => ({ hooks: { input: { getSnapshot: () => ({ phase: "idle" }) } } })
  },
  slots: {
    inject(key, callback) {
      callback();
    },
    register(options) {
      registered.push({ key: null, options });
      return () => {};
    }
  }
};
// 让 register 知道归属的 slot：包一层，在回调执行期间记住 key。
const slotKeys = [];
ctx.slots.inject = (key, callback) => {
  slotKeys.push(key);
  try {
    callback();
  } finally {
    slotKeys.pop();
  }
};
ctx.slots.register = (options) => {
  registered.push({ key: slotKeys[slotKeys.length - 1] ?? null, options });
  return () => {};
};

try {
  clientModule.apply(ctx);
  check("apply runs", true);
} catch (error) {
  check("apply runs", false, error.stack);
  process.exitCode = 1;
  throw error;
}

const left = registered.filter((r) => r.key === "conversation.input.left");
const dock = registered.filter((r) => r.key === "conversation.input.dock");
const settingsTab = registered.filter((r) => r.key === "settings.plugins.tab");
check("input.left registered", left.length === 1 && left[0].options.id === "attach-formats");
check("input.dock registered", dock.length === 1 && dock[0].options.id === "attach-formats");
check("settings.plugins.tab registered (cache page)", settingsTab.length === 1 && settingsTab[0].options.id === "attach-cache");

const drops = documentListeners.filter((l) => l.type === "drop" && l.capture);
const pastes = documentListeners.filter((l) => l.type === "paste" && l.capture);
const keydowns = documentListeners.filter((l) => l.type === "keydown" && l.capture);
const clicks = documentListeners.filter((l) => l.type === "click" && l.capture);
check("drop capture listener", drops.length === 1);
check("paste capture listener", pastes.length === 1);
check("keydown capture listener (send merge)", keydowns.length === 1);
check("click capture listener (send merge)", clicks.length === 1);

// ---- 纯图片 drop 必须放行（不拦截）-----------------------------------------
const fakeImageFile = { name: "a.png", type: "image/png" };
const transferNative = { types: ["Files"], files: [fakeImageFile] };
const evNative = {
  dataTransfer: transferNative,
  preventDefault: () => { evNative.prevented = true; },
  stopImmediatePropagation: () => { evNative.stopped = true; }
};
drops[0].fn(evNative);
check("native-image drop passes through", evNative.prevented !== true && evNative.stopped !== true);

// ---- 含 PDF 的 drop 必须拦截 ------------------------------------------------
const transferPdf = { types: ["Files"], files: [{ name: "报告.pdf", type: "application/pdf" }] };
const evPdf = {
  dataTransfer: transferPdf,
  preventDefault: () => { evPdf.prevented = true; },
  stopImmediatePropagation: () => { evPdf.stopped = true; }
};
drops[0].fn(evPdf);
check("pdf drop intercepted", evPdf.prevented === true && evPdf.stopped === true);

// ---- 文档卡片流：拖入 md → 挂芯片（输入框干净）→ Enter 合并进草稿 ----------
{
  const textarea = new HTMLTextAreaElementStub();
  textarea.disabled = false;
  textarea.readOnly = false;
  textarea.setSelectionRange = () => {};
  textarea.dispatchEvent = () => true;
  textarea.focus = () => {};
  queriedTextarea = textarea;
  const mdFile = {
    name: "测试.md",
    type: "text/markdown",
    size: 100,
    arrayBuffer: async () => new TextEncoder().encode("这是附件正文内容 hello").buffer
  };
  const evDropMd = {
    dataTransfer: { types: ["Files"], files: [mdFile] },
    preventDefault: () => {},
    stopImmediatePropagation: () => {}
  };
  drops[0].fn(evDropMd);
  await new Promise((resolve) => setTimeout(resolve, 30));
  check("芯片期：输入框保持干净", textarea.value === "", `got ${JSON.stringify(textarea.value)}`);
  // 会话路由：芯片挂在 intake 时的 shell 当前会话（s1）上；
  // 切到 s2 后 Enter 不得合并 s1 的芯片，切回 s1 才能合并。
  shellSnapshot.current = "s2";
  keydowns[0].fn({ key: "Enter", shiftKey: false, target: textarea });
  check("s2 不会合并 s1 的芯片", textarea.value === "", `got ${JSON.stringify(textarea.value)}`);
  shellSnapshot.current = "s1";
  keydowns[0].fn({ key: "Enter", shiftKey: false, target: textarea });
  check(
    "Enter 合并：草稿含附件标记与内容",
    textarea.value.includes("[附件: 测试.md]") && textarea.value.includes("这是附件正文内容")
  );
  const afterFirst = textarea.value;
  keydowns[0].fn({ key: "Enter", shiftKey: false, target: textarea });
  check("二次 Enter 不重复合并", textarea.value === afterFirst);
}

// ---- 官方注入面（v0.1.1+ ctx.conversation）：优先于 DOM 桥接 ----------------
{
	const setDraftCalls = [];
	const submitCalls = [];
	let addedIds = null;
	const createdBatches = [];
	const shell = {
		state: { getSnapshot: () => ({ draft: "", phase: "plain" }) },
		setDraft: (text) => setDraftCalls.push(text),
		addImages: (ids) => {
			addedIds = ids;
			return true;
		},
		submit: () => submitCalls.push(true)
	};
	let forArg = null;
	ctx.conversation = {
		createDraftImages: (files) => {
			createdBatches.push(files);
			return files.map((file, index) => ({ id: `draft-${createdBatches.length}-${index}`, file }));
		},
		releaseDraftImages: () => {},
		input: {
			for: (arg) => {
				forArg = arg;
				return shell;
			}
		}
	};
	ctx.sessions.scope = (id) => ({ scopeId: id });

	// 图片注入：createDraftImages + addImages 按会话寻址
	const faces = clientModule.__officialFaces;
	const attached = faces.attachImagesOfficially([{ name: "p1.png", type: "image/png" }], "s1");
	check(
		"官方图片注入：createDraftImages+addImages 被调用",
		attached === true && createdBatches.length === 1 && Array.isArray(addedIds) && addedIds.length === 1,
		`attached=${attached}`
	);
	check(
		"官方图片注入：input.for 收到 sessions.scope 的会话作用域",
		forArg !== null && forArg.scopeId === "s1",
		`forArg=${JSON.stringify(forArg)}`
	);

	// 忙/命令认领态拒绝合并（返回 false，卡片保留语义由调用方处理）
	shell.state.getSnapshot = () => ({ draft: "/cmd", phase: "claimed" });
	check("官方合并：claimed 相拒绝", faces.mergeDraftBlocksOfficially("x", "s1") === false);
	shell.state.getSnapshot = () => ({ draft: "", phase: "plain" });

	// 文本芯片经官方 setDraft 合并（textarea 不被写入）
	const mdOfficial = {
		name: "官方.md",
		type: "text/markdown",
		size: 100,
		arrayBuffer: async () => new TextEncoder().encode("官方路径正文").buffer
	};
	const textareaBefore = queriedTextarea.value;
	drops[0].fn({
		dataTransfer: { types: ["Files"], files: [mdOfficial] },
		preventDefault: () => {},
		stopImmediatePropagation: () => {}
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	keydowns[0].fn({ key: "Enter", shiftKey: false, target: queriedTextarea });
	check(
		"官方 setDraft 合并：textarea 保持不变（未走 DOM 桥接）",
		setDraftCalls.length === 1 && String(setDraftCalls[0]).includes("[附件: 官方.md]") && queriedTextarea.value === textareaBefore,
		`setDraftCalls=${setDraftCalls.length}`
	);

	// v0.1.2-alpha.1：Lexical contenteditable 可接收附件，Enter 子节点事件仍触发官方合并。
	queriedTextarea = null;
	const lexical = {
		isContentEditable: true,
		getAttribute: (name) => name === "contenteditable" ? "true" : null
	};
	queriedComposerInput = lexical;
	const lexicalChild = { closest: (selector) => selector === "[data-composer-input]" ? lexical : null };
	drops[0].fn({
		dataTransfer: { types: ["Files"], files: [{
			name: "Lexical.md", type: "text/markdown", size: 100,
			arrayBuffer: async () => new TextEncoder().encode("Lexical 路径正文").buffer
		}] },
		preventDefault: () => {},
		stopImmediatePropagation: () => {}
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	keydowns[0].fn({ key: "Enter", shiftKey: false, target: lexicalChild });
	check(
		"v0.1.2 Lexical 输入框：附件接收并经官方 setDraft 合并",
		setDraftCalls.length === 2 && String(setDraftCalls[1]).includes("[附件: Lexical.md]")
	);
	queriedComposerInput = null;
	delete ctx.conversation;
	delete ctx.sessions.scope;
}

// ---- 组件真实挂载（SSR）：验证产品而非框架 --------------------------------
{
  const components = clientModule.__components;
  check("__components 导出完整", typeof components === "object" && components !== null
    && ["AttachButton", "AttachDock", "ChipPill", "CacheSettings"].every((name) => typeof components[name] === "function"));
  const mountResults = [];
  const reactWarnings = [];
  const realError = console.error;
  console.error = (...args) => {
    reactWarnings.push(args.map(String).join(" "));
    realError(...args);
  };
  const mount = (name, props) => {
    try {
      const html = renderToString(React.createElement(components[name], props));
      if (typeof html !== "string") throw new Error("not a string");
      return true; // 空输出合法（AttachDock 无状态时渲染 null），关键是不抛错
    } catch (error) {
      mountResults.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const allMounted = mount("AttachButton", { sessionId: "s1" })
    && mount("AttachDock", { sessionId: "s1" })
    && mount("ChipPill", { item: { key: "k", name: "测试.md", kind: "text", chars: 10, text: "x" } })
    && mount("CacheSettings", {});
  console.error = realError;
  check("四个组件均可真实挂载（钩子引用完整，无 ReferenceError）", allMounted, mountResults.join(" | "));
  const keyWarnings = reactWarnings.filter((line) => line.includes("unique \"key\""));
  check("挂载无 React key 警告（列表渲染键完整）", keyWarnings.length === 0, keyWarnings.slice(0, 2).join(" | "));
}

console.log(`\n${failures === 0 ? "客户端冒烟通过 ✅" : `${failures} 项失败 ❌`}`);
if (failures > 0) process.exitCode = 1;
