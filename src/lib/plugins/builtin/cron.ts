import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

/* ─────────────────────────── 解析与匹配 ─────────────────────────── */

const MONTH_NAMES: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

type CronFields = {
  hasSeconds: boolean;
  seconds: string;
  minutes: string;
  hours: string;
  dom: string;
  month: string;
  dow: string;
  year: string | null;
};

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 7) throw new Error('Cron 需要 5~7 段：秒(可选) 分 时 日 月 周 [年(可选)]');
  if (parts.length === 6) {
    const [s, m, h, d, mo, w] = parts;
    return { hasSeconds: true, seconds: s, minutes: m, hours: h, dom: d, month: mo, dow: w, year: null };
  }
  if (parts.length === 7) {
    const [s, m, h, d, mo, w, y] = parts;
    return { hasSeconds: true, seconds: s, minutes: m, hours: h, dom: d, month: mo, dow: w, year: y };
  }
  const [m, h, d, mo, w] = parts;
  return { hasSeconds: false, seconds: '0', minutes: m, hours: h, dom: d, month: mo, dow: w, year: null };
}

function expandNames(token: string, names: Record<string, number>): string {
  return token.toUpperCase().replace(/[A-Z]{3}/g, (name) => String(names[name] ?? name));
}

function fieldTokens(field: string): string[] {
  return field.split(',');
}

function normDow(v: number): number {
  return v === 7 ? 0 : v;
}

