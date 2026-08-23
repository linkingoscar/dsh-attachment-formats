// React / primitives 运行时注入：模块拆分后各组件经此共享 factory 内的 require。
// ESM live bindings：initRuntime 在 factory 入口最先调用，随后所有读取可见。
export let useState, useEffect, useRef, useCallback, useSyncExternalStore;
export let jsx, jsxs, Fragment;
export let Tooltip, IconPaperclipOutline16;

export function initRuntime(require) {
  const react = require("react");
  const jsxRuntime = require("react/jsx-runtime");
  const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  useState = react.useState;
  useEffect = react.useEffect;
  useRef = react.useRef;
  useCallback = react.useCallback;
  useSyncExternalStore = react.useSyncExternalStore;
  jsx = jsxRuntime.jsx;
  jsxs = jsxRuntime.jsxs;
  Fragment = jsxRuntime.Fragment;
  Tooltip = primitives.Tooltip;
  IconPaperclipOutline16 = primitives.IconPaperclipOutline16;
}

