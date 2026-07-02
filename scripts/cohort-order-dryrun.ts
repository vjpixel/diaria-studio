#!/usr/bin/env node
/**
 * cohort-order-dryrun.ts — dry-run comparativo READ-ONLY entre a ordenação de
 * 1º envio por TIER (comportamento pré-#2857-fase-B) e por COHORT (#2857 fase
 * B, `segmentFromStore`/`cohortSendRank` atuais) sobre um store real.
 *
 * Artefato de validação humana pré-fase-C (cutover: remoção da coluna `tier`)
 * — o editor roda isso contra o store de produção pra conferir, com números
 * reais, que a única diferença observável é a documentada (safras mensais
 * rankeando por recência acima dos buckets legados que herdariam o mesmo tier
 * residual do merge — ver test/clarice-segment.test.ts, equivalência (a)/(b)).
 *
 * NÃO dispara, NÃO faz fetch ao vivo, NÃO escreve nada — só lê o store
 * (#2647) e imprime um relatório comparativo lado a lado.
 *
 * ⚠️ O relatório contém EMAILS (PII) nas top-N posições de cada ordem — mesma
 * ressalva de scripts/lib/clarice-waves-dryrun.ts: manter local, não commitar.
 *
 * Uso:
 *   npx tsx scripts/cohort-order-dryrun.ts [--db <path>] [--top N] [--out <file.md>]
 *   --top N: quantas posições do topo da fila de 1º envio comparar (default 50).
 *   --out:   grava o relatório num arquivo além de imprimir no stdout.
 */

import { writeFileSync } from "node:fs";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { loadStoreRows, tierRank, isFirstSend, type StoreRow } from "./lib/clarice-segment.ts";
import { cohortSendRank } from "./lib/cohorts.ts";
import { getArg } from "./lib/cli-args.ts";

const DEFAULT_TOP = 50;

/**
 * Ordena `firstSend` (elegível, nunca enviado) por TIER ASC + email ASC —
 * réplica PURA e independente do comportamento PRÉ-#2857-fase-B. NÃO reimporta
 * `segmentFromStore` (que já migrou pra cohort) — um oráculo independente do
 * código de produção pega bug que comparar "com si mesma" não pegaria (mesmo
 * princípio de test/clarice-segment.test.ts, `firstSendOrderByTierOracle`).
 */
