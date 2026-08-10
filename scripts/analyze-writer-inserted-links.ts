#!/usr/bin/env tsx
/**
 * analyze-writer-inserted-links.ts (#4848)
 *
 * Mede clique/link separado por ORIGEM do link publicado — `scored` (passou
 * pelo funil pesquisa → dedup → categorize → score do Stage 1, presente em
 * `01-approved.json`) vs `writer_inserted` (link contextual inserido pelo
 * writer dentro do corpo de um destaque no Stage 2, ex.: "segundo a
 * Reuters", nunca visto pelo scorer).
 *
 * **Decisão do editor (sessão develop 260810b, comentário durável em #4848):
 * Opção 2 — aceitar como desenho + medir separado.** Link contextual dentro
 * do corpo do destaque é trabalho legítimo do writer, não deve virar sinal
 * de scoring por padrão — mas precisa ser medido SEPARADO do resto do pool
 * pontuado, para não contaminar a avaliação do scorer (H2/H4 de
 * `analyze-scorer-impact.ts`/`analyze-h4.ts` continuam olhando só pro pool
 * pontuado; este script NUNCA mistura as duas populações na mesma média).
 *
 * A medição bruta que originou a issue (43 links/janela renderam 2,1× o CTR
 * do pool pontuado) tinha um confundimento óbvio: link do writer costuma
 * ocupar posição de alta atenção (corpo de um destaque já selecionado como
 * o melhor do dia) — comparar com a média geral do pool é comparar
 * posições, não origens. `link-layout.json`/`published-links.json` (#4841)
 * resolvem esse confundimento gravando POSIÇÃO e PROVENIÊNCIA no momento do
 * render, a partir da mesma `NewsletterContent` que `renderHTML()` consome —
 * nunca por heurística sobre o HTML já publicado.
 *
 * Este script faz o join `published-links.json` (proveniência, por edição)
 * × `data/link-ctr-table.csv` (cliques reais, por post/dia, via Beehiiv) por
 * `${data da edição}|${url canonicalizado}`, e agrega clique/link e CTR
 * pooled SEPARADAMENTE por origem. Só cobre edições publicadas depois do
 * #4841 mergear (260810) — edições anteriores não têm `published-links.json`
 * e ficam de fora do relatório (não há proveniência retroativa confiável,
 * ver docstring de `lib/link-layout.ts`).
 *
 * Uso:
 *   npx tsx scripts/analyze-writer-inserted-links.ts \
 *     [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
 *     [--ctr data/link-ctr-table.csv] [--editions-dir data/editions] [--out report.md]
 *
 * Sem `--from`/`--to`: cobre TODAS as edições instrumentadas encontradas.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./lib/url-utils.ts";
import { parseArgsWithTrueDefault as parseArgs, isMainModule } from "./lib/cli-args.ts"; // #2834
import { loadCtrRowsH4 } from "./analyze-h4.ts";
import type { CtrRow } from "./analyze-scorer-impact.ts";
import type { PublishedLink, LinkOrigin } from "./lib/link-layout.ts";

const ROOT = resolve(import.meta.dirname, "..");

const ORIGINS: readonly LinkOrigin[] = ["scored", "writer_inserted"];

// ─── Edição AAMMDD ↔ data YYYY-MM-DD ───────────────────────────────────────

/** "AAMMDD" (ex: "260810") → "YYYY-MM-DD" (ex: "2026-08-10"). null se inválido. */
export function editionToDate(edition: string): string | null {
  const m = edition.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  return `20${yy}-${mm}-${dd}`;
}

// ─── Descoberta + leitura fail-soft de published-links.json ───────────────

/**
 * Lista os códigos de edição (AAMMDD) que já têm `published-links.json` —
 * só edições publicadas pós-#4841. Ignora entradas não-AAMMDD (ex.:
 * `replay-scorer-a`, `2608` — diretórios auxiliares de experimento).
 */
export function listEditionsWithPublishedLinks(editionsDir: string): string[] {
  const abs = resolve(ROOT, editionsDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => /^\d{6}$/.test(name))
    .filter((name) => existsSync(resolve(abs, name, "_internal", "published-links.json")))
    .sort();
}

