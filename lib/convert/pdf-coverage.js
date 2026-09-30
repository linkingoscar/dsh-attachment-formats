/** Text coverage is not visual completeness: a textless page may be blank, scanned or a chart. */
export function pdfTextCoverage(pageCount, textPages) {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0 || !Array.isArray(textPages)) return null;
  const covered = new Set(textPages.filter(page => Number.isSafeInteger(page) && page >= 1 && page <= pageCount));
  const missingTextPages = Array.from({ length: pageCount }, (_, i) => i + 1).filter(page => !covered.has(page));
  return { totalPages: pageCount, textPageCount: covered.size, missingTextPages,
    status: missingTextPages.length > 0 ? "missing-text-pages" : "text-on-all-pages" };
}

export function coverageNotes(coverage) {
  if (!coverage || coverage.missingTextPages.length === 0) return [];
  const pages = coverage.missingTextPages.slice(0, 20).join("、");
  return [`文本覆盖 ${coverage.textPageCount}/${coverage.totalPages} 页；第 ${pages}${coverage.missingTextPages.length > 20 ? " 等" : ""} 页未提取到文字，可能为空白、扫描件或图表。请核对原文页面，必要时单独 OCR；其余页面有文字也不代表图表、公式和版式已完整保留。`];
}
