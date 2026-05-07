/**
 * env-loader.ts (#923)
 *
 * Carrega `.env.local` e `.env` do root do projeto em scripts standalone (`npx tsx`).
 *
 * **Por que isto existe:** scripts standalone não herdam env vars carregadas
 * pelo orchestrator (Claude Code Bash inherits shell env, mas o terminal
 * raramente tem `set -a; source .env.local; set +a` ativo). Sem esse loader,
 * `process.env.DIARIA_LINKEDIN_CRON_TOKEN` fica `undefined` mesmo com a var
 * presente em `.env.local` — causa fallback silencioso pra fire-now em
 * `publish-linkedin.ts --schedule`, que postou 3 posts à 1h da manhã
 * em vez de agendar (incidente 2026-05-07, #923).
 *
 * **Precedência:** vars já presentes em `process.env` ganham (não sobrescreve).
 * `.env.local` ganha de `.env` (carregado segundo, mas `override: false`).
 *
 * Uso:
 * ```ts
 * import { loadProjectEnv } from "./lib/env-loader.ts";
 * loadProjectEnv();
 * // resto do script — agora process.env tem .env.local + .env carregados
 * ```
 *
 * Pode ser chamado multiplas vezes — idempotente.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

/**
 * Carrega `.env.local` (precedência sobre `.env`) do root do projeto.
 *
 * @param rootOverride  Path absoluto do root (default: 2 níveis acima de scripts/lib)
 * @returns             Lista de paths dos .env files efetivamente carregados
 */
export function loadProjectEnv(rootOverride?: string): string[] {
  const root = rootOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const loaded: string[] = [];

  // .env.local primeiro (precedência)
  const envLocal = resolve(root, ".env.local");
  if (existsSync(envLocal)) {
    dotenvConfig({ path: envLocal, override: false });
    loaded.push(envLocal);
  }

  // .env como fallback — não sobrescreve vars já carregadas de .env.local
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) {
    dotenvConfig({ path: envFile, override: false });
    loaded.push(envFile);
  }

  return loaded;
}
