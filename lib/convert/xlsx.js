/**
 * dsh-attachment-formats — XLSX → 矩形 TSV 文本（host side，v0.6）。
 *
 * 每个工作表输出为**矩形网格**：按 cell.col 补齐空单元格（A、C 有值而 B 为空
 * 时 B 保留为空白列，列坐标不漂移），行尾的连续空单元格被裁掉。公式用缓存
 * 结果、富文本取纯文本、其余取显示文本。
 * 始终返回完整逻辑结果——截断策略只发生在最终 delivery tier（见 index.js）。
 */
import ExcelJS from "exceljs";
import { loadArchiveSafely } from "./archive-budget.js";

/** Render one cell to the flat text form used in the TSV grid. */
function cellText(cell) {
  try {
    if (cell.type === ExcelJS.ValueType.Formula) {
      const result = cell.result;
      if (result !== null && result !== undefined && !(result instanceof Error)) return String(result);
      return cell.text ?? "";
    }
    if (cell.type === ExcelJS.ValueType.RichText) {
      const parts = Array.isArray(cell.value?.richText)
        ? cell.value.richText.map((part) => part.text ?? "").join("")
        : cell.text ?? "";
      return parts;
    }
    const text = cell.text;
    if (typeof text === "string" && text !== "") return text;
    const value = cell.value;
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? String(value.text ?? value.result ?? "") : String(value);
  } catch {
    return "";
  }
}

/**
 * Extract text from an encoded .xlsx.
 * @param {Uint8Array} data - encoded XLSX (zip) bytes.
 * @returns {Promise<string>} tab-separated rectangular sections (uncapped).
 */
export async function xlsxToText(data) {
  await loadArchiveSafely(data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data));
  const sections = [];
  for (const sheet of workbook.worksheets) {
    // 先扫一遍拿到全局最大列号，保证矩形网格
    let maxCol = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (row.cellCount > maxCol) maxCol = row.cellCount;
    });
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      for (let col = 1; col <= maxCol; col += 1) {
        cells.push(cellText(row.getCell(col)));
      }
      // 裁掉行尾连续空单元格
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      const line = cells.join("\t");
      if (line.trim() !== "") rows.push(line);
    });
    sections.push(`[工作表: ${sheet.name}]\n${rows.join("\n")}`);
  }
  return sections.join("\n\n");
}