/**
 * Leitura fail-soft de `published-links.json` de uma edição. Arquivo
 * ausente/inválido/malformado retorna `[]` — nunca lança (mesma disciplina
 * fail-soft de `readScoredUrls` em `lib/link-layout.ts`).
 */
export function loadPublishedLinksForEdition(
  editionsDir: string,
  edition: string,
): PublishedLink[] {
  const p = resolve(ROOT, editionsDir, edition, "_internal", "published-links.json");
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is PublishedLink =>
        l && typeof l.url === "string" && (l.origin === "scored" || l.origin === "writer_inserted"),
    );
  } catch {
    return [];
  }
}

// ─── Join com o CTR table ──────────────────────────────────────────────────

/**
 * Índice `${date}|${url canonicalizado}` → CtrRow, pra join O(1) entre
 * `published-links.json` (por edição) e `data/link-ctr-table.csv` (todas as
 * edições, 1 linha por link publicado por post). Em colisão (mesmo link
 * repetido no mesmo post — ex.: aprofunde reaparecendo), mantém a 1ª
 * ocorrência.
 */
export function buildCtrIndex(rows: CtrRow[]): Map<string, CtrRow> {
  const idx = new Map<string, CtrRow>();
  for (const r of rows) {
    const key = `${r.date}|${canonicalize(r.base_url)}`;
    if (!idx.has(key)) idx.set(key, r);
  }
  return idx;
}

// ─── Agregação por origem ───────────────────────────────────────────────────

export interface OriginAgg {
  origin: LinkOrigin;
  links_matched: number;
  links_unmatched: number;
  opens: number;
  clicks: number;
}

export interface WriterInsertedReport {
  editions: string[];
  total_links: number;
  matched_links: number;
  unmatched_links: number;
  byOrigin: Record<LinkOrigin, OriginAgg>;
}

function emptyAgg(origin: LinkOrigin): OriginAgg {
  return { origin, links_matched: 0, links_unmatched: 0, opens: 0, clicks: 0 };
}

/**
 * Agrega clique/link por origem, SEPARADO — nunca soma `scored` e
 * `writer_inserted` na mesma conta. Links sem match no CTR table (post não
 * sincronizado ainda / CTR não estabilizado, ver `MIN_AGE_DAYS_FOR_CLICKS`)
 * contam em `links_unmatched` mas não entram nas somas de opens/clicks.
 */
export function aggregateByOrigin(
  editions: string[],
  editionsDir: string,
  ctrIndex: Map<string, CtrRow>,
): WriterInsertedReport {
  const byOrigin: Record<LinkOrigin, OriginAgg> = {
    scored: emptyAgg("scored"),
    writer_inserted: emptyAgg("writer_inserted"),
  };
  let total = 0;
  let matched = 0;
  let unmatched = 0;

  for (const edition of editions) {
    const date = editionToDate(edition);
    if (!date) continue;
    for (const link of loadPublishedLinksForEdition(editionsDir, edition)) {
      total++;
      const agg = byOrigin[link.origin];
      const row = ctrIndex.get(`${date}|${canonicalize(link.url)}`);
      if (!row) {
        unmatched++;
        agg.links_unmatched++;
        continue;
      }
      matched++;
      agg.links_matched++;
      agg.opens += row.unique_opens;
      agg.clicks += row.unique_verified_clicks;
    }
  }

  return { editions, total_links: total, matched_links: matched, unmatched_links: unmatched, byOrigin };
}

export interface OriginStats {
  origin: LinkOrigin;
  links: number;
  opens: number;
  clicks: number;
  /** clicks totais / links casados — a métrica citada na issue original (#4848: "1,302 vs 0,618 clique/link"). */
  clicks_per_link: number | null;
  /** CTR pooled (clicks totais / opens totais), em %. */
  ctr_pooled_pct: number | null;
}

