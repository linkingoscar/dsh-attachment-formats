// 设置页：附件缓存管理 + 外部服务（OCR/文档解析供应商）配置。
import { useState, useEffect, useCallback, useRef, jsx, jsxs, Fragment } from "../runtime.js";
import { currentCwd, activeSession, activeCtx } from "../session-state.js";

const SETTINGS_NS = "attachment-formats";
function officialScope() {
	try {
		const ctx = activeCtx;
		if (!ctx) return null;
		const svc = ctx.settingsScope ?? ctx.get?.("settingsScope") ?? ctx.get?.("settings");
		if (!svc || typeof svc.bind !== "function") return null;
		return svc.bind({ namespace: SETTINGS_NS });
	} catch {
		return null;
	}
}

// ---- cache + supplier settings page（设置页：缓存 + 外部 API 供应商）----
function CacheSettings() {
	const [state, setState] = useState({ loading: true, docs: [], sizeBytes: 0, error: null, busy: null });
	const [cfg, setCfg] = useState(null);
	const [cfgSaving, setCfgSaving] = useState(false);
	const [cfgError, setCfgError] = useState(null);
	const [cfgNote, setCfgNote] = useState(null);
	const cfgRevisionRef = useRef(0);
	const refresh = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: null }));
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const params = new URLSearchParams();
			if (cwd !== undefined) params.set("cwd", cwd);
			if (sessionId !== undefined) params.set("sessionId", sessionId);
			const query = params.toString();
			const url = `/api/attach-formats/cache${query === "" ? "" : `?${query}`}`;
			const response = await fetch(url);
			const payload = await response.json();
			if (payload?.ok !== true) throw new Error(payload?.error?.message ?? "读取缓存失败");
			setState({ loading: false, docs: payload.docs ?? [], sizeBytes: payload.sizeBytes ?? 0, error: null, busy: null });
		} catch (error) {
			setState({ loading: false, docs: [], sizeBytes: 0, error: error instanceof Error ? error.message : String(error), busy: null });
		}
	}, []);
	const refreshCfg = useCallback(async () => {
		// 优先官方缝 ctx.settingsScope（rc.7+ 可暴露），失败回退自建 /api/attach-formats/settings
		const scope = officialScope();
		if (scope) {
			try {
				const snap = typeof scope.getSnapshot === "function" ? scope.getSnapshot() : scope;
				// status 为 unavailable 时说明未暴露，回退
				if (snap && snap.status === "unavailable") throw new Error("not-exposed");
				const value = snap?.value ?? snap?.user ?? snap;
				if (value && typeof value === "object" && (value.engine !== undefined || value.ocr !== undefined)) {
					setCfg(value);
					cfgRevisionRef.current = typeof snap.revision === "number" ? snap.revision : 0;
					return;
				}
			} catch {}
		}
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const params = new URLSearchParams();
			if (cwd !== undefined) params.set("cwd", cwd);
			if (sessionId !== undefined) params.set("sessionId", sessionId);
			const url = `/api/attach-formats/settings${params.toString() ? `?${params}` : ""}`;
			const r = await fetch(url);
			const p = await r.json();
			if (p?.ok === true && p.config) {
				setCfg(p.config);
				cfgRevisionRef.current = typeof p.revision === "number" ? p.revision : 0;
			}
		} catch {}
	}, []);
	useEffect(() => {
		void refresh();
		void refreshCfg();
	}, [refresh, refreshCfg]);
	const act = useCallback(async (path, body = {}) => {
		setState((current) => ({ ...current, busy: path }));
		try {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: currentCwd(), sessionId: activeSession?.sessionId, ...body })
			});
			const payload = await response.json();
			if (payload?.ok !== true) throw new Error(payload?.error?.message ?? "操作失败");
		} catch (error) {
			setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
		} finally {
			await refresh();
		}
	}, [refresh]);
	const saveCfg = useCallback(async (patch) => {
		setCfgSaving(true);
		setCfgError(null);
		// 优先官方缝
		const scope = officialScope();
		if (scope) {
			try {
				// 尝试按官方 scope 写入（字段级 set 或批量 mutate/update）
				if (typeof scope.update === "function") {
					await scope.update(patch, cfgRevisionRef.current);
				} else if (typeof scope.mutate === "function") {
					const ops = [];
					for (const [k, v] of Object.entries(patch)) ops.push({ op: "replace", path: k, value: v });
					await scope.mutate(ops, cfgRevisionRef.current);
				} else if (typeof scope.set === "function") {
					for (const [k, v] of Object.entries(patch)) {
						if (v !== null && typeof v === "object" && !Array.isArray(v)) {
							for (const [sk, sv] of Object.entries(v)) await scope.set(`${k}.${sk}`, sv);
						} else await scope.set(k, v);
					}
				} else throw new Error("no official write");
				const snap = typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
				if (snap?.value) setCfg(snap.value);
				else setCfg((c) => ({ ...c, ...patch }));
				cfgRevisionRef.current = typeof snap?.revision === "number" ? snap.revision : cfgRevisionRef.current + 1;
				return;
			} catch (e) {
				const msg = String(e?.message ?? e);
				// 暴露失败等回退自建 route
				if (!/not-exposed|unavailable/i.test(msg)) {
					// 非暴露问题也回退，避免卡死
				}
			}
		}
		try {
			const cwd = currentCwd();
			const sessionId = activeSession?.sessionId;
			const r = await fetch("/api/attach-formats/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd, sessionId, expectedRevision: cfgRevisionRef.current, ...patch })
			});
			const p = await r.json();
			if (p?.ok !== true) throw new Error(p?.error?.message ?? "保存失败");
			setCfg(p.config);
			cfgRevisionRef.current = typeof p.revision === "number" ? p.revision : cfgRevisionRef.current + 1;
			const moved = typeof p.secretsMoved === "number" ? p.secretsMoved : 0;
			if (moved > 0) {
				setCfgNote(`已把 ${moved} 个密钥移入 dsh 凭据库（配置文件仅保留引用，删除后可重新填写）`);
				setTimeout(() => setCfgNote(null), 6000);
			}
		} catch (e) {
			setCfgError(e instanceof Error ? e.message : String(e));
			void refreshCfg(); // 冲突/失败后拉取最新，避免本地 revision 卡死
		} finally {
			setCfgSaving(false);
		}
	}, [refreshCfg]);
	const sizeText = state.sizeBytes >= 1024 * 1024
		? `${(state.sizeBytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.round(state.sizeBytes / 1024)} KB`;
	const fmt = (value) => {
		if (value === null || value === undefined) return "—";
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	};
	const ocrProviders = [
		{ v: "auto", l: "自动（已配置的优先）" },
		{ v: "deepseek", l: "DeepSeek Vision（零配置，复用宿主 Key）⭐" },
		{ v: "baidu", l: "百度 OCR（免费 1000 次/月）" },
		{ v: "aliyun", l: "阿里云 OCR（AppCode）" },
		{ v: "tencent", l: "腾讯云 OCR" },
		{ v: "azure", l: "Azure Document Intelligence" },
		{ v: "volc", l: "火山引擎 OCR" },
		{ v: "vlm", l: "通用 VLM（Qwen-VL / GPT-4o / GLM-4V）" },
		{ v: "tesseract-js", l: "本地 tesseract.js（离线，~5MB）" },
		{ v: "off", l: "关闭 OCR（仅页面图）" }
	];
	const docProviders = [
		{ v: "auto", l: "自动（有 URL 则用）" },
		{ v: "custom", l: "自定义服务" },
		{ v: "paddle", l: "PaddleOCR PP-StructureV3" },
		{ v: "mineru", l: "MinerU" },
		{ v: "marker", l: "Marker" },
		{ v: "docling", l: "Docling" },
		{ v: "off", l: "关闭外部解析" }
	];
	const ocrHelp = {
		deepseek: "零配置：自动复用 dsh 已配的 DeepSeek API Key（.credentials.yaml），表格自动转 GFM；无需另配，失败回退本地",
		baidu: "百度智能云 → 文字识别 → 创建应用，填 API Key / Secret Key",
		aliyun: "阿里云市场 → 购买 OCR 服务 → 填 AppCode（Authorization: APPCODE xxx）",
		tencent: "腾讯云 → 文字识别 → 填 SecretId / SecretKey，Region 如 ap-guangzhou",
		azure: "Azure Portal → Document Intelligence → 填 Endpoint（https://xxx.cognitiveservices.azure.com）与 Key",
		volc: "火山引擎 → 文字识别 → 填 AppCode",
		vlm: "任意 OpenAI 兼容视觉接口（base 如 https://api.openai.com/v1，model 如 gpt-4o）"
	};
	return jsx("div", {
		className: "dshaf-settings",
		children: [
			// 附件缓存
			jsxs("div", {
				className: "dshaf-settings-head",
				children: [
					jsxs("div", {
						className: "dshaf-settings-title",
						children: [
							jsx("div", { className: "dshaf-settings-name", children: "附件缓存" }),
							jsx("div", {
								className: "dshaf-settings-sub",
								children: state.loading
									? "读取中…"
									: `${state.docs.length} 个已转存文档 · 共 ${sizeText}（约 7 天未访问自动清理）`
							})
						]
					}),
					jsx("button", {
						type: "button",
						className: "dshaf-settings-btn",
						disabled: state.busy !== null || state.loading,
						onClick: () => void act("/api/attach-formats/cache/clear"),
						children: "全部清空"
					})
				]
			}, "head"),
			(cfg !== null) ? jsxs("div", {
				className: "dshaf-settings-field",
				children: [
					jsx("label", { className: "dshaf-settings-label", children: "缓存位置" }),
					jsx("select", {
						className: "dshaf-settings-select",
						value: cfg.cacheLocation ?? "home",
						onChange: (e) => {
							const v = e.target.value;
							setCfg((c) => ({ ...c, cacheLocation: v }));
							void saveCfg({ cacheLocation: v });
						},
						children: [
							jsx("option", { value: "home", children: "用户目录（DSH_HOME，默认，不污染工作区）" }, "home"),
							jsx("option", { value: "workspace", children: "工作区（.dsh-attachments/，模型可用相对路径读取）" }, "workspace")
						]
					})
				]
			}, "cache-loc") : null,
			state.error !== null
				? jsx("div", { className: "dshaf-settings-error", children: state.error }, "error")
				: null,
			state.docs.length === 0 && !state.loading
				? jsx("div", { className: "dshaf-settings-empty", children: "还没有转存的文档——拖入超过 8 万字符的文本或长 PDF 后会出现在这里。" }, "empty")
				: jsx("div", {
					className: "dshaf-settings-list",
					children: state.docs.map((doc) => jsxs("div", {
						className: "dshaf-settings-row",
						children: [
							jsxs("div", {
								className: "dshaf-settings-rowtext",
								children: [
									jsx("div", { className: "dshaf-settings-rowname", children: doc.name }),
									jsx("div", {
										className: "dshaf-settings-rowmeta",
										children: `${doc.id} · ${doc.pageCount > 0 ? `${doc.pageCount} 页` : `${doc.lineCount} 行`} · ${doc.charCount} 字符 · ${fmt(doc.createdAt)}`
									})
								]
							}),
							jsx("button", {
								type: "button",
								className: "dshaf-settings-btn",
								disabled: state.busy !== null,
								onClick: () => void act("/api/attach-formats/cache/delete", { ids: [doc.id] }),
								children: "删除"
							})
						]
					}, doc.id))
				}, "list"),
			// 外部服务配置
			jsxs("div", {
				className: "dshaf-settings-group",
				children: [
					jsx("div", { className: "dshaf-settings-group-title", children: "外部服务（可选，<50M 约束：仅轻量 fetch，不捆重模型）" }),
					cfg === null
						? jsx("div", { className: "dshaf-settings-sub", children: "读取配置中…" })
						: jsxs(Fragment, {
							children: [
								// OCR 供应商
								jsxs("div", {
									className: "dshaf-settings-field",
									children: [
										jsx("label", { className: "dshaf-settings-label", children: "OCR 供应商" }),
										jsx("select", {
											className: "dshaf-settings-select",
											value: cfg.ocr?.provider ?? "auto",
											onChange: (e) => {
												const v = e.target.value;
												setCfg((c) => ({ ...c, ocr: { ...c.ocr, provider: v } }));
												void saveCfg({ ocr: { provider: v } });
											},
											children: ocrProviders.map(o => jsx("option", { value: o.v, children: o.l }, o.v))
										})
									]
								}),
								(cfg.ocr?.provider === "baidu" || cfg.ocr?.provider === "auto") && cfg.ocr?.baidu
									? jsxs("div", {
										className: "dshaf-settings-subgroup",
										children: [
											jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.baidu }),
											jsxs("div", {
												className: "dshaf-settings-field",
												children: [
													jsx("input", {
														className: "dshaf-settings-input",
														placeholder: "百度 API Key",
														value: cfg.ocr.baidu.apiKey ?? "",
														onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, baidu: { ...c.ocr.baidu, apiKey: e.target.value } } }))
													}),
													jsx("input", {
														className: "dshaf-settings-input",
														placeholder: "百度 Secret Key",
														type: "password",
														value: cfg.ocr.baidu.secretKey ?? "",
														onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, baidu: { ...c.ocr.baidu, secretKey: e.target.value } } }))
													})
												]
											}),
											jsxs("label", {
												className: "dshaf-settings-check",
												children: [
													jsx("input", {
														type: "checkbox",
														checked: !!cfg.ocr.baidu.accurate,
														onChange: (e) => {
															const v = e.target.checked;
															setCfg((c) => ({ ...c, ocr: { ...c.ocr, baidu: { ...c.ocr.baidu, accurate: v } } }));
															void saveCfg({ ocr: { baidu: { accurate: v } } });
														}
													}),
													jsx("span", { children: "高精度版（独立免费额度）" })
												]
											}),
											jsx("button", {
												type: "button",
												className: "dshaf-settings-btn",
												disabled: cfgSaving,
												onClick: () => void saveCfg({ ocr: { baidu: cfg.ocr.baidu } }),
												children: cfgSaving ? "保存中…" : "保存百度配置"
											})
										]
									}, "baidu")
									: null,
								(cfg.ocr?.provider === "auto") ? jsxs("label", {
									className: "dshaf-settings-check",
									children: [
										jsx("input", {
											type: "checkbox",
											checked: cfg.ocr?.deepseekAuto !== false,
											onChange: (e) => {
												const v = e.target.checked;
												setCfg((c) => ({ ...c, ocr: { ...c.ocr, deepseekAuto: v } }));
												void saveCfg({ ocr: { deepseekAuto: v } });
											}
										}),
										jsx("span", { children: "auto 时启用 DeepSeek Vision（检测到 Key 即用，按 token 计费）" })
									]
								}, "ds-auto") : null,
								(cfg.ocr?.provider === "auto") ? jsxs("label", {
									className: "dshaf-settings-check",
									children: [
										jsx("input", {
											type: "checkbox",
											checked: cfg.ocr?.crossCloudFallback === true,
											onChange: (e) => {
												const v = e.target.checked;
												setCfg((c) => ({ ...c, ocr: { ...c.ocr, crossCloudFallback: v } }));
												void saveCfg({ ocr: { crossCloudFallback: v } });
											}
										}),
										jsx("span", { children: "允许失败后转发到另一家云 OCR（默认关闭，避免跨云重复上传）" })
									]
								}, "cross-cloud") : null,
								(cfg.ocr?.provider === "deepseek") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.deepseek }),
										jsx("input", {
											className: "dshaf-settings-input",
											placeholder: "API Key（留空自动复用宿主 DeepSeek Key）",
											type: "password",
											value: cfg.ocr.deepseek?.key ?? "",
											onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, deepseek: { ...c.ocr.deepseek, key: e.target.value } } }))
										}),
										jsxs("div", {
											className: "dshaf-settings-field",
											children: [
												jsx("input", { className: "dshaf-settings-input", placeholder: "Base（默认 https://api.deepseek.com）", value: cfg.ocr.deepseek?.base ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, deepseek: { ...c.ocr.deepseek, base: e.target.value } } })) }),
												jsx("input", { className: "dshaf-settings-input", placeholder: "Model（默认 deepseek-v4-flash-vision-exp）", value: cfg.ocr.deepseek?.model ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, deepseek: { ...c.ocr.deepseek, model: e.target.value } } })) })
											]
										}),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ ocr: { deepseek: cfg.ocr.deepseek } }), children: cfgSaving ? "保存中…" : "保存 DeepSeek 配置" })
									]
								}, "deepseek") : null,
								(cfg.ocr?.provider === "aliyun") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.aliyun }),
										jsx("input", {
											className: "dshaf-settings-input",
											placeholder: "AppCode（阿里云市场 → 已购服务 → AppCode）",
											value: cfg.ocr.aliyun?.accessKeyId ?? "",
											onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, aliyun: { ...c.ocr.aliyun, accessKeyId: e.target.value } } }))
										}),
										jsx("button", {
											type: "button",
											className: "dshaf-settings-btn",
											disabled: cfgSaving,
											onClick: () => void saveCfg({ ocr: { aliyun: cfg.ocr.aliyun } }),
											children: cfgSaving ? "保存中…" : "保存阿里云配置"
										})
									]
								}, "aliyun") : null,
								(cfg.ocr?.provider === "tencent") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.tencent }),
										jsxs("div", {
											className: "dshaf-settings-field",
											children: [
												jsx("input", { className: "dshaf-settings-input", placeholder: "SecretId", value: cfg.ocr.tencent?.secretId ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, tencent: { ...c.ocr.tencent, secretId: e.target.value } } })) }),
												jsx("input", { className: "dshaf-settings-input", placeholder: "SecretKey", type: "password", value: cfg.ocr.tencent?.secretKey ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, tencent: { ...c.ocr.tencent, secretKey: e.target.value } } })) })
											]
										}),
										jsx("input", { className: "dshaf-settings-input", placeholder: "Region（默认 ap-guangzhou）", value: cfg.ocr.tencent?.region ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, tencent: { ...c.ocr.tencent, region: e.target.value } } })) }),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ ocr: { tencent: cfg.ocr.tencent } }), children: cfgSaving ? "保存中…" : "保存腾讯云配置" })
									]
								}, "tencent") : null,
								(cfg.ocr?.provider === "azure") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.azure }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "Endpoint（https://xxx.cognitiveservices.azure.com）", value: cfg.ocr.azure?.endpoint ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, azure: { ...c.ocr.azure, endpoint: e.target.value } } })) }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "API Key", type: "password", value: cfg.ocr.azure?.apiKey ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, azure: { ...c.ocr.azure, apiKey: e.target.value } } })) }),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ ocr: { azure: cfg.ocr.azure } }), children: cfgSaving ? "保存中…" : "保存 Azure 配置" })
									]
								}, "azure") : null,
								(cfg.ocr?.provider === "volc") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.volc }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "AppCode", value: cfg.ocr.volc?.accessKey ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, volc: { ...c.ocr.volc, accessKey: e.target.value } } })) }),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ ocr: { volc: cfg.ocr.volc } }), children: cfgSaving ? "保存中…" : "保存火山配置" })
									]
								}, "volc") : null,
								(cfg.ocr?.provider === "vlm") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: ocrHelp.vlm }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "Base URL（https://api.openai.com/v1）", value: cfg.ocr.vlm?.base ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, vlm: { ...c.ocr.vlm, base: e.target.value } } })) }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "Model（如 gpt-4o / qwen-vl-max / glm-4v）", value: cfg.ocr.vlm?.model ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, vlm: { ...c.ocr.vlm, model: e.target.value } } })) }),
										jsx("input", { className: "dshaf-settings-input", placeholder: "API Key（可选）", type: "password", value: cfg.ocr.vlm?.key ?? "", onChange: (e) => setCfg((c) => ({ ...c, ocr: { ...c.ocr, vlm: { ...c.ocr.vlm, key: e.target.value } } })) }),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ ocr: { vlm: cfg.ocr.vlm } }), children: cfgSaving ? "保存中…" : "保存 VLM 配置" })
									]
								}, "vlm") : null,
								// 文档解析服务
								jsxs("div", {
									className: "dshaf-settings-field",
									children: [
										jsx("label", { className: "dshaf-settings-label", children: "文档解析服务" }),
										jsx("select", {
											className: "dshaf-settings-select",
											value: cfg.docServer?.provider ?? "auto",
											onChange: (e) => {
												const v = e.target.value;
												setCfg((c) => ({ ...c, docServer: { ...c.docServer, provider: v } }));
												void saveCfg({ docServer: { provider: v } });
											},
											children: docProviders.map(o => jsx("option", { value: o.v, children: o.l }, o.v))
										})
									]
								}),
								(cfg.docServer?.provider !== "auto" && cfg.docServer?.provider !== "off") ? jsxs("div", {
									className: "dshaf-settings-subgroup",
									children: [
										jsx("div", { className: "dshaf-settings-hint", children: "POST {URL}/convert  multipart field file → { ok:true, markdown:\"...\" }（兼容 PaddleOCR/MinerU/Marker/Docling）" }),
										jsx("input", {
											className: "dshaf-settings-input",
											placeholder: "服务地址（如 http://localhost:8000）",
											value: cfg.docServer?.url ?? "",
											onChange: (e) => setCfg((c) => ({ ...c, docServer: { ...c.docServer, url: e.target.value } }))
										}),
										jsx("button", { type: "button", className: "dshaf-settings-btn", disabled: cfgSaving, onClick: () => void saveCfg({ docServer: cfg.docServer }), children: cfgSaving ? "保存中…" : "保存解析服务" })
									]
								}, "doc") : null,
								cfgError ? jsx("div", { className: "dshaf-settings-error", children: cfgError }) : null,
							cfgNote ? jsx("div", { className: "dshaf-settings-note", children: cfgNote }) : null
							]
						})
				]
			}, "suppliers")
		]
	});
}


export { CacheSettings };
