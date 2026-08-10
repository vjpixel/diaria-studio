/**
 * ctr-rebuild-guard.ts (#4836)
 *
 * Guarda contra o único passo com dano IRREVERSÍVEL do pipeline de CTR:
 * `build-link-ctr.ts --full` reescreve `data/link-ctr-table.csv` do zero a
 * partir do cache local (`data/beehiiv-cache/posts/*.json`). Se o cache tiver
 * degradado desde o último build, o rebuild propaga a degradação pro CSV — e o
 * CSV é a ÚNICA cópia local desse dado (`data/` é gitignored por blanket, e a
 * rota de recuperação via histórico do OneDrive nunca foi testada).
 *
 * Incidente que motivou (auditoria 260810, issue #4836): em 2026-08-05, entre
 * 18:19:29 e 18:19:53, 22 posts tiveram `stats.clicks` sobrescrito com `[]`
 * mantendo `stats.email.unique_verified_clicks` entre 6 e 28. Um `--full`
 * rodado nesse estado apagaria 109 cliques reais do CSV, sem erro e sem aviso —
 * o script reportaria sucesso e um total de linhas plausível.
 *
 * DESENHO: a guarda não sabe nada sobre o incidente de 05/ago. Ela compara o
 * que o rebuild PRODUZIRIA contra o que já está no CSV e recusa escrever se o
 * resultado perder cliques. Isso cobre a causa conhecida e qualquer causa
 * futura (falha de enriquecimento, timeout de paginação, mudança de schema da
 * API) sem manter lista de posts sabidamente ruins.
 *
 * A comparação é POR EDIÇÃO, não só pelo total: um rebuild pode ganhar cliques
 * numa edição e perder em outra, fechando positivo no agregado enquanto destrói
 * dado. O total sozinho não pegaria isso.
 *
 * Não se aplica ao modo incremental (default), que só APENDA linhas novas e
 * nunca reescreve as existentes.
 *
 * Módulo puro: sem I/O, sem `process.exit`, sem `dotenv`. O call site decide o
 * que fazer com o veredicto.
 */

import Papa from "papaparse";

/** Subconjunto de uma row do CSV/rebuild que a guarda precisa ver. */
export interface ClickCountRow {
  date: string;
  post_title: string;
  unique_verified_clicks: number;
}

export interface EditionLoss {
  /** Chave de identidade da edição: `date|post_title` (mesma de `postKey`). */
  key: string;
  date: string;
  post_title: string;
  before: number;
  after: number;
  /** Negativo — quantos cliques a edição perderia. */
  delta: number;
}

export interface ClickLossReport {
  /** `true` quando nenhuma edição perde cliques. Só isto autoriza a escrita. */
  safe: boolean;
  totalBefore: number;
  totalAfter: number;
  /** `totalAfter - totalBefore`. Positivo = rebuild recupera cliques (ex: fix do #4834). */
  totalDelta: number;
  /** Edições que perderiam cliques, da maior perda para a menor. */
  editionsLosing: EditionLoss[];
  /** Edições presentes no CSV que sumiriam por completo do rebuild. */
  editionsVanishing: string[];
}

/** Mesma identidade usada por `build-link-ctr.ts` (`postKey`). */
export function editionKey(date: string, postTitle: string): string {
  return `${date}|${postTitle}`;
}

function tally(rows: ClickCountRow[]): Map<string, { date: string; post_title: string; clicks: number }> {
  const byEdition = new Map<string, { date: string; post_title: string; clicks: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const key = editionKey(r.date, r.post_title ?? "");
    const prev = byEdition.get(key);
    const clicks = Number.isFinite(r.unique_verified_clicks) ? r.unique_verified_clicks : 0;
    if (prev) prev.clicks += clicks;
    else byEdition.set(key, { date: r.date, post_title: r.post_title ?? "", clicks });
  }
  return byEdition;
}

/**
 * Lê as contagens de clique de um CSV já gravado. Tolerante a CSV vazio, só
 * cabeçalho, ou coluna ausente — nesses casos devolve lista vazia, e a guarda
 * trata "nada pra comparar" como seguro (é o caso do bootstrap legítimo, em que
 * o CSV ainda não existe).
 */
