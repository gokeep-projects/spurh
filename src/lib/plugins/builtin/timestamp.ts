import { TOOL_ICONS as ICONS } from '../../icons';
import type { PluginResult, SpurhPlugin } from '../types';

export function localDatetimeValue(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function parseTimestamp(input: string, unit: string): Date {
  const number = Number(input.trim());
  if (!Number.isFinite(number)) throw new Error('请输入有效数字');
  const ms = unit === 'seconds' ? number * 1000
    : unit === 'milliseconds' ? number
    : Math.abs(number) < 100_000_000_000 ? number * 1000 : number;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error('时间戳超出范围');
  return d;
}

/** 从任意文本（如日志行）中提取第一个日期时间，本地时区构造，避免各浏览器解析差异 */
function matchDateParts(input: string): number[] | null {
  const m = input.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)] : null;
}

/** 构造本地时间并回读校验：JS Date 会把 2 月 30 日溢出到 3 月 2 日，必须拒绝 */
function strictLocalDate(parts: number[]): Date | null {
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractDate(input: string): Date | null {
  const parts = matchDateParts(input);
  return parts ? strictLocalDate(parts) : null;
}

function fmt(date: Date): string {
  const p = new Intl.DateTimeFormat('zh-CN', { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).formatToParts(date);
  const m = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}

function toResult(date: Date, actionId: string): PluginResult {
  const r = { local: fmt(date), utc: date.toISOString(), unixSeconds: Math.floor(date.getTime()/1000), unixMilliseconds: date.getTime(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return { output: JSON.stringify(r,null,2), language:'json', view:'timestamp', data:r, summary: actionId==='now'?'当前时间':actionId==='to-unix'?'日期→时间戳':'时间戳→日期', meta:{ 时区:r.timezone, Unix秒:r.unixSeconds, 毫秒:r.unixMilliseconds } };
}

export const timestampPlugin: SpurhPlugin = {
  id: 'spurh.timestamp', name: '时间戳转换', description: 'Unix 时间戳 ↔ 日期时间 双向转换', icon: ICONS['spurh.timestamp'], version:'0.1.0', category:'开发', priority:92,
  actions: [
    { id: 'now', label: '当前时间', description: '显示此刻的时间和对应时间戳' },
    { id: 'to-date', label: '时间戳→日期', description: '输入秒/毫秒时间戳转为日期' },
    { id: 'to-unix', label: '日期→时间戳', description: '选择日期时间转为 Unix 时间戳' },
  ],
  options: [
    { id: 'unit', label: '单位', type:'select', defaultValue:'auto', actions:['to-date'], choices:[{value:'auto',label:'自动'},{value:'seconds',label:'秒'},{value:'milliseconds',label:'毫秒'}] },
    { id: 'pickDateTime', label: '日期时间', type:'datetime', defaultValue: localDatetimeValue(), actions:['to-unix'], placeholder:'选择时间（默认当前时间）' },
  ],
  detect(input) {
    const v = input.trim();
    const prefixed = /^(?:timestamp|时间戳)[:：]/i.test(v);
    const body = v.replace(/^(?:timestamp|时间戳)[:：]\s*/i, '');
    if (/^\d{10}$/.test(body)) return { confidence: prefixed ? .9 : .93, reason: prefixed ? '时间戳指令' : '10位秒时间戳', suggestedAction: 'to-date' };
    if (/^\d{13}$/.test(body)) return { confidence: prefixed ? .9 : .96, reason: prefixed ? '时间戳指令' : '13位毫秒时间戳', suggestedAction: 'to-date' };
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(body)) return { confidence: prefixed ? .86 : .84, reason: prefixed ? '时间戳指令' : '日期时间', suggestedAction: 'to-unix' };
    return null;
  },
  execute(actionId, input, options = {}): PluginResult {
    if (actionId === 'now') return toResult(new Date(), actionId);
    if (actionId === 'to-unix') {
      const raw = (options.pickDateTime ?? '').trim();
      const typed = input.trim().replace(/^(?:timestamp|时间戳)[:：]\s*/i, '');
      // 仅当共享输入确实像日期时才优先使用，避免其他模式残留的时间戳文本被误解析
      const dateLike = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(typed);
      const fromPicker = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
      let date: Date;
      if (typed && dateLike) {
        // 文本框内容优先（粘贴/输入日期），避免被 picker 默认值覆盖
        const parts = matchDateParts(typed);
        if (parts) {
          const strict = strictLocalDate(parts);
          if (!strict) throw new Error("无效日期 " + typed + "：请检查年月日是否正确（如 2 月没有 30 日）");
          date = strict;
        } else {
          date = new Date(typed.replace('T', ' '));
        }
      } else if (fromPicker) {
        const strict = strictLocalDate([Number(fromPicker[1]), Number(fromPicker[2]), Number(fromPicker[3]), Number(fromPicker[4]), Number(fromPicker[5]), Number(fromPicker[6] ?? 0)]);
        if (!strict) throw new Error('选择的日期时间无效');
        date = strict;
      } else if (raw) {
        const parts = matchDateParts(raw);
        if (!parts) throw new Error("无法解析日期 " + raw + "，请用 YYYY-MM-DD HH:mm 格式");
        const strict = strictLocalDate(parts);
        if (!strict) throw new Error("无效日期 " + raw + "：请检查年月日是否正确");
        date = strict;
      } else {
        date = new Date(localDatetimeValue().replace('T', ' '));
      }
      if (Number.isNaN(date.getTime())) throw new Error(`无法解析日期 "${dateLike ? typed : raw}"，请用 YYYY-MM-DD HH:mm 格式`);
      return toResult(date, actionId);
    }
    // to-date：支持纯时间戳、日志行（含日期时间或数字）等任意文本
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return toResult(parseTimestamp(trimmed, options.unit || 'auto'), actionId);
    const extracted = extractDate(trimmed);
    if (extracted) return toResult(extracted, actionId);
    const numberMatch = trimmed.match(/-?\d{6,}/);
    if (numberMatch) return toResult(parseTimestamp(numberMatch[0], options.unit || 'auto'), actionId);
    throw new Error('请输入 Unix 时间戳（如 1700000000 / 1700000000000），或包含日期时间的文本');
  },
};