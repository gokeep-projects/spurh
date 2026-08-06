// 正则样例生成：解析常见 JS 正则语法，生成能匹配的示例文本。
// 支持：字面量、转义字符、字符类、分组、量词、分支。断言/锚点会被忽略。

type Token =
  | { kind: 'literal'; value: string }
  | { kind: 'escape'; value: string }
  | { kind: 'class'; items: ClassItem[]; negated: boolean }
  | { kind: 'group'; branches: Token[][]; capturing: boolean; negative: boolean }
  | { kind: 'quant'; base: Token; min: number; max: number };

type ClassItem = { type: 'char'; value: string } | { type: 'range'; from: string; to: string } | { type: 'special'; value: string };

const DIGITS = '0123456789';
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const WORD = LOWERCASE + UPPERCASE + DIGITS + '_';
const SPACE = ' \t\n';
const ALL = LOWERCASE + UPPERCASE + DIGITS + ' _-.,;:!?@#$%^&*()[]{}<>/\\|`~\'"+=';
const CJK = '中文编码开发测试工具';
const POOL = LOWERCASE + DIGITS;

function pick(pool: string): string {
  if (!pool) return 'a';
  return pool[Math.floor(Math.random() * pool.length)];
}

function parse(pattern: string): Token[] {
  let index = 0;
  const tokens: Token[] = [];

  function parseQuantified(): Token {
    let base: Token;
    const start = index;
    const ch = pattern[index];
    if (ch === '(') {
      index++;
      const two = pattern.slice(index, index + 2);
      const three = pattern.slice(index, index + 3);
      const lookaround = two === '?=' || two === '?!' || two === '?:' || three === '?<=' || three === '?<!';
      const capturing = !(pattern[index] === '?' && lookaround);
      if (pattern[index] === '?') {
        if (two === '?=' || two === '?!' || two === '?:') index += 2;
        else if (three === '?<=' || three === '?<!') index += 3;
      }
      const branches: Token[][] = [];
      let current: Token[] = [];
      let depth = 1;
      while (index < pattern.length && depth > 0) {
        const c = pattern[index];
        if (c === '(') depth++;
        if (c === ')' && depth === 1) {
          branches.push(current);
          index++;
          break;
        }
        if (c === '|' && depth === 1) {
          branches.push(current);
          current = [];
          index++;
          continue;
        }
        if (c === ')') depth--;
        current = current.concat(parseExpression());
      }
      if (branches.length === 0) branches.push(current);
      base = { kind: 'group', branches, capturing, negative: two === '?!' || three === '?<!' };
    } else if (ch === '[') {
      index++;
      const negated = pattern[index] === '^';
      if (negated) index++;
      const items: ClassItem[] = [];
      while (index < pattern.length && pattern[index] !== ']') {
        const c = pattern[index];
        if (c === '\\') {
          index++;
          items.push({ type: 'special', value: pattern[index] ?? '' });
          index++;
        } else if (pattern[index + 1] === '-' && pattern[index + 2] !== ']' && pattern[index + 2] !== undefined) {
          items.push({ type: 'range', from: c, to: pattern[index + 2] });
          index += 3;
        } else {
          items.push({ type: 'char', value: c });
          index++;
        }
      }
      index++; // ]
      base = { kind: 'class', items, negated };
    } else if (ch === '\\') {
      index++;
      const escaped = pattern[index] ?? '';
      index++;
      base = { kind: 'escape', value: escaped };
    } else if (ch === '.') {
      index++;
      base = { kind: 'class', items: [{ type: 'special', value: '.' }], negated: false };
    } else if (ch === '^' || ch === '$') {
      index++;
      base = { kind: 'literal', value: '' };
    } else {
      index++;
      base = { kind: 'literal', value: ch };
    }
    // 量词
    const q = pattern[index];
    if (q === '*' || q === '+' || q === '?') {
      index++;
      if (pattern[index] === '?') index++; // 懒惰量词
      base = q === '*' ? { kind: 'quant', base, min: 0, max: 3 }
        : q === '+' ? { kind: 'quant', base, min: 1, max: 4 }
        : { kind: 'quant', base, min: 0, max: 1 };
    } else if (q === '{') {
      const close = pattern.indexOf('}', index);
      if (close !== -1) {
        const body = pattern.slice(index + 1, close);
        const parts = body.split(',');
        const min = Number.parseInt(parts[0] || '0', 10);
        const max = parts.length > 1 ? (parts[1] ? Number.parseInt(parts[1], 10) : Math.max(min, min + 3)) : min;
        index = close + 1;
        if (pattern[index] === '?') index++;
        base = { kind: 'quant', base, min: Math.min(min, 5), max: Math.min(Math.max(max, min), 6) };
      }
    }
    return base;
  }

  function parseExpression(): Token[] {
    if (pattern[index] === ')' || pattern[index] === '|') return [];
    const token = parseQuantified();
    return token ? [token] : [];
  }

  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === ')' || ch === '|') { index++; continue; }
    tokens.push(...parseExpression());
  }
  return tokens;
}

