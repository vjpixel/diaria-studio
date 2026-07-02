/**
 * beehiiv-config.ts (#2104)
 *
 * Centraliza o bloco `loadBeehiivConfig()` que estava duplicado em:
 *   - scripts/backup-beehiiv.ts
 *   - scripts/beehiiv-sync.ts
 *   - scripts/verify-scheduled-post.ts
 *
 * Contrato: lê BEEHIIV_API_KEY do env (obrigatório) e publicationId
 * de BEEHIIV_PUBLICATION_ID (env) ou platform.config.json (fallback).
 * Em caso de erro, escreve em stderr e chama process.exit(2).
 *
 * #2834: também hospeda `beehiivApiBase()` — getter da base URL da API
 * pública da Beehiiv, hardcoded (com o mesmo fallback `?? "https://api.
 * beehiiv.com/v2"`) em pelo menos 9 scripts. `BEEHIIV_API_URL` (env) segue
 * como override — usado por testes que apontam pra mock server local.
 *
 * #2850: `beehiivApiBase()` é uma FUNÇÃO (lazy getter), não uma const de
 * módulo. Uma const seria avaliada NO IMPORT — por semântica ESM, imports
 * estáticos avaliam antes do corpo do módulo importador, então em scripts
 * que carregam env via chamada de função `loadProjectEnv()` (em vez de
 * `import "dotenv/config"` como side-effect), a const capturaria
 * `process.env.BEEHIIV_API_URL` antes do `.env`/`.env.local` existir em
 * `process.env` — override silenciosamente ignorado. O getter lê o env no
 * primeiro uso (call site), não no import.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");

/**
 * Base URL da API pública da Beehiiv. `BEEHIIV_API_URL` (env) override pra tests.
 * Lazy getter (#2850) — lê `process.env` no momento da chamada, não no import.
 */
export function beehiivApiBase(): string {
  return process.env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";
}

export interface BeehiivConfig {
  apiKey: string;
  publicationId: string;
}

/**
 * Carrega apiKey + publicationId do ambiente e de platform.config.json.
 * Chama process.exit(2) em caso de configuração inválida.
 *
 * @param callerTag  Prefixo exibido nas mensagens de erro (ex: "[backup-beehiiv]").
 *                   Default: "[beehiiv-config]".
 */
export function loadBeehiivConfig(callerTag = "[beehiiv-config]"): BeehiivConfig {
  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      `${callerTag} BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).\n`,
    );
    process.exit(2);
  }

  let publicationId = process.env.BEEHIIV_PUBLICATION_ID ?? "";
  if (!publicationId) {
    if (!existsSync(CONFIG_PATH)) {
      process.stderr.write(
        `${callerTag} platform.config.json não encontrado em ${CONFIG_PATH}\n`,
      );
      process.exit(2);
    }
    let cfg: { beehiiv?: { publicationId?: string } };
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { beehiiv?: { publicationId?: string } };
    } catch (e) {
      process.stderr.write(
        `${callerTag} platform.config.json inválido: ${(e as Error).message}\n`,
      );
      process.exit(2);
    }
    publicationId = cfg.beehiiv?.publicationId ?? "";
  }

  if (!publicationId) {
    process.stderr.write(
      `${callerTag} publicationId ausente — adicione \`beehiiv.publicationId\` em platform.config.json ou exporte BEEHIIV_PUBLICATION_ID.\n`,
    );
    process.exit(2);
  }

  return { apiKey, publicationId };
}
