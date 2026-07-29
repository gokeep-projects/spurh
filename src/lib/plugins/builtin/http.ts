import { invoke } from '@tauri-apps/api/core';
import type { PluginResult, SpurhPlugin } from '../types';

type HttpResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  contentType: string;
  sizeBytes: number;
};

function parseHeaders(value: string): Record<string, string> {
  const input = value.trim();
  if (!input) return {};
  if (input.startsWith('{')) {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求头 JSON 必须是对象');
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  }
  return Object.fromEntries(input.split(/\r?\n|;/).filter(Boolean).map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`请求头格式错误：${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

function requestHeaders(options: Record<string, string>): Record<string, string> {
  const headers = parseHeaders(options.headers ?? '');
  if (options.contentType && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = options.contentType;
  }
  if (options.authType === 'bearer') headers.Authorization = `Bearer ${options.token ?? ''}`;
  if (options.authType === 'api-key') headers[options.apiKeyHeader || 'X-API-Key'] = options.apiKeyValue ?? '';
  return headers;
}

function generateCode(language: string, method: string, url: string, body: string, options: Record<string, string>): string {
  const headers = requestHeaders(options);
  if (options.authType === 'basic') {
    const credentials = btoa(`${options.username ?? ''}:${options.password ?? ''}`);
    headers.Authorization = `Basic ${credentials}`;
  }
  const hasBody = body.length > 0 && !['GET', 'HEAD'].includes(method);
  if (language === 'javascript') {
    return [
      `const response = await fetch(${JSON.stringify(url)}, {`,
      `  method: ${JSON.stringify(method)},`,
      `  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`,
      ...(hasBody ? [`  body: ${JSON.stringify(body)},`] : []),
      '});',
      'const data = await response.text();',
      'console.log(response.status, data);',
    ].join('\n');
  }
  if (language === 'python') {
    return [
      'import requests',
      '',
      `response = requests.request(${JSON.stringify(method)}, ${JSON.stringify(url)},`,
      `    headers=${JSON.stringify(headers, null, 2).replace(/"([^"\n]+)":/g, '"$1":')},`,
      ...(hasBody ? [`    data=${JSON.stringify(body)},`] : []),
      ')',
      'print(response.status_code)',
      'print(response.text)',
    ].join('\n');
  }
  if (language === 'go') {
    return [
      'package main',
      '',
      'import (',
      '  "fmt"',
      '  "io"',
      '  "net/http"',
      '  "strings"',
      ')',
      '',
      'func main() {',
      `  body := strings.NewReader(${JSON.stringify(hasBody ? body : '')})`,
      `  req, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)`,
      ...Object.entries(headers).map(([key, value]) => `  req.Header.Set(${JSON.stringify(key)}, ${JSON.stringify(value)})`),
      '  res, err := http.DefaultClient.Do(req)',
      '  if err != nil { panic(err) }',
      '  defer res.Body.Close()',
      '  data, _ := io.ReadAll(res.Body)',
      '  fmt.Println(res.StatusCode, string(data))',
      '}',
    ].join('\n');
  }
  const headerArgs = Object.entries(headers).map(([key, value]) => `  -H ${JSON.stringify(`${key}: ${value}`)} \\`).join('\n');
  return [
    `curl --request ${method} \\`,
    `  --url ${JSON.stringify(url)} \\`,
    headerArgs,
    ...(hasBody ? [`  --data-raw ${JSON.stringify(body)}`] : []),
  ].filter(Boolean).join('\n').replace(/ \\\n$/, '');
}

export const httpPlugin: SpurhPlugin = {
  id: 'spurh.http',
  name: 'HTTP 调用',
  description: '请求调试、认证、响应查看与代码生成',
  icon: '↗',
  version: '0.1.0',
  category: '开发',
  priority: 86,
  actions: [
    { id: 'request', label: '发送请求', description: '通过原生客户端发送 HTTP 请求' },
    { id: 'code', label: '生成代码', description: '按当前请求配置生成调用代码' },
  ],
  options: [
    {
      id: 'method', label: '方法', type: 'select', defaultValue: 'GET',
      choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((value) => ({ value, label: value })),
    },
    { id: 'url', label: '地址', type: 'text', defaultValue: '', placeholder: 'https://api.example.com/users' },
    {
      id: 'authType', label: '认证', type: 'select', defaultValue: 'none',
      choices: [
        { value: 'none', label: '无认证' },
        { value: 'bearer', label: 'Bearer Token' },
        { value: 'basic', label: 'Basic Auth' },
        { value: 'api-key', label: 'API Key' },
      ],
    },
    { id: 'token', label: 'Token', type: 'text', defaultValue: '', placeholder: 'Bearer Token', showWhen: { optionId: 'authType', values: ['bearer'] } },
    { id: 'username', label: '用户名', type: 'text', defaultValue: '', placeholder: 'username', showWhen: { optionId: 'authType', values: ['basic'] } },
    { id: 'password', label: '密码', type: 'text', defaultValue: '', placeholder: 'password', showWhen: { optionId: 'authType', values: ['basic'] } },
    { id: 'apiKeyHeader', label: 'Key Header', type: 'text', defaultValue: 'X-API-Key', showWhen: { optionId: 'authType', values: ['api-key'] } },
    { id: 'apiKeyValue', label: 'Key Value', type: 'text', defaultValue: '', showWhen: { optionId: 'authType', values: ['api-key'] } },
    { id: 'headers', label: '请求头', type: 'text', defaultValue: 'Accept: application/json', placeholder: 'Accept: application/json; X-App: Spurh' },
    {
      id: 'contentType', label: 'Body 类型', type: 'select', defaultValue: 'application/json',
      choices: [
        { value: 'application/json', label: 'JSON' },
        { value: 'application/x-www-form-urlencoded', label: 'Form URL Encoded' },
        { value: 'text/plain', label: '纯文本' },
        { value: 'application/xml', label: 'XML' },
      ],
    },
    {
      id: 'codeLanguage', label: '语言', type: 'select', defaultValue: 'curl', actions: ['code'],
      choices: [
        { value: 'curl', label: 'cURL' },
        { value: 'javascript', label: 'JavaScript' },
        { value: 'python', label: 'Python' },
        { value: 'go', label: 'Go' },
      ],
    },
  ],
  detect(input) {
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+https?:\/\//i.test(input.trim())) {
      return { confidence: 0.98, reason: '检测到 HTTP 方法与请求地址' };
    }
    return null;
  },
  async execute(actionId, input, options = {}): Promise<PluginResult> {
    let url = options.url?.trim() ?? '';
    let method = (options.method || 'GET').toUpperCase();
    let body = input;
    const requestLine = input.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/\S+)\s*\n?/i);
    if (requestLine) {
      method = requestLine[1].toUpperCase();
      url = requestLine[2];
      body = input.slice(requestLine[0].length);
    }
    if (!url) throw new Error('请输入 HTTP 请求地址');
    if (actionId === 'code') {
      const output = generateCode(options.codeLanguage || 'curl', method, url, body, options);
      return {
        output,
        language: options.codeLanguage === 'javascript' ? 'javascript' : options.codeLanguage,
        view: 'code',
        summary: `已生成 ${options.codeLanguage || 'cURL'} 调用代码`,
        meta: { 方法: method, 地址: url },
      };
    }
    const response = await invoke<HttpResponse>('http_request', {
      request: {
        method,
        url,
        headers: parseHeaders(options.headers ?? ''),
        body,
        authType: options.authType,
        username: options.username,
        password: options.password,
        token: options.token,
        apiKeyHeader: options.apiKeyHeader,
        apiKeyValue: options.apiKeyValue,
        timeoutSeconds: 30,
      },
    });
    let output = response.body;
    let language = 'text';
    if (response.contentType.includes('json')) {
      language = 'json';
      try { output = JSON.stringify(JSON.parse(response.body), null, 2); } catch { /* Keep malformed JSON response readable. */ }
    } else if (response.contentType.includes('xml')) language = 'xml';
    return {
      output,
      language,
      view: 'http',
      data: { ...response, body: output, language, method, url },
      summary: `${response.status} ${response.statusText} · ${response.durationMs} ms`,
      meta: { 状态: response.status, 耗时: `${response.durationMs} ms`, 大小: `${response.sizeBytes} B` },
    };
  },
};
