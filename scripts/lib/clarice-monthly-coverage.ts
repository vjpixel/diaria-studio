/**
 * scripts/lib/clarice-monthly-coverage.ts (#9837)
 *
 * Miolo PURO da verificação "o agregado mensal do painel Clarice cobre toda
 * campanha `sent` da conta?" — a "Definição de feito" da #9837 pede que
 * contagem e 1º/último envio por mês batam com a API da Brevo, verificado
 * por script e não por inspeção visual.
 *
 * O painel monta "Totais por mês" (`aggregateByMonth`, sections-kv.ts) sobre
 * `[...janelaAoVivo, ...arquivo]` (sections-core.ts):
 *   - janela ao vivo = as `CAMPAIGNS_FETCH_LIMIT` campanhas `sent` mais
 *     recentes (`fetchRecentCampaigns`, offset 0);
 *   - arquivo = `dash:campaigns:archive-index` filtrado pelas entradas com
 *     `stats:{id}` cacheado (`loadMonthlyTotalsArchive`).
 * `buildDashboardCoverage` reproduz essa composição a partir dos dados crus
 * (listagem completa da Brevo + índice de arquivo + quais ids têm stats) e
 * `compareMonthlyCoverage` compara mês a mês contra a listagem completa.
 *
 * Escopo: COBERTURA (quais campanhas entram no agregado), não o valor das
 * métricas. Campanha da janela ao vivo conta como coberta mesmo sem saber se
 * o `pickStats` do render a aceitaria — a issue mediu que as campanhas
 * faltantes tinham `globalStats.sent > 0`, então o buraco era de cobertura.
 *
 * Sem I/O — o CLI fino é `scripts/verify-clarice-monthly-coverage.ts`.
 */
import { monthKeyBRT } from "../../workers/brevo-dashboard/src/sections-core.ts";

export interface CoverageCampaign {
  id: number;
  sentDate: string | null;
}

export interface DashboardCoverage {
  /** Exatamente o que `aggregateByMonth` recebe — janela ao vivo seguida do
   * arquivo, SEM deduplicar (o render não deduplica; duplicata conta 2×). */
  campaigns: CoverageCampaign[];
  /** Entradas do índice de arquivo sem `stats:{id}` — o render as descarta
   * (`loadMonthlyTotalsArchive`), então ficam fora do agregado. */
  archivedWithoutStats: number[];
}

/**
 * Pura: reproduz a composição do painel. `listing` é a listagem COMPLETA de
 * `/v3/emailCampaigns?status=sent&sort=desc` (mais recente primeiro) — as
 * primeiras `liveWindowLimit` são a janela ao vivo.
 */
export function buildDashboardCoverage(
  listing: readonly CoverageCampaign[],
  archiveIndex: readonly CoverageCampaign[],
  idsWithStats: ReadonlySet<number>,
  liveWindowLimit: number,
): DashboardCoverage {
  const live = listing.slice(0, liveWindowLimit).map((c) => ({ id: c.id, sentDate: c.sentDate }));
  const archived: CoverageCampaign[] = [];
  const archivedWithoutStats: number[] = [];
  for (const a of archiveIndex) {
    if (idsWithStats.has(a.id)) archived.push({ id: a.id, sentDate: a.sentDate });
    else archivedWithoutStats.push(a.id);
  }
  return { campaigns: [...live, ...archived], archivedWithoutStats };
}

export interface MonthCoverageRow {
  /** "YYYY-MM" em BRT — mesma chave de `aggregateByMonth`. */
  month: string;
  brevoCount: number;
  dashboardCount: number;
  brevoFirst: string | null;
  brevoLast: string | null;
  dashboardFirst: string | null;
  dashboardLast: string | null;
  /** Na Brevo, fora do agregado do painel. */
  missingIds: number[];
  /** No agregado do painel, mas não na listagem da Brevo pra este mês
   * (campanha apagada, ou `sentDate` divergente entre arquivo e API). */
  extraIds: number[];
  /** Contadas mais de uma vez no agregado do painel. */
  duplicateIds: number[];
  ok: boolean;
}

export interface MonthlyCoverageResult {
  rows: MonthCoverageRow[];
  ok: boolean;
  /** Campanhas da Brevo sem `sentDate` utilizável — `aggregateByMonth` as
   * pula, então ficam fora da comparação nos dois lados. */
  brevoWithoutMonth: number[];
}

interface MonthAcc {
  ids: number[];
  first: string | null;
  last: string | null;
}

function accumulate(campaigns: readonly CoverageCampaign[]): { byMonth: Map<string, MonthAcc>; withoutMonth: number[] } {
  const byMonth = new Map<string, MonthAcc>();
  const withoutMonth: number[] = [];
  for (const c of campaigns) {
    const month = c.sentDate ? monthKeyBRT(c.sentDate) : null;
    if (!month || !c.sentDate) {
      withoutMonth.push(c.id);
      continue;
    }
    const acc = byMonth.get(month) ?? { ids: [], first: null, last: null };
    acc.ids.push(c.id);
    if (acc.first === null || Date.parse(c.sentDate) < Date.parse(acc.first)) acc.first = c.sentDate;
    if (acc.last === null || Date.parse(c.sentDate) > Date.parse(acc.last)) acc.last = c.sentDate;
    byMonth.set(month, acc);
  }
  return { byMonth, withoutMonth };
}