export function firstSendByTier(rows: StoreRow[]): StoreRow[] {
  return rows
    .filter((r) => isFirstSend(r))
    .slice()
    .sort((a, b) => {
      const ra = tierRank(a.tier);
      const rb = tierRank(b.tier);
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
}

/** Ordena `firstSend` por COHORT ASC + email ASC — comportamento ATUAL (pós-#2857 fase B), mesma regra de `segmentFromStore`. */
export function firstSendByCohort(rows: StoreRow[]): StoreRow[] {
  return rows
    .filter((r) => isFirstSend(r))
    .slice()
    .sort((a, b) => {
      const ra = cohortSendRank(a.cohort);
      const rb = cohortSendRank(b.cohort);
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
}

export interface OrderDiffEntry {
  /** Posição na fila (1-indexed). */
  position: number;
  /** Email na ordem antiga (tier) nesta posição — "(fim)" se a fila antiga já acabou. */
  tierOrderEmail: string;
  /** Email na ordem nova (cohort) nesta posição — "(fim)" se a fila nova já acabou. */
  cohortOrderEmail: string;
}

export interface OrderComparison {
  firstSendTotal: number;
  /** Top N emails de cada ordem, na posição correspondente. */
  tierOrderTop: string[];
  cohortOrderTop: string[];
  /** Total de posições (sobre a fila INTEIRA, não só o top N) onde as duas ordens divergem. */
  diffCount: number;
  /** Amostra das primeiras `top` divergências (posição + email de cada lado). */
  sampleDiffs: OrderDiffEntry[];
}

/** Compara as duas ordens sobre o universo firstSend inteiro; `top` limita o que É REPORTADO (top-N + amostra de diffs), não o que é COMPARADO (sempre a fila inteira). */
export function compareOrders(rows: StoreRow[], top: number = DEFAULT_TOP): OrderComparison {
  const byTier = firstSendByTier(rows);
  const byCohort = firstSendByCohort(rows);
  const n = Math.max(byTier.length, byCohort.length);
  const diffs: OrderDiffEntry[] = [];
  for (let i = 0; i < n; i++) {
    const t = byTier[i]?.email;
    const c = byCohort[i]?.email;
    if (t !== c) {
      diffs.push({ position: i + 1, tierOrderEmail: t ?? "(fim)", cohortOrderEmail: c ?? "(fim)" });
    }
  }
  return {
    firstSendTotal: byTier.length,
    tierOrderTop: byTier.slice(0, top).map((r) => r.email),
    cohortOrderTop: byCohort.slice(0, top).map((r) => r.email),
    diffCount: diffs.length,
    sampleDiffs: diffs.slice(0, top),
  };
}

const fmt = (n: number): string => n.toLocaleString("pt-BR");

/** Relatório markdown READ-ONLY. Contém emails (PII) — manter local. */
export function renderComparisonReport(cmp: OrderComparison, top: number): string {
  const pct = cmp.firstSendTotal > 0 ? ((cmp.diffCount / cmp.firstSendTotal) * 100).toFixed(1) : "0.0";
  const sideBySide = Array.from({ length: Math.max(cmp.tierOrderTop.length, cmp.cohortOrderTop.length) }, (_, i) => {
    const t = cmp.tierOrderTop[i] ?? "—";
    const c = cmp.cohortOrderTop[i] ?? "—";
    const mark = t !== c ? " ⚠️" : "";
    return `| ${i + 1} | ${t} | ${c}${mark} |`;
  }).join("\n");
  const diffRows = cmp.sampleDiffs
    .map((d) => `| ${d.position} | ${d.tierOrderEmail} | ${d.cohortOrderEmail} |`)
    .join("\n") || "| (nenhuma) | — | — |";

  return `# Dry-run comparativo — ordem de 1º envio: tier (antigo) vs cohort (#2857 fase B)

> READ-ONLY. NÃO dispara, NÃO escreve nada. Universo firstSend (elegível, nunca
> enviado): **${fmt(cmp.firstSendTotal)}** contatos.
>
> ⚠️ Contém EMAILS (PII) — manter local, não commitar/subir.

## Resumo
- Posições divergentes (fila inteira): **${fmt(cmp.diffCount)}** de ${fmt(cmp.firstSendTotal)} (**${pct}%**).
- Diferença ESPERADA (documentada, #2857 fase B/B.1):
  1. Safras mensais (\`leads-YYYY-MM\`) e semestres de lead (\`leads-YYYYhN\`)
     rankeiam por recência DECRESCENTE do início do período REAL de
     \`created\` — antes, contatos do MESMO tier empatavam e desempatavam só
     por email ASC.
  2. Pra tiers 3-9, o cohort deriva do período REAL de \`created\`, não mais
     do rótulo estático que o tier atribuiria (fase B.1) — um lead \`created\`
     em 2025-03 nunca mais aparece rotulado como o semestre que o tier
     residual do merge "diria" que ele é.
  3. Pagante (tier 1/2) SEMPRE fica em \`assinantes-ativos\`/\`ex-assinantes\`,
     nunca cai pra um cohort de lead — mesma posição em ambas as ordens (a
     ordem tier já cobria isso; a fase B.1 corrigiu um bug em que \`created\`
     recente rebaixava o pagante indevidamente na ordem cohort).
- Se \`diffCount\` for MUITO maior do que o esperado só pelo item 1/2 acima,
  investigue antes de prosseguir pro cutover (fase C).

## Top ${top} — lado a lado (posição idêntica)
| # | tier (antigo) | cohort (novo) |
|---:|---|---|
${sideBySide || "| (nenhum contato firstSend) | — | — |"}

## Amostra de divergências (até ${top})
| posição | tier (antigo) | cohort (novo) |
|---:|---|---|
${diffRows}
`;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const top = Number(getArg(argv, "top")) || DEFAULT_TOP;
  const out = getArg(argv, "out");

  const db = openClariceDb(dbPath);
  const rows = loadStoreRows(db);
  db.close();

  if (rows.length === 0) {
    console.error(
      `❌ store vazio (0 contatos) em ${dbPath} — rode clarice-build-db.ts + ` +
        `clarice-sync-brevo.ts antes. Comparar ordens sobre um store vazio é inútil.`,
    );
    process.exit(1);
  }

  const cmp = compareOrders(rows, top);
  const md = renderComparisonReport(cmp, top);

  if (out) {
    writeFileSync(out, md, "utf8");
    console.error(
      `[cohort-order-dryrun] relatório gravado em ${out}\n` +
        `⚠️  CONTÉM EMAILS (PII) — NÃO commitar/subir. Grave em data/ (gitignored) ou apague após revisar.`,
    );
  }
  console.log(md);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
