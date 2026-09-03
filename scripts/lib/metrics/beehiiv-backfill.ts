/**
 * scripts/lib/metrics/beehiiv-backfill.ts (#7179, F7 do épico #7172)
 *
 * Miolo PURO do backfill histórico de cadastros Beehiiv — reconstrói, a
 * partir de N snapshots locais já PREPARADOS (`loadPreparedSubscribers` em
 * `scripts/cac-report.ts`: origem recuperada aplicada + internos/teste
 * filtrados), 1 linha por E-MAIL com o `entered_at` da aparição MAIS ANTIGA.
 *
 * Nenhuma função deste módulo toca disco/rede — `scripts/metrics-backfill-
 * cadastros.ts` (CLI) é quem lê os 8 snapshots de `data/beehiiv-backup/` e
 * grava no store (`scripts/lib/diaria-subscribers-db.ts`) e em
 * `data/metrics/captura-log.jsonl`. Mesmo par puro×I/O documentado no topo
 * de `cac.ts`/`cac-report.ts`.
 *
 * ## Por que "aparição mais antiga", nunca "mais recente"
 *
 * A reativação (`promoteBeehiivSubscription`, `scripts/evaluate-brevo-diaria.ts`)
 * faz DELETE+CREATE na Beehiiv — o CREATE novo tem `id` e `created` PRÓPRIOS,
 * diferentes do cadastro original. Medido (#7179, corpo da issue): 59
 * e-mails com `id`/`created` distintos entre `2026-06-05` e `2026-08-30` —
 * um deles com cadastro real em `2025-09-13` reaparecendo como `created`
 * `2026-08-04`/`utm_source: "brevo-diaria"`. Usar a aparição MAIS RECENTE
 * fabricaria 59 cadastros em agosto e apagaria 59 datas reais — o oposto do
 * baseline que o objetivo 1 do épico #7172 quer evidenciar (decisão 9: a
 * reativação fica fora da meta).
 *
 * ## `reativado: true` — quando o `id` muda entre aparições
 *
 * Quando as aparições de 1 e-mail (já dedup) trazem MAIS de 1 `id` nativo da
 * Beehiiv distinto, o e-mail passou por reativação em algum ponto. A linha
 * ainda entra (com o `entered_at` da aparição mais antiga — o cadastro real
 * não some), mas `utm_medium`/`utm_campaign`/`utm_channel` são gravados
 * `null`: mesmo quando a aparição mais antiga parece limpa, a decisão do
 * corpo da issue é não confiar nesses 3 campos numa linha que sabidamente
 * passou por DELETE+CREATE em algum ponto do histórico — só `utm_source`/
 * `referring_site` sobrevivem (e já vêm da camada de origem recuperada,
 * aplicada pelo CHAMADOR via `applyOrigemOverride` antes de chegar aqui).
 * F4/F5 excluem `reativado: true` do placar da meta sem precisar re-derivar
 * nada via `utm_source` (decisão 9 do #7172).
 *
 * ## Fronteira 2025-09-02..2026-08-24 (decisão 10 do #7172)
 *
 * A série viva do Kit (F2) só é válida a partir de 2026-08-25 (#7172, decisão
 * 11 — `created_at` traz 590 dos 649 registros do Kit em 24/08, import em
 * massa, não cadastro). Este módulo NUNCA devolve linha com `entered_at`
 * cujo dia BRT seja `>= 2026-08-25` — `filterToBackfillWindow` aplica esse
 * corte antes de qualquer gravação.
 */

import type { BeehiivBackupSubscriber } from "../beehiiv-backup-snapshots.ts";
import { ATRIBUICAO_FONTE_BEEHIIV } from "../kit-attribution.ts";

/**
 * Mesma fórmula de `normalizeEmail` (`scripts/lib/cac.ts`) — reimplementada
 * aqui, NÃO importada: `cac.ts` encadeia `cohort-engagement.ts`, que carrega
 * `import "dotenv/config"` como efeito colateral do import (achado
 * documentado na docstring de `scripts/lib/metrics/acquisition-class.ts`,
 * mesma armadilha) — poluiria `process.env` sempre que este módulo puro
 * fosse importado, inclusive em teste. `trim().toLowerCase()` é o corpo
 * inteiro da função original; travado por `test/beehiiv-backfill.test.ts`
 * contra a mesma fixture do `cac.test.ts` pra nunca divergir em silêncio.
 * @pure
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Fronteira superior (exclusiva) do backfill — a partir daqui a série é do
 *  Kit (F2, decisão 11 do #7172). Mesmo valor de `KIT_SERIES_FLOOR` em
 *  `scripts/lib/metrics/registry.ts`, não importado daqui de propósito
 *  (`registry.ts` não é dependency-free — ver docstring de
 *  `acquisition-class.ts` — e este módulo precisa continuar sem I/O nem
 *  cadeia de import pesada; a constante é re-declarada, travada por
 *  `test/beehiiv-backfill.test.ts` contra o mesmo valor literal). */