/**
 * Pura: compara, mês a mês, a listagem da Brevo (deduplicada por id — uma
 * campanha enviada durante a paginação pode aparecer em 2 páginas) contra o
 * agregado do painel. Um mês só é `ok` com contagem, 1º e último envio
 * iguais e nenhuma campanha faltando, sobrando ou duplicada.
 */
export function compareMonthlyCoverage(
  brevoListing: readonly CoverageCampaign[],
  dashboard: readonly CoverageCampaign[],
): MonthlyCoverageResult {
  const seen = new Set<number>();
  const brevoUnique = brevoListing.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  const brevo = accumulate(brevoUnique);
  const dash = accumulate(dashboard);
  const months = [...new Set([...brevo.byMonth.keys(), ...dash.byMonth.keys()])].sort((a, b) => b.localeCompare(a));

  const rows: MonthCoverageRow[] = months.map((month) => {
    const b = brevo.byMonth.get(month) ?? { ids: [], first: null, last: null };
    const d = dash.byMonth.get(month) ?? { ids: [], first: null, last: null };
    const bSet = new Set(b.ids);
    const dSet = new Set(d.ids);
    const counts = new Map<number, number>();
    for (const id of d.ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const missingIds = b.ids.filter((id) => !dSet.has(id)).sort((x, y) => x - y);
    const extraIds = [...dSet].filter((id) => !bSet.has(id)).sort((x, y) => x - y);
    const duplicateIds = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort((x, y) => x - y);
    const ok =
      b.ids.length === d.ids.length &&
      b.first === d.first &&
      b.last === d.last &&
      missingIds.length === 0 &&
      extraIds.length === 0 &&
      duplicateIds.length === 0;
    return {
      month,
      brevoCount: b.ids.length,
      dashboardCount: d.ids.length,
      brevoFirst: b.first,
      brevoLast: b.last,
      dashboardFirst: d.first,
      dashboardLast: d.last,
      missingIds,
      extraIds,
      duplicateIds,
      ok,
    };
  });

  return { rows, ok: rows.every((r) => r.ok), brevoWithoutMonth: brevo.withoutMonth };
}

const BRT_FMT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtBRT(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : BRT_FMT.format(new Date(t)).replace(",", "");
}

function fmtIds(ids: readonly number[], max = 12): string {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} … (+${ids.length - max})`;
}

/** Pura: relatório em texto, 1 linha por mês + detalhes das divergências. */
export function formatMonthlyCoverageReport(result: MonthlyCoverageResult, extra: { archivedWithoutStats?: readonly number[] } = {}): string {
  const lines: string[] = [];
  lines.push("Mês      | Brevo (1º – último)                | Painel (1º – último)               | ok");
  for (const r of result.rows) {
    const b = `${String(r.brevoCount).padStart(3)}, ${fmtBRT(r.brevoFirst)} – ${fmtBRT(r.brevoLast)}`;
    const d = `${String(r.dashboardCount).padStart(3)}, ${fmtBRT(r.dashboardFirst)} – ${fmtBRT(r.dashboardLast)}`;
    lines.push(`${r.month}  | ${b.padEnd(34)} | ${d.padEnd(34)} | ${r.ok ? "sim" : "NÃO"}`);
  }
  for (const r of result.rows.filter((x) => !x.ok)) {
    if (r.missingIds.length) lines.push(`  ${r.month}: ${r.missingIds.length} na Brevo, fora do painel — ids ${fmtIds(r.missingIds)}`);
    if (r.extraIds.length) lines.push(`  ${r.month}: ${r.extraIds.length} no painel, fora da Brevo — ids ${fmtIds(r.extraIds)}`);
    if (r.duplicateIds.length) lines.push(`  ${r.month}: ${r.duplicateIds.length} contadas 2× no painel — ids ${fmtIds(r.duplicateIds)}`);
  }
  if (result.brevoWithoutMonth.length) {
    lines.push(`Sem sentDate utilizável na Brevo (fora dos dois lados): ids ${fmtIds(result.brevoWithoutMonth)}`);
  }
  if (extra.archivedWithoutStats?.length) {
    lines.push(
      `No índice de arquivo sem stats:{id} (o render as descarta): ${extra.archivedWithoutStats.length} — ids ${fmtIds(extra.archivedWithoutStats)}`,
    );
  }
  lines.push(result.ok ? "Resultado: agregado mensal cobre toda campanha sent." : "Resultado: DIVERGE da Brevo.");
  return lines.join("\n");
}