function specialValue(value: string): string {
  switch (value) {
    case 'd': return pick(DIGITS);
    case 'w': return pick(WORD);
    case 's': return pick(SPACE);
    case 'D': return pick(ALL.replace(/\d/g, ''));
    case 'W': return pick(ALL.replace(/\w/g, ''));
    case 'S': return pick(ALL.replace(/\s/g, ''));
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '\0';
    case 'u': return pick(CJK);
    case 'x': return pick(CJK);
    case '.': return '.';
    case '/': return '/';
    case '-': return '-';
    case ']': return ']';
    case '}': return '}';
    case '{': return '{';
    case '(': return '(';
    case ')': return ')';
    case '[': return '[';
    case '*': return '*';
    case '+': return '+';
    case '?': return '?';
    case '^': return '^';
    case '$': return '$';
    case '|': return '|';
    case '\\': return '\\';
    case 'b': return '';
    case 'B': return '';
    default: return value;
  }
}

function classItemValue(item: ClassItem): string {
  if (item.type === 'special') return specialValue(item.value) || pick(POOL);
  if (item.type === 'range') {
    const from = item.from.codePointAt(0) ?? 97;
    const to = item.to.codePointAt(0) ?? 122;
    if (from > to) return item.from;
    return String.fromCodePoint(from + Math.floor(Math.random() * (to - from + 1)));
  }
  return item.value;
}

function render(token: Token, depth = 0): string {
  if (depth > 8) return '';
  if (token.kind === 'literal') return token.value;
  if (token.kind === 'escape') return specialValue(token.value);
  if (token.kind === 'class') {
    if (token.items.length === 0) return pick(POOL);
    const candidates = token.items.map(classItemValue).filter((value) => value !== '');
    if (candidates.length === 0) return pick(POOL);
    if (token.negated) return pick(POOL);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (token.kind === 'group') {
    // negative assertions are zero-width: render nothing
    if (token.negative) return '';
    const branch = token.branches[Math.floor(Math.random() * token.branches.length)];
    return branch.map((item) => render(item, depth + 1)).join('');
  }
  if (token.kind === 'quant') {
    const count = token.min + Math.floor(Math.random() * Math.max(1, token.max - token.min + 1));
    let output = '';
    for (let i = 0; i < count; i++) output += render(token.base, depth + 1);
    return output;
  }
  return '';
}

export function generateRegexSamples(pattern: string, flags: string, count = 6): string[] {
  if (!pattern) return [];
  try {
    new RegExp(pattern, flags.replace(/[^gimsuvy]/g, ''));
  } catch {
    return [];
  }
  const tokens = parse(pattern);
  const samples = new Set<string>();
  for (let attempt = 0; attempt < count * 8 && samples.size < count; attempt++) {
    const sample = tokens.map((token) => render(token)).join('').slice(0, 80);
    if (sample && (new RegExp(pattern, flags.replace(/[^gimsuvy]/g, '')).test(sample))) samples.add(sample);
  }
  return [...samples].slice(0, count);
}
