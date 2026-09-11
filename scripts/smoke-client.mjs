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
const dispatchedDrops = [];
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
  dispatchEvent: (event) => { dispatchedDrops.push(event); return true; }
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
  setInterval,
  clearInterval,
  File,
  Blob,
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
	const attached = faces.attachFilesOfficially([{ name: "p1.png", type: "image/png" }], "s1");
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

// ---- 0.1.3：原生透传、混合转换、会话切换和拒绝清理 ---------------------
{
  const zip = { name: "archive.zip", type: "application/zip" };
  for (const files of [[zip], [zip, fakeImageFile]]) {
    const event = {
      dataTransfer: { types: ["Files"], files },
      clipboardData: { items: files.map(file => ({ kind: "file", getAsFile: () => file })) },
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }
    };
    drops[0].fn(event);
    pastes[0].fn(event);
    check("ZIP/ZIP+PNG drop 和 paste 完整放行", !event.prevented && !event.stopped);
  }

  queriedComposerInput = { isContentEditable: true, getAttribute: () => null };
  const batches = [], released = [], added = [];
  const shells = new Map();
  let admission = true;
  ctx.sessions.scope = id => ({ scopeId: id });
  ctx.conversation = {
    createDrafts(sessionId, files) {
      const drafts = files.map((file, index) => ({ id: 'new-' + batches.length + '-' + index, file }));
      batches.push({ sessionId, files, drafts });
      return drafts;
    },
    releaseDraftAttachments(drafts) { released.push(drafts); },
    createDraftImages() { throw new Error("新版不应走旧接口"); },
    input: { for(scope) {
      if (!shells.has(scope.scopeId)) shells.set(scope.scopeId, {
        draft: "用户问题",
        state: { getSnapshot: () => ({ phase: "plain", draft: shells.get(scope.scopeId).draft }) },
        setDraft(text) { this.draft = text; },
        addAttachments(ids) {
          if (admission === "throw") throw new Error("admission failed");
          if (admission === true) added.push({ sessionId: scope.scopeId, ids });
          return admission;
        }
      });
      return shells.get(scope.scopeId);
    } }
  };
  // Real 0.1.3 Cordis exposes the service via ctx.get; property reads are not guaranteed.
  const modernConversation = ctx.conversation;
  delete ctx.conversation;
  ctx.get = name => name === "conversation" ? modernConversation : undefined;
  const tick = () => new Promise(resolve => setTimeout(resolve, 30));
  const drop = files => drops[0].fn({
    dataTransfer: { types: ["Files"], files }, preventDefault() {}, stopImmediatePropagation() {}
  });
  const enter = () => keydowns[0].fn({ key: "Enter", target: queriedComposerInput });
  const md = (name, content) => ({
    name, type: "text/markdown", size: 100,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer
  });
  let finishBitmap;
  context.createImageBitmap = () => new Promise(resolve => { finishBitmap = resolve; });
  const createElement = documentStub.createElement;
  documentStub.createElement = tag => tag === "canvas" ? {
    getContext: () => ({ fillRect() {}, drawImage() {} }),
    toBlob: callback => callback(new Blob(["converted image"], { type: "image/png" }))
  } : createElement(tag);

  shellSnapshot.current = "s1";
  drop([{ name: "convert.bmp", type: "image/bmp" }, zip, fakeImageFile, md("s1.md", "原会话正文")]);
  // Conversion is still pending while another session receives its own document.
  shellSnapshot.current = "s2";
  drop([md("s2.md", "第二会话正文")]);
  await tick();
  finishBitmap({ width: 2, height: 2, close() {} });
  await tick();
  check("转换中切换会话：新附件创建和挂载均锁定 s1",
    batches.length === 1 && batches[0].sessionId === "s1" && added[0]?.sessionId === "s1");
  check("混合 BMP/ZIP/PNG/文档：转换 PNG 与原始文件各挂载一次",
    batches[0]?.files.length === 3 && batches[0].files[0].name === "convert.png"
    && batches[0].files[0].type === "image/png" && batches[0].files.includes(zip)
    && batches[0].files.includes(fakeImageFile) && added[0]?.ids.length === 3);
  enter();
  check("s2 草稿只并入 s2 文档，保留用户问题",
    shells.get("s2").draft.includes("第二会话正文") && !shells.get("s2").draft.includes("原会话正文")
    && shells.get("s2").draft.startsWith("用户问题"));
  shellSnapshot.current = "s1";
  enter();
  check("s1 转换完成不会覆盖 s2 卡片，返回 s1 可合并原文档",
    shells.get("s1").draft.includes("原会话正文") && !shells.get("s1").draft.includes("第二会话正文"));

  let finishText;
  shellSnapshot.current = "paste-s1";
  pastes[0].fn({
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => ({ name: "paste.md", type: "text/markdown", size: 20,
        arrayBuffer: () => new Promise(resolve => { finishText = resolve; }) }) }],
      getData: () => "剪贴板随附文字"
    }, preventDefault() {}, stopImmediatePropagation() {}
  });
  shellSnapshot.current = "paste-s2";
  finishText(new TextEncoder().encode("剪贴板附件正文").buffer);
  await tick();
  enter();
  check("转换期间切换会话：剪贴板文字不写入新会话",
    !shells.has("paste-s2") || shells.get("paste-s2").draft === "用户问题");
  shellSnapshot.current = "paste-s1";
  enter();
  check("剪贴板文字与附件保留在原会话",
    shells.get("paste-s1").draft.includes("剪贴板随附文字")
    && shells.get("paste-s1").draft.includes("剪贴板附件正文"));

  const face = clientModule.__officialFaces.attachFilesOfficially;
  for (const rejected of [false, "throw"]) {
    admission = rejected;
    const before = released.length;
    check("新版拒绝/异常：释放本次创建的附件", face([fakeImageFile], "s1") === false
      && released.length === before + 1 && released.at(-1) === batches.at(-1).drafts);
  }
  admission = false;
  const beforeRetry = released.length;
  drop([fakeImageFile, md("rejected.md", "图片拒绝时文档仍保留")]);
  await tick();
  check("忙态重试仍拒绝：两次草稿都释放", released.length === beforeRetry + 2);
  const noScope = ctx.sessions.scope;
  ctx.sessions.scope = () => undefined;
  const beforeMissing = batches.length;
  drop([fakeImageFile, md("missing.md", "接口缺失时文档仍保留")]);
  await tick();
  check("原会话接口缺失：不创建附件、不广播全局 drop",
    batches.length === beforeMissing && dispatchedDrops.length === 0);
  ctx.sessions.scope = noScope;
  check("缺少 sessionId 不创建附件", face([fakeImageFile], undefined) === null && batches.length === beforeMissing);
  documentStub.createElement = createElement;
  queriedComposerInput = null;
  shellSnapshot.current = "s1";
  delete ctx.conversation;
  delete ctx.get;
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

