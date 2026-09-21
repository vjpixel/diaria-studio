import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeViralBonus, urlKey, VIRAL_BONUS_CAP, VIRAL_MIN_BASE_SCORE } from "../scripts/lib/viral-score.ts";
import { applyViral, parsePair } from "../scripts/apply-viral-poc.ts";

const NOW = "2026-09-21T18:00:00Z";
const ctx = { newsletterBodies: [] as string[], now: NOW };

describe("computeViralBonus (POC #viral)", () => {
  it("dá bônus a ator de alta atenção + gancho de conflito + recência", () => {
    const r = computeViralBonus(
      { url: "https://x.com/a", title: "Trump says AI hack breached agency", score_base: 60, published_at: "2026-09-21T10:00:00Z" },
      ctx,
    );
    assert.ok(r.bonus >= 8);
    assert.ok(r.signals.some((s) => s.startsWith("actors:")));
    assert.ok(r.signals.some((s) => s.startsWith("hooks:")));
    assert.ok(r.signals.includes("recency:+2"));
  });

  it("não resgata artigo abaixo do piso de qualidade", () => {
    const r = computeViralBonus(
      { url: "https://x.com/a", title: "Trump hack IPO", score_base: VIRAL_MIN_BASE_SCORE - 1 },
      ctx,
    );
    assert.equal(r.bonus, 0);
  });

  it("não se aplica a tutorial/vídeo", () => {
    assert.equal(computeViralBonus({ url: "u", title: "Trump hack", score_base: 80, category: "tutorial" }, ctx).bonus, 0);
  });

  it("respeita o teto", () => {
    const r = computeViralBonus(
      {
        url: "https://x.com/a",
        title: "Trump hack IPO trillion China law",
        score_base: 80,
        published_at: "2026-09-21T17:00:00Z",
      },
      { newsletterBodies: ["x.com/a", "x.com/a", "x.com/a"], now: NOW },
    );
    assert.ok(r.bonus <= VIRAL_BONUS_CAP);
  });

  it("cobertura cruzada conta newsletters que citam a URL (sem query)", () => {
    assert.equal(urlKey("https://www.site.com/p/x/?utm=1#y"), "www.site.com/p/x");
    const r = computeViralBonus(
      { url: "https://www.site.com/p/x?utm=1", title: "neutro", score_base: 60 },
      { newsletterBodies: ["... www.site.com/p/x ...", "outra"], now: NOW },
    );
    assert.ok(r.signals.includes("cross_coverage:+3"));
  });
});

describe("applyViral", () => {
  it("mantém o invariante score == score_base + Σ bonuses e é idempotente", () => {
    const chunk = {
      categorized: {
        radar: [{ url: "https://x.com/a", title: "Trump hack", summary: "", published_at: "2026-09-21T10:00:00Z", category: "noticias" }],
      },
    };
    const scored = () => ({ scored: [{ url: "https://x.com/a", score: 70, score_base: 60, bonuses_applied: ["primary_source:+10"] }] });
    const s = scored();
    applyViral(chunk, s, [], NOW);
    const row = s.scored[0];
    const sum = row.bonuses_applied!.reduce((t, b) => t + Number(b.split(":")[1]), 0);
    assert.equal(row.score, row.score_base! + sum);
    const once = row.score;
    applyViral(chunk, s, [], NOW);
    assert.equal(s.scored[0].score, once);
    assert.equal(s.scored[0].bonuses_applied!.filter((b) => b.startsWith("viral:")).length, 1);
  });
});

describe("regressões do review (#8673)", () => {
  it("política/geopolítica casa com inicial maiúscula (título)", () => {
    const r = computeViralBonus({ url: "https://x.com/a", title: "China Warns On Regulation", score_base: 60 }, ctx);
    assert.ok(r.signals.some((s) => s.startsWith("hooks:")));
  });

  it("sigla UN casa; 'un' minúsculo não", () => {
    const yes = computeViralBonus({ url: "https://x.com/a", title: "UN panel", score_base: 60 }, ctx);
    const no = computeViralBonus({ url: "https://x.com/a", title: "un panel neutro", score_base: 60 }, ctx);
    assert.ok(yes.signals.some((s) => s.startsWith("hooks:")));
    assert.equal(no.signals.length, 0);
  });

  it("cluster_sources não é contado de novo (merge já dá coverageBonus)", () => {
    const r = computeViralBonus({ url: "https://x.com/a", title: "neutro", score_base: 60 }, ctx);
    assert.ok(!r.signals.some((s) => s.startsWith("cross_coverage")));
  });

  it("parsePair aceita path absoluto do Windows e recusa par malformado", () => {
    assert.deepEqual(parsePair(String.raw`C:ain.json|C:ascored.json`), [String.raw`C:ain.json`, String.raw`C:ascored.json`]);
    assert.throws(() => parsePair("so-um-caminho"));
    assert.throws(() => parsePair("a|b|c"));
  });

  it("applyViral usa all_scored quando presente e falha claro sem nenhum", () => {
    const chunk = { categorized: { radar: [{ url: "https://x.com/a", title: "Trump hack", category: "noticias" }] } };
    const file = { all_scored: [{ url: "https://x.com/a", score: 60, score_base: 60 }] };
    applyViral(chunk, file, [], NOW);
    assert.ok(file.all_scored[0].score > 60);
    assert.throws(() => applyViral(chunk, {}, [], NOW), /all_scored/);
  });
});
