/**
 * test/calibration-power-report-track-a.test.ts (#7980)
 *
 * Cobre scripts/calibration-power-report-track-a.ts — relatório de
 * evidência do Track A: população restrita aos eventos `track_a`
 * (finalistas do LLM aprovados/rejeitados), barra de evidência mais alta
 * que Track B (mesmos pisos de evento/edição + gate DURO de ≥2 janelas
 * de validação consistentes), e diagnóstico de
 * `editor_promoted_outside_llm_finalists` fora do teste estatístico.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTrackAPowerReport } from "../scripts/calibration-power-report-track-a.ts";

interface HighlightSpec {
  url: string;
  primary_source?: boolean;
  approved: boolean; // aparece em approved.highlights?
}

/** Escreve 1 edição sintética: N candidatos, TODOS escolhidos pelo LLM (categorized.highlights) — só uma parte aprovada pelo editor (approved.highlights). */
function writeTrackAEdition(editionsRoot: string, edition: string, items: HighlightSpec[]): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });

  const categorized = { highlights: items.map((i) => ({ article: { url: i.url, title: i.url } })) };
  const approved = { highlights: items.filter((i) => i.approved).map((i) => ({ article: { url: i.url, title: i.url } })) };
  writeFileSync(join(dir, "01-categorized.json"), JSON.stringify(categorized), "utf8");
  writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved), "utf8");

  const rows = items.map((i) => ({
    url: i.url,
    bucket: "highlights",
    title: i.url,
    score: 50,
    score_base: 50,
    primary_source: i.primary_source ?? false,
    hands_on: false,
    academy: false,
    howto_br: false,
    howto_br_source: false,
    cluster_sources_count: 0,
    negative_impact: false,
    category: "noticias",
    origin: "cadastrada",
    recency_hours: 10,
    domain: "example.com",
    title_char_count: 10,
    has_official_link: false,
    novelty_vs_past_editions: null,
    source_reputation_ctr_30d: null,
    source_reputation_ctr_90d: null,
    feature_available_since: new Date(0).toISOString(),
    launch_heuristics_sha: null,
  }));
  writeFileSync(join(dir, "scoring-features.json"), JSON.stringify({ edition, row_count: rows.length, rows }), "utf8");
}