function matchesBasic(value: number, token: string, min: number, max: number): boolean {
  const step = token.match(/^\*\/(\d+)$/);
  if (step) return value % Number(step[1]) === 0;
  const rangeStep = token.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (rangeStep) {
    const [a, b, s] = [Number(rangeStep[1]), Number(rangeStep[2]), Number(rangeStep[3])];
    return value >= a && value <= b && (value - a) % s === 0;
  }
  const range = token.match(/^(\d+)-(\d+)$/);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  const singleStep = token.match(/^(\d+)\/(\d+)$/);
  if (singleStep) {
    const [a, s] = [Number(singleStep[1]), Number(singleStep[2])];
    return value >= a && (value - a) % s === 0;
  }
  return String(value) === token;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function matchesDom(year: number, month: number, day: number, domField: string): boolean {
  const last = lastDayOfMonth(year, month);
  const tokens = fieldTokens(domField).map((t) => expandNames(t, {}));
  let concrete = false;
  const anyMatch = tokens.some((token) => {
    if (token === '*' || token === '?') return false;
    concrete = true;
    if (/^L-\d+$/.test(token)) return day === last - Number(token.slice(2));
    if (/^\d+W$/i.test(token)) {
      const target = Number(token.slice(0, -1));
      if (target < 1 || target > last) return false;
      const candidate = new Date(year, month - 1, target);
      const offset = candidate.getDay() === 0 ? 1 : candidate.getDay() === 6 ? -1 : 0;
      const moved = new Date(year, month - 1, target + offset);
      return moved.getMonth() === month - 1 && day === target + offset;
    }
    if (token === 'L' || token.toLowerCase() === 'l') return day === last;
    return matchesBasic(day, token, 1, 31);
  });
  return anyMatch || (!concrete && tokens.some((t) => t === '*' || t === '?'));
}

function matchesDow(year: number, month: number, day: number, dowField: string): boolean {
  const date = new Date(year, month - 1, day);
  const weekday = normDow(date.getDay());
  const tokens = fieldTokens(expandNames(dowField, DAY_NAMES));
  let concrete = false;
  const anyMatch = tokens.some((token) => {
    if (token === '*' || token === '?') return false;
    concrete = true;
    const nth = token.match(/^(\d+)#(\d+)$/);
    if (nth) {
      const [w, k] = [normDow(Number(nth[1])), Number(nth[2])];
      const first = 1 + ((w + 7 - new Date(year, month - 1, 1).getDay()) % 7);
      const target = first + (k - 1) * 7;
      return target <= lastDayOfMonth(year, month) && day === target;
    }
    if (/^\d+L$/i.test(token) || token.toLowerCase() === 'l') {
      const w = /^\d+L$/i.test(token) ? normDow(Number(token.slice(0, -1))) : null;
      const last = new Date(year, month, 0);
      for (let d = last.getDate(); d >= 1; d--) {
        const wd = normDow(new Date(year, month - 1, d).getDay());
        if (w === null || wd === w) return day === d;
      }
      return false;
    }
    if (/^\d{1,2}(-\d{1,2})?(\/\d+)?$/.test(token)) {
      // 范围展开并处理 7→0 回绕（如 6-7 = 周六、周日）
      const [aRaw, bRaw, stepRaw] = token.split(/[-/]/);
      const a = normDow(Number(aRaw));
      const b = bRaw !== undefined ? normDow(Number(bRaw)) : a;
      const step = stepRaw ? Number(stepRaw) : 1;
      if (a <= b) {
        return matchesBasic(weekday, `${a}-${b}${stepRaw ? `/${stepRaw}` : ''}`, 0, 7);
      }
      for (let v = a; v <= 7; v += step) {
        if (normDow(v) === weekday) return true;
      }
      for (let v = 0; v <= b; v += step) {
        if (normDow(v) === weekday) return true;
      }
      return false;
    }
    return matchesBasic(weekday, token, 0, 7);
  });
  return anyMatch || (!concrete && tokens.some((t) => t === '*' || t === '?'));
}

function matchesMonth(month: number, monthField: string): boolean {
  const tokens = fieldTokens(expandNames(monthField, MONTH_NAMES));
  return tokens.some((token) => {
    if (token === '*' || token === '?') return true;
    return matchesBasic(month, token, 1, 12);
  });
}

function matchesYear(year: number, yearField: string | null): boolean {
  if (!yearField) return true;
  return fieldTokens(yearField).some((token) => token === '*' || matchesBasic(year, token, 1970, 2199));
}

/** 同时限制日和周字段时，满足其一即可（Quartz 语义） */
function matchesDay(fields: CronFields, year: number, month: number, day: number): boolean {
  const domRestricted = !['*', '?'].includes(fields.dom.trim());
  const dowRestricted = !['*', '?'].includes(fields.dow.trim());
  if (domRestricted && dowRestricted) {
    return matchesDom(year, month, day, fields.dom) || matchesDow(year, month, day, fields.dow);
  }
  return matchesDom(year, month, day, fields.dom) && matchesDow(year, month, day, fields.dow);
}

/* ─────────────────────────── 执行时间计算 ─────────────────────────── */

function matchesTime(value: number, field: string, min: number, max: number): boolean {
  if (field === '*' || field === '?') return true;
  return matchesBasic(value, field, min, max);
}

function nextRuns(expr: string, count = 10): Date[] {
  const fields = parseCron(expr);
  const out: Date[] = [];
  const now = new Date();
  // 从下一个整分/整秒开始
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  let cursor = new Date(start.getTime() + (fields.hasSeconds ? 1000 : 60000));
  const maxDays = 3 * 366;

  for (let scanned = 0; scanned < maxDays && out.length < count; scanned++) {
    const year = cursor.getFullYear();
    const monthIndex = cursor.getMonth(); // 0-based
    const month = monthIndex + 1;         // 1-based（Cron 字段）
    if (!matchesMonth(month, fields.month) || !matchesYear(year, fields.year)) {
      // 跳到下个月 1 号
      cursor = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(fields, year, month, cursor.getDate())) {
      cursor = new Date(year, monthIndex, cursor.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    // 当日有效：以分钟为步长扫描，命中分钟后再遍历秒
    const dayEnd = new Date(year, monthIndex, cursor.getDate() + 1, 0, 0, 0, 0).getTime();
    let t = cursor.getTime();
    while (t < dayEnd && out.length < count) {
      const dt = new Date(t);
      if (matchesTime(dt.getHours(), fields.hours, 0, 23) && matchesTime(dt.getMinutes(), fields.minutes, 0, 59)) {
        if (!fields.hasSeconds) {
          out.push(dt);
        } else {
          const base = t - dt.getSeconds() * 1000;
          for (let s = 0; s < 60 && out.length < count; s++) {
            if (!matchesTime(s, fields.seconds, 0, 59)) continue;
            const at = base + s * 1000;
            // 过滤掉早于当前时刻的秒（cursor 从整分+1s 开始，当前分内可能有已过去的秒）
            if (at > now.getTime()) out.push(new Date(at));
          }
        }
      }
      t += 60000;
    }
    cursor = new Date(year, monthIndex, cursor.getDate() + 1, 0, 0, 0, 0);
  }
  return out;
}
/* ─────────────────────────── 人类可读说明 ─────────────────────────── */

function describeField(field: string, min: number, max: number, unit: string): string {
  const tokens = fieldTokens(field);
  const descs = tokens.map((token) => {
    if (token === '*' || token === '?') return `任意${unit}`;
    const step = token.match(/^\*\/(\d+)$/);
    if (step) return `每 ${step[1]} ${unit}`;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) return `${range[1]}-${range[2]} ${unit}`;
    if (/^(\d+)-(\d+)\/(\d+)$/.test(token)) {
      const m = token.match(/^(\d+)-(\d+)\/(\d+)$/)!;
      return `${m[1]}-${m[2]} ${unit}，步进 ${m[3]}`;
    }
    return `${token} ${unit}`;
  });
  return descs.join('、');
}

function describeDow(field: string): string {
  const tokens = fieldTokens(expandNames(field, DAY_NAMES));
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const descs = tokens.map((token) => {
    if (token === '*' || token === '?') return '每天';
    const nth = token.match(/^(\d+)#(\d+)$/);
    if (nth) return `第${nth[2]}个${names[normDow(Number(nth[1]))]}`;
    if (/^\d+L$/i.test(token) || token.toLowerCase() === 'l') {
      return /^\d+L$/i.test(token) ? `最后一个${names[normDow(Number(token.slice(0, -1)))]}` : '最后一个工作日';
    }
    if (/^\d+(-\d+)?(\/\d+)?$/.test(token)) {
      const values = token.split(',').flatMap((part) => {
        const [a, b] = part.split('-').map((p) => normDow(Number(p.split('/')[0])));
        const out: string[] = [];
        const end = b ?? a;
        for (let i = a; i <= end; i++) out.push(names[i % 7]);
        return out;
      });
      return values.join('、');
    }
    return token;
  });
  return descs.join('、');
}

function describeMonth(field: string): string {
  const tokens = fieldTokens(expandNames(field, MONTH_NAMES));
  return tokens.map((token) => (token === '*' || token === '?' ? '每月' : `${token}月`)).join('、');
}

function quickExplain(f: CronFields): string | null {
  const m = f.minutes.trim();
  const h = f.hours.trim();
  const d = f.dom.trim();
  const mo = f.month.trim();
  const w = f.dow.trim();
  const mStep = m.match(/^\*\/(\d+)$/);
  const hStep = h.match(/^\*\/(\d+)$/);
  const fixed = (v: string) => /^\d+$/.test(v);
  if (mStep && h === '*' && d === '*' && mo === '*' && w === '*') return `每${mStep[1]}分钟`;
  if (fixed(m) && h === '*' && d === '*' && mo === '*' && w === '*') return `每小时第 ${m} 分`;
  if (m === '0' && hStep && d === '*' && mo === '*' && w === '*') return `每${hStep[1]}小时`;
  if (m === '0' && h === '0' && d === '*' && mo === '*' && w === '*') return `每天 00:00`;
  if (fixed(m) && fixed(h) && d === '*' && mo === '*' && w === '*') return `每天 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (fixed(m) && fixed(h) && d === '*' && mo === '*' && w === '1-5') return `工作日 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (fixed(m) && fixed(h) && fixed(d) && mo === '*' && w === '*') return `每月 ${d} 号 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (fixed(m) && fixed(h) && fixed(d) && fixed(mo) && w === '*') return `每年 ${mo} 月 ${d} 号 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  return null;
}
function explainCron(expr: string): string {
  const f = parseCron(expr);
  // 常见模式给出简洁描述（带非零秒时跳过快速路径，避免丢失秒信息）
  const quick = f.hasSeconds && f.seconds !== '0' ? null : quickExplain(f);
  if (quick) return quick;
  const parts: string[] = [];
  if (f.hasSeconds && f.seconds !== '0') parts.push(describeField(f.seconds, 0, 59, '秒'));
  parts.push(describeField(f.minutes, 0, 59, '分'));
  parts.push(describeField(f.hours, 0, 23, '时'));
  const dom = f.dom.trim();
  const dow = f.dow.trim();
  const month = f.month.trim();
  if (dom !== '*' && dom !== '?') {
    const domTokens = fieldTokens(dom).map((token) => {
      if (token === 'L' || token.toLowerCase() === 'l') return '每月最后一天';
      if (/^L-\d+$/.test(token)) return `每月最后一天前 ${token.slice(2)} 天`;
      if (/^\d+W$/i.test(token)) return `每月 ${token.slice(0, -1)} 号最近的平日`;
      return `${token} 号`;
    });
    parts.push(domTokens.join('、'));
  } else {
    parts.push('每天');
  }
  if (month !== '*' && month !== '?') parts.push(describeMonth(month));
  if (dow !== '*' && dow !== '?') parts.push(describeDow(dow));
  if (f.year) parts.push(`年份：${f.year}`);
  return parts.join(' · ');
}

/* ─────────────────────────── 生成器 ─────────────────────────── */

const H = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const M = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const D = Array.from({ length: 31 }, (_, i) => String(i + 1));

function buildExpression(options: Record<string, string>): string {
  const type = options.type || 'daily';
  const m = options.minute || '00';
  const h = options.hour || '09';
  const s = options.second || '00';
  if (type === 'seconds') {
    const interval = Number(options.secondInterval || '10');
    return `*/${Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : 10} * * * * *`;
  }
  if (type === 'minutes') return `*/${options.minuteInterval || '5'} * * * *`;
  if (type === 'hourly') return options.hourInterval && options.hourInterval !== '1' ? `0 */${options.hourInterval} * * *` : '0 * * * *';
  // 定时类型统一生成 6 段表达式，让「秒」选择器生效（默认 00 秒）
  if (type === 'daily') return `${Number(s)} ${Number(m)} ${Number(h)} * * *`;
  if (type === 'workdays') return `${Number(s)} ${Number(m)} ${Number(h)} * * 1-5`;
  if (type === 'weekly') {
    const weekdays = (options.weekdays || '1,3,5').split(',').filter(Boolean).map((v) => String(normDow(Number(v)))).join(',');
    return `${Number(s)} ${Number(m)} ${Number(h)} * * ${weekdays}`;
  }
  if (type === 'monthly') {
    const md = options.monthDay || '1';
    const mdField = md === 'L' ? 'L' : /^L-\d+$/.test(md) ? md : Number(md);
    return `${Number(s)} ${Number(m)} ${Number(h)} ${mdField} * *`;
  }
  if (type === 'yearly') return `${Number(s)} ${Number(m)} ${Number(h)} ${options.monthDay || '1'} ${options.month || '1'} *`;
  const custom = (options.customExpr || '').trim();
  if (!custom) throw new Error('请输入自定义 Cron 表达式');
  parseCron(custom); // 校验
  return custom;
}

function formatDate(date: Date): string {
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function runsResult(expr: string, count: number): PluginResult {
  const runs = nextRuns(expr, count);
  if (!runs.length) throw new Error('3 年内没有匹配的时间');
  const lines = runs.map((d, i) => `${i + 1}. ${formatDate(d)}`);
  return {
    output: `${explainCron(expr)}\n\n未来 ${runs.length} 次执行：\n${lines.join('\n')}`,
    language: 'text',
    view: 'list',
    data: runs.map((d) => formatDate(d)),
    summary: `${runs.length} 次 · ${explainCron(expr)}`,
    meta: { 表达式: expr, 说明: explainCron(expr) },
  };
}

/* ─────────────────────────── 插件定义 ─────────────────────────── */

/** 校验单个 Cron 字段 token 的值域与语法（用于 detect 防误判） */
function validField(token: string, min: number, max: number, special = false, names: Record<string, number> | null = null): boolean {
  if (token === '*' || token === '?') return true;
  for (const part of token.split(',')) {
    if (special) {
      if (/^L(-\d+)?$/i.test(part) || /^\d+W$/i.test(part) || /^\d+#\d+$/.test(part) || /^\d+L$/i.test(part)) {
        const nums = part.match(/\d+/g)?.map(Number) ?? [];
        if (nums.some((n) => n < min || n > max)) return false;
        continue;
      }
    }
    if (/^\*\/(\d+)$/.test(part)) {
      if (Number(part.slice(2)) < 1) return false;
      continue;
    }
    // 名称仅放行本字段允许的月份/星期表，其余字段一律拒绝
    if (names) {
      const namePart = part.match(/^([A-Z]{3})(?:-([A-Z]{3}))?$/);
      if (namePart) {
        const nameTokens = [namePart[1], namePart[2]].filter(Boolean);
        if (nameTokens.every((n) => n in names)) continue;
      }
    }
    const range = part.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (range) {
      const a = Number(range[1]);
      const b = range[2] ? Number(range[2]) : a;
      const step = range[3] ? Number(range[3]) : 1;
      if (step < 1 || a < min || b > max || a > b) return false;
      continue;
    }
    return false;
  }
  return true;
}

export const cronPlugin: SpurhPlugin = {
  id: 'spurh.cron',
  name: 'Cron 表达式',
  description: '生成与解析 Cron，支持秒、L/W/#、年份等全部语法',
  icon: ICONS['spurh.cron'],
  version: '0.2.0',
  category: '开发',
  priority: 80,
  actions: [
    { id: 'generate', label: '生成', description: '选择条件生成 Cron' },
    { id: 'next', label: '执行时间', description: '未来 10 次执行时间' },
    { id: 'explain', label: '解析', description: '解读已有 Cron' },
  ],
  options: [
    { id: 'type', label: '类型', type: 'select', defaultValue: 'daily', actions: ['generate'], choices: [
      { value: 'seconds', label: '每 N 秒' }, { value: 'minutes', label: '每 N 分钟' },
      { value: 'hourly', label: '每 N 小时' }, { value: 'daily', label: '每天' },
      { value: 'workdays', label: '工作日' }, { value: 'weekly', label: '每周' },
      { value: 'monthly', label: '每月' }, { value: 'yearly', label: '每年' },
      { value: 'custom', label: '自定义表达式' },
    ] },
    { id: 'secondInterval', label: '秒间隔', type: 'select', defaultValue: '10', actions: ['generate'], showWhen: { optionId: 'type', values: ['seconds'] }, choices: Array.from({ length: 59 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 秒` })) },
    { id: 'minuteInterval', label: '分间隔', type: 'select', defaultValue: '5', actions: ['generate'], showWhen: { optionId: 'type', values: ['minutes'] }, choices: Array.from({ length: 59 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 分钟` })) },
    { id: 'hourInterval', label: '时间隔', type: 'select', defaultValue: '2', actions: ['generate'], showWhen: { optionId: 'type', values: ['hourly'] }, choices: Array.from({ length: 23 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 小时` })) },
    { id: 'hour', label: '时', type: 'select', defaultValue: '09', actions: ['generate'], showWhen: { optionId: 'type', values: ['daily', 'workdays', 'weekly', 'monthly', 'yearly'] }, choices: H.map((v) => ({ value: v, label: `${v} 时` })) },
    { id: 'minute', label: '分', type: 'select', defaultValue: '00', actions: ['generate'], showWhen: { optionId: 'type', values: ['daily', 'workdays', 'weekly', 'monthly', 'yearly'] }, choices: M.map((v) => ({ value: v, label: `${v} 分` })) },
    { id: 'second', label: '秒', type: 'select', defaultValue: '00', actions: ['generate'], showWhen: { optionId: 'type', values: ['daily', 'workdays', 'weekly', 'monthly', 'yearly'] }, choices: M.map((v) => ({ value: v, label: `${v} 秒` })) },
    { id: 'weekdays', label: '星期', type: 'text', defaultValue: '1,3,5', actions: ['generate'], showWhen: { optionId: 'type', values: ['weekly'] } },
    { id: 'monthDay', label: '日期', type: 'select', defaultValue: '1', actions: ['generate'], showWhen: { optionId: 'type', values: ['monthly', 'yearly'] }, choices: [...D.map((v) => ({ value: v, label: `${v} 号` })), { value: 'L', label: '最后一天' }, ...Array.from({ length: 7 }, (_, i) => ({ value: `L-${i + 1}`, label: `最后一天前 ${i + 1} 天` }))] },
    { id: 'month', label: '月份', type: 'select', defaultValue: '1', actions: ['generate'], showWhen: { optionId: 'type', values: ['yearly'] }, choices: Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` })) },
    { id: 'customExpr', label: '表达式', type: 'text', defaultValue: '*/5 * * * *', actions: ['generate'], showWhen: { optionId: 'type', values: ['custom'] }, placeholder: '分 时 日 月 周 [秒 年]' },
  ],
  detect(input) {
    const v = input.trim();
    const f = v.split(/\s+/);
    if ((f.length >= 5 && f.length <= 7) && f.every((x) => /^[\d*/?,\-LWN#A-Za-z]+$/.test(x))) {
      try {
        parseCron(v);
        const [sec, min, hr, dom, mon, dow, yr] = f.length === 5 ? ['0', ...f] : f;
        if (!validField(sec, 0, 59) || !validField(min, 0, 59) || !validField(hr, 0, 23)
          || !validField(dom, 1, 31, true) || !validField(mon, 1, 12, false, MONTH_NAMES)
          || !validField(dow, 0, 7, true, DAY_NAMES)
          || (yr !== undefined && !validField(yr, 1970, 2199))) {
          return null;
        }
        return { confidence: 0.96, reason: 'Cron 表达式' };
      } catch { /* not valid */ }
    }
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    if (actionId === 'generate') {
      const expr = buildExpression(options);
      return runsResult(expr, 5);
    }
    const expr = input.trim();
    if (!expr) throw new Error('请先输入 Cron 表达式（支持 5~7 段）');
    parseCron(expr);
    if (actionId === 'next') return runsResult(expr, 10);
    return { output: explainCron(expr), language: 'text', summary: 'Cron 解析', meta: { 表达式: expr } };
  },
};

export { buildExpression, explainCron, nextRuns };