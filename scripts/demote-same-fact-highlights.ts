#!/usr/bin/env npx tsx
/**
 * demote-same-fact-highlights.ts (#9100, decisão do editor de 05/10/2026)
 *
 * Stage 1 §1u-quater — roda sobre `_internal/01-categorized.json` depois do
 * dedup intra-edição/evergreen e ANTES do render do MD (§1v), para que o gate
 * 1 e o `--auto` já vejam a ordem nova. Rebaixa do top-3 o candidato a
 * destaque que repete um fato publicado nos D1–D3 das últimas 3 edições
 * (mesma URL, ou mesma entidade + ≥2 números idênticos — ver
 * `scripts/lib/same-fact-demotion.ts`). O item NUNCA é descartado: continua em
 * `highlights` com rank 4+ e no bucket dele (pool), marcado com
 * `same_fact_demoted`; o editor pode promovê-lo de volta.
 *
 * Fonte dos D1–D3 passados: `02-reviewed.md` (o que de fato saiu — inclui
 * troca editorial pós-gate 1, que o `01-approved.json` não registra: foi o
 * buraco do 260918 × 260917), enriquecido com o resumo da fonte do
 * `01-approved.json`; sem `02-reviewed.md`, os `highlights` do approved.
 *
 * Uso:
 *   npx tsx scripts/demote-same-fact-highlights.ts \
 *     --categorized data/editions/2610/261005/_internal/01-categorized.json \
 *     --current-edition 261005 [--editions-dir data/editions] [--window 3] \
 *     [--out-log .../_internal/01-same-fact-demoted.json] [--dry-run]
 *
 * Stdout: JSON `{ demoted, kept, notes[] }`. Fail-soft no histórico: edição
 * passada ilegível é pulada.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { recentEditionDirs, deriveCurrentEdition } from "./lib/past-editions-extract.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { parseDestaques } from "./extract-destaques.ts";
import {
  DEMOTION_PAST_WINDOW,
  demoteSameFactHighlights,
  formatDemotionNote,
  type DemotableHighlight,
  type PublishedDestaque,
} from "./lib/same-fact-demotion.ts";

type Rec = Record<string, unknown>;

function approvedSummaries(editionDir: string): Map<string, { title?: string; summary?: string }> {
  const out = new Map<string, { title?: string; summary?: string }>();
  for (const p of [resolve(editionDir, "_internal", "01-approved.json"), resolve(editionDir, "01-approved.json")]) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as Rec;
      for (const key of ["highlights", "runners_up", "lancamento", "radar", "use_melhor", "video"]) {
        const arr = j[key];
        if (!Array.isArray(arr)) continue;
        for (const it of arr as Rec[]) {
          const a = ((it?.article as Rec | undefined) ?? it) as Rec;
          const url = a?.url ?? it?.url;
          if (typeof url !== "string" || !url) continue;
          const k = canonicalize(url);
          if (out.has(k)) continue;
          out.set(k, {
            title: typeof a.title === "string" ? a.title : undefined,
            summary: typeof a.summary === "string" ? a.summary : undefined,
          });
        }
      }
    } catch {
      // ilegível → sem enriquecimento
    }
    break;
  }
  return out;
}

/**
 * D1–D3 publicados das `window` edições anteriores a `currentAammdd`.
 */
export function readRecentPublishedDestaques(
  editionsDir: string,
  window: number,
  currentAammdd: string,
): PublishedDestaque[] {
  if (!existsSync(editionsDir)) return [];
  const dirsByAammdd = enumerateEditionDirs(editionsDir);
  const recent = recentEditionDirs(editionsDir, window, currentAammdd);
  const out: PublishedDestaque[] = [];
  for (const aammdd of recent) {
    const dir = dirsByAammdd.get(aammdd);
    if (!dir) continue;
    const summaries = approvedSummaries(dir);
    const reviewed = resolve(dir, "02-reviewed.md");
    let got = false;
    if (existsSync(reviewed)) {
      try {
        for (const d of parseDestaques(readFileSync(reviewed, "utf8"))) {
          const extra = d.url ? summaries.get(canonicalize(d.url)) : undefined;
          out.push({
            aammdd,
            n: d.n,
            title: d.title,
            url: d.url,
            text: [d.body, extra?.summary].filter(Boolean).join("\n"),
            ...(extra?.title ? { source_title: extra.title } : {}),
          });
          got = true;
        }
      } catch {
        got = false;
      }
    }
    if (got) continue;
    // Fallback: highlights do 01-approved.json (snapshot do gate 1).
    for (const p of [resolve(dir, "_internal", "01-approved.json"), resolve(dir, "01-approved.json")]) {
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8")) as Rec;
        const hs = Array.isArray(j.highlights) ? (j.highlights as Rec[]) : [];
        hs.slice(0, 3).forEach((h, i) => {
          const a = ((h.article as Rec | undefined) ?? h) as Rec;
          const url = (h.url ?? a.url) as unknown;
          const title = a.title ?? h.title;
          if (typeof title !== "string") return;
          out.push({
            aammdd,
            n: i + 1,
            title,
            url: typeof url === "string" ? url : "",
            text: typeof a.summary === "string" ? a.summary : "",
          });
        });
      } catch {
        // ilegível → pula
      }
      break;
    }
  }
  return out;
}

