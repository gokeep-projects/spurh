/**
 * SQL 编辑器语法高亮：先把文本 HTML 转义，再单遍扫描注释/字符串/数字/关键字。
 * 独立成模块以便单元测试。
 */

const SQL_KEYWORDS = new Set([
  'SELECT','INSERT','UPDATE','DELETE','FROM','WHERE','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS',
  'ON','AS','AND','OR','NOT','NULL','IN','EXISTS','BETWEEN','LIKE','ILIKE','ORDER','BY','GROUP','HAVING',
  'LIMIT','OFFSET','DISTINCT','UNION','ALL','CASE','WHEN','THEN','ELSE','END','CREATE','TABLE','ALTER','DROP',
  'INDEX','VIEW','PRIMARY','KEY','FOREIGN','REFERENCES','CONSTRAINT','DEFAULT','UNIQUE','AUTO_INCREMENT',
  'INT','INTEGER','BIGINT','SMALLINT','TINYINT','VARCHAR','CHAR','TEXT','LONGTEXT','DATE','DATETIME','TIMESTAMP',
  'TIME','DECIMAL','NUMERIC','FLOAT','DOUBLE','BOOLEAN','BLOB','JSON','JSONB','SERIAL','BIGSERIAL','REAL','UUID',
  'BYTEA','USE','SHOW','DESCRIBE','DESC','EXPLAIN','PRAGMA','WITH','VALUES','SET','TRUNCATE','GRANT','REVOKE',
  'COMMIT','ROLLBACK','BEGIN','TRANSACTION','CASCADE','RESTRICT','IF','TO','INTO','RETURNING','OVER','PARTITION',
  'WINDOW','ROWS','RANGE','CURRENT','ROW','LATERAL','FETCH','FIRST','NEXT','ONLY','TABLESAMPLE','RECURSIVE',
]);

export function highlightSql(input: string): string {
  const escaped = input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 单遍扫描：注释 → 字符串 → 数字 → 单词（关键字）
  // 只转义 & < >（引号保持原样），因此字符串需按原始引号匹配
  const pattern = /(--[^\n]*)|('(?:[^'\n]|'')*'|"(?:[^"\n]|"")*")|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  return escaped.replace(pattern, (token, comment: string, str: string, num: string, word: string) => {
    if (comment) return '<span class="sql-hl-comment">' + token + '</span>';
    if (str) return '<span class="sql-hl-string">' + token + '</span>';
    if (num) return '<span class="sql-hl-number">' + token + '</span>';
    if (word && SQL_KEYWORDS.has(word.toUpperCase())) return '<span class="sql-hl-keyword">' + token + '</span>';
    return token;
  });
}
