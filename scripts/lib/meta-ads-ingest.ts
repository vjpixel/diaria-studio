/**
 * scripts/lib/meta-ads-ingest.ts (#5469)
 *
 * Traduz a resposta do MCP oficial da Meta (`mcp.facebook.com/ads`,
 * `ads_get_ad_entities`) para o formato `spend.csv` de #5236 (`canal,mes,
 * moeda,valor,fonte`). Espelha `scripts/lib/google-ads-ingest.ts` (#5237) e
 * `scripts/lib/microsoft-ads-ingest.ts` (#5502) na forma (parse puro +
 * orquestração fail-soft sobre `runSpendIngest`), mas difere num ponto
 * estrutural: Google/Microsoft expõem uma API REST com credencial estática
 * (`GOOGLE_ADS_*`/`MICROSOFT_ADS_*` no ambiente) que o script chama via
 * `fetch` direto. A Meta Ads MCP (`mcp__claude_ai_Meta_Ads__*`) só existe
 * dentro de uma sessão do Claude Code — não há endpoint REST documentado
 * com key própria para este projeto, e não há `META_ADS_*` no `.env` (ver
 * `docs/meta-ads-mcp-tools.md`). Por isso este módulo NÃO faz `fetch`: ele
 * normaliza um envelope JÁ CAPTURADO da tool `ads_get_ad_entities` (pela
 * sessão/agente que tem acesso ao conector) — o CLI
 * (`scripts/meta-ads-ingest-spend.ts`) lê esse envelope de um arquivo via
 * `--input`, nunca chama a API sozinho.
 *
 * ## Shape real confirmado ao vivo (#5469, 17/08/2026)
 *
 * `ads_get_ad_entities` devolve `{"ad_entities": "<json-string>"}` — o
 * campo `ad_entities` é uma STRING contendo um array JSON serializado, não
 * o array diretamente (confirmado com a conta real `10151064543294811`,
 * zero campanhas no período consultado: `{"ad_entities":"[]"}`). Rows
 * individuais (quando existem) trazem `spend` como string — a doc da
 * ferramenta (`docs/meta-ads-mcp-tools.md`) mostra dois formatos possíveis
 * pra valor monetário em BRL vistos em campos relacionados da mesma tool:
 * decimal com ponto (`"71.74"`, convenção usual de insights por
 * campanha/anúncio) e o formato humano `"R$71,74 BRL"` (visto em
 * `amount_spent` no nível `ad_account`) — `parseMetaSpendValue` abaixo
 * aceita os dois.
 *
 * ## Fixture sintética (destrava do editor, 17/08/2026, comentário da
 * issue) em vez de esperar campanha real
 *
 * Sem gasto real na conta (`R$0,00` de histórico até 16/08/2026, e o
 * envelope capturado ao vivo confirma `ad_entities: "[]"` — zero campanhas
 * no range consultado), o parser é testado contra
 * `test/fixtures/meta-ads/ad-entities-empty.json` (a resposta REAL vazia,
 * não inventada) e `test/fixtures/meta-ads/ad-entities-synthetic.json`
 * (valores preenchidos à mão sobre o MESMO envelope real, cobrindo os
 * casos que quebram parser: BRL com vírgula decimal, campanha sem gasto no
 * período, múltiplas campanhas agregando no mesmo mês, linha malformada).
 * Fixture sintética valida o PARSER, não o CONTRATO — quando a campanha
 * real da #5524 gerar o primeiro gasto, re-verificar o envelope ao vivo e
 * comentar na issue #5469 antes de fechá-la (ver limite documentado lá).
 *
 * ## `META_ADS_AD_ACCOUNT_ID` travado numa constante testável
 *
 * Por pedido explícito de `docs/meta-ads-mcp-tools.md` ("travar o
 * `ad_account_id` numa constante testável em `scripts/lib/`... nunca uma
 * string solta copiada desta doc"): `test/meta-ads-ingest-5469.test.ts`
 * trava o valor abaixo — mudar o ID exige editar aqui explicitamente,
 * nunca em silêncio.
 */

import type { SpendRow } from "./aquisicao-spend.ts";
import { runSpendIngest, mergeSpendRows, type SpendIngestFetchResult } from "./spend-ingest.ts";

export { mergeSpendRows };

