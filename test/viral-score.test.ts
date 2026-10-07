import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeViralBonus,
  extractViralSignals,
  mentionsUrl,
  urlKey,
  SCORE_MAX,
  VIRAL_BONUS_CAP,
  VIRAL_MIN_BASE_SCORE,
  VIRAL_SIGNAL_NAMES,
  VIRAL_WEIGHTS,
} from "../scripts/lib/viral-score.ts";
import { NON_CALIBRATABLE_FEATURES } from "../scripts/lib/scoring-features.ts";
import { applyViral, parsePair, summarizeSelectionImpact } from "../scripts/apply-viral-poc.ts";

const NOW = "2026-09-21T18:00:00Z";
const ctx = { newsletterBodies: [] as string[], now: NOW };

describe("computeViralBonus (POC #viral)", () => {
  it("dá bônus a ator de alta atenção + gancho de conflito + recência", () => {
    const r = computeViralBonus(
      { url: "https://news.example.com/a", title: "Trump says AI hack breached agency", score_base: 60, published_at: "2026-09-21T10:00:00Z" },
      ctx,
    );
    assert.ok(r.bonus >= 8);
    assert.ok(r.signals.some((s) => s.startsWith("actors:")));
    assert.ok(r.signals.some((s) => s.startsWith("hooks:")));
    assert.ok(r.signals.includes("recency:+2"));
  });

  it("não resgata artigo abaixo do piso de qualidade", () => {
    const r = computeViralBonus(
      { url: "https://news.example.com/a", title: "Trump hack IPO", score_base: VIRAL_MIN_BASE_SCORE - 1 },
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
        url: "https://news.example.com/a",
        title: "Trump hack IPO trillion China law",
        score_base: 80,
        published_at: "2026-09-21T17:00:00Z",
      },
      { newsletterBodies: ["news.example.com/a", "news.example.com/a", "news.example.com/a"], now: NOW },
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
        radar: [{ url: "https://news.example.com/a", title: "Trump hack", summary: "", published_at: "2026-09-21T10:00:00Z", category: "noticias" }],
      },
    };
    const scored = () => ({ scored: [{ url: "https://news.example.com/a", score: 70, score_base: 60, bonuses_applied: ["primary_source:+10"] }] });
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
    const r = computeViralBonus({ url: "https://news.example.com/a", title: "China Warns On Regulation", score_base: 60 }, ctx);
    assert.ok(r.signals.some((s) => s.startsWith("hooks:")));
  });

  it("sigla UN casa; 'un' minúsculo não", () => {
    const yes = computeViralBonus({ url: "https://news.example.com/a", title: "UN panel", score_base: 60 }, ctx);
    const no = computeViralBonus({ url: "https://news.example.com/a", title: "un panel neutro", score_base: 60 }, ctx);
    assert.ok(yes.signals.some((s) => s.startsWith("hooks:")));
    assert.equal(no.signals.length, 0);
  });

  it("cluster_sources não é contado de novo (merge já dá coverageBonus)", () => {
    const r = computeViralBonus({ url: "https://news.example.com/a", title: "neutro", score_base: 60 }, ctx);
    assert.ok(!r.signals.some((s) => s.startsWith("cross_coverage")));
  });

  it("parsePair aceita path absoluto do Windows e recusa par malformado", () => {
    assert.deepEqual(parsePair(String.raw`C:ain.json|C:ascored.json`), [String.raw`C:ain.json`, String.raw`C:ascored.json`]);
    assert.throws(() => parsePair("so-um-caminho"));
    assert.throws(() => parsePair("a|b|c"));
  });

  it("applyViral usa all_scored quando presente e falha claro sem nenhum", () => {
    const chunk = { categorized: { radar: [{ url: "https://news.example.com/a", title: "Trump hack", category: "noticias" }] } };
    const file = { all_scored: [{ url: "https://news.example.com/a", score: 60, score_base: 60 }] };
    applyViral(chunk, file, [], NOW);
    assert.ok(file.all_scored[0].score > 60);
    assert.throws(() => applyViral(chunk, {}, [], NOW), /all_scored/);
  });
});