export function parseClickCountsFromCsv(csv: string): ClickCountRow[] {
  if (!csv.trim()) return [];
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const out: ClickCountRow[] = [];
  for (const rec of parsed.data) {
    if (!rec?.date) continue;
    out.push({
      date: rec.date,
      post_title: rec.post_title ?? "",
      unique_verified_clicks: Number.parseInt(rec.unique_verified_clicks ?? "0", 10) || 0,
    });
  }
  return out;
}

/**
 * Compara o que o rebuild produziria contra o que já está no CSV.
 *
 * Uma edição que some por completo do rebuild conta como perda — mesmo que o
 * total feche positivo — porque some junto com todos os cliques dela.
 */
export function assessClickLoss(existingRows: ClickCountRow[], newRows: ClickCountRow[]): ClickLossReport {
  const before = tally(existingRows);
  const after = tally(newRows);

  let totalBefore = 0;
  for (const v of before.values()) totalBefore += v.clicks;
  let totalAfter = 0;
  for (const v of after.values()) totalAfter += v.clicks;

  const editionsLosing: EditionLoss[] = [];
  const editionsVanishing: string[] = [];

  for (const [key, prev] of before) {
    const next = after.get(key);
    if (!next) {
      if (prev.clicks > 0) {
        editionsVanishing.push(key);
        editionsLosing.push({
          key, date: prev.date, post_title: prev.post_title,
          before: prev.clicks, after: 0, delta: -prev.clicks,
        });
      }
      continue;
    }
    if (next.clicks < prev.clicks) {
      editionsLosing.push({
        key, date: prev.date, post_title: prev.post_title,
        before: prev.clicks, after: next.clicks, delta: next.clicks - prev.clicks,
      });
    }
  }

  editionsLosing.sort((a, b) => a.delta - b.delta);

  return {
    safe: editionsLosing.length === 0,
    totalBefore,
    totalAfter,
    totalDelta: totalAfter - totalBefore,
    editionsLosing,
    editionsVanishing,
  };
}

/**
 * Mensagem de abort. Nomeia o que seria perdido, a causa provável e a saída —
 * um abort que só diz "recusado" empurra o operador direto pro `--force`.
 */
export function formatClickLossAbort(report: ClickLossReport, flagName = "--allow-click-loss"): string {
  const perdidos = -report.editionsLosing.reduce((s, e) => s + e.delta, 0);
  const linhas = [
    "",
    "╔══════════════════════════════════════════════════════════════════════════╗",
    "║  REBUILD ABORTADO — destruiria cliques já registrados                     ║",
    "╚══════════════════════════════════════════════════════════════════════════╝",
    "",
    `  Cliques no CSV atual ....... ${report.totalBefore}`,
    `  Cliques após o rebuild ..... ${report.totalAfter}  (${report.totalDelta >= 0 ? "+" : ""}${report.totalDelta})`,
    `  Edições que perderiam ...... ${report.editionsLosing.length}  (${perdidos} cliques)`,
  ];

  if (report.editionsVanishing.length > 0) {
    linhas.push(`  Edições que sumiriam ....... ${report.editionsVanishing.length}`);
  }

  linhas.push("", "  Maiores perdas:");
  for (const e of report.editionsLosing.slice(0, 10)) {
    const titulo = e.post_title.length > 44 ? `${e.post_title.slice(0, 41)}...` : e.post_title;
    linhas.push(`    ${e.date}  ${String(e.before).padStart(4)} → ${String(e.after).padStart(4)}  ${titulo}`);
  }
  if (report.editionsLosing.length > 10) {
    linhas.push(`    ... e mais ${report.editionsLosing.length - 10} edições`);
  }

  linhas.push(
    "",
    "  CAUSA PROVÁVEL: o cache local (data/beehiiv-cache/posts/*.json) degradou",
    "  desde o último build — `stats.clicks` vazio em post que tem",
    "  `stats.email.unique_verified_clicks > 0`. Ver #4836 (incidente de 05/ago,",
    "  22 posts, 109 cliques) para o procedimento de restauração.",
    "",
    "  O CSV é a ÚNICA cópia local desse dado. Não force sem restaurar o cache.",
    "",
    "  Ordem correta: (1) backup  (2) endurecer apply-mcp-clicks.ts",
    "  (3) beehiiv-sync → enricher  (4) só então rebuild.",
    "",
    `  Se a perda for INTENCIONAL (ex: filtro de host mais estrito), passe ${flagName}.`,
    "",
  );

  return linhas.join("\n");
}