export const BACKFILL_WINDOW_END_EXCLUSIVE = "2026-08-25";

/** Origem/procedência que este módulo sempre grava — re-exportado por
 *  conveniência (o chamador não precisa importar de 2 módulos pra montar a
 *  linha completa). */
export { ATRIBUICAO_FONTE_BEEHIIV };

/** 1 linha reconstruída, pronta para `ensureSubscriber`/`upsertSubscription`/
 *  `recordEvent` (o CLI decide a ordem/transação — este módulo só monta o
 *  valor). `email` já normalizado (`normalizeEmail`). */
export interface BeehiivBackfillRow {
  email: string;
  /** `id` nativo da Beehiiv da aparição MAIS ANTIGA — pode ser `null` num
   *  registro sem `id` tipado (snapshot antigo, campo adicionado em #7229). */
  externalId: string | null;
  /** ISO 8601, derivado do `created` (epoch segundos) da aparição mais
   *  antiga. */
  enteredAt: string;
  /** `AAAA-MM-DD`, fronteira BRT — dia lógico de `enteredAt`, já resolvido
   *  (o chamador não precisa reconverter). */
  dia: string;
  status: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmChannel: string | null;
  referringSite: string | null;
  /** `true` quando mais de 1 `id` nativo distinto foi visto para este
   *  e-mail entre os snapshots — ver docstring do módulo. */
  reativado: boolean;
  /** Sempre `ATRIBUICAO_FONTE_BEEHIIV` — toda linha deste módulo vem do
   *  snapshot local, nunca inferida. */
  atribuicaoFonte: string;
  /** Sempre `"backfill-beehiiv"` — ver `scripts/lib/metrics/captura-log.ts`
   *  pro mesmo eixo no log de execução. */
  origemSerie: "backfill-beehiiv";
}

/** Mesma fórmula de `brtDayKey` (`scripts/lib/metrics/acquisition-store-
 *  deps.ts`) — reimplementada aqui pelo mesmo motivo documentado lá (módulo
 *  PURO, sem import cross-domain só por uma conversão de fuso de 3 linhas).
 *  @pure */
