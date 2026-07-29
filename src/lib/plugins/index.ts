import { base64Plugin } from './builtin/base64';
import { cronPlugin } from './builtin/cron';
import { hashPlugin } from './builtin/hash';
import { httpPlugin } from './builtin/http';
import { jsonPlugin } from './builtin/json';
import { jwtPlugin } from './builtin/jwt';
import { regexPlugin } from './builtin/regex';
import { randomPlugin } from './builtin/random';
import { textPlugin } from './builtin/text';
import { timestampPlugin } from './builtin/timestamp';
import { urlPlugin } from './builtin/url';
import { PluginRuntime } from './runtime';

export const runtime = new PluginRuntime([
  jsonPlugin,
  timestampPlugin,
  textPlugin,
  httpPlugin,
  randomPlugin,
  jwtPlugin,
  cronPlugin,
  base64Plugin,
  urlPlugin,
  hashPlugin,
  regexPlugin,
]);

export type { DispatchResult, PluginMatch, PluginResult, SpurhPlugin } from './types';
export { PluginRuntime } from './runtime';
