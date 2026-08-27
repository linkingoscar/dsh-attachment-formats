import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const tag = process.argv[3] ?? "unknown";
if (process.argv[2] === undefined) throw new Error("用法: npm run check:harness -- <deepseek-harness checkout> <tag>");

/** @param {string} pattern */
function has(pattern) {
  try {
    execFileSync("git", ["-C", root, "grep", "-F", "-l", "--", pattern, "apps", "packages"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const common = [
  "conversation.input.left",
  "conversation.input.dock",
  "settings.plugins.tab",
  "createDraftImages",
  "setDraft",
  "data-composer-card"
];
const versioned = tag.includes("0.1.2")
  ? ["requestRejection", "data-composer-input", "ComposerContentEditable"]
  : ["<textarea"];
const missing = [...common, ...versioned].filter((pattern) => !has(pattern));
if (missing.length > 0) throw new Error(`${tag} 缺少插件依赖契约: ${missing.join(", ")}`);
console.log(`${tag}: attachment host contracts verified (${common.length + versioned.length} anchors)`);
