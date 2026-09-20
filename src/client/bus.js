// 状态总线：状态条（bus）+ 文档芯片（chips），useSyncExternalStore 桥接 React。
import { useSyncExternalStore } from "./runtime.js";
import { currentSessionId } from "./session-state.js";

// ---- tiny state bus for the status dock --------------------------
const busBySession = new Map();
function getBusState(sessionId = currentSessionId()) {
	return busBySession.get(sessionId) ?? null;
}
const busListeners = new Set();
function setBus(patch, sessionId = currentSessionId()) {
	if (patch === null) busBySession.delete(sessionId);
	else busBySession.set(sessionId, { seq: Date.now(), ...patch });
	for (const listener of busListeners) listener();
}
function subscribeBus(listener) {
	busListeners.add(listener);
	return () => {
		busListeners.delete(listener);
	};
}
function useBusState(sessionId) {
	return useSyncExternalStore(subscribeBus, () => getBusState(sessionId), () => null);
}

// ---- document chips store（Codex 式：内容挂卡片，输入框保持干净）----
// { sessionId, items: [{ key, name, kind: "text"|"card"|"note", text, chars }] }
const chipsBySession = new Map();
const EMPTY_CHIPS = { sessionId: undefined, items: [] };
function getChipsState(sessionId) {
	return chipsBySession.get(sessionId) ?? EMPTY_CHIPS;
}
const chipsListeners = new Set();
function setChips(items, sessionId) {
	if (items.length === 0) chipsBySession.delete(sessionId);
	else chipsBySession.set(sessionId, { sessionId, items });
	for (const listener of chipsListeners) listener();
}
function subscribeChips(listener) {
	chipsListeners.add(listener);
	return () => {
		chipsListeners.delete(listener);
	};
}
function useChipsState(sessionId) {
	return useSyncExternalStore(subscribeChips, () => getChipsState(sessionId), () => EMPTY_CHIPS);
}
let chipSeq = 0;
function addChips(entries, sessionId) {
	const current = getChipsState(sessionId).items;
	const next = [...current];
	for (const entry of entries) {
		next.push({ key: `chip-${++chipSeq}`, chars: entry.text.length, ...entry });
	}
	setChips(next, sessionId);
}

function removeChip(key, sessionId = currentSessionId()) {
	const current = getChipsState(sessionId).items;
	const next = current.filter((item) => item.key !== key);
	setChips(next, sessionId);
	// 最后一张卡片移除后，立即清掉残留的"已挂载"提示（不留 6 秒尾巴）
	if (next.length === 0 && getBusState(sessionId)?.phase === "done") setBus(null, sessionId);
}


export { getBusState, setBus, subscribeBus, useBusState, getChipsState, setChips, subscribeChips, useChipsState, addChips, removeChip };