function brtDayKey(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function isoFromEpochSeconds(created: number): string {
  return new Date(created * 1000).toISOString();
}

interface EmailAppearance {
  sub: BeehiivBackupSubscriber;
  externalId: string | null;
}

/**
 * Agrupa as aparições (já PREPARADAS pelo chamador — origem recuperada
 * aplicada, internos/teste filtrados) de N snapshots por e-mail normalizado.
 * Um mesmo e-mail presente em vários snapshots (ou várias vezes no mesmo
 * snapshot, defensivo) entra 1x só nas chaves — a lista de valores é que
 * acumula todas as aparições. @pure
 */
function groupByEmail(
  snapshots: readonly (readonly BeehiivBackupSubscriber[])[],
): Map<string, EmailAppearance[]> {
  const byEmail = new Map<string, EmailAppearance[]>();
  for (const snapshot of snapshots) {
    for (const sub of snapshot) {
      if (typeof sub.email !== "string" || !sub.email.trim()) continue;
      if (typeof sub.created !== "number" || !Number.isFinite(sub.created)) continue;
      const email = normalizeEmail(sub.email);
      const externalId = typeof sub.id === "string" && sub.id.trim() ? sub.id.trim() : null;
      const list = byEmail.get(email);
      if (list) list.push({ sub, externalId });
      else byEmail.set(email, [{ sub, externalId }]);
    }
  }
  return byEmail;
}

/**
 * Constrói 1 `BeehiivBackfillRow` a partir de todas as aparições de 1
 * e-mail — aparição de `created` MÍNIMO vence (ver docstring do módulo);
 * `reativado` é `true` sse mais de 1 `externalId` distinto aparecer. @pure
 */
function buildRowForEmail(email: string, appearances: readonly EmailAppearance[]): BeehiivBackfillRow {
  let earliest = appearances[0];
  for (const app of appearances) {
    if ((app.sub.created as number) < (earliest.sub.created as number)) earliest = app;
  }
  const distinctIds = new Set(appearances.map((a) => a.externalId).filter((id): id is string => id !== null));
  const reativado = distinctIds.size > 1;

  const created = earliest.sub.created as number;
  const enteredAt = isoFromEpochSeconds(created);
  const sub = earliest.sub;

  return {
    email,
    externalId: earliest.externalId,
    enteredAt,
    dia: brtDayKey(enteredAt),
    status: typeof sub.status === "string" && sub.status ? sub.status : null,
    utmSource: typeof sub.utm_source === "string" && sub.utm_source ? sub.utm_source : null,
    // reativado: só utm_source/referring_site sobrevivem — ver docstring do
    // módulo. Não-reativado: os 3 campos vêm da aparição mais antiga, que é
    // genuinamente o cadastro original.
    utmMedium: reativado ? null : typeof sub.utm_medium === "string" && sub.utm_medium ? sub.utm_medium : null,
    utmCampaign: reativado ? null : typeof sub.utm_campaign === "string" && sub.utm_campaign ? sub.utm_campaign : null,
    utmChannel: reativado ? null : typeof sub.utm_channel === "string" && sub.utm_channel ? sub.utm_channel : null,
    referringSite: typeof sub.referring_site === "string" && sub.referring_site ? sub.referring_site : null,
    reativado,
    atribuicaoFonte: ATRIBUICAO_FONTE_BEEHIIV,
    origemSerie: "backfill-beehiiv",
  };
}

export interface BuildBeehiivBackfillResult {
  rows: BeehiivBackfillRow[];
  /** Quantos e-mails únicos foram vistos ANTES do corte de fronteira
   *  (`BACKFILL_WINDOW_END_EXCLUSIVE`) — `rows.length + excludedByWindow ===
   *  totalEmailsSeen`. */
  totalEmailsSeen: number;
  /** Quantos e-mails únicos foram excluídos por `dia >=
   *  BACKFILL_WINDOW_END_EXCLUSIVE` (série viva do Kit assume a partir daí). */
  excludedByWindow: number;
}

/**
 * Constrói a série completa de backfill a partir de N snapshots já
 * preparados (1 array por data de snapshot, ordem irrelevante — a função
 * agrupa por e-mail e resolve a aparição mais antiga internamente, não
 * depende da ordem de entrada dos snapshots).
 *
 * Idempotente em relação à ENTRADA: chamar 2x com os mesmos snapshots
 * produz exatamente as mesmas linhas (a idempotência de ESCRITA — não
 * duplicar no store — é responsabilidade do CLI via `upsertSubscription`/
 * `recordEvent`, que já são idempotentes por natural key).
 *
 * @pure
 */
export function buildBeehiivBackfillRows(
  snapshots: readonly (readonly BeehiivBackupSubscriber[])[],
): BuildBeehiivBackfillResult {
  const byEmail = groupByEmail(snapshots);
  const rows: BeehiivBackfillRow[] = [];
  let excludedByWindow = 0;

  for (const [email, appearances] of byEmail) {
    const row = buildRowForEmail(email, appearances);
    if (row.dia >= BACKFILL_WINDOW_END_EXCLUSIVE) {
      excludedByWindow++;
      continue;
    }
    rows.push(row);
  }

  // Ordem determinística de saída — por dia, depois e-mail — não muda a
  // semântica (idempotente por natural key na gravação), mas torna o
  // resultado reproduzível/testável sem depender da ordem de iteração do Map.
  rows.sort((a, b) => (a.dia === b.dia ? a.email.localeCompare(b.email) : a.dia.localeCompare(b.dia)));

  return { rows, totalEmailsSeen: byEmail.size, excludedByWindow };
}

// ---------------------------------------------------------------------------
// Agregação por dia — pra popular `data/metrics/captura-log.jsonl` (1 linha
// por DIA reconstruído, não por execução — ver docstring de captura-log.ts).
// ---------------------------------------------------------------------------

export interface BackfillDayCount {
  dia: string;
  total: number;
}

/** Conta quantas linhas do backfill caem em cada dia — insumo direto pra
 *  `buildCapturaLogEntry({ ..., dia, origemSerie: "backfill-beehiiv" })`
 *  por dia, no CLI. Ordem ascendente por `dia`. @pure */
export function countBackfillRowsByDay(rows: readonly BeehiivBackfillRow[]): BackfillDayCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.dia, (counts.get(row.dia) ?? 0) + 1);
  }
  return [...counts.entries()].map(([dia, total]) => ({ dia, total })).sort((a, b) => a.dia.localeCompare(b.dia));
}

// ---------------------------------------------------------------------------
// Seed do intervalo 25/08 → dia do armamento de F2 — só o LOG, nunca cadastro
// (ver docstring do módulo captura-log.ts / corpo da issue #7179).
// ---------------------------------------------------------------------------

/** Enumera os dias `AAAA-MM-DD` de `[BACKFILL_WINDOW_END_EXCLUSIVE, until]`
 *  inclusive — usado só pra gerar as linhas `seed-kit` de
 *  `captura-log.jsonl` (nenhuma linha de cadastro é escrita para esta
 *  janela: a contagem real vem de graça na 1ª execução de F2, que traz todo
 *  mundo com `created_at` real via `status: "all"`). Lança se `until` for
 *  anterior à fronteira (janela vazia/inválida — erro de configuração do
 *  chamador, não um caso silencioso). @pure */
export function enumerateSeedGapDays(until: string): string[] {
  if (until < BACKFILL_WINDOW_END_EXCLUSIVE) {
    throw new Error(
      `enumerateSeedGapDays: "until" (${until}) é anterior à fronteira do backfill ` +
        `(${BACKFILL_WINDOW_END_EXCLUSIVE}) — janela vazia/inválida.`,
    );
  }
  const days: string[] = [];
  let cursor = new Date(`${BACKFILL_WINDOW_END_EXCLUSIVE}T00:00:00.000Z`);
  const end = new Date(`${until}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}
