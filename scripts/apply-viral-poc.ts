#!/usr/bin/env node
/**
 * scripts/apply-viral-poc.ts — aplica o POC de bônus de viralização (viral-score.ts)
 * sobre chunks já pontuados, ANTES do `merge-scored-chunks.ts`.
 *
 * Uso:
 *   npx tsx scripts/apply-viral-poc.ts --pairs "in0.json|scored0.json,in1.json|scored1.json" \
 *     --newsletters _internal/captured-newsletters.json --now 2026-09-21T18:00:00Z \
 *     [--audit-out _internal/viral-poc-audit.json] [--top 15]
 *
 * Cada par é `scoring-chunk-N.json|scored-chunk-N.json` (`|`, não `:` — #8713). Reescreve o scored-chunk
 * somando o bônus a `score` e gravando `viral:+N` em `bonuses_applied`
 * (invariante `score == score_base + Σ bonuses`). Idempotente: remove um
 * `viral:*` anterior antes de reaplicar.
 *
 * Auditoria (#8672 item 5): `--audit-out` grava `{ top_n, articles,
 * selection_changes }`. `selection_changes` lista quem ENTROU ou SAIU do
 * top-N (os finalistas que `merge-scored-chunks.ts --top` manda pro
 * `scorer-select`) por causa do bônus — é ali que o bônus pode mudar a
 * seleção dos destaques. Aproximação declarada: o ranking aqui é antes do
 * `coverageBonus` que o merge soma depois.
 *
 * Não é produção: a calibração da #8672 (`docs/viral-score-calibration.md`)
 * não encontrou sinal de clique que justifique o bônus.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { computeViralBonus } from "./lib/viral-score.ts";

interface ScoredRow {
  url: string;
  score: number;
  score_base?: number;
  bonuses_applied?: string[];
  [k: string]: unknown;
}

export interface ViralAuditRow {
  url: string;
  title: unknown;
  score_before: number;
  bonus: number;
  signals: string[];
  skipped: string | null;
}

export function applyViral(
  chunkInput: { categorized: Record<string, Record<string, unknown>[]> },
  scoredFile: { scored?: ScoredRow[]; all_scored?: ScoredRow[] },
  newsletterBodies: string[],
  now: string,
): ViralAuditRow[] {
  // `merge-scored-chunks.ts` lê `all_scored ?? scored` — aplicar no mesmo campo.
  const rows = scoredFile.all_scored ?? scoredFile.scored;
  if (!rows) throw new Error("scored-chunk sem `all_scored` nem `scored`");
  const byUrl = new Map<string, Record<string, unknown>>();
  for (const arr of Object.values(chunkInput.categorized)) {
    for (const a of arr) byUrl.set(String(a.url), a);
  }
  const audit: ViralAuditRow[] = [];
  for (const row of rows) {
    const art = byUrl.get(row.url) ?? {};
    const prevViral = (row.bonuses_applied ?? []).find((b) => b.startsWith("viral:"));
    const before = prevViral ? row.score - Number(prevViral.split(":")[1]) : row.score;
    const base = row.score_base ?? before;
    const { bonus, signals, skipped } = computeViralBonus(
      {
        url: row.url,
        title: art.title as string | undefined,
        summary: art.summary as string | undefined,
        published_at: art.published_at as string | undefined,
        score_base: base,
        score_current: before,
        category: art.category as string | undefined,
        verify_verdict: art.verify_verdict as string | undefined,
        negative_impact: art.negative_impact === true || row.negative_impact === true,
        from_newsletter: art.flag === "newsletter_extracted",
      },
      { newsletterBodies, now },
    );
    const rest = (row.bonuses_applied ?? []).filter((b) => !b.startsWith("viral:"));
    row.score_base = base;
    row.score = before + bonus;
    row.bonuses_applied = bonus ? [...rest, `viral:+${bonus}`] : rest;
    if (!row.bonuses_applied.length) delete row.bonuses_applied;
    audit.push({ url: row.url, title: art.title, score_before: before, bonus, signals, skipped });
  }
  return audit;
}

export interface SelectionChange {
  url: string;
  title: unknown;
  rank_before: number;
  rank_after: number;
  bonus: number;
  change: "entered_top_n" | "left_top_n";
}

/** Ranking 1-based por score desc; empate desempata por URL (determinístico). */
function ranks(rows: readonly ViralAuditRow[], score: (r: ViralAuditRow) => number): Map<string, number> {
  const sorted = [...rows].sort((a, b) => score(b) - score(a) || a.url.localeCompare(b.url));
  return new Map(sorted.map((r, i) => [r.url, i + 1]));
}

/**
 * Quem cruzou a linha do top-N por causa do bônus (#8672 item 5). Lista
 * vazia = o bônus não mudou o conjunto de finalistas.
 */
export function summarizeSelectionImpact(audit: readonly ViralAuditRow[], topN: number): SelectionChange[] {
  const before = ranks(audit, (r) => r.score_before);
  const after = ranks(audit, (r) => r.score_before + r.bonus);
  const out: SelectionChange[] = [];
  for (const r of audit) {
    const rb = before.get(r.url)!;
    const ra = after.get(r.url)!;
    if (rb > topN && ra <= topN) out.push({ url: r.url, title: r.title, rank_before: rb, rank_after: ra, bonus: r.bonus, change: "entered_top_n" });
    else if (rb <= topN && ra > topN) out.push({ url: r.url, title: r.title, rank_before: rb, rank_after: ra, bonus: r.bonus, change: "left_top_n" });
  }
  return out.sort((a, b) => a.rank_after - b.rank_after);
}

/** Par `entrada|pontuado`. `|` não aparece em path Windows (`:` aparece: `C:\`). */
export function parsePair(pair: string): [string, string] {
  const parts = pair.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`par inválido "${pair}" — use scoring-chunk-N.json|scored-chunk-N.json`);
  }
  return [parts[0], parts[1]];
}

function main() {
  const args = parseArgs(process.argv.slice(2)).values;
  const pairs = String(args.pairs ?? "").split(",").filter(Boolean);
  const nlPath = String(args.newsletters ?? "");
  const now = String(args.now ?? new Date().toISOString());
  const topN = Number(args.top ?? 15);
  if (!pairs.length) {
    console.error('uso: --pairs "in|scored[,in|scored]" --newsletters captured-newsletters.json [--now ISO] [--audit-out f] [--top 15]');
    process.exit(1);
  }
  const bodies: string[] = nlPath
    ? (JSON.parse(readFileSync(nlPath, "utf8")) as { body: string }[]).map((n) => n.body)
    : [];
  const all: ViralAuditRow[] = [];
  for (const p of pairs) {
    const [inPath, scoredPath] = parsePair(p);
    const chunk = JSON.parse(readFileSync(inPath, "utf8"));
    const scored = JSON.parse(readFileSync(scoredPath, "utf8"));
    all.push(...applyViral(chunk, scored, bodies, now));
    writeFileSync(scoredPath, JSON.stringify(scored, null, 2));
  }
  const selection_changes = summarizeSelectionImpact(all, topN);
  if (args["audit-out"]) {
    writeFileSync(String(args["audit-out"]), JSON.stringify({ top_n: topN, articles: all, selection_changes }, null, 2));
  }
  const boosted = all.filter((a) => a.bonus > 0);
  console.log(
    JSON.stringify({
      articles: all.length,
      boosted: boosted.length,
      max_bonus: Math.max(0, ...all.map((a) => a.bonus)),
      selection_changes: selection_changes.length,
    }),
  );
}

if (isMainModule(import.meta.url)) main();
