import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initRuntime } from "../src/client/runtime.js";
import { activeSession, setActiveCtx, currentSessionId, disposeIntakes } from "../src/client/session-state.js";
import { addChips, getChipsState, setChips, getBusState, setBus } from "../src/client/bus.js";
import { intake } from "../src/client/intake.js";
import { AttachDock, AttachButton, ChipPill } from "../src/client/ui/components.js";

const effects = [];
const jsx = (type, props) => ({ type, props });
const requireStub = name => name === "react" ? {
  useState: value => [typeof value === "function" ? value() : value, () => {}],
  useEffect: effect => effects.push(effect), useRef: current => ({ current }),
  useCallback: fn => fn, useSyncExternalStore: (_subscribe, snapshot) => snapshot()
} : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: Symbol.for("Fragment") } : {};
initRuntime(requireStub);
let list, sessions, drafts, cards, markers, refs, released, sent, added, context, listeners, disposers;
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
}
const textFile = (name, text) => ({ name, type: "text/plain", size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const flush = () => new Promise(resolve => setImmediate(resolve));
let client;
globalThis.window = { __ModuleLoader__: { load(spec) { client = spec.factory(requireStub); } }, dispatchEvent() {} };
await import("../src/client/index.js");

beforeEach(() => {
  effects.length = 0;
  list = { ids: ["A", "B"], byId: {
    A: { id: "A", cwd: "/a", retainedBy: { mainView: 1 } },
    B: { id: "B", cwd: "/b", retainedBy: { sidebar: 1 } }
  } };
  drafts = { A: "Question A", B: "Question B" };
  refs = { A: 1, B: 1 }; released = []; sent = []; added = []; disposers = []; listeners = new Map();
  cards = {}; markers = {};
  for (const id of ["A", "B"]) {
    const editor = {
      isContentEditable: true, getAttribute: name => name === "contenteditable" ? "true" : null, focus() {},
      closest: selector => selector === "[data-composer-input]" ? editor : cards[id],
      dispatchEvent: event => { sent.push({ id, key: event.key }); }
    };
    cards[id] = {
      editor,
      querySelector: selector => selector.includes("data-dshaf-session") ? markers[id] : selector.includes("textarea") ? null : editor,
      closest() { return this; }
    };
    markers[id] = { getAttribute: () => id, closest: () => cards[id] };
  }
  globalThis.HTMLTextAreaElement = class {};
  globalThis.KeyboardEvent = class { constructor(type, props) { Object.assign(this, { type }, props); } };
  globalThis.document = {
    querySelectorAll: () => Object.values(markers),
    querySelector: selector => selector.includes("textarea") ? null : cards.A.editor,
    getElementById: () => ({}),
    addEventListener: (type, fn) => { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn)
  };
  sessions = {
    list: { getSnapshot: () => list },
    binding: id => refs[id] > 0 ? { ctx: { id }, session: { projections: { faceOf: () => ({ getSnapshot: () => null }) } } } : undefined,
    scope: id => refs[id] > 0 ? { id } : undefined,
    retain(id) {
      refs[id]++;
      let done = false;
      return { ready: Promise.resolve(sessions.binding(id)), release() { if (!done) { done = true; refs[id]--; released.push(id); } } };
    }
  };
  context = {
    sessions,
    get: name => name === "conversation" ? {
      input: { for: scope => ({
        state: { getSnapshot: () => ({ phase: "plain", draft: drafts[scope.id] }) },
        setDraft: text => { drafts[scope.id] = text; },
        addAttachments: ids => { added.push({ session: scope.id, ids }); return true; }
      }) },
      createDrafts: (id, files) => files.map((file, index) => ({ id: `${id}-${index}`, file })),
      releaseDraftAttachments() {}
    } : undefined,
    effect: effect => { const dispose = effect(); disposers.push(dispose); return dispose; },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} }
  };
  client.apply(context);
  for (const id of ["A", "B"]) { setChips([], id); setBus(null, id); }
});
afterEach(() => { for (const dispose of disposers.reverse()) dispose?.(); disposeIntakes(); setActiveCtx(null); });