/**
 * Marca o artigo do bucket (pool) com `same_fact_demoted` — sinal para o
 * gate e para `removeSameFactSecondary` (#9386) não descartá-lo em
 * `--no-gates`: rebaixado nunca é descartado (decisão de 05/10/2026).
 */
export function markPoolArticles(categorized: Rec, demotedUrls: Map<string, unknown>): Rec {
  if (demotedUrls.size === 0) return categorized;
  const out: Rec = { ...categorized };
  for (const key of ["lancamento", "radar", "use_melhor", "video"]) {
    const arr = categorized[key];
    if (!Array.isArray(arr)) continue;
    out[key] = (arr as Rec[]).map((it) => {
      const url = (it?.article as Rec | undefined)?.url ?? it?.url;
      if (typeof url !== "string") return it;
      const mark = demotedUrls.get(canonicalize(url));
      return mark ? { ...it, same_fact_demoted: mark } : it;
    });
  }
  return out;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const dryRun = rawArgv.includes("--dry-run");
  const args = parseCliArgs(rawArgv.filter((a) => a !== "--dry-run")).values;
  const categorizedPath = args["categorized"];
  if (!categorizedPath) {
    console.error(
      "Uso: demote-same-fact-highlights.ts --categorized <01-categorized.json> [--current-edition AAMMDD] " +
        "[--editions-dir data/editions] [--window 3] [--out-log <path>] [--dry-run]",
    );
    process.exit(1);
  }
  const editionsDir = args["editions-dir"] ?? "data/editions";
  const window = parseInt(args["window"] ?? String(DEMOTION_PAST_WINDOW), 10);
  const current = args["current-edition"] ?? deriveCurrentEdition(categorizedPath);
  if (!current) {
    console.error("[demote-same-fact] --current-edition ausente e não derivável do path — nada a fazer.");
    process.stdout.write(JSON.stringify({ demoted: 0, kept: 0, notes: [] }) + "\n");
    return;
  }

  const categorized = JSON.parse(readFileSync(categorizedPath, "utf8")) as Rec;
  const highlights = (Array.isArray(categorized.highlights) ? categorized.highlights : []) as DemotableHighlight[];
  const past = readRecentPublishedDestaques(editionsDir, window, current);
  const result = demoteSameFactHighlights(highlights, past);

  const notes = result.demoted.map(formatDemotionNote);
  for (const k of result.kept) {
    notes.push(
      `🚨 MESMO FATO — "${k.title}" (D${k.rank}) repete o D${k.match.matched_destaque} de ${k.match.matched_edition} "${k.match.matched_title}"; ${k.reason}.`,
    );
  }
  for (const n of notes) console.error(`[demote-same-fact] ${n}`);
  if (notes.length === 0) {
    console.error(`[demote-same-fact] ✓ ${highlights.length} candidato(s) × ${past.length} destaque(s) de ${window} edição(ões) — nenhum fato repetido no top-3.`);
  }

  const outLog = args["out-log"];
  if (!dryRun) {
    if (result.demoted.length > 0) {
      const marks = new Map<string, unknown>(
        result.demoted.map((d) => [
          canonicalize(d.url),
          { matched_edition: d.match.matched_edition, matched_destaque: d.match.matched_destaque, matched_title: d.match.matched_title, evidence: d.match.evidence },
        ]),
      );
      const updated = markPoolArticles({ ...categorized, highlights: result.highlights }, marks);
      writeFileSync(categorizedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    }
    // Resume: rodada sem nada novo não apaga o registro de uma rodada anterior
    // (o JSON já reordenado não reproduz o rebaixamento).
    if (outLog && (result.demoted.length > 0 || result.kept.length > 0 || !existsSync(outLog))) {
      writeFileSync(outLog, JSON.stringify({ demoted: result.demoted, kept: result.kept }, null, 2) + "\n", "utf8");
    }
  }
  process.stdout.write(
    JSON.stringify({ demoted: result.demoted.length, kept: result.kept.length, notes, details: dryRun ? result : undefined }) + "\n",
  );
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
