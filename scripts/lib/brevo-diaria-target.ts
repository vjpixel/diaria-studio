/**
 * Resolve o alvo de escrita do canal `brevo_diaria`: a lista da Brevo e a
 * credencial da conta PRÓPRIA do editor (`platform.config.json` →
 * `brevo_diaria.list_id` / `brevo_diaria.api_key_env`).
 *
 * ## Por que existe (#5843)
 *
 * `sync-pending-to-brevo.ts` resolvia isso inline no seu `main()`. Quando o
 * `sunset-dead-subscribers.ts` (#5807) e o importador de lote curado (#5841)
 * passaram a precisar do mesmo par, copiar a resolução pela 3ª vez seria
 * convite pro tipo de divergência que causou o #5843 — um caminho de escrita
 * que "parecia" ter a credencial e na prática nunca escrevia na Brevo.
 *
 * O `list_id` NUNCA tem default: um fallback silencioso escreveria contatos na
 * lista errada de uma conta de produção. Ausente = erro, nunca palpite.
 *
 * @see scripts/sync-pending-to-brevo.ts (ingestContactToBrevo — o consumidor
 *      original do par)
 * @see scripts/sunset-dead-subscribers.ts (#5843)
 * @see scripts/import-curated-batch-brevo.ts (#5841)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export type BrevoDiariaTarget =
  | { ok: true; listId: number; apiKey: string; apiKeyEnv: string }
  | { ok: false; reason: string };

/**
 * Pura — recebe o bloco `brevo_diaria` já parseado e o mapa de env, devolve o
 * alvo ou o motivo exato da recusa. Testável sem tocar disco nem `process.env`.
 */
export function resolveBrevoDiariaTarget(
  brevoDiaria: { list_id?: unknown; api_key_env?: unknown } | undefined,
  env: Record<string, string | undefined>,
): BrevoDiariaTarget {
  if (!brevoDiaria) {
    return { ok: false, reason: "brevo_diaria não configurado em platform.config.json" };
  }
  const { list_id: listId, api_key_env: apiKeyEnv } = brevoDiaria;
  if (typeof listId !== "number" || !Number.isInteger(listId) || listId <= 0) {
    return {
      ok: false,
      reason: `brevo_diaria.list_id ausente ou inválido em platform.config.json (recebido: ${JSON.stringify(listId)}) — sem default por segurança, escreveria na lista errada`,
    };
  }
  if (typeof apiKeyEnv !== "string" || !apiKeyEnv) {
    return { ok: false, reason: "brevo_diaria.api_key_env ausente em platform.config.json" };
  }
  const apiKey = env[apiKeyEnv];
  if (!apiKey) {
    return { ok: false, reason: `variável de ambiente ${apiKeyEnv} não definida (credencial da conta Brevo do canal diária)` };
  }
  return { ok: true, listId, apiKey, apiKeyEnv };
}

/** I/O — lê `platform.config.json` e delega pra `resolveBrevoDiariaTarget`. */
export function loadBrevoDiariaTarget(
  configPath: string = DEFAULT_PLATFORM_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): BrevoDiariaTarget {
  let parsed: { brevo_diaria?: { list_id?: unknown; api_key_env?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `falha ao ler ${configPath}: ${(e as Error).message}` };
  }
  return resolveBrevoDiariaTarget(parsed.brevo_diaria, env);
}
