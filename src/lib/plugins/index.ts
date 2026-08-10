import { cronPlugin } from './builtin/cron';
import { cryptoPlugin } from './builtin/crypto';
import { encoderPlugin } from './builtin/encoder';
import { jsonPlugin } from './builtin/json';
import { networkPlugin } from './builtin/network';
import { regexPlugin } from './builtin/regex';
import { remotePlugin } from './builtin/remote';
import { sqlPlugin } from './builtin/sql';
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
  sqlPlugin,
  networkPlugin,
  remotePlugin,
]);

export type { DispatchResult, PluginMatch, PluginResult, SpurhPlugin } from './types';
export { PluginRuntime } from './runtime';