test("main and side Send/delete/picker target their own cards and editor", () => {
  assert.equal(currentSessionId(), "A");
  addChips([{ name: "a.txt", text: "Document A", kind: "text" }], "A");
  addChips([{ name: "b.txt", text: "Document B", kind: "text" }], "B");
  const dock = AttachDock({ sessionId: "B" });
  find(dock, node => node.props?.className === "dshaf-chip-send").props.onClick();
  assert.equal(drafts.A, "Question A");
  assert.match(drafts.B, /Document B/);
  assert.deepEqual(sent, [{ id: "B", key: "Enter" }]);
  assert.equal(getChipsState("A").items.length, 1);
  assert.equal(getChipsState("B").items.length, 0);
  const item = getChipsState("A").items[0];
  find(ChipPill({ item, sessionId: "A" }), node => node.props?.className === "dshaf-chip-remove").props.onClick({ stopPropagation() {} });
  assert.equal(getChipsState("A").items.length, 0);
  const picker = find(AttachButton({ sessionId: "B" }), node => node.type === "input");
  assert.equal(picker.props["data-dshaf-session"], "B");
  delete list.byId.A.retainedBy.mainView;
  assert.equal(currentSessionId(), undefined, "blank main must not select the sidebar");
});

test("drop, paste and Enter use the enclosing conversation on modern hosts", async () => {
  const event = { target: cards.B.editor, preventDefault() {}, stopImmediatePropagation() {} };
  for (const listener of listeners.get("drop")) listener({ ...event, dataTransfer: { types: ["Files"], files: [textFile("side.txt", "Side drop")] } });
  await flush();
  for (const listener of listeners.get("paste")) listener({ ...event, clipboardData: {
    items: [{ kind: "file", getAsFile: () => textFile("paste.txt", "Side paste") }], getData: () => "Clipboard B"
  } });
  await flush();
  assert.equal(getChipsState("A").items.length, 0);
  assert.equal(getChipsState("B").items.length, 3);
  for (const listener of listeners.get("keydown")) listener({ ...event, key: "Enter", shiftKey: false });
  assert.equal(drafts.A, "Question A");
  assert.match(drafts.B, /Side drop/);
  assert.match(drafts.B, /Side paste/);
  assert.match(drafts.B, /Clipboard B/);
  assert.equal(getChipsState("B").items.length, 0);
});

test("preview requests preserve the card session even when the main view changes", async t => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async url => { urls.push(url); return { json: async () => ({ files: [] }) }; });
  const { PreviewLightbox } = await import("../src/client/ui/components.js");
  effects.length = 0;
  PreviewLightbox({ sessionId: "B", preview: { id: "scan1" }, onClose() {} });
  const cleanups = effects.map(effect => effect());
  await flush();
  assert.equal(new URL(urls[0], "http://local").searchParams.get("sessionId"), "B");
  assert.equal(new URL(urls[0], "http://local").searchParams.get("cwd"), "/b");
  for (const cleanup of cleanups) cleanup?.();
});

test("conversion retains its original session through a view switch and releases it on completion", async () => {
  let finish;
  const pending = intake([{ ...textFile("slow.txt", ""), arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }], "A");
  await flush();
  assert.equal(refs.A, 2);
  refs.A--; delete list.byId.A.retainedBy.mainView; list.byId.B.retainedBy.mainView = 1;
  finish(new TextEncoder().encode("Original A document").buffer);
  await pending;
  assert.equal(getChipsState("A").items[0].text, "Original A document");
  assert.equal(getChipsState("B").items.length, 0);
  assert.equal(refs.A, 0);
  assert.deepEqual(released, ["A"]);
});

test("disable aborts upload, releases references and removes listeners; re-enable accepts one copy", async t => {
  let xhr;
  t.mock.method(globalThis, "fetch", async () => ({ json: async () => ({ found: false }) }));
  globalThis.XMLHttpRequest = class {
    constructor() { xhr = this; this.upload = {}; }
    open() {} setRequestHeader() {} send() {}
    abort() { this.aborted = true; this.onloadend?.(); }
  };
  const pending = intake([{ name: "scan.pdf", type: "application/pdf", size: 10 }], "B");
  await flush();
  assert.equal(refs.B, 2);
  for (const dispose of disposers.splice(0).reverse()) dispose?.();
  await pending;
  assert.equal(xhr.aborted, true);
  assert.equal(refs.B, 1);
  assert.equal(getChipsState("B").items.length, 0);
  assert.equal(getBusState("B").phase, "error", "re-enable must not leave a cancelled upload spinning");
  assert.ok([...listeners.values()].every(set => set.size === 0));
  client.apply(context);
  assert.equal(listeners.get("drop").size, 1);
  await intake([textFile("again.txt", "One card")], "B");
  assert.equal(getChipsState("B").items.length, 1);
  assert.equal(getBusState("B").phase, "done");
  assert.equal(activeSession.sessionsService, sessions);
});

test("closing the last view cannot silently discard a successful native attachment", async () => {
  const pending = intake([{ name: "image.png", type: "image/png", size: 10 }], "A");
  delete markers.A;
  refs.A--;
  delete list.byId.A.retainedBy.mainView;
  await pending;
  assert.deepEqual(added, []);
  assert.equal(getBusState("A").phase, "error");
  assert.equal(refs.A, 0);
});