/** Conta Meta Ads confirmada como a do projeto (`business_name === "Diar.ia"`,
 *  ver `docs/meta-ads-mcp-tools.md` "Conta correta e como confirmar").
 *  Reverificar via `ads_get_ad_accounts` (LEITURA) antes de mudar este
 *  valor — nunca copiar de memória/doc sem re-derivar (#1172). */
export const META_ADS_AD_ACCOUNT_ID = "10151064543294811";

/** Nome canônico da coluna `canal` — fixado em `scripts/lib/cac.ts`
 *  (`RESERVED_CHANNEL_NAMES`) como `"Meta"`, não `"Meta Ads"`. */
export const META_ADS_CANAL = "Meta";

// ---------------------------------------------------------------------------
// Envelope MCP → linhas brutas (puro)
// ---------------------------------------------------------------------------

/** Forma mínima de uma linha da resposta de `ads_get_ad_entities` (nível
 *  campaign/adset/ad com métricas de spend). Todos os campos são opcionais
 *  porque uma linha malformada/incompleta deve ser IGNORADA por
 *  `aggregateMetaAdsSpendByMonth`, nunca contaminar a soma como zero. */
export interface MetaAdsEntityRow {
  id?: string;
  name?: string;
  campaign_name?: string;
  /** Valor de gasto — visto como string decimal (`"71.74"`) em insights por
   *  campanha/anúncio na doc oficial. */
  spend?: string | number;
  /** Variante formatada humana vista no nível `ad_account`
   *  (`"R$71,74 BRL"`) — aceita como fallback quando `spend` está ausente. */
  amount_spent?: string;
  date_start?: string;
  date_stop?: string;
}

export type ParseAdEntitiesEnvelopeResult = { rows: MetaAdsEntityRow[] } | { error: string };

/**
 * Extrai `MetaAdsEntityRow[]` do envelope bruto devolvido por
 * `ads_get_ad_entities` (`{"ad_entities": "<json-string>"}`). Tolera o
 * campo já vir como array (robustez a uma mudança de serialização
 * upstream) e um payload que já é o array diretamente. Nunca lança —
 * qualquer forma inesperada vira `{error}`.
 *
 * @pure
 */
export function parseAdEntitiesEnvelope(payload: unknown): ParseAdEntitiesEnvelopeResult {
  if (Array.isArray(payload)) return { rows: payload as MetaAdsEntityRow[] };

  if (payload && typeof payload === "object" && "ad_entities" in payload) {
    const raw = (payload as { ad_entities: unknown }).ad_entities;
    if (Array.isArray(raw)) return { rows: raw as MetaAdsEntityRow[] };
    if (typeof raw === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { error: `ad_entities não é JSON válido: ${e instanceof Error ? e.message : e}` };
      }
      if (!Array.isArray(parsed)) {
        return { error: `ad_entities parseado não é um array (tipo "${typeof parsed}")` };
      }
      return { rows: parsed as MetaAdsEntityRow[] };
    }
    return { error: `ad_entities tem tipo inesperado: "${typeof raw}"` };
  }

  return { error: 'payload não tem o formato esperado {"ad_entities": string | array} nem é array diretamente' };
}

// ---------------------------------------------------------------------------
// Parsing de valor monetário — dois formatos vistos na doc oficial
// ---------------------------------------------------------------------------

/**
 * Aceita `number` direto, decimal com ponto (`"71.74"`) e o formato humano
 * `"R$71,74 BRL"` (símbolo de moeda + vírgula decimal + sufixo de código —
 * qualquer subconjunto desses tokens). Devolve `null` (nunca `0`) para
 * qualquer entrada não-numérica ou negativa — chamado só depois de já ter
 * checado que o campo está presente.
 *
 * @pure
 */
