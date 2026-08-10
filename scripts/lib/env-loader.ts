/**
 * env-loader.ts (#923, consolidado pra arquivo único em #4820)
 *
 * Carrega `.env` do root do projeto em scripts standalone (`npx tsx`).
 *
 * **Por que isto existe:** scripts standalone não herdam env vars carregadas
 * pelo orchestrator (Claude Code Bash inherits shell env, mas o terminal
 * raramente tem `set -a; source .env; set +a` ativo). Sem esse loader,
 * `process.env.DIARIA_LINKEDIN_CRON_TOKEN` fica `undefined` mesmo com a var
 * presente em `.env` — causa fallback silencioso pra fire-now em
 * `publish-linkedin.ts --schedule`, que postou 3 posts à 1h da manhã
 * em vez de agendar (incidente 2026-05-07, #923).
 *
 * **#4820 — `.env.local` deixou de ser suportado.** O projeto tinha 2
 * arquivos possíveis pra credencial (`.env.local` com precedência, `.env`
 * como fallback), o que já causou diagnóstico errado de credencial "ausente"
 * quando na verdade só estava no arquivo não-checado (achado ao vivo 260809).
 * Decisão do editor: consolidar pra um único arquivo. Risco assumido: uma
 * key que só exista em `.env.local` numa máquina para de carregar sem aviso
 * — migrar o conteúdo pra `.env` é responsabilidade de quem tiver esse
 * arquivo local (checagem pendente do PR, ver PR body).
 *
 * **Precedência:** vars já presentes em `process.env` ganham (não sobrescreve
 * o que já foi setado no shell/ambiente).
 *
 * Uso:
 * ```ts
 * import { loadProjectEnv } from "./lib/env-loader.ts";
 * loadProjectEnv();
 * // resto do script — agora process.env tem .env carregado
 * ```
 *
 * Pode ser chamado multiplas vezes — idempotente.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

/**
 * Carrega `.env` do root do projeto.
 *
 * @param rootOverride  Path absoluto do root (default: 2 níveis acima de scripts/lib)
 * @returns             Lista de paths dos .env files efetivamente carregados
 */
export function loadProjectEnv(rootOverride?: string): string[] {
  const root = rootOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const loaded: string[] = [];

  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) {
    dotenvConfig({ path: envFile, override: false });
    loaded.push(envFile);
  }

  return loaded;
}
