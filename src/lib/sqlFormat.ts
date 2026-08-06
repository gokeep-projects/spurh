/**
 * 轻量 SQL 格式化：保留字符串/注释原样，关键字统一大写，主从句换行。
 * 不追求完美 AST，目标是让常见查询可读性大幅提升。
 */

const CLAUSE_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'UNION', 'JOIN', 'ON', 'SET', 'VALUES', 'INSERT', 'UPDATE', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'RETURNING',
]);

const CLAUSE_PHRASES = [
  'UNION ALL', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'RIGHT JOIN', 'RIGHT OUTER JOIN',
  'FULL JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'INSERT INTO',
  'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
];

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

/** 从 i 开始读取一个完整单词（含多词子句，如 LEFT JOIN） */
function readPhrase(input: string, i: number): { text: string; upper: string; next: number } {
  let j = i;
  while (j < input.length && isIdentChar(input[j])) j += 1;
  const first = input.slice(i, j);
  let upper = first.toUpperCase();
  // 尝试匹配多词子句（如 LEFT JOIN / GROUP BY）
  for (const phrase of CLAUSE_PHRASES) {
    const words = phrase.split(' ');
    if (words[0] !== upper) continue;
    // 检查后续是否紧跟着 phrase 的其余单词
    let k = j;
    let ok = true;
    for (const w of words.slice(1)) {
      while (k < input.length && /\s/.test(input[k])) k += 1;
      let m = k;
      while (m < input.length && isIdentChar(input[m])) m += 1;
      if (input.slice(k, m).toUpperCase() !== w) { ok = false; break; }
      k = m;
    }
    if (ok) {
      let end = j;
      for (const w of words.slice(1)) {
        while (end < input.length && /\s/.test(input[end])) end += 1;
        end += w.length;
      }
      return { text: phrase, upper: phrase, next: end };
    }
  }
  return { text: first, upper, next: j };
}

export function formatSql(input: string): string {
  const out: string[] = [];
  let i = 0;
  let pendingSpace = false;

  const push = (text: string): void => {
    if (pendingSpace && out.length > 0 && !/\s$/.test(out[out.length - 1])) out.push(' ');
    out.push(text);
    pendingSpace = false;
  };
  const newline = (indent = 0): void => {
    while (out.length > 0 && /\s$/.test(out[out.length - 1])) out.pop();
    out.push('\n' + ' '.repeat(indent));
    pendingSpace = false;
  };

  while (i < input.length) {
    const ch = input[i];

    // 字符串字面量（含 '' 转义）
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < input.length) {
        if (input[j] === quote) {
          if (input[j + 1] === quote) { j += 2; continue; }
          j += 1; break;
        }
        j += 1;
      }
      push(input.slice(i, j));
      i = j;
      continue;
    }

    // 行注释
    if (ch === '-' && input[i + 1] === '-') {
      const e = input.indexOf('\n', i);
      push(input.slice(i, e === -1 ? input.length : e));
      i = e === -1 ? input.length : e;
      continue;
    }

    // 块注释
    if (ch === '/' && input[i + 1] === '*') {
      const e = input.indexOf('*/', i + 2);
      push(input.slice(i, e === -1 ? input.length : e + 2));
      i = e === -1 ? input.length : e + 2;
      continue;
    }

    // 空白
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }

    // 标识符/关键字
    if (isIdentChar(ch)) {
      const { text, upper, next } = readPhrase(input, i);
      i = next;
      if (CLAUSE_PHRASES.includes(upper) || CLAUSE_KEYWORDS.has(upper)) {
        newline(upper === 'AND' || upper === 'OR' ? 2 : 0);
        out.push(upper);
        pendingSpace = true;
      } else {
        push(text);
        pendingSpace = true;
      }
      continue;
    }

    // 标点
    if (ch === ',') {
      // 去掉前导空格再输出逗号
      while (out.length > 0 && /\s$/.test(out[out.length - 1])) out.pop();
      out.push(',');
      pendingSpace = true;
    } else {
      push(ch);
    }
    i += 1;
  }

  let result = out.join('').replace(/\n\n+/g, '\n').trim();
  if (input.trim().endsWith(';') && !result.endsWith(';')) result += ';';
  return result;
}
