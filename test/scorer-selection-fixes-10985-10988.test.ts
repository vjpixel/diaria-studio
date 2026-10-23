/**
 * test/scorer-selection-fixes-10985-10988.test.ts
 *
 * Regressões dos 4 achados do review consolidado diário sobre a seleção de
 * destaques (261023):
 *  - #10985: trio por mérito da política #10795 contava item `same_fact_demoted`.
 *  - #10986: `applyNegativePromotionLimits` (#10936) comparava com runners_up
 *    que nunca poderiam ser destaque (USE MELHOR, placeholder, mesmo fato).
 *  - #10987: `curatePool` cortava item pinado pelo editor e as assinaturas de
 *    fato sem `\b` casavam "framework"/"workspace"/"agentes"/"context".
 *  - #10988: `top3-merit-warning` lia o trio defasado do `tmp-scored` no
 *    Stage 1 e acusava rebaixamentos deliberados/remoções do editor no Stage 4.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoteSameFactHighlights, type PublishedDestaque } from "../scripts/lib/same-fact-demotion.ts";
import { applyNegativePromotionEligibility } from "../scripts/lib/negative-promotion-eligibility.ts";
import { applyNegativePromotionLimits, type AssembledOutput } from "../scripts/assemble-scored.ts";
import { curatePool, isEditorPinned, lowSignalFormat, poolFactAnchors } from "../scripts/lib/pool-quality.ts";
import { isEditorPinned as isEditorPinnedFromCaps } from "../scripts/lib/apply-stage2-caps.ts";
import { checkTop3Merit } from "../scripts/lib/invariant-checks/stage-1.ts";

// ---------------------------------------------------------------------------
// #10985
// ---------------------------------------------------------------------------

type H = {
  rank: number;
  score: number;
  url: string;
  article: { url: string; title: string; summary: string; negative_impact?: boolean };
  same_fact_demoted?: unknown;
  negative_promotion_excluded?: string;
};
function hl(slug: string, title: string, score: number, negative = false): H {
  const url = `https://${slug}.example.com/a`;
  return { rank: 0, score, url, article: { url, title, summary: "", ...(negative ? { negative_impact: true } : {}) } };
}
const ranked = (...hs: H[]) => hs.map((h, i) => ({ ...h, rank: i + 1 }));

describe("#10985 — trio por mérito ignora item rebaixado por mesmo fato", () => {
  it("negativo-processo que sobe a D3 depois do #9100 continua no top-3", () => {
    const a = hl("a", "OpenAI anuncia GPT novo para empresas", 95);
    const b = hl("b", "Nvidia apresenta chip para data centers", 90);
    const c = hl("c", "Google lança busca com agentes", 88);
    const n = hl("n", "Oito estados processam a OpenAI por danos a adolescentes", 85, true);
    const d = hl("d", "Meta abre modelo de linguagem menor", 70);
    // A repete um destaque passado pela MESMA URL → #9100 rebaixa A.
    const past: PublishedDestaque[] = [
      { aammdd: "261020", n: 1, title: "GPT novo para empresas", url: a.url, text: "" },
    ];
    const demoted = demoteSameFactHighlights(ranked(a, b, c, n, d), past);
    const top3 = demoted.highlights
      .slice()
      .sort((x, y) => x.rank - y.rank)
      .slice(0, 3)
      .map((h) => h.article.title);
    assert.deepEqual(top3, [b.article.title, c.article.title, n.article.title]);
    assert.ok(demoted.highlights.find((h) => h.url === a.url)?.same_fact_demoted, "A marcado same_fact_demoted");

    const policy = applyNegativePromotionEligibility(demoted.highlights, []);
    const finalTop = policy.highlights
      .slice()
      .sort((x, y) => x.rank - y.rank)
      .slice(0, 3)
      .map((h) => h.article.title);
    assert.ok(finalTop.includes(n.article.title), `negativo continua no top-3: ${finalTop.join(" | ")}`);
    assert.equal(policy.no_eligible_negative, false);
    assert.equal(policy.actions.filter((x) => x.action === "removido-do-top3").length, 0);
  });

  it("marca no artigo (formato do gate) também conta como rebaixado", () => {
    const a = { ...hl("a2", "OpenAI anuncia GPT novo", 95), article: { ...hl("a2", "OpenAI anuncia GPT novo", 95).article, same_fact_demoted: { evidence: "url" } } };
    const b = hl("b2", "Nvidia apresenta chip", 90);
    const c = hl("c2", "Google lança busca", 88);
    const n = hl("n2", "Empresa é acusada de fraude com IA", 85, true);
    const d = hl("d2", "Meta abre modelo", 70);
    const policy = applyNegativePromotionEligibility(ranked(b, c, n, a as H, d), []);
    assert.equal(policy.actions.length, 0, "N está no trio por mérito entre os elegíveis");
  });

  it("controle: sem rebaixamento, o negativo promovido continua saindo do top-3", () => {
    const a = hl("a3", "OpenAI anuncia GPT novo", 95);
    const b = hl("b3", "Nvidia apresenta chip", 90);
    const n = hl("n3", "Oito estados processam a OpenAI", 60, true);
    const d = hl("d3", "Meta abre modelo", 70);
    const c = hl("c3", "Google lança busca", 88);
    const policy = applyNegativePromotionEligibility(ranked(a, b, n, c, d), []);
    assert.equal(policy.actions[0]?.action, "removido-do-top3");
  });
});

// ---------------------------------------------------------------------------
// #10986
// ---------------------------------------------------------------------------

const ah = (url: string, score: number, extra: Record<string, unknown> = {}, negative = false) => ({
  score,
  ...extra,
  article: { url, title: url, negative_impact: negative },
});

describe("#10986 — applyNegativePromotionLimits compara só com candidatos elegíveis", () => {
  it("runners_up USE MELHOR de score alto não empurram o negativo para D3", () => {
    for (const idx of [0, 1]) {
      const highlights = [ah("d1", 95), ah("other", 70)];
      highlights.splice(idx, 0, ah("negative", 75, {}, true));
      const out: AssembledOutput = {
        highlights: highlights.map((h, i) => ({ ...h, rank: i + 1 })),
        runners_up: [ah("um1", 92, { bucket: "use_melhor" }), ah("um2", 91, { bucket: "use_melhor" })],
        all_scored: [],
      };
      assert.equal(applyNegativePromotionLimits(out), out, `negativo em D${idx + 1} fica onde está`);
    }
  });

  it("placeholder e rebaixado por mesmo fato também ficam fora da comparação", () => {
    const out: AssembledOutput = {
      highlights: [ah("negative", 75, {}, true), ah("d2", 95), ah("d3", 70)].map((h, i) => ({ ...h, rank: i + 1 })),
      runners_up: [
        { score: 93, article: { url: "https://p.example/x", title: "(inbox)" } },
        ah("demoted", 92, { same_fact_demoted: { evidence: "url" } }),
        ah("demoted-art", 91, {}),
      ].map((h, i) => (i === 2 ? { ...h, article: { ...h.article, same_fact_demoted: { evidence: "url" } } } : h)),
      all_scored: [],
    };
    assert.equal(applyNegativePromotionLimits(out), out);
  });

  it("controle: runners_up elegíveis de score alto ainda reordenam o promovido", () => {
    const out: AssembledOutput = {
      highlights: [ah("negative", 75, {}, true), ah("d2", 95), ah("d3", 70)].map((h, i) => ({ ...h, rank: i + 1 })),
      runners_up: [ah("r1", 92, { bucket: "radar" }), ah("r2", 91, { bucket: "lancamento" })],
      all_scored: [],
    };
    const res = applyNegativePromotionLimits(out);
    assert.equal(res.highlights[2].article?.url, "negative");
  });
});

// ---------------------------------------------------------------------------
// #10987
// ---------------------------------------------------------------------------

describe("#10987 — curatePool respeita pinados e assinaturas ancoradas", () => {
  const previous: PublishedDestaque[] = [
    { aammdd: "261018", n: 1, url: "https://old.example/gemini", title: "Gemini at Work: Introducing Gemini agent", text: "" },
  ];

  it("item pinado pelo editor nunca vai para a reserva (mesmo fato, mesma história, formato)", () => {
    for (const pin of [
      { flag: "editor_added" },
      { flag: "editor_submitted" },
      { editor_submitted: true },
      { source: "editor: incluído no gate" },
    ]) {
      const sameStory = { url: "https://new.example/gemini", title: "Gemini está virando copiloto do trabalho dentro dos apps", ...pin };
      const tweet = { url: "https://x.com/someone/status/123", title: "post", ...pin };
      const out = curatePool({ radar: [sameStory, tweet] }, previous);
      assert.equal(out.radar?.length, 2, JSON.stringify(pin));
      assert.equal((out.pool_reserve as unknown[]).length, 0, JSON.stringify(pin));
    }
  });

  it("controle: sem pin, a mesma história ainda vai para a reserva", () => {
    const out = curatePool({ radar: [{ url: "https://new.example/gemini", title: "Gemini está virando copiloto do trabalho dentro dos apps" }] }, previous);
    assert.equal(out.radar?.length, 0);
  });

  it("isEditorPinned é a mesma função nos dois módulos e cobre editor_submitted:true", () => {
    assert.equal(isEditorPinnedFromCaps, isEditorPinned);
    assert.equal(isEditorPinned({ editor_submitted: true }), true);
    assert.equal(lowSignalFormat({ url: "https://x.com/a/status/1", flag: "editor_added" }), null);
  });

  it("assinaturas não casam substring: framework/network/workspace/agentes/context/texto", () => {
    assert.equal(poolFactAnchors("Gemini ganha framework de agentes no Workspace").has("gemini-work-apps"), false);
    assert.equal(poolFactAnchors("Gemini network for Workspace").has("gemini-work-apps"), false);
    assert.equal(poolFactAnchors("Google amplia context window e combate scam").has("android-message-scams"), false);
    assert.equal(poolFactAnchors("Google traduz texto e alerta sobre golpes").has("android-message-scams"), false);
    // Formas legítimas continuam casando.
    assert.equal(poolFactAnchors("Gemini at Work: Introducing Gemini agent").has("gemini-work-apps"), true);
    assert.equal(poolFactAnchors("Google checks text messages for scams").has("android-message-scams"), true);
    assert.equal(poolFactAnchors("Google: Android protege mensagens e combate golpes").has("android-message-scams"), true);
  });

  it("dois itens Gemini Workspace quaisquer não se derrubam", () => {
    const out = curatePool(
      { radar: [{ url: "https://n.example/b", title: "Gemini chega ao Workspace com framework de agentes" }] },
      [{ aammdd: "261019", n: 2, url: "https://o.example/a", title: "Gemini Workspace ganha novo framework para agentes", text: "" }],
    );
    assert.equal(out.radar?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// #10988
// ---------------------------------------------------------------------------

const mh = (id: string, score: number, extra: Record<string, unknown> = {}) => ({
  score,
  bucket: "radar",
  ...extra,
  article: { url: `https://example.com/${id}`, title: id },
});
function edition(run: (dir: string, save: (name: string, data: unknown) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "top3-merit-10988-"));
  mkdirSync(join(dir, "_internal"));
  try {
    run(dir, (name, data) => writeFileSync(join(dir, "_internal", name), JSON.stringify(data)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#10988 — top3-merit-warning lê o trio que o editor vê", () => {
  it("Stage 1: usa o 01-categorized.json pós-rebaixamento, não o tmp-scored defasado", () => edition((dir, save) => {
    // tmp-scored: ordem antes da penalidade de estudo genérico (#9462) —
    // `generic` (70) em D1 deixa `d` (85) de fora, o que leria como falha de
    // mérito num trio que o editor nunca vê.
    save("tmp-scored.json", {
      highlights: [mh("generic", 70), mh("b", 80), mh("c", 78), mh("d", 85)],
      all_scored: [mh("generic", 70), mh("b", 80), mh("c", 78), mh("d", 85)],
    });
    // categorized: a penalidade rebaixou `generic`; `d` subiu ao trio.
    save("01-categorized.json", {
      highlights: [mh("b", 80), mh("c", 78), mh("d", 85), mh("generic", 70, { generic_study_demoted: { signals: [] } })],
    });
    assert.deepEqual(checkTop3Merit(dir), []);
  }));

  it("Stage 1: item de score alto fora do trio, sem marca, ainda avisa", () => edition((dir, save) => {
    save("tmp-scored.json", { highlights: [mh("b", 90)] });
    save("01-categorized.json", { highlights: [mh("b", 80), mh("c", 78), mh("n", 70), mh("research", 92)] });
    const w = checkTop3Merit(dir);
    assert.equal(w.length, 1);
    assert.match(w[0].message, /research/);
    assert.match(w[0].file ?? "", /01-categorized\.json$/);
  }));

  it("Stage 4: ignora negative_promotion_excluded, generic_study_demoted e removidos no gate 1", () => edition((dir, save) => {
    save("tmp-scored.json", {
      highlights: [mh("excluded", 97), mh("generic", 96), mh("removed", 94)],
      all_scored: [mh("excluded", 97), mh("generic", 96), mh("removed", 94)],
    });
    save("01-categorized.json", {
      highlights: [
        mh("a", 85), mh("b", 80), mh("c", 72),
        mh("excluded", 97, { negative_promotion_excluded: "acusacao" }),
        mh("generic", 96, { generic_study_demoted: { signals: [] } }),
      ],
      radar: [mh("removed", 94)],
    });
    save("01-approved.json", { highlights: [mh("a", 85), mh("b", 80), mh("c", 72)], radar: [] });
    assert.deepEqual(checkTop3Merit(dir), []);
  }));

  it("compara URLs canonicalizadas (utm/trailing slash não viram item novo)", () => edition((dir, save) => {
    save("01-approved.json", {
      highlights: [
        { score: 95, article: { url: "https://example.com/top", title: "top" } },
        mh("b", 80),
        mh("c", 72),
      ],
    });
    save("tmp-scored.json", { all_scored: [{ score: 95, article: { url: "https://example.com/top/?utm_source=x", title: "top" } }] });
    assert.deepEqual(checkTop3Merit(dir), []);
  }));
});