export function parseMetaSpendValue(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;

  const stripped = raw
    .replace(/R\$\s*/gi, "")
    .replace(/\s*BRL\s*/gi, "")
    .trim();
  if (stripped === "") return null;

  let normalized: string;
  if (stripped.includes(",") && stripped.includes(".")) {
    // Formato pt-BR com separador de milhar: "1.234,56" → "1234.56".
    normalized = stripped.replace(/\./g, "").replace(",", ".");
  } else if (stripped.includes(",")) {
    // Só vírgula → é o separador decimal: "71,74" → "71.74".
    normalized = stripped.replace(",", ".");
  } else {
    normalized = stripped;
  }

  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Agregação por mês (puro) — mesmo formato de saída de google/microsoft
// ---------------------------------------------------------------------------

export interface AggregateMetaAdsSpendOptions {
  canal?: string;
  moeda: string;
  /** Prefixo da coluna `fonte` — a função acrescenta o range de datas agregado. */
  fonteLabel: string;
}

/**
 * Agrupa linhas por mês (`AAAA-MM`, extraído de `date_start`, com
 * `date_stop` como fallback) somando o valor de gasto (via
 * `parseMetaSpendValue`, preferindo `spend` e caindo pra `amount_spent`
 * quando ausente). Linha sem data reconhecível OU sem valor de gasto
 * parseável é IGNORADA — nunca soma como zero silencioso. Uma linha com
 * gasto explicitamente `0`/`"0.00"`/`"R$0,00 BRL"` É incluída (campanha
 * real sem gasto no período é um resultado válido, distinto de "não sei o
 * valor").
 *
 * @pure
 */
export function aggregateMetaAdsSpendByMonth(
  rows: MetaAdsEntityRow[],
  opts: AggregateMetaAdsSpendOptions,
): SpendRow[] {
  const canal = opts.canal ?? META_ADS_CANAL;
  const byMonth = new Map<string, { sum: number; dates: string[] }>();

  for (const row of rows) {
    const date = row.date_start ?? row.date_stop;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const value = row.spend !== undefined ? parseMetaSpendValue(row.spend) : parseMetaSpendValue(row.amount_spent);
    if (value === null) continue;

    const mes = date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { sum: 0, dates: [] };
    entry.sum += value;
    entry.dates.push(date);
    byMonth.set(mes, entry);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { sum, dates }]) => {
      const sorted = dates.slice().sort();
      const first = sorted[0];
      const last = sorted.at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal,
        mes,
        moeda: opts.moeda,
        valor: Math.round(sum * 100) / 100,
        fonte: `${opts.fonteLabel} — ads_get_ad_entities spend, ${dates.length} linha(s) (${range}), ingestão via MCP oficial`,
      };
    });
}

// ---------------------------------------------------------------------------
// Orquestração (envelope já capturado → merge, sempre fail-soft)
// ---------------------------------------------------------------------------

export interface RunMetaAdsIngestOptions {
  /** Envelope bruto JÁ CAPTURADO de `ads_get_ad_entities` (lido de arquivo
   *  pelo CLI) — este módulo nunca chama a API/MCP diretamente. */
  envelopePayload: unknown;
  existingRows: SpendRow[];
  canal?: string;
  moeda?: string;
  fonteLabel?: string;
}

export type MetaAdsIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedRows: number }
  | { kind: "fallback"; reason: string };

/**
 * Orquestra parse do envelope → agregação → merge, sempre fail-soft:
 * envelope malformado ou sem nenhuma linha com gasto parseável devolve
 * `{ kind: "fallback", reason }` em vez de lançar — o CLI decide o que
 * logar, mas NUNCA quebra o relatório (`cac-report.ts` segue lendo o
 * `spend.csv` intocado). Implementado como adaptador de `runSpendIngest`
 * (mesmo núcleo genérico de `google-ads-ingest.ts`/`microsoft-ads-ingest.ts`).
 */
export async function runMetaAdsIngest(opts: RunMetaAdsIngestOptions): Promise<MetaAdsIngestResult> {
  const canal = opts.canal ?? META_ADS_CANAL;
  const moeda = opts.moeda ?? "BRL";
  const fonteLabel = opts.fonteLabel ?? "Meta Ads MCP oficial (mcp.facebook.com/ads)";

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const parsed = parseAdEntitiesEnvelope(opts.envelopePayload);
    if ("error" in parsed) return { kind: "error", reason: parsed.error };

    const rows = aggregateMetaAdsSpendByMonth(parsed.rows, { canal, moeda, fonteLabel });
    return { kind: "ok", rows, fetchedCount: parsed.rows.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows: opts.existingRows });
  if (result.kind === "fallback") return result;
  return { kind: "updated", rows: result.rows, fetchedRows: result.fetchedCount };
}