export function computeOriginStats(agg: OriginAgg): OriginStats {
  return {
    origin: agg.origin,
    links: agg.links_matched,
    opens: agg.opens,
    clicks: agg.clicks,
    clicks_per_link: agg.links_matched > 0 ? agg.clicks / agg.links_matched : null,
    ctr_pooled_pct: agg.opens > 0 ? (agg.clicks / agg.opens) * 100 : null,
  };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function fmt(n: number | null, digits = 3): string {
  return n === null ? "—" : n.toFixed(digits);
}

export function renderReport(report: WriterInsertedReport): string {
  const L: string[] = [];
  L.push("# Clique/link por origem — scored vs writer-inserted (#4848)", "");
  L.push(
    "Decisão do editor (sessão develop 260810b): link contextual inserido pelo " +
      "writer dentro do corpo do destaque é trabalho legítimo, não sinal de " +
      "scoring por padrão — medido aqui SEPARADO do pool pontuado, nunca " +
      "misturado na mesma média. Reavaliar com dado acumulado de algumas " +
      "semanas se o padrão persistir (ver comentário da decisão em #4848).",
    "",
  );
  L.push(
    `Edições instrumentadas (têm \`published-links.json\`, pós-#4841/260810): ` +
      `${report.editions.length}.`,
  );
  if (report.editions.length > 0) {
    L.push(`Lista: ${report.editions.join(", ")}`);
  } else {
    L.push(
      "> Nenhuma edição instrumentada ainda — `published-links.json` só existe " +
        "a partir da 1ª edição publicada depois do #4841 mergear. Esperado ficar " +
        "vazio por alguns dias/semanas até o CTR das primeiras edições estabilizar.",
    );
  }
  L.push("");

  L.push("## Cobertura do join (published-links.json × link-ctr-table.csv)", "");
  L.push(
    `Total de links publicados: ${report.total_links} · casados com dado de clique: ` +
      `${report.matched_links} · sem match ainda: ${report.unmatched_links}`,
  );
  L.push(
    "(links sem match não entram na agregação abaixo — CTR não estabilizado " +
      "ainda, ver `MIN_AGE_DAYS_FOR_CLICKS`, ou o post não passou por " +
      "`build-link-ctr.ts` ainda.)",
    "",
  );

  L.push("## Clique/link por origem — populações SEPARADAS", "");
  L.push("| Origem | Links c/ dado | Opens (soma) | Clicks (soma) | Clicks/link | CTR pooled |");
  L.push("|---|---|---|---|---|---|");
  for (const origin of ORIGINS) {
    const stats = computeOriginStats(report.byOrigin[origin]);
    L.push(
      `| ${origin} | ${stats.links} | ${stats.opens} | ${stats.clicks} | ` +
        `${fmt(stats.clicks_per_link)} | ${fmt(stats.ctr_pooled_pct, 2)}% |`,
    );
  }
  L.push("");

  const scored = computeOriginStats(report.byOrigin.scored);
  const writerInserted = computeOriginStats(report.byOrigin.writer_inserted);
  if (
    scored.clicks_per_link !== null &&
    scored.clicks_per_link > 0 &&
    writerInserted.clicks_per_link !== null
  ) {
    const ratio = writerInserted.clicks_per_link / scored.clicks_per_link;
    L.push(
      `**writer_inserted rende ${fmt(ratio, 2)}× o clique/link de scored** nesta janela ` +
        `(n=${writerInserted.links} vs n=${scored.links} — leia com cautela sob n baixo).`,
      "",
    );
  }

  L.push(
    "_Este relatório NUNCA alimenta o scorer/audience-profile — é medição " +
      "isolada, pra decidir com evidência acumulada se a Opção 2 (#4848) segue " +
      "valendo ou se o padrão justifica reabrir a decisão._",
  );

  return L.join("\n");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const ctrPath = args.ctr ?? "data/link-ctr-table.csv";
  const from = args.from;
  const to = args.to;

  let editions = listEditionsWithPublishedLinks(editionsDir);
  if (from || to) {
    editions = editions.filter((edition) => {
      const date = editionToDate(edition);
      if (!date) return false;
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });
  }

  const ctrRows = loadCtrRowsH4(ctrPath);
  const ctrIndex = buildCtrIndex(ctrRows);
  const report = aggregateByOrigin(editions, editionsDir, ctrIndex);
  const md = renderReport(report);

  if (args.out) {
    writeFileSync(resolve(ROOT, args.out), md + "\n", "utf8");
    process.stderr.write(`[analyze-writer-inserted-links] relatório em ${args.out}\n`);
  } else {
    process.stdout.write(md + "\n");
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