describe("guardas e pendências P3 (#8672 item 3)", () => {
  const big = { title: "Trump hack IPO trillion China law", score_base: 80, published_at: "2026-09-21T17:00:00Z" };

  it("post de rede social não ganha bônus (falso positivo do tweet em 260922)", () => {
    const r = computeViralBonus({ url: "https://x.com/S1r1u5_/status/1", ...big }, ctx);
    assert.equal(r.bonus, 0);
    assert.equal(r.skipped, "social_post");
    assert.equal(computeViralBonus({ url: "https://www.linkedin.com/posts/abc", ...big }, ctx).skipped, "social_post");
  });

  it("paywall/anti_bot não ganham bônus", () => {
    for (const v of ["paywall", "anti_bot"]) {
      const r = computeViralBonus({ url: "https://news.example.com/a", ...big, verify_verdict: v }, ctx);
      assert.equal(r.bonus, 0);
      assert.equal(r.skipped, `verdict:${v}`);
    }
    assert.ok(computeViralBonus({ url: "https://news.example.com/a", ...big, verify_verdict: "accessible" }, ctx).bonus > 0);
  });

  it("gancho de dano não conta quando o artigo já é impacto negativo (backstop, não score)", () => {
    const a = { url: "https://news.example.com/a", title: "Deepfake hack hits users", score_base: 60 };
    assert.ok(computeViralBonus(a, ctx).signals.includes("hooks:+4"));
    assert.ok(!computeViralBonus({ ...a, negative_impact: true }, ctx).signals.some((s) => s.startsWith("hooks:")));
  });

  it("nenhum sinal viral é feature não-calibrável do feature store", () => {
    for (const k of VIRAL_SIGNAL_NAMES) assert.ok(!NON_CALIBRATABLE_FEATURES.has(k as never), k);
    assert.deepEqual(Object.keys(VIRAL_WEIGHTS).sort(), [...VIRAL_SIGNAL_NAMES].sort());
  });

  it("teto: sinais reconciliam com o bônus gravado e o score não passa de 100", () => {
    const nl = { newsletterBodies: ["news.example.com/a", "news.example.com/a"], now: NOW };
    const r = computeViralBonus({ url: "https://news.example.com/a", ...big }, nl);
    assert.equal(r.bonus, VIRAL_BONUS_CAP);
    const sum = r.signals.reduce((t, s) => t + Number(s.split(":")[1]), 0);
    assert.equal(sum, r.bonus);
    const near = computeViralBonus({ url: "https://news.example.com/a", ...big, score_current: 96 }, nl);
    assert.equal(near.bonus, SCORE_MAX - 96);
    assert.ok(near.signals.some((s) => s.startsWith("cap:-")));
  });

  it("menção de URL não casa por prefixo de outra URL", () => {
    assert.ok(mentionsUrl("veja https://site.com/p/x hoje", "site.com/p/x"));
    assert.ok(mentionsUrl("(https://site.com/p/x/)", "site.com/p/x"));
    assert.ok(mentionsUrl("leia site.com/p/x.", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/xyz", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/x/outra", "site.com/p/x"));
    assert.ok(!mentionsUrl("https://site.com/p/x.html", "site.com/p/x"));
  });

  it("a newsletter de origem não conta como menção", () => {
    const nl = { newsletterBodies: ["https://news.example.com/a", "https://news.example.com/a"], now: NOW };
    const a = { url: "https://news.example.com/a", title: "neutro" };
    assert.equal(extractViralSignals(a, nl).newsletter_mentions, 2);
    assert.equal(extractViralSignals({ ...a, from_newsletter: true }, nl).newsletter_mentions, 1);
  });

  it("falsos positivos lexicais em PT: meta/processo/lei genéricos não casam", () => {
    const s = extractViralSignals({ url: "u", title: "Bater a meta com o processo seletivo e a lei do menor esforço" }, ctx);
    assert.equal(s.big_company, false);
    assert.equal(s.conflict_harm, false);
    assert.equal(s.policy_geo, false);
    const t = extractViralSignals({ url: "u", title: "Meta é processada; projeto de lei avança" }, ctx);
    assert.equal(t.big_company, true);
    assert.equal(t.conflict_harm, true);
    assert.equal(t.policy_geo, true);
  });
});

describe("summarizeSelectionImpact (#8672 item 5)", () => {
  const row = (url: string, score_before: number, bonus: number) => ({ url, title: url, score_before, bonus, signals: [], skipped: null });

  it("registra quem entrou e quem saiu do top-N por causa do bônus", () => {
    const audit = [row("a", 90, 0), row("b", 80, 0), row("c", 70, 15)];
    const ch = summarizeSelectionImpact(audit, 2);
    assert.deepEqual(
      ch.map((c) => [c.url, c.change, c.rank_before, c.rank_after]),
      [
        ["c", "entered_top_n", 3, 2],
        ["b", "left_top_n", 2, 3],
      ],
    );
  });

  it("sem cruzamento da linha, lista vazia", () => {
    assert.deepEqual(summarizeSelectionImpact([row("a", 90, 2), row("b", 50, 5)], 1), []);
  });
});
