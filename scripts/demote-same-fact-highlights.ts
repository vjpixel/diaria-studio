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
 * #10795 (decisão do editor, briefing 261023): na mesma passada, depois do
 * rebaixamento de mesmo fato, `applyNegativePromotionEligibility`
 * (`scripts/lib/negative-promotion-eligibility.ts`) impede que um destaque
 * `negative_impact:true` de processo/acusação ou de entidade+tema que já foi
 * destaque nos últimos 14 dias chegue ao top-3/D1 por PROMOÇÃO (no trio por
 * mérito ele fica). O log ganha `negative_promotion[]`.
 *
 * Stdout: JSON `{ demoted, kept, negative_promotion, notes[] }`. Fail-soft no histórico: edição
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
import {
  NEGATIVE_THEME_WINDOW_DAYS,
  applyNegativePromotionEligibility,
  formatNegativePolicyNote,
  withinThemeWindow,
} from "./lib/negative-promotion-eligibility.ts";

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
  // #10795: negativo inelegível (processo/acusação, entidade+tema nos últimos
  // 14 dias) não chega ao top-3/D1 por promoção. Roda sobre a ordem já
  // corrigida pelo #9100; uma edição por dia, então 14 edições cobrem 14 dias.
  const themePast = withinThemeWindow(
    readRecentPublishedDestaques(editionsDir, NEGATIVE_THEME_WINDOW_DAYS, current),
    current,
  );
  const policy = applyNegativePromotionEligibility(result.highlights, themePast);
  const finalHighlights = policy.highlights;
  const finalRank = new Map(
    finalHighlights.map((h) => [canonicalize(String(h.url ?? h.article?.url ?? "")), h.rank ?? 0]),
  );
  const inFinalTop = (url: string) => (finalRank.get(canonicalize(url)) ?? Infinity) <= 3;
  // Repetido mantido pelo #9100 (cota #3916) que a política tirou do top-3 deixa de ser "kept".
  const kept = result.kept
    .filter((k) => inFinalTop(k.url))
    .map((k) => ({ ...k, rank: finalRank.get(canonicalize(k.url)) ?? k.rank }));
  const keptOut = result.kept.filter((k) => !inFinalTop(k.url));

  const notes = result.demoted.map(formatDemotionNote);
  notes.push(...policy.actions.map(formatNegativePolicyNote));
  if (policy.no_eligible_negative) {
    notes.push("⚠️ #10795/#3916 — top-3 sem negativo elegível depois das exclusões; o gate da Etapa 4 avisa (decisão do editor).");
  }
  for (const k of kept) {
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
    if (result.demoted.length > 0 || policy.actions.length > 0) {
      // Pool marcado = não descartável em --no-gates (#9386): rebaixado pelo
      // #9100, e repetido mantido por ele que a política #10795 tirou do top-3.
      const toMark = [...result.demoted, ...keptOut];
      const marks = new Map<string, unknown>(
        toMark.map((d) => [
          canonicalize(d.url),
          { matched_edition: d.match.matched_edition, matched_destaque: d.match.matched_destaque, matched_title: d.match.matched_title, evidence: d.match.evidence },
        ]),
      );
      const updated = markPoolArticles({ ...categorized, highlights: finalHighlights }, marks);
      writeFileSync(categorizedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    }
    // Resume: rodada sem nada novo não apaga o registro de uma rodada anterior
    // (o JSON já reordenado não reproduz o rebaixamento).
    if (outLog && (result.demoted.length > 0 || kept.length > 0 || policy.actions.length > 0 || !existsSync(outLog))) {
      writeFileSync(
        outLog,
        JSON.stringify({ demoted: result.demoted, kept, negative_promotion: policy.actions }, null, 2) + "\n",
        "utf8",
      );
    }
  }
  process.stdout.write(
    JSON.stringify({
      demoted: result.demoted.length,
      kept: kept.length,
      negative_promotion: policy.actions.length,
      notes,
      details: dryRun ? { ...result, highlights: finalHighlights, kept, negative_promotion: policy.actions } : undefined,
    }) + "\n",
  );
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
