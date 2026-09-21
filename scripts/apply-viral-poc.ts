#!/usr/bin/env node
/**
 * scripts/apply-viral-poc.ts — aplica o POC de bônus de viralização (viral-score.ts)
 * sobre chunks já pontuados, ANTES do `merge-scored-chunks.ts`.
 *
 * Uso:
 *   npx tsx scripts/apply-viral-poc.ts --pairs "in0.json:scored0.json,in1.json:scored1.json" \
 *     --newsletters _internal/captured-newsletters.json --now 2026-09-21T18:00:00Z \
 *     [--audit-out _internal/viral-poc-audit.json]
 *
 * Cada par é `scoring-chunk-N.json:scored-chunk-N.json`. Reescreve o scored-chunk
 * somando o bônus a `score` e gravando `viral:+N` em `bonuses_applied`
 * (invariante `score == score_base + Σ bonuses`). Idempotente: remove um
 * `viral:*` anterior antes de reaplicar.
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

export function applyViral(
  chunkInput: { categorized: Record<string, Record<string, unknown>[]> },
  scoredFile: { scored?: ScoredRow[]; all_scored?: ScoredRow[] },
  newsletterBodies: string[],
  now: string,
) {
  // `merge-scored-chunks.ts` lê `all_scored ?? scored` — aplicar no mesmo campo.
  const rows = scoredFile.all_scored ?? scoredFile.scored;
  if (!rows) throw new Error("scored-chunk sem `all_scored` nem `scored`");
  const scored = { scored: rows };
  const byUrl = new Map<string, Record<string, unknown>>();
  for (const arr of Object.values(chunkInput.categorized)) {
    for (const a of arr) byUrl.set(String(a.url), a);
  }
  const audit: { url: string; title: unknown; score_before: number; bonus: number; signals: string[] }[] = [];
  for (const row of scored.scored) {
    const art = byUrl.get(row.url) ?? {};
    const prevViral = (row.bonuses_applied ?? []).find((b) => b.startsWith("viral:"));
    const before = prevViral ? row.score - Number(prevViral.split(":")[1]) : row.score;
    const base = row.score_base ?? before;
    const { bonus, signals } = computeViralBonus(
      {
        url: row.url,
        title: art.title as string | undefined,
        summary: art.summary as string | undefined,
        published_at: art.published_at as string | undefined,
        score_base: base,
        category: art.category as string | undefined,
      },
      { newsletterBodies, now },
    );
    const rest = (row.bonuses_applied ?? []).filter((b) => !b.startsWith("viral:"));
    row.score_base = base;
    row.score = before + bonus;
    row.bonuses_applied = bonus ? [...rest, `viral:+${bonus}`] : rest;
    if (!row.bonuses_applied.length) delete row.bonuses_applied;
    audit.push({ url: row.url, title: art.title, score_before: before, bonus, signals });
  }
  return audit;
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
  if (!pairs.length) {
    console.error("uso: --pairs in:scored[,in:scored] --newsletters captured-newsletters.json [--now ISO] [--audit-out f]");
    process.exit(1);
  }
  const bodies: string[] = nlPath
    ? (JSON.parse(readFileSync(nlPath, "utf8")) as { body: string }[]).map((n) => n.body)
    : [];
  const all: ReturnType<typeof applyViral> = [];
  for (const p of pairs) {
    const [inPath, scoredPath] = parsePair(p);
    const chunk = JSON.parse(readFileSync(inPath, "utf8"));
    const scored = JSON.parse(readFileSync(scoredPath, "utf8"));
    all.push(...applyViral(chunk, scored, bodies, now));
    writeFileSync(scoredPath, JSON.stringify(scored, null, 2));
  }
  if (args["audit-out"]) writeFileSync(String(args["audit-out"]), JSON.stringify(all, null, 2));
  const boosted = all.filter((a) => a.bonus > 0);
  console.log(JSON.stringify({ articles: all.length, boosted: boosted.length, max_bonus: Math.max(0, ...all.map((a) => a.bonus)) }));
}

if (isMainModule(import.meta.url)) main();