describe("buildTrackAPowerReport (#7980)", () => {
  it("efeito forte e consistente nas 3 janelas (60 edições): passa o gate de evento/edição E o de janelas", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-a-strong-"));
    try {
      for (let e = 0; e < 60; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: true },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: false },
        ]);
      }
      const report = buildTrackAPowerReport(dir);
      const f = report.features.find((x) => x.feature === "primary_source")!;
      assert.equal(f.n_true, 60);
      assert.equal(f.n_false, 60);
      assert.equal(f.evaluable_editions, 60);
      assert.equal(f.passes_event_bar, true);
      assert.equal(f.consistent_windows >= 2, true);
      assert.equal(f.passes_window_bar, true);
      assert.equal(f.passes_evidence_bar_track_a, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sinal se INVERTE na 2ª metade do corpus: passa o piso de evento/edição mas FALHA o gate de janelas (Track A é mais estrito que Track B aqui)", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-a-flip-"));
    try {
      // 1ª metade (30 edições): primary_source ajuda (true→aprovado, false→rejeitado).
      for (let e = 0; e < 30; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: true },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: false },
        ]);
      }
      // 2ª metade (30 edições): efeito INVERTIDO (true→rejeitado, false→aprovado).
      for (let e = 30; e < 60; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: false },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: true },
        ]);
      }
      const report = buildTrackAPowerReport(dir);
      const f = report.features.find((x) => x.feature === "primary_source")!;
      assert.equal(f.n_true, 60);
      assert.equal(f.n_false, 60);
      assert.equal(f.evaluable_editions, 60);
      assert.equal(f.passes_event_bar, true, "conta de evento/edição por si só já passaria (é o piso de Track B)");
      assert.equal(f.passes_window_bar, false, "janelas 1 e 3 têm sinal oposto — nunca 2 concordam");
      assert.equal(f.passes_evidence_bar_track_a, false, "Track A exige os dois gates JUNTOS — este é o cenário que só o Track A pega");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("achado de review do #7980 (P2, média confiança): janela FINA (poucos eventos de 1 lado) concordando por acaso NÃO conta pro gate de consistência", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-a-thin-window-"));
    try {
      // Janela 1 (eds 0-19): efeito forte, sinal POSITIVO, bem povoada (20/20).
      for (let e = 0; e < 20; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: true },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: false },
        ]);
      }
      // Janela 2 (eds 20-39): 20 edições com item "a" (primary_source=true),
      // mas só 3 delas TAMBÉM têm um item "b" (primary_source=false) — as
      // outras 17 não têm nenhum candidato com a feature ausente. Essas 3
      // "concordam" com o sinal positivo da janela 1 por puro acaso, sobre
      // uma amostra de n=3 do lado false.
      for (let e = 20; e < 40; e++) {
        const ed = String(260800 + e);
        const items = [{ url: `https://x.com/${ed}-a`, primary_source: true, approved: true }];
        if (e < 23) items.push({ url: `https://x.com/${ed}-b`, primary_source: false, approved: false });
        writeTrackAEdition(dir, ed, items);
      }
      // Janela 3 (eds 40-59): efeito forte, sinal INVERTIDO, bem povoada (20/20).
      for (let e = 40; e < 60; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: false },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: true },
        ]);
      }
      const report = buildTrackAPowerReport(dir);
      const f = report.features.find((x) => x.feature === "primary_source")!;
      assert.equal(f.n_true, 60);
      assert.equal(f.n_false, 43, "20(janela1) + 3(janela2, finos) + 20(janela3)");
      assert.equal(f.passes_event_bar, true, "conta agregada ainda passa o piso de evento/edição");
      // Sem o piso MIN_WINDOW_EVENTS_PER_SIDE, a janela 2 (n=3 do lado false)
      // "concordaria" com a janela 1 e passaria passes_window_bar
      // incorretamente (2 de 3 concordando por amostra fina) — com o piso,
      // a janela 2 é excluída (nFalse=3 < mínimo), sobram só janela1(+) e
      // janela3(-), que discordam — nunca 2 concordam de verdade.
      assert.equal(f.window_diffs[1], null, "janela 2 deveria ser excluída por amostra fina (nFalse=3)");
      assert.equal(f.passes_window_bar, false);
      assert.equal(f.passes_evidence_bar_track_a, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("n abaixo do piso (poucas edições): não passa nem o gate de evento/edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-a-thin-"));
    try {
      for (let e = 0; e < 5; e++) {
        const ed = String(260800 + e);
        writeTrackAEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, approved: true },
          { url: `https://x.com/${ed}-b`, primary_source: false, approved: false },
        ]);
      }
      const report = buildTrackAPowerReport(dir);
      const f = report.features.find((x) => x.feature === "primary_source")!;
      assert.equal(f.passes_event_bar, false);
      assert.equal(f.passes_evidence_bar_track_a, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("editor_promoted_outside_llm_finalists é diagnóstico — conta separado, nunca entra no n_true/n_false do teste estatístico", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-a-promoted-"));
    try {
      for (let e = 0; e < 45; e++) {
        const ed = String(260800 + e);
        const dir_ = join(dir, ed, "_internal");
        mkdirSync(dir_, { recursive: true });
        // O LLM escolheu só "a" e "b" (highlights) — "c" é promovido pelo
        // editor de FORA dos finalistas do LLM (só aparece em approved).
        writeFileSync(
          join(dir_, "01-categorized.json"),
          JSON.stringify({ highlights: [{ article: { url: `https://x.com/${ed}-a`, title: "a" } }, { article: { url: `https://x.com/${ed}-b`, title: "b" } }], radar: [{ url: `https://x.com/${ed}-c`, title: "c" }] }),
          "utf8",
        );
        writeFileSync(
          join(dir_, "01-approved.json"),
          JSON.stringify({ highlights: [{ article: { url: `https://x.com/${ed}-a`, title: "a" } }, { article: { url: `https://x.com/${ed}-c`, title: "c" } }] }),
          "utf8",
        );
        const rows = [
          { url: `https://x.com/${ed}-a`, primary_source: true },
          { url: `https://x.com/${ed}-b`, primary_source: false },
          { url: `https://x.com/${ed}-c`, primary_source: true },
        ].map((r) => ({
          url: r.url,
          bucket: "highlights",
          title: r.url,
          score: 50,
          score_base: 50,
          primary_source: r.primary_source,
          hands_on: false,
          academy: false,
          howto_br: false,
          howto_br_source: false,
          cluster_sources_count: 0,
          negative_impact: false,
          category: "noticias",
          origin: "cadastrada",
          recency_hours: 10,
          domain: "example.com",
          title_char_count: 10,
          has_official_link: false,
          novelty_vs_past_editions: null,
          source_reputation_ctr_30d: null,
          source_reputation_ctr_90d: null,
          feature_available_since: new Date(0).toISOString(),
          launch_heuristics_sha: null,
        }));
        writeFileSync(join(dir_, "scoring-features.json"), JSON.stringify({ edition: ed, row_count: rows.length, rows }), "utf8");
      }
      const report = buildTrackAPowerReport(dir);
      assert.equal(report.promoted_outside_total, 45, "1 evento promovido por edição, 45 edições");
      const f = report.features.find((x) => x.feature === "primary_source")!;
      assert.equal(f.promoted_outside_count, 45, "todos os 'c' promovidos têm primary_source=true");
      assert.equal(f.n_true, 45, "só 'a' (primary_source=true, escolhido pelo LLM) conta — 'c' NUNCA entra no teste estatístico");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
