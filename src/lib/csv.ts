/**
 * CSV 序列化（SQL 面板导出用）。
 * 独立成模块以便单元测试；同时做公式注入防护（CWE-1236）：
 * 以 = + @ 或制表符/回车开头的单元格会被前缀单引号，避免在 Excel 中
 * 被解释为公式。负数的 "-" 前缀不做处理，避免破坏常见数值数据。
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const guarded = /^[=+@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(columns: string[], dataRows: Array<Array<string | number | boolean | null>>): string {
  const head = columns.map(csvEscape).join(',');
  const body = dataRows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  return head + (body ? '\r\n' + body : '');
}
