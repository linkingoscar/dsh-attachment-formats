// 浏览器本地转换：图片解码转 PNG、文本读取、SHA-256、零拷贝解析、主机路由调用。
import { RASTER_PIXEL_CAP, MAX_TEXT_BYTES, MAX_TEXT_CHARS, ROUTE_PATH, baseNameOf, extensionOf, bytesToBase64 } from "./contract.js";

// ---- local conversions ---------------------------------------------
function loadImage(url) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("图片解码失败"));
		img.src = url;
	});
}
function canvasToPngFile(canvas, name) {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				resolve(null);
				return;
			}
			resolve(new File([blob], name, { type: "image/png" }));
		}, "image/png");
	});
}
function drawIntoPng(source, width, height, name) {
	const scale = Math.min(1, Math.sqrt(RASTER_PIXEL_CAP / Math.max(1, width * height)));
	const w = Math.max(1, Math.round(width * scale));
	const h = Math.max(1, Math.round(height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const context = canvas.getContext("2d");
	if (context === null) return Promise.resolve(null);
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, w, h);
	try {
		context.drawImage(source, 0, 0, w, h);
	} catch {
		return Promise.resolve(null);
	}
	return canvasToPngFile(canvas, name);
}
async function fileToPngFile(file) {
	const stem = baseNameOf(file.name) || "image";
	const name = `${stem}.png`;
	if ((file.type || "").toLowerCase() === "image/svg+xml" || extensionOf(file.name) === "svg") {
		const text = await file.text();
		const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
		try {
			const img = await loadImage(url);
			const w = img.naturalWidth || img.width || 1024;
			const h = img.naturalHeight || img.height || 1024;
			return await drawIntoPng(img, w, h, name);
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	let bitmap = null;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		const url = URL.createObjectURL(file);
		try {
			const img = await loadImage(url);
			return await drawIntoPng(img, img.naturalWidth || img.width, img.naturalHeight || img.height, name);
		} catch {
			return null;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
	try {
		return await drawIntoPng(bitmap, bitmap.width, bitmap.height, name);
	} finally {
		bitmap.close();
	}
}
function countReplacement(text) {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 0xfffd) count += 1;
	}
	return count;
}
async function fileToText(file) {
	if (file.size > MAX_TEXT_BYTES) {
		throw new Error(`文本文件过大（超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)}MB），未附加`);
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	const head = bytes.subarray(0, Math.min(8192, bytes.length));
	let nuls = 0;
	for (const byte of head) {
		if (byte === 0) nuls += 1;
	}
	if (nuls > head.length * 0.02) {
		throw new Error("文件看起来是二进制内容，未按文本附加");
	}
	let text = new TextDecoder("utf-8").decode(bytes);
	const utf8Broken = countReplacement(text);
	if (utf8Broken > Math.min(64, Math.max(8, text.length * 0.005))) {
		try {
			const alt = new TextDecoder("gb18030").decode(bytes);
			if (countReplacement(alt) < utf8Broken) text = alt;
		} catch {
			/* gb18030 unavailable — keep utf-8 */
		}
	}
	if (text.length > MAX_TEXT_CHARS) {
		text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[内容过长，已截断]`;
	}
	return text;
}

// ---- host conversion -----------------------------------------------
/** 浏览器本地 SHA-256（完整内容哈希，供 host 同源判定；不可用时返回 null）。 */
async function fileSha256(file) {
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}
/**
 * 工作区零拷贝：按「文件名 + 字节数 + 完整 SHA-256」询问主机是否有
 * 同源文件（P2-1）。name+size 只是候选过滤，哈希相等才算同源——
 * 同名同大小的不同内容绝不挂成 workspace ref。
 */
async function resolveWorkspaceRef(file, cwd, sessionId) {
	try {
		const hash = await fileSha256(file);
		if (hash === null) return null;
		const params = new URLSearchParams({ name: file.name, size: String(file.size), hash });
		if (cwd !== undefined) params.set("cwd", cwd);
		if (sessionId !== undefined) params.set("sessionId", sessionId);
		const response = await fetch(`/api/attach-formats/resolve?${params.toString()}`, {
			signal: AbortSignal.timeout(4000)
		});
		if (!response.ok) return null;
		const payload = await response.json();
		if (payload?.ok !== true || payload?.found !== true || typeof payload.rel !== "string") return null;
		return payload.rel;
	} catch {
		return null;
	}
}
async function convertRemote(file, kind, cwd, sessionId, directLimit, hooks = {}) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	// 大文件 base64 编码挪 Worker（主线程只做零拷贝 transfer），不可用回退同步
	const data = await bytesToBase64Async(bytes);
	let response;
	try {
		response = await new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", ROUTE_PATH);
			xhr.responseType = "text";
			// 上传进度：base64 体的 0-90% 区间（响应解析占剩余心智）
			if (typeof hooks.onUploadPercent === "function") {
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						hooks.onUploadPercent(Math.min(99, Math.round((event.loaded / event.total) * 90)));
					}
				};
			}
			xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: xhr.response });
			xhr.onerror = () => reject(new Error("network"));
			xhr.send(JSON.stringify({
				cwd,
				sessionId,
				directLimitChars: directLimit,
				jobId: hooks.jobId,
				files: [{ name: file.name, kind, data }]
			}));
		});
	} catch {
		throw new Error("转换服务不可用（主机插件未加载？）");
	}
	if (!response.ok) throw new Error(`转换服务错误 (HTTP ${response.status})`);
	const payload = JSON.parse(response.text);
	if (!payload || payload.ok !== true) {
		throw new Error(payload?.error?.message ?? "转换服务返回异常");
	}
	const result = Array.isArray(payload.results) ? payload.results[0] : null;
	if (result === null || result === undefined) throw new Error("转换服务未返回结果");
	if (result.kind === "error") throw new Error(result.error?.message ?? "转换失败");
	return result;
}

// ---- base64 编码 Worker（大文件不卡主线程；vm/老环境回退同步）------------
const B64_WORKER_SRC = "self.onmessage=(e)=>{try{const u8=new Uint8Array(e.data.buf);let binary=\"\";const chunk=0x8000;for(let o=0;o<u8.length;o+=chunk)binary+=String.fromCharCode.apply(null,u8.subarray(o,o+chunk));self.postMessage({b64:btoa(binary)});}catch(err){self.postMessage({err:String(err&&err.message||err)});}};";
let b64WorkerUrl = null;

/**
 * Worker 内做 base64 编码；环境不支持 Worker（vm 冒烟/老浏览器）时回退同步。
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
function bytesToBase64Async(bytes) {
	if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
		return Promise.resolve(bytesToBase64(bytes));
	}
	try {
		if (b64WorkerUrl === null) {
			b64WorkerUrl = URL.createObjectURL(new Blob([B64_WORKER_SRC], { type: "text/javascript" }));
		}
		return new Promise((resolve) => {
			const worker = new Worker(b64WorkerUrl);
			worker.onmessage = (event) => {
				worker.terminate();
				if (event.data && typeof event.data.b64 === "string") resolve(event.data.b64);
				else resolve(bytesToBase64(bytes));
			};
			worker.onerror = () => {
				worker.terminate();
				resolve(bytesToBase64(bytes)); // Worker 失败：同步回退，绝不丢内容
			};
			const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
			worker.postMessage({ buf: buf }, [buf]);
		});
	} catch {
		return Promise.resolve(bytesToBase64(bytes));
	}
}


export { loadImage, canvasToPngFile, drawIntoPng, fileToPngFile, countReplacement, fileToText, fileSha256, resolveWorkspaceRef, convertRemote };
