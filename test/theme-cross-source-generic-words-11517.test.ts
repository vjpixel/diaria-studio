/**
 * #11517: o aviso theme-cross-source-repeat do gate 4 saía como 🚨 "Cortar no
 * gate" em qualquer `cross_source_match`, inclusive com jaccard 0.2 vindo só
 * de palavra de anúncio genérica. Os dois falsos positivos do replay (261015)
 * e o caso real (261029, Siri) estão abaixo com os títulos reais.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentJaccard, detectEventOverlap } from "../scripts/lib/repeat-theme-check.ts";
import { subjectSimilarity } from "../scripts/lib/title-similarity.ts";
import {
  checkThemeCrossSourceRepeat,
  THEME_CROSS_SOURCE_CUT_MIN_JACCARD,
} from "../scripts/lib/invariant-checks/stage-4.ts";

const FP1 = { cand: "Introducing The X Subscription", past: "Introducing the Anthropic Cyber Mission", url: "https://x.example/subscription" };
const FP2 = { cand: "An Update on Character.ai", past: "2026 Usage Policy update", url: "https://character.example/update" };
const SIRI = {
  cand: "iOS 27.2 libera nova Siri em português no Brasil",
  past: "Atualize já: Apple libera iOS 27.2 com Siri AI em português",
  url: "https://tecnoblog.net/noticias/ios-27-2-libera-nova-siri-em-portugues-no-brasil/",
};
// #8896: mesmo evento, títulos parafraseados (jaccard ≈0.22, sem entidade)
const AGENTE = {
  cand: "Agente da OpenAI invadiu o sistema de saúde australiano",
  past: "Agente rebelde invade sistema de governo",
  url: "https://wired.example/agente",
};

function runCheck(pairs: Array<{ cand: string; past: string; url: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "theme-cross-11517-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "02-reviewed.md"),
      pairs.map((p) => `**${p.cand}**\n\n${p.url}\n`).join("\n"),
    );
    const warnings = pairs.map((p, i) => ({
      candidate_rank: i + 1,
      candidate_title: p.cand,
      candidate_url: p.url,
      matched_edition: "261014",
      matched_title: p.past,
      jaccard: Math.round(subjectSimilarity(p.cand, p.past) * 100) / 100,
      shared_entities: [],
      cross_source_match: true,
    }));
    writeFileSync(join(dir, "_internal", "01-highlight-theme-check.json"), JSON.stringify({ warnings, same_fact_warnings: [] }));
    return checkThemeCrossSourceRepeat(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#11517: os 2 falsos positivos da 261015 só casavam por palavra genérica", () => {
  // pré-condição: o Stage 1 de fato os sinaliza (jaccard 0.2, piso do sinal)
  const stage1 = detectEventOverlap(
    [{ title: FP1.cand, url: FP1.url }, { title: FP2.cand, url: FP2.url }],
    [{ title: FP1.past, aammdd: "261014" }, { title: FP2.past, aammdd: "261014" }],
  );
  assert.equal(stage1.length, 2);
  assert.ok(stage1.every((m) => Math.round(m.jaccard * 100) / 100 === 0.2));
  assert.equal(contentJaccard(FP1.cand, FP1.past), 0);
  assert.equal(contentJaccard(FP2.cand, FP2.past), 0);
});

test("#11517: gate 4 não sobe os falsos positivos de palavra genérica", () => {
  assert.deepEqual(runCheck([FP1, FP2]), []);
});

test("#11517: caso real 261029 (Siri) continua 🚨 Cortar no gate", () => {
  assert.ok(contentJaccard(SIRI.cand, SIRI.past) >= THEME_CROSS_SOURCE_CUT_MIN_JACCARD);
  const v = runCheck([SIRI, FP1]);
  assert.equal(v.length, 1);
  assert.ok(v[0].message.startsWith("🚨"));
  assert.ok(v[0].message.includes("Cortar no gate"));
  assert.ok(v[0].message.includes(SIRI.url));
});

test("#11517: sobreposição fraca de conteúdo sobe como conferência, sem 🚨 nem Cortar", () => {
  const sim = contentJaccard(AGENTE.cand, AGENTE.past);
  assert.ok(sim >= 0.2 && sim < THEME_CROSS_SOURCE_CUT_MIN_JACCARD, `sim=${sim}`);
  const v = runCheck([AGENTE]);
  assert.equal(v.length, 1);
  assert.equal(v[0].severity, "warning");
  assert.ok(!v[0].message.includes("🚨"));
  assert.ok(!v[0].message.includes("Cortar"));
  assert.ok(v[0].message.includes("Conferir no gate"));
});
