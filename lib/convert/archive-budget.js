import JSZip from "jszip";

export const ARCHIVE_MAX_ENTRIES = 4_096;
export const ARCHIVE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_MAX_RATIO = 200;

function budgetError(message) {
  const error = new Error(`压缩文档超出安全预算：${message}`);
  error.code = "archive-budget-exceeded";
  return error;
}

/**
 * 在解压任一条目前检查 ZIP 中央目录声明，阻断高压缩比、超大条目和条目洪泛。
 * @param {import("jszip")} zip
 * @param {number} compressedBytes
 */
export function assertArchiveBudget(zip, compressedBytes) {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > ARCHIVE_MAX_ENTRIES) {
    throw budgetError(`条目数 ${entries.length} 超过 ${ARCHIVE_MAX_ENTRIES}`);
  }
  let total = 0;
  for (const entry of entries) {
    const size = Number(entry?._data?.uncompressedSize);
    if (!Number.isFinite(size) || size < 0) throw budgetError(`无法验证条目 ${entry.name} 的解压大小`);
    if (size > ARCHIVE_MAX_ENTRY_BYTES) {
      throw budgetError(`条目 ${entry.name} 解压后超过 ${ARCHIVE_MAX_ENTRY_BYTES / 1024 / 1024}MB`);
    }
    total += size;
    if (total > ARCHIVE_MAX_TOTAL_BYTES) {
      throw budgetError(`总解压大小超过 ${ARCHIVE_MAX_TOTAL_BYTES / 1024 / 1024}MB`);
    }
  }
  const denominator = Math.max(1, compressedBytes);
  if (total / denominator > ARCHIVE_MAX_RATIO) {
    throw budgetError(`压缩比超过 ${ARCHIVE_MAX_RATIO}:1`);
  }
  return { entries: entries.length, uncompressedBytes: total };
}

/** 加载 ZIP 并在任何 entry.async() 前完成预算校验。 */
export async function loadArchiveSafely(data) {
  const bytes = Buffer.from(data);
  const zip = await JSZip.loadAsync(bytes);
  assertArchiveBudget(zip, bytes.length);
  return zip;
}
