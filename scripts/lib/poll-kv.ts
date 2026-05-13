/**
 * scripts/lib/poll-kv.ts (#1233)
 *
 * Wrangler KV helpers compartilhados entre `add-valid-edition.ts` e
 * `maintain-valid-editions-window.ts`. Extraído de add-valid-edition.ts
 * pra evitar duplicação.
 *
 * Lê/escreve KV remoto do Worker `diar-ia-poll` via `npx wrangler` no
 * diretório `workers/poll/` (herda OAuth cache + wrangler.toml).
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = resolve(ROOT, "workers", "poll");

const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID ?? "5d15d8303325211d6976d73051f4b002";
const POLL_KV_NAMESPACE_ID =
  process.env.POLL_KV_NAMESPACE_ID ?? "72784da4ae39444481eb422ebac357c6";

export function wranglerKvGet(key: string): string | null {
  const r = spawnSync(
    `npx wrangler kv key get "${key}" --namespace-id=${POLL_KV_NAMESPACE_ID} --remote`,
    {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

export function wranglerKvPut(key: string, value: string): void {
  // value é JSON.stringify de array de strings AAMMDD — não tem `"` problemático
  // além das aspas duplas das chaves, então escapamos pra cmd.exe envolvendo
  // em aspas duplas duplas (CMD trata `""` como aspa literal).
  const escaped = value.replace(/"/g, '\\"');
  const r = spawnSync(
    `npx wrangler kv key put "${key}" "${escaped}" --namespace-id=${POLL_KV_NAMESPACE_ID} --remote`,
    {
      cwd: WORKER_DIR,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (r.status !== 0) {
    throw new Error(
      `wrangler kv key put failed (exit ${r.status}):\nstdout: ${r.stdout?.slice(0, 300)}\nstderr: ${r.stderr?.slice(0, 500)}`,
    );
  }
}

/**
 * Lê o set atual `valid_editions` e retorna array de strings AAMMDD.
 * Vazio ou corrupted → []. (Worker trata como fail-open quando vazio.)
 */
export function readValidEditions(): string[] {
  const raw = wranglerKvGet("valid_editions");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    console.warn(`[poll-kv] valid_editions corrupted: ${raw.slice(0, 100)}`);
  }
  return [];
}

/**
 * Escreve o set `valid_editions` (ordenado pra estabilidade).
 */
export function writeValidEditions(editions: string[]): void {
  const sorted = [...new Set(editions)].sort();
  wranglerKvPut("valid_editions", JSON.stringify(sorted));
}