// ---- 会话级取消围栏：s1 的新任务不能取消 s2 -----------------------------
{
  const { nextIntakeSeq, peekIntakeSeq } = await import("../src/client/session-state.js");
  nextIntakeSeq("isolation-s1");
  const s2 = nextIntakeSeq("isolation-s2");
  nextIntakeSeq("isolation-s1");
  check("附件任务取消序号按会话隔离", peekIntakeSeq("isolation-s2") === s2);
}

// Real intake result/status semantics on a refused modern attachment batch.
{
  const state = await import("../src/client/session-state.js");
  const bus = await import("../src/client/bus.js");
  const { intake } = await import("../src/client/intake.js");
  const originals = { document: globalThis.document, HTMLTextAreaElement: globalThis.HTMLTextAreaElement };
  globalThis.document = { querySelector: selector => selector.endsWith("textarea") ? null
    : { isContentEditable: true, getAttribute: () => null } };
  globalThis.HTMLTextAreaElement = HTMLTextAreaElementStub;
  state.activeSession.sessionsService = {
    list: { getSnapshot: () => ({ current: "status-s1", byId: {} }) },
    scope: id => ({ id }), binding: () => ({})
  };
  const shell = { addAttachments: () => false };
  state.setActiveCtx({ conversation: {
    createDrafts: (_id, files) => files.map(file => ({ id: file.name, file })),
    releaseDraftAttachments() {}, input: { for: () => shell }
  } });
  try {
    await intake([fakeImageFile], "status-s1");
    check("拒绝挂载不谎报成功", bus.getBusState("status-s1")?.phase === "error"
      && !bus.getBusState("status-s1").label.includes("已挂载"));
    bus.addChips([{ name: "other.md", text: "另一会话" }], "status-s2");
    bus.setBus({ phase: "working", label: "另一会话进度" }, "status-s2");
    await intake([fakeImageFile, { name: "kept.md", type: "text/markdown", size: 8,
      arrayBuffer: async () => new TextEncoder().encode("保留正文").buffer }], "status-s1");
    check("部分失败显示错误、保留成功卡片和其他会话状态",
      bus.getBusState("status-s1")?.phase === "error"
      && bus.getChipsState("status-s1").items[0]?.text === "保留正文"
      && bus.getChipsState("status-s2").items[0]?.text === "另一会话"
      && bus.getBusState("status-s2")?.label === "另一会话进度");
  } finally {
    Object.assign(globalThis, originals);
    state.setActiveCtx(null);
    state.activeSession.sessionsService = undefined;
  }
}

// Card send must reach the native keymap, whose current preferences own queue/steer.
{
  const state = await import("../src/client/session-state.js");
  const bus = await import("../src/client/bus.js");
  const { sendChipsNow } = await import("../src/client/intake.js");
  const originals = { document: globalThis.document, HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    KeyboardEvent: globalThis.KeyboardEvent };
  const sessionId = "send-card-s1";
  let draft = "", phase = "plain", directSubmits = 0, nativeSubmits = 0, preferred = "queue", submitted;
  const shell = { state: { getSnapshot: () => ({ phase, draft }) },
    setDraft: text => { draft = text; }, submit: () => { directSubmits++; } };
  const editor = { focus() {}, dispatchEvent(event) {
    if (event.type === "keydown" && event.key === "Enter" && event.bubbles && event.cancelable) {
      nativeSubmits++;
      submitted = { mode: preferred, draft };
    }
  } };
  let mounted = editor;
  globalThis.document = { querySelector: selector => selector.endsWith("textarea") ? null : mounted };
  globalThis.HTMLTextAreaElement = HTMLTextAreaElementStub;
  globalThis.KeyboardEvent = class { constructor(type, options) { Object.assign(this, { type }, options); } };
  state.activeSession.sessionsService = {
    list: { getSnapshot: () => ({ current: sessionId }) }, scope: id => ({ id })
  };
  state.setActiveCtx({ conversation: { input: { for: () => shell } } });
  try {
    for (const mode of ["queue", "steer"]) {
      preferred = mode;
      draft = "说明";
      bus.addChips([{ name: "attached.md", text: "正文" }], sessionId);
      sendChipsNow();
      check(`卡片发送交由原生按键处理（${mode}）`, submitted?.mode === mode
        && submitted.draft === "说明\n\n[附件: attached.md]\n正文" && directSubmits === 0
        && bus.getChipsState(sessionId).items.length === 0);
    }
    phase = "claimed";
    bus.addChips([{ name: "keep.md", text: "保留" }], sessionId);
    sendChipsNow();
    check("命令占用时卡片保留且不触发发送", nativeSubmits === 2 && directSubmits === 0
      && bus.getChipsState(sessionId).items[0]?.text === "保留");
    phase = "plain";
    mounted = null;
    sendChipsNow();
    check("输入框未挂载时仍可通过官方提交面发送已合并草稿", directSubmits === 1 && draft.includes("保留"));
  } finally {
    Object.assign(globalThis, originals);
    bus.setChips([], sessionId);
    state.setActiveCtx(null);
    state.activeSession.sessionsService = undefined;
  }
}

// The host can load a replacement bundle as another classic script in the same page.
try {
  vm.runInContext(source, context, { filename: "client-reloaded.js" });
  check("客户端重新加载不产生全局变量重复声明", typeof windowStub.__loaded.apply === "function");
} catch (error) {
  check("客户端重新加载不产生全局变量重复声明", false, error.message);
}

console.log(`\n${failures === 0 ? "客户端冒烟通过 ✅" : `${failures} 项失败 ❌`}`);
if (failures > 0) process.exitCode = 1;
