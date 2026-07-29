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
 * Resultado de `resolveBeehiivConfig` — nunca lança, nunca termina o
 * processo. `reason` distingue as DUAS causas possíveis de falha (#4296):
 * key ausente vs. publicationId não resolvido (nem env, nem
 * platform.config.json) — mensagens concorrentes eram a causa raiz do bug
 * original, então o caller (ex: studio-utms.ts) consegue relayar o motivo
 * específico em vez de um texto genérico que mistura as duas.
 */
export type BeehiivConfigResult =
  | { ok: true; config: BeehiivConfig }
  | { ok: false; reason: string };

/**
 * Resolve apiKey + publicationId do ambiente e de platform.config.json, SEM
 * nunca lançar ou chamar `process.exit` — é a versão "pura" usada por
 * consumidores long-running (studio-server) que não podem se dar ao luxo de
 * `loadBeehiivConfig` derrubar o processo inteiro por credencial ausente
 * (#4296). Mesmo contrato de resolução que `loadBeehiivConfig`:
 *   - `BEEHIIV_API_KEY` → env, obrigatório;
 *   - `publicationId` → `BEEHIIV_PUBLICATION_ID` (env) OU
 *     `platform.config.json` (fallback).
 *
 * @param env         Fonte do env — default `process.env`. Injetável pra
 *                     testes controlarem o cenário sem tocar o env real da
 *                     máquina (mesmo padrão de `buildUtmsData`/`BuildUtmsOptions.env`
 *                     em `studio-utms.ts`).
 * @param configPath  Path de `platform.config.json` — default o real do
 *                     repo. Injetável só pra testar o caso "sem
 *                     publicationId em lugar nenhum" sem mutar o arquivo
 *                     versionado.
 */
export function resolveBeehiivConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  configPath: string = CONFIG_PATH,
): BeehiivConfigResult {
  const apiKey = env.BEEHIIV_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).",
    };
  }

  let publicationId = env.BEEHIIV_PUBLICATION_ID ?? "";
  if (!publicationId) {
    if (!existsSync(configPath)) {
      return { ok: false, reason: `platform.config.json não encontrado em ${configPath}` };
    }
    let cfg: { beehiiv?: { publicationId?: string } };
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8")) as { beehiiv?: { publicationId?: string } };
    } catch (e) {
      return { ok: false, reason: `platform.config.json inválido: ${(e as Error).message}` };
    }
    publicationId = cfg.beehiiv?.publicationId ?? "";
  }

  if (!publicationId) {
    return {
      ok: false,
      reason:
        "publicationId não resolvido: BEEHIIV_PUBLICATION_ID ausente e platform.config.json sem beehiiv.publicationId.",
    };
  }

  return { ok: true, config: { apiKey, publicationId } };
}

/**
 * Carrega apiKey + publicationId do ambiente e de platform.config.json.
 * Chama process.exit(2) em caso de configuração inválida — casca fina de
 * CLI sobre `resolveBeehiivConfig` (#4296). Comportamento inalterado pros
 * ~20 call sites de script (mesmo texto de erro por caso, mesmo exit code).
 *
 * @param callerTag  Prefixo exibido nas mensagens de erro (ex: "[backup-beehiiv]").
 *                   Default: "[beehiiv-config]".
 */
export function loadBeehiivConfig(callerTag = "[beehiiv-config]"): BeehiivConfig {
  const result = resolveBeehiivConfig();
  if (!result.ok) {
    process.stderr.write(`${callerTag} ${result.reason}\n`);
    process.exit(2);
  }
  return result.config;
}
