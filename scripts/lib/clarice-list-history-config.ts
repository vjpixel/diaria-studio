/**
 * clarice-list-history-config.ts (#9532)
 *
 * Lê `platform.config.json` → `clarice_list_history` — a lista de HISTÓRICO
 * única da conta Brevo da Clarice (teto de 300 listas da conta). Ver
 * `scripts/clarice-consolidate-lists.ts` (quem a popula e apaga as listas
 * originais) e `fetchQueuedAndCommittedCampaignListIds` em
 * `scripts/lib/brevo-client.ts` (quem soma o id ao Set `committed` do guard
 * por contato, #7406/#3682).
 *
 * Falha ALTA por desenho: este bloco alimenta um GUARD anti-reenvio. Se o
 * arquivo não abrir, não parsear, ou o bloco vier malformado, lançar é o
 * único comportamento seguro — devolver `null` encolheria o guard em
 * silêncio (contatos já atendidos voltariam a ser elegíveis assim que as
 * listas originais fossem apagadas).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");

/** Default de `min_age_days` (decisão do editor no dispatch da #9532). */
export const DEFAULT_MIN_AGE_DAYS = 14;

export interface ClariceListHistoryConfig {
  /** `null` = lista de histórico ainda não criada/configurada. */
  listId: number | null;
  minAgeDays: number;
}

/**
 * Pura — valida o bloco já parseado. Lança em qualquer forma inesperada,
 * inclusive bloco AUSENTE: o default "sem histórico" precisa ser declarado
 * (`list_id: null`), nunca inferido de uma chave que sumiu por engano.
 */
export function parseClariceListHistoryConfig(block: unknown): ClariceListHistoryConfig {
  if (block === undefined) {
    throw new Error(
      "platform.config.json: bloco `clarice_list_history` ausente (#9532) — declare `{ \"list_id\": null, \"min_age_days\": 14 }` " +
        "explicitamente; ausência nunca é lida como 'sem histórico' porque isso encolheria o guard anti-reenvio em silêncio.",
    );
  }
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`platform.config.json: \`clarice_list_history\` precisa ser objeto (recebido: ${JSON.stringify(block)}).`);
  }
  const b = block as Record<string, unknown>;
  if (!("list_id" in b)) {
    throw new Error("platform.config.json: `clarice_list_history.list_id` ausente — use `null` quando a lista ainda não existir.");
  }
  const rawId = b.list_id;
  let listId: number | null;
  if (rawId === null) {
    listId = null;
  } else if (typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0) {
    listId = rawId;
  } else {
    throw new Error(
      `platform.config.json: \`clarice_list_history.list_id\` inválido (recebido: ${JSON.stringify(rawId)}) — inteiro positivo ou null.`,
    );
  }
  const rawAge = b.min_age_days ?? DEFAULT_MIN_AGE_DAYS;
  if (typeof rawAge !== "number" || !Number.isInteger(rawAge) || rawAge < 1) {
    throw new Error(
      `platform.config.json: \`clarice_list_history.min_age_days\` inválido (recebido: ${JSON.stringify(rawAge)}) — inteiro ≥ 1.`,
    );
  }
  return { listId, minAgeDays: rawAge };
}

/** I/O — lê o arquivo e delega pra `parseClariceListHistoryConfig`. Lança alto. */
export function loadClariceListHistoryConfig(configPath = DEFAULT_PLATFORM_CONFIG_PATH): ClariceListHistoryConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e) {
    throw new Error(`clarice_list_history (#9532): não foi possível ler ${configPath}: ${(e as Error).message}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`clarice_list_history (#9532): ${configPath} não é JSON válido: ${(e as Error).message}`);
  }
  return parseClariceListHistoryConfig(parsed.clarice_list_history);
}

// ---------------------------------------------------------------------------
// Override de teste — os testes do guard (`test/brevo-committed-campaigns-3682.test.ts`)
// assertam o Set `committed` EXATO; sem isto, preencher `list_id` no config
// real quebraria esses testes. `undefined` = sem override (lê o arquivo).
// ---------------------------------------------------------------------------

let historyListIdOverride: number | null | undefined;

export function __setClariceHistoryListIdOverrideForTests(v: number | null | undefined): void {
  historyListIdOverride = v;
}

/** id da lista de histórico pro guard — override de teste, senão o config. */
export function resolveClariceHistoryListIdForGuard(): number | null {
  if (historyListIdOverride !== undefined) return historyListIdOverride;
  return loadClariceListHistoryConfig().listId;
}
