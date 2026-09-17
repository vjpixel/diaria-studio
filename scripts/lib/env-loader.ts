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
 * o que já foi setado no shell/ambiente). **#8277, 17/09/2026:** essa
 * precedência pode ceder em silêncio pra uma var que não veio do shell do
 * usuário nem de `doppler run --`, mas de injeção do PROCESSO PAI (achado
 * ao vivo no Neo: o app desktop do Claude Code injeta `GOOGLE_CLIENT_ID`/
 * `GOOGLE_CLIENT_SECRET` de um app OAuth interno seu, sem relação com este
 * projeto, no ambiente de todo processo filho). Como `microsoft-ads-ingest.ts`
 * reusa de propósito o par `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` do
 * `.env` deste repo (ver docstring de `authConfigFromEnv` em
 * `scripts/microsoft-ads-ingest-spend.ts`, #5928) pra autenticar contra a
 * conta Google do Microsoft Ads, uma colisão de nome com esse valor injetado
 * faz o script autenticar contra o app Google ERRADO, sem nenhum erro —
 * `override: false` cede em silêncio. Por isso `loadProjectEnv` agora avisa
 * (stderr, sem nunca logar o VALOR — pode ser um secret) sempre que uma var
 * do `.env` diverge de um valor já presente no ambiente, pra quem depurar
 * tenha um ponto de partida em vez de um 401/token de conta errada.
 * Continua fail-soft: nunca aborta, a precedência de ambiente pode ser
 * intencional (ex: `doppler run --` sobrepondo `.env` de propósito).
 *
 * **Aviso é 1x por var por processo** (`WARNED_DIVERGENT_KEYS` abaixo) — vários
 * scripts do repo chamam `loadProjectEnv()` mais de uma vez no mesmo processo
 * (é o motivo desta função ser documentada como idempotente), e sem esse dedup
 * uma única divergência real reimprimiria o mesmo warning a cada chamada.
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

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";

/** Vars já avisadas nesta run — evita reimprimir o mesmo warning a cada chamada de `loadProjectEnv()`. */
const WARNED_DIVERGENT_KEYS = new Set<string>();

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
    const parsed = dotenvParse(readFileSync(envFile));
    for (const [key, value] of Object.entries(parsed)) {
      const existing = process.env[key];
      if (existing === undefined) {
        process.env[key] = value;
      } else if (existing !== value) {
        warnAboutDivergence(key);
      }
    }
    loaded.push(envFile);
  }

  return loaded;
}

/**
 * Avisa (stderr, 1x por var por processo) que uma var do `.env` já está
 * presente em `process.env` com um valor DIFERENTE — nunca loga o valor em
 * si. A precedência de ambiente (env > .env) cederia a essa var em silêncio;
 * este aviso é o único sinal de que isso aconteceu.
 */
function warnAboutDivergence(key: string): void {
  if (WARNED_DIVERGENT_KEYS.has(key)) return;
  WARNED_DIVERGENT_KEYS.add(key);
  console.warn(
    `[env-loader] ${key} já está definida no ambiente com um valor diferente do .env — ` +
      `mantendo a do ambiente (override:false). Se isso não for intencional (ex: uma var ` +
      `genérica injetada por outro processo, não pelo shell/Doppler), confira a origem antes ` +
      `de assumir que o .env está sendo usado.`,
  );
}
