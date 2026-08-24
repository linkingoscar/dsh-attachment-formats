/**
 * dsh-attachment-formats — DSH_HOME 单一真理（对齐上游 single-harness-home 决策）。
 * 显式 env → ~/.dsh，与宿主 resolveDshHome 同构，插件内所有缓存/配置选址共用。
 */
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";

export function dshHomeOf() {
  const env = (process.env.DSH_HOME ?? "").trim();
  if (env !== "" && isAbsolute(env)) return env;
  try {
    return join(homedir(), ".dsh");
  } catch {
    return "";
  }
}

export function resolveStoragesPath(...segments) {
  const home = dshHomeOf();
  if (home !== "") return join(home, "storages", ...segments);
  return null;
}
