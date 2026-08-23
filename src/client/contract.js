// 常量与纯函数（无 DOM / 无 React 依赖，host 冒烟可直接 import）。
// ---- constants ---------------------------------------------------
const ROUTE_PATH = "/api/attach-formats/convert";
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;
/** 文本直插草稿的阈值；超过则上传主机走索引卡模式（T2）。 */
const DIRECT_TEXT_CHARS = 80_000;
/** 长文本上传主机的字节上限。 */
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const RASTER_PIXEL_CAP = 8_000_000; // 降采样阈值（原生限额为 4e7）
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = new Set([
	"txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml",
	"toml", "ini", "cfg", "conf", "env", "log", "xml", "html", "htm", "css", "scss",
	"less", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "java", "kt", "kts", "c", "h",
	"cpp", "hpp", "cc", "cs", "go", "rs", "rb", "php", "swift", "scala", "sql", "r",
	"lua", "pl", "dart", "ex", "exs", "elm", "hs", "clj", "fs", "fsx", "vue", "svelte",
	"graphql", "gql", "proto", "sh", "bat", "cmd", "ps1", "dockerfile", "makefile",
	"cmake", "gradle", "properties", "gitignore", "gitattributes", "editorconfig", "tex", "rst"
]);
const ACCEPT = [
	"image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif",
	"image/svg+xml", "image/x-icon", "image/tiff", "application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
	"application/epub+zip", "application/vnd.oasis.opendocument.text", "application/rtf",
	"text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
	".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".h", ".cpp",
	".cs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql", ".yaml", ".yml", ".toml",
	".ini", ".log", ".vue", ".svelte", ".css", ".scss", ".html", ".graphql",
	".doc", ".xls", ".ppt", ".tiff", ".tif", ".epub", ".odt", ".rtf"
].join(",");

// ---- helpers ------------------------------------------------------
function extensionOf(name) {
	const base = String(name ?? "").toLowerCase();
	const dot = base.lastIndexOf(".");
	if (dot < 0 || dot === base.length - 1) return "";
	return base.slice(dot + 1);
}
function baseNameOf(name) {
	const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "attachment";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}
function bytesToBase64(bytes) {
	let binary = "";
	const chunk = 32768;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return btoa(binary);
}
function b64ToBytes(data) {
	const binary = atob(String(data ?? ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---- classification ----------------------------------------------
function classifyFile(file) {
	const type = (file.type || "").toLowerCase();
	const ext = extensionOf(file.name);
	if (NATIVE_IMAGE_TYPES.has(type)) return "native-image";
	if (type === "application/pdf" || ext === "pdf") return "pdf";
	if (ext === "docx" || ext === "xlsx" || ext === "pptx") return ext;
	if (ext === "doc" || ext === "xls" || ext === "ppt") return ext;
	if (ext === "epub" || ext === "odt" || ext === "rtf") return ext;
	if (ext === "tiff" || ext === "tif" || type === "image/tiff") return "tiff";
	if (ext === "svg" || type === "image/svg+xml") return "browser-image";
	if (type.startsWith("image/")) return "browser-image";
	if (
		TEXT_EXTENSIONS.has(ext) ||
		type.startsWith("text/") ||
		type === "application/json" ||
		type.endsWith("+json") ||
		type === "application/xml" ||
		type === "application/x-yaml" ||
		type === "application/javascript"
	) return "text";
	return "unsupported";
}


export { ROUTE_PATH, MAX_TEXT_BYTES, MAX_TEXT_CHARS, DIRECT_TEXT_CHARS, MAX_CACHE_BYTES, RASTER_PIXEL_CAP, NATIVE_IMAGE_TYPES, TEXT_EXTENSIONS, ACCEPT, extensionOf, baseNameOf, bytesToBase64, b64ToBytes, classifyFile };
