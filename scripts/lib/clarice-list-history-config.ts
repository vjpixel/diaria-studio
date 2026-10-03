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
 * arquivo não abrir, não parsear, ou o bloco vier ausente/malformado, TODO
 * consumidor do guard `committed` lança — devolver `null` encolheria o guard
 * em silêncio (contatos já atendidos voltariam a ser elegíveis assim que as
 * listas originais fossem apagadas).
 *
 * Marcador irreversível `consolidated_at`: gravado por
 * `clarice-consolidate-lists.ts --apply` antes do 1º DELETE. Depois disso,
 * `list_id: null` é rejeitado — apagar o id deixaria o guard sem o
 * histórico das listas já apagadas.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");

/**
 * Piso de `min_age_days`. `summarizeCycleSends` (clarice-wave-plan.ts)
 * atribui campanha a ciclo pelo NOME da lista; apagar lista de um ciclo
 * mensal ainda em curso subconta envios e reusa número de onda (#3682).
 * 45 dias > 1 ciclo de envio inteiro; o plano ainda exige ciclo fechado.
 */
export const MIN_SAFE_AGE_DAYS = 45;

export interface ClariceListHistoryConfig {
  /** `null` = lista de histórico ainda não criada/configurada. */
  listId: number | null;
  minAgeDays: number;
  /** ISO do 1º DELETE (marcador irreversível) ou `null`. */
  consolidatedAt: string | null;
}

/**
 * Pura — valida o bloco já parseado. Lança em qualquer forma inesperada,
 * inclusive bloco AUSENTE: o default "sem histórico" precisa ser declarado
 * (`list_id: null`), nunca inferido de uma chave que sumiu por engano.
 */
export function parseClariceListHistoryConfig(block: unknown): ClariceListHistoryConfig {
  if (block === undefined) {
    throw new Error(
      "platform.config.json: bloco `clarice_list_history` ausente (#9532) — declare `{ \"list_id\": null, \"min_age_days\": 45 }` " +
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
  if (!("min_age_days" in b)) {
    throw new Error("platform.config.json: `clarice_list_history.min_age_days` ausente — sem default silencioso (#9532).");
  }
  const rawAge = b.min_age_days;
  if (typeof rawAge !== "number" || !Number.isInteger(rawAge) || rawAge < MIN_SAFE_AGE_DAYS) {
    throw new Error(
      `platform.config.json: \`clarice_list_history.min_age_days\` inválido (recebido: ${JSON.stringify(rawAge)}) — inteiro ≥ ${MIN_SAFE_AGE_DAYS} ` +
        "(abaixo disso a lista pode ser de um ciclo mensal ainda em curso).",
    );
  }
  let consolidatedAt: string | null = null;
  if ("consolidated_at" in b && b.consolidated_at !== null) {
    const raw = b.consolidated_at;
    if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
      throw new Error(`platform.config.json: \`clarice_list_history.consolidated_at\` inválido (recebido: ${JSON.stringify(raw)}) — ISO.`);
    }
    consolidatedAt = raw;
  }
  if (consolidatedAt !== null && listId === null) {
    throw new Error(
      `platform.config.json: \`clarice_list_history.list_id\` é null mas \`consolidated_at\` (${consolidatedAt}) está presente — ` +
        "listas já foram apagadas e o histórico delas só existe na lista de histórico. Restaure o list_id; o guard nunca roda sem ele.",
    );
  }
  return { listId, minAgeDays: rawAge, consolidatedAt };
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

/**
 * Pura — insere `"consolidated_at": "{iso}"` logo após a linha `"list_id": N,`
 * do bloco `clarice_list_history`, edição CIRÚRGICA de texto (o arquivo não
 * faz round-trip por `JSON.stringify`, reformatar tudo seria diff gigante).
 * Idempotente: se o campo já existe, devolve o texto intacto. Lança se o
 * bloco não tiver o formato esperado ou se o resultado não parsear com o
 * marcador.
 */
export function insertConsolidatedAt(configText: string, iso: string): string {
  const current = parseClariceListHistoryConfig((JSON.parse(configText) as Record<string, unknown>).clarice_list_history);
  if (current.consolidatedAt !== null) return configText;
  const re = /("clarice_list_history":\s*\{\s*\n)([ \t]*)("list_id":\s*\d+,\n)/;
  if (!re.test(configText)) {
    throw new Error("insertConsolidatedAt: bloco clarice_list_history fora do formato esperado (list_id numérico na 1ª linha).");
  }
  const out = configText.replace(re, (_m, head: string, indent: string, idLine: string) =>
    `${head}${indent}${idLine}${indent}"consolidated_at": ${JSON.stringify(iso)},\n`,
  );
  const check = parseClariceListHistoryConfig((JSON.parse(out) as Record<string, unknown>).clarice_list_history);
  if (check.consolidatedAt !== iso) throw new Error("insertConsolidatedAt: marcador não confere após a edição.");
  return out;
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

/**
 * id da lista de histórico pro guard — override de teste, senão o config
 * DEFAULT deste checkout (nunca outro path: é este arquivo que o guard lê em
 * produção, por isso o `--apply` exige que ele bata com o id que vai usar).
 */
export function resolveClariceHistoryListIdForGuard(): number | null {
  if (historyListIdOverride !== undefined) return historyListIdOverride;
  return loadClariceListHistoryConfig().listId;
}
