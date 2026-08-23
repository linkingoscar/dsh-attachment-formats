// 状态总线：状态条（bus）+ 文档芯片（chips），useSyncExternalStore 桥接 React。
import { useSyncExternalStore } from "./runtime.js";
import { currentSessionId } from "./session-state.js";

// ---- tiny state bus for the status dock --------------------------
let busState = null;
const busListeners = new Set();
function setBus(patch) {
	busState = patch === null ? null : { seq: Date.now(), ...patch };
	for (const listener of busListeners) listener();
}
function subscribeBus(listener) {
	busListeners.add(listener);
	return () => {
		busListeners.delete(listener);
	};
}
function useBusState() {
	return useSyncExternalStore(subscribeBus, () => busState, () => null);
}

// ---- document chips store（Codex 式：内容挂卡片，输入框保持干净）----
// { sessionId, items: [{ key, name, kind: "text"|"card"|"note", text, chars }] }
let chipsState = { sessionId: undefined, items: [] };
const chipsListeners = new Set();
function setChips(items, sessionId) {
	chipsState = { sessionId, items };
	for (const listener of chipsListeners) listener();
}
function subscribeChips(listener) {
	chipsListeners.add(listener);
	return () => {
		chipsListeners.delete(listener);
	};
}
function useChipsState() {
	return useSyncExternalStore(subscribeChips, () => chipsState, () => ({ sessionId: undefined, items: [] }));
}
let chipSeq = 0;
function addChips(entries, sessionId) {
	const current = chipsState.sessionId === sessionId ? chipsState.items : [];
	const next = [...current];
	for (const entry of entries) {
		next.push({ key: `chip-${++chipSeq}`, chars: entry.text.length, ...entry });
	}
	setChips(next, sessionId);
}

function removeChip(key) {
	const sessionId = currentSessionId();
	const current = chipsState.sessionId === sessionId ? chipsState.items : [];
	const next = current.filter((item) => item.key !== key);
	setChips(next, sessionId);
	// 最后一张卡片移除后，立即清掉残留的"已挂载"提示（不留 6 秒尾巴）
	if (next.length === 0 && busState !== null && busState.phase === "done") setBus(null);
}


export { busState, setBus, subscribeBus, useBusState, chipsState, setChips, subscribeChips, useChipsState, addChips, removeChip };
