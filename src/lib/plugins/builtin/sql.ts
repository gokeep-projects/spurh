import { TOOL_ICONS as ICONS } from '../../icons';
import { invoke } from '@tauri-apps/api/core';
import type { PluginResult, SpurhPlugin } from '../types';

export type SqlProfile = {
  kind: 'mysql' | 'sqlite' | 'postgres';
  host: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  file?: string;
  ssl?: boolean;
};

export type SqlExecResult = {
  columns: string[];
  rows: unknown[][];
  affected: number;
  elapsedMs: number;
  truncated: boolean;
  isQuery: boolean;
};

export type SqlTestResult = {
  kind: string;
  serverVersion: string;
  elapsedMs: number;
};

export function profileFromOptions(options: Record<string, string>): SqlProfile {
  const kind = (options.dbType === 'sqlite' || options.dbType === 'postgres' ? options.dbType : 'mysql') as SqlProfile['kind'];
  return {
    kind,
    host: options.host || 'localhost',
    port: options.port ? Number(options.port) : undefined,
    user: options.user || undefined,
    password: options.password || undefined,
    database: options.database || undefined,
    file: options.file || undefined,
    ssl: options.ssl === '1' || options.ssl === 'true',
  };
}

export const sqlPlugin: SpurhPlugin = {
  id: 'spurh.sql',
  name: 'SQL 工具',
  description: 'MySQL · SQLite · PostgreSQL',
  icon: ICONS['spurh.sql'],
  version: '0.1.0',
  category: '数据',
  priority: 72,
  actions: [{ id: 'run', label: '运行', description: '在已选连接上执行 SQL' }],
  options: [
    {
      id: 'dbType', label: '数据库', type: 'select', defaultValue: 'mysql',
      choices: [
        { value: 'mysql', label: 'MySQL（内置驱动）' },
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'sqlite', label: 'SQLite' },
      ],
    },
    { id: 'host', label: '主机', type: 'text', defaultValue: 'localhost', placeholder: '127.0.0.1', showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] } },
    { id: 'port', label: '端口', type: 'text', defaultValue: '', placeholder: '3306 / 5432', showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] } },
    { id: 'user', label: '用户', type: 'text', defaultValue: 'root', placeholder: 'root', showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] } },
    { id: 'password', label: '密码', type: 'password', defaultValue: '', placeholder: '••••••••', showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] } },
    { id: 'database', label: '数据库', type: 'text', defaultValue: '', placeholder: '默认库（可留空）', showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] } },
    { id: 'ssl', label: 'SSL 加密', type: 'select', defaultValue: '0', actions: ['run'], showWhen: { optionId: 'dbType', values: ['mysql', 'postgres'] }, choices: [{ value: '0', label: '关闭' }, { value: '1', label: '启用' }] },
    { id: 'file', label: '数据库文件', type: 'text', defaultValue: '', placeholder: 'C:\path\to\app.db 或 :memory:', showWhen: { optionId: 'dbType', values: ['sqlite'] } },
  ],
  detect(input) {
    if (/^\s*(select|show|desc|describe|explain|create|alter|drop|insert|update|delete|truncate|use|with|pragma|set)\b/i.test(input)) {
      return { confidence: 0.52, reason: '检测到 SQL 语句' };
    }
    return null;
  },
  async execute(actionId, input, options = {}): Promise<PluginResult> {
    if (actionId !== 'run') throw new Error('未知操作');
    const profile = profileFromOptions(options);
    const result = await invoke<SqlExecResult>('sql_execute', { profile, sql: input });
    const rows = result.rows ?? [];
    const summary = result.isQuery
      ? `${rows.length} 行${result.truncated ? '（已截断）' : ''} · ${result.elapsedMs} ms`
      : `影响 ${result.affected} 行 · ${result.elapsedMs} ms`;
    return {
      output: JSON.stringify(result, null, 2),
      language: 'json',
      view: 'sql',
      data: result,
      summary,
      meta: result.isQuery
        ? { 行数: rows.length, 耗时: `${result.elapsedMs} ms`, 类型: profile.kind.toUpperCase() }
        : { 影响行数: result.affected, 耗时: `${result.elapsedMs} ms`, 类型: profile.kind.toUpperCase() },
    };
  },
};
