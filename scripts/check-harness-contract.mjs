import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? "");
const tag = process.argv[3] ?? "unknown";
if (process.argv[2] === undefined) throw new Error("用法: npm run check:harness -- <deepseek-harness checkout> <tag>");
const ref = tag === "unknown" ? "HEAD" : tag;
execFileSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { stdio: "ignore" });

/** @param {string} pattern */
function has(pattern) {
  try {
    execFileSync("git", ["-C", root, "grep", "-F", "-l", "-e", pattern, ref, "--", ":(glob)packages/client/**/src/**"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const common = [
  "conversation.input.left",
  "conversation.input.dock",
  "settings.plugins.tab",
  "setDraft",
  "data-composer-card"
];
// Inspect capabilities rather than treating every release after 0.1.2 as textarea-era.
const attachments = has("createDrafts(sessionId:")
  ? ["createDrafts(sessionId:", "addAttachments(", "releaseDraftAttachments("]
  : ["createDraftImages(", "addImages(", "releaseDraftImages("];
const editor = has("data-composer-input")
  ? ["requestRejection", "data-composer-input", "ComposerContentEditable"]
  : ["<textarea"];
const anchors = [...common, ...attachments, ...editor];
const missing = anchors.filter((pattern) => !has(pattern));
if (missing.length > 0) throw new Error(`${tag} 缺少插件依赖契约: ${missing.join(", ")}`);
console.log(`${tag}: attachment source anchors present (${anchors.length}; run smoke:client for behavior)`);
const listPath = execFileSync("git", ["-C", root, "grep", "-l", "export interface SessionListState", ref, "--", ":(glob)packages/**/src/**"], { encoding: "utf8" }).trim().split("\n")[0];
const listSource = execFileSync("git", ["-C", root, "show", listPath], { encoding: "utf8" });
const listShape = /export interface SessionListState \{([\s\S]*?)\n\}/.exec(listSource)?.[1] ?? "";
if (!/\bcurrent[?:]/.test(listShape)) {
  if (!listSource.includes("readonly retainedBy:") || !listSource.includes("retain(") || !has("retainedBy.mainView") || !has("data-conversation-content")) {
    throw new Error(`${tag}: unrecognized retained-session/composer contract`);
  }
  execFileSync(process.execPath, ["--test", fileURLToPath(new URL("./multisession-client.test.mjs", import.meta.url))], { stdio: "inherit" });
}
