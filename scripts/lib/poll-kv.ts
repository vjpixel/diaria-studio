/**
 * scripts/lib/poll-kv.ts (#1233, #1237)
 *
 * Wrangler KV helpers compartilhados entre `add-valid-edition.ts`,
 * `maintain-valid-editions-window.ts`, `poll-kv-put.ts` (CLI), etc.
 *
 * Lê/escreve KV remoto do Worker `diar-ia-poll` via `npx wrangler` no
 * diretório `workers/poll/` (herda OAuth cache + wrangler.toml).
 *
 * #1237: `wranglerKvPut` agora usa `--path=<tmpfile>` em vez de passar
 * value inline. Wrangler lê o arquivo como bytes raw, eliminando shell
 * escape problem que corrompia JSON com aspas duplas aninhadas.
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
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

/**
 * Escreve `value` no KV sob `key`. Usa `--path=<tmpfile>` (#1237) pra
 * eliminar shell escape problem com JSON contendo aspas duplas — wrangler
 * lê arquivo como bytes raw, sem interpolação.
 *
 * Funciona com qualquer string: JSON arbitrário, payload binário base64,
 * texto puro. Caller é responsável pelo conteúdo (incluindo serialização
 * JSON.stringify).
 *
 * Cleanup do tmpfile via finally — `mkdtempSync` cria diretório dedicado
 * pra evitar collision em writes paralelos.
 */
export function wranglerKvPut(key: string, value: string): void {
  const tmpDir = mkdtempSync(join(tmpdir(), "diaria-kv-put-"));
  const tmpFile = join(tmpDir, "value");
  try {
    writeFileSync(tmpFile, value, "utf8");
    const r = spawnSync(
      `npx wrangler kv key put "${key}" --path="${tmpFile}" --namespace-id=${POLL_KV_NAMESPACE_ID} --remote`,
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
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ENOENT/EBUSY não bloqueia retorno
    }
  }
}

/**
 * Resultado de `readValidEditions` que distingue "key vazia" (ok com
 * editions=[]) de "wrangler falhou" (read_failed=true).
 *
 * Crítico (#1234 review): pre-fix, ambos casos retornavam []. Em falha
 * transitória de wrangler, caller computava target da janela e
 * sobrescrevia KV, destruindo entries manuais que estavam lá.
 */
export interface ReadValidEditionsResult {
  editions: string[];
  read_failed: boolean;
}

/**
 * Lê o set atual `valid_editions` do KV remoto.
 *
 * - `{ editions: [], read_failed: false }` → key não existe ou está vazia (fail-open Worker)
 * - `{ editions: [...], read_failed: false }` → key tem array válido
 * - `{ editions: [], read_failed: true }` → wrangler falhou. Caller deve abortar, não escrever.
 */
export function readValidEditions(): ReadValidEditionsResult {
  const raw = wranglerKvGet("valid_editions");
  if (raw === null) {
    // wranglerKvGet retorna null se r.status !== 0 ou !r.stdout.
    // Key vazia gera stdout vazio que também vira null. Como distinguir?
    // wrangler retorna "Value not found" no stderr quando key não existe vs
    // erro de auth/rede que retorna outro status. Pra simplificar, tratamos
    // null como "ambíguo" — read_failed=true pra ser conservador.
    // Trade-off: primeira execução em KV virgem reporta read_failed,
    // editor precisa forçar via flag (ou rodar add-valid-edition.ts uma vez).
    return { editions: [], read_failed: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        editions: parsed.filter((x): x is string => typeof x === "string"),
        read_failed: false,
      };
    }
    console.warn(`[poll-kv] valid_editions not array: ${typeof parsed}`);
    return { editions: [], read_failed: false }; // key existe mas com shape ruim — tratamos como vazia
  } catch {
    console.warn(`[poll-kv] valid_editions corrupted JSON: ${raw.slice(0, 100)}`);
    return { editions: [], read_failed: false }; // key existe mas JSON quebrado — tratamos como vazia
  }
}

/**
 * Escreve o set `valid_editions` (ordenado pra estabilidade).
 */
export function writeValidEditions(editions: string[]): void {
  const sorted = [...new Set(editions)].sort();
  wranglerKvPut("valid_editions", JSON.stringify(sorted));
}
