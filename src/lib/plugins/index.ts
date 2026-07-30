import { cronPlugin } from './builtin/cron';
import { cryptoPlugin } from './builtin/crypto';
import { encoderPlugin } from './builtin/encoder';
import { jsonPlugin } from './builtin/json';
import { regexPlugin } from './builtin/regex';
import { randomPlugin } from './builtin/random';
import { textPlugin } from './builtin/text';
import { timestampPlugin } from './builtin/timestamp';
import { PluginRuntime } from './runtime';

export const runtime = new PluginRuntime([
  jsonPlugin,
  timestampPlugin,
  textPlugin,
  randomPlugin,
  cryptoPlugin,
  cronPlugin,
  encoderPlugin,
  regexPlugin,
]);

export type { DispatchResult, PluginMatch, PluginResult, SpurhPlugin } from './types';
export { PluginRuntime } from './runtime';
