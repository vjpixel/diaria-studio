#!/usr/bin/env node
/** #12981. Writes only on the expected host; --dry-run performs no network I/O. */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectEnv } from './lib/env-loader.ts';
import { createKvRestOps } from './lib/cloudflare-kv-rest.ts';
import { resolveOpsStateKvConfig } from './lib/diaria/short-related-kv.ts';
import { isMainModule } from './lib/cli-args.ts';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.some(a => a !== '--dry-run')) throw new Error('Use apenas --dry-run');
  loadProjectEnv();
  const host = hostname();
  const expected = process.env.INFRA_300_HOSTNAME;
  if (!expected || host !== expected) throw new Error('INFRA_300_HOSTNAME deve corresponder ao hostname real do 300');
  const value = JSON.stringify({timestamp: new Date().toISOString(), hostname: host});
  if (argv.includes('--dry-run')) { console.log(value); return; }
  const config = resolveOpsStateKvConfig(JSON.parse(readFileSync(resolve('platform.config.json'), 'utf8')), process.env);
  if (!config.ok) throw new Error(`Configuração ausente: ${config.missing.join(', ')}`);
  const kv = createKvRestOps(config.config);
  await kv.put('infra:heartbeat:300', value);
}
if (isMainModule(import.meta.url)) main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });
