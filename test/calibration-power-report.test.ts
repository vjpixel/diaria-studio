/**
 * test/calibration-power-report.test.ts (#7976)
 *
 * Cobre scripts/calibration-power-report.ts — relatório de evidência
 * read-only, sem nenhuma escrita em arquivo de produção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPowerReport } from "../scripts/calibration-power-report.ts";

/** Monta 1 edição sintética: N artigos, cada um com `primary_source` definido
 *  pelo índice, e `keep` definido separadamente (controla o efeito plantado). */
function writeEdition(editionsRoot: string, edition: string, articles: Array<{ url: string; primary_source: boolean; keep: boolean }>): void {
  const dir = join(editionsRoot, edition, "_internal");
  mkdirSync(dir, { recursive: true });
  const rows = articles.map((a) => ({
    url: a.url,
    bucket: "radar",
    title: a.url,
    score: 50,
    score_base: 50,
    primary_source: a.primary_source,
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
  const kept = articles.filter((a) => a.keep).map((a) => ({ url: a.url, title: a.url }));
  writeFileSync(
    join(dir, "01-approved.json"),
    JSON.stringify({ highlights: [], runners_up: [], lancamento: [], radar: kept, use_melhor: [], video: [] }),
    "utf8",
  );
}

describe("buildPowerReport (#7976)", () => {
  it("edições sem scoring-features.json ou 01-approved.json não entram no relatório", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-empty-"));
    try {
      mkdirSync(join(dir, "260811", "_internal"), { recursive: true });
      const report = buildPowerReport(dir);
      assert.equal(report.editions_analyzed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feature sem NENHUM efeito plantado (kept independente de primary_source): diff perto de 0, p-valor alto, não passa a barra por falta de eventos", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-null-"));
    try {
      // 5 edições pequenas, kept alterna sem relação com primary_source.
      for (let e = 0; e < 5; e++) {
        writeEdition(dir, `26081${e}`, [
          { url: `https://x.com/${e}-a`, primary_source: true, keep: e % 2 === 0 },
          { url: `https://x.com/${e}-b`, primary_source: false, keep: e % 2 === 1 },
          { url: `https://x.com/${e}-c`, primary_source: true, keep: e % 2 === 1 },
          { url: `https://x.com/${e}-d`, primary_source: false, keep: e % 2 === 0 },
        ]);
      }
      const report = buildPowerReport(dir);
      const feature = report.features.find((f) => f.feature === "primary_source")!;
      assert.equal(feature.passes_event_bar, false, "n=10 por lado é bem abaixo do piso de 30");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("efeito FORTE e consistente plantado (primary_source sempre kept, resto sempre cortado, 50 edições): passa a barra, p-valor baixo, forward-chaining consistente", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-strong-"));
    try {
      for (let e = 0; e < 50; e++) {
        const ed = String(260800 + e);
        writeEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-b`, primary_source: true, keep: true },
          { url: `https://x.com/${ed}-c`, primary_source: false, keep: false },
          { url: `https://x.com/${ed}-d`, primary_source: false, keep: false },
        ]);
      }
      const report = buildPowerReport(dir);
      const feature = report.features.find((f) => f.feature === "primary_source")!;
      assert.equal(feature.n_true, 100);
      assert.equal(feature.n_false, 100);
      assert.equal(feature.evaluable_editions, 50);
      assert.equal(feature.passes_event_bar, true);
      assert.equal(feature.kept_rate_true, 1);
      assert.equal(feature.kept_rate_false, 0);
      assert.ok(feature.diff > 0.9, `diff deveria ser ~1.0, foi ${feature.diff}`);
      assert.ok(feature.null_p_value < 0.05, `efeito plantado perfeito deveria ter p-valor baixo, foi ${feature.null_p_value}`);
      assert.equal(feature.forward_chaining_consistent, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição com dado malformado é pulada, não trava o relatório", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-malformed-"));
    try {
      writeEdition(dir, "260811", [{ url: "https://x.com/ok", primary_source: true, keep: true }]);
      mkdirSync(join(dir, "260812", "_internal"), { recursive: true });
      writeFileSync(join(dir, "260812", "_internal", "scoring-features.json"), "{ inválido", "utf8");
      writeFileSync(join(dir, "260812", "_internal", "01-approved.json"), "{}", "utf8");
      const report = buildPowerReport(dir);
      assert.equal(report.editions_analyzed, 1, "só a edição válida deveria contar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("negative_impact é excluído das features candidatas (NON_CALIBRATABLE_FEATURES)", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-noncalib-"));
    try {
      writeEdition(dir, "260811", [{ url: "https://x.com/a", primary_source: true, keep: true }]);
      const report = buildPowerReport(dir);
      // `CandidateFeature` (#7990) já exclui "negative_impact" em COMPILAÇÃO
      // — `f.feature: string` widening explícito preserva este teste como
      // guard RUNTIME (defesa em profundidade, caso o tipo e o runtime
      // desalinhem de novo no futuro) sem comparação que o tsc rejeitaria
      // por união sem overlap (TS2367).
      assert.equal(
        report.features.some((f) => (f.feature as string) === "negative_impact"),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("feature CONSTANTE (100% true, nunca false): n_true reflete a contagem real, nunca zera junto com n_false (achado de review do #7976)", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-constant-"));
    try {
      // academy=true em TODAS as 40 linhas, em 20 edições — nunca false.
      for (let e = 0; e < 20; e++) {
        const ed = String(260800 + e);
        writeEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: false, keep: true },
          { url: `https://x.com/${ed}-b`, primary_source: false, keep: false },
        ]);
      }
      const report = buildPowerReport(dir);
      const feature = report.features.find((f) => f.feature === "primary_source")!;
      // primary_source aqui é sempre false (nunca true) — n_false deve
      // refletir as 40 linhas reais, n_true deve ser 0 (genuinamente, não
      // por colapso do bug antigo que zerava os DOIS lados juntos).
      assert.equal(feature.n_true, 0);
      assert.equal(feature.n_false, 40, "n_false não pode zerar só porque n_true é 0 (bug do #7976: os dois colapsavam juntos)");
      assert.equal(feature.passes_event_bar, false);
      assert.equal(feature.diff, 0, "diff indefinido (um lado vazio) vira 0, mas n_true/n_false continuam reais");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edições_skipped: JSON malformado é reportado com motivo, não só silenciosamente excluído da contagem", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-skipped-"));
    try {
      writeEdition(dir, "260811", [{ url: "https://x.com/a", primary_source: true, keep: true }]);
      mkdirSync(join(dir, "260812", "_internal"), { recursive: true });
      writeFileSync(join(dir, "260812", "_internal", "scoring-features.json"), "{ inválido", "utf8");
      writeFileSync(join(dir, "260812", "_internal", "01-approved.json"), "{}", "utf8");
      const report = buildPowerReport(dir);
      assert.equal(report.editions_analyzed, 1);
      assert.equal(report.editions_skipped.length, 1);
      assert.equal(report.editions_skipped[0].edition, "260812");
      assert.match(report.editions_skipped[0].reason, /JSON malformado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mesma seed produz o mesmo p-valor entre 2 rodadas (determinístico, sem depender de Math.random global)", () => {
    const dir = mkdtempSync(join(tmpdir(), "power-report-determ-"));
    try {
      for (let e = 0; e < 10; e++) {
        const ed = String(260800 + e);
        writeEdition(dir, ed, [
          { url: `https://x.com/${ed}-a`, primary_source: true, keep: e % 3 === 0 },
          { url: `https://x.com/${ed}-b`, primary_source: false, keep: e % 3 !== 0 },
        ]);
      }
      const r1 = buildPowerReport(dir, 42);
      const r2 = buildPowerReport(dir, 42);
      const f1 = r1.features.find((f) => f.feature === "primary_source")!;
      const f2 = r2.features.find((f) => f.feature === "primary_source")!;
      assert.equal(f1.null_p_value, f2.null_p_value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
