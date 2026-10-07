/**
 * #8672 item 1 — calibração dos sinais viral contra CTR sobre entregues.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aammddBrt,
  buildEditionRows,
  decide,
  demeanWithinCells,
  fitOls,
  groupClicksByEdition,
  indexApproved,
  parseNewsletterLinks,
  runCalibration,
  sectionSlug,
  withinCellConcordance,
  mulberry32,
  type DatasetRow,
  type ModelResult,
} from "../scripts/calibrate-viral-score.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";

const MD = [
  "**DESTAQUE 1 | 🛡️ SEGURANÇA**",
  "",
  "**[ONU alerta](https://news.un.org/story/1)**  ",
  "Texto com [link de corpo](https://corpo.example.com/x).",
  "",
  "**DESTAQUE 2 | 🚀 LANÇAMENTO**",
  "**[Googlebook](https://blog.google/googlebook/?utm_source=x)**",
  "",
  "**📡 RADAR**",
  "**[Radar 1](https://a.example.com/r1)**",
  "**[Radar 2](https://a.example.com/r2)**",
  "**[ONU de novo](https://news.un.org/story/1)**",
  "**É IA?**",
].join("\n");

describe("parseNewsletterLinks / sectionSlug", () => {
  it("extrai só manchetes, com seção e posição", () => {
    const links = parseNewsletterLinks(MD);
    assert.deepEqual(
      links.map((l) => [l.section, l.position, l.url]),
      [
        ["destaque", 1, "https://news.un.org/story/1"],
        ["destaque", 2, "https://blog.google/googlebook/?utm_source=x"],
        ["radar", 1, "https://a.example.com/r1"],
        ["radar", 2, "https://a.example.com/r2"],
        ["radar", 3, "https://news.un.org/story/1"],
      ],
    );
  });

  it("normaliza cabeçalhos antigos e novos", () => {
    assert.equal(sectionSlug("DESTAQUE 3 | 💼 MERCADO"), "destaque");
    assert.equal(sectionSlug("📰 OUTRAS NOTÍCIAS"), "outras_noticias");
    assert.equal(sectionSlug("🛠️ USE MELHOR"), "use_melhor");
    assert.equal(sectionSlug("🚀 LANÇAMENTOS"), "lancamentos");
  });
});

describe("aammddBrt", () => {
  it("usa o dia em BRT (UTC-3), não UTC", () => {
    // 2026-09-22T02:00Z = 21/09 23h BRT
    assert.equal(aammddBrt(Date.parse("2026-09-22T02:00:00Z") / 1000), "260921");
    assert.equal(aammddBrt(Date.parse("2026-09-22T09:00:00Z") / 1000), "260922");
  });
});

function post(over: Partial<UnifiedCachedPost> & { delivered?: number; clicks?: [string, number][] }): UnifiedCachedPost {
  return {
    origin: "kit",
    status: "confirmed",
    publish_date: Date.parse("2026-09-22T09:00:00Z") / 1000,
    stats: {
      email: { recipients: over.delivered ?? 500 },
      clicks: over.clicks?.map(([url, n]) => ({ url, email: { unique_clicks: n, unique_verified_clicks: n, verified_clicks: n } })),
    },
    ...over,
  } as UnifiedCachedPost;
}

describe("groupClicksByEdition", () => {
  it("soma Beehiiv + Kit do mesmo dia por URL canônica", () => {
    const g = groupClicksByEdition([
      post({ clicks: [["https://a.example.com/r1?utm_source=newsletter", 3]] }),
      post({ origin: "beehiiv", delivered: 200, clicks: [["https://a.example.com/r1", 2]] }),
    ]);
    const e = g.get("260922")!;
    assert.equal(e.delivered, 700);
    assert.equal(e.sends, 2);
    assert.equal(e.clicks.get("https://a.example.com/r1"), 5);
  });

  it("descarta teste (poucos destinatários), não publicado, sem cliques buscados e zero-clique total", () => {
    const g = groupClicksByEdition([
      post({ delivered: 1, clicks: [["https://a.example.com/r1", 1]] }),
      post({ status: "draft", clicks: [["https://a.example.com/r1", 1]] }),
      post({}),
      post({ clicks: [["https://a.example.com/r1", 0]] }),
    ]);
    assert.equal(g.size, 0);
  });
});

describe("buildEditionRows", () => {
  const approved = {
    highlights: [
      {
        score: 84,
        article: {
          url: "https://news.un.org/story/1",
          title: "UN panel warns of AI agents loss of control",
          score_base: 70,
          bonuses_applied: ["primary_source:+2", "viral:+12"],
          published_at: "2026-09-21T10:00:00Z",
        },
      },
    ],
    lancamento: [{ url: "https://blog.google/googlebook", title: "Googlebook", score: 80, score_base: 70, bonuses_applied: ["primary_source:+10"] }],
    radar: [{ url: "https://a.example.com/r1", title: "Trump hack", score: 60, score_base: 60 }],
  };

  it("junta link publicado ↔ artigo aprovado ↔ cliques, sem o viral: do POC no score atual", () => {
    const clicks = { delivered: 1000, sends: 1, clicks: new Map([["https://news.un.org/story/1", 9]]) };
    const stats = { links: 0, unmatched_links: 0 };
    const rows = buildEditionRows({ edition: "260922", reviewedMd: MD, approved, newsletterBodies: null }, clicks, stats);
    assert.equal(stats.links, 4); // a 2ª ocorrência da URL da ONU não conta de novo
    assert.equal(stats.unmatched_links, 1); // r2 não está no approved
    const onu = rows.find((r) => r.url === "https://news.un.org/story/1")!;
    assert.equal(onu.score_current, 72);
    assert.deepEqual(onu.bonuses, ["primary_source:+2"]);
    assert.equal(onu.clicks, 9);
    assert.ok(Math.abs(onu.y - Math.log(9.5 / 1000)) < 1e-12);
    assert.equal(onu.signals.policy_geo, true);
    assert.equal(onu.has_inbox, false);
    const g = rows.find((r) => r.url === "https://blog.google/googlebook")!;
    assert.equal(g.clicks, 0); // ausente da lista de cliques = zero
  });

  it("indexApproved aceita {article, score} e artigo direto", () => {
    const idx = indexApproved(approved);
    assert.equal(idx.get("https://news.un.org/story/1")?.score, 84);
    assert.equal(idx.get("https://blog.google/googlebook")?.score_base, 70);
  });
});

describe("estimação dentro da célula", () => {
  it("fitOls recupera coeficientes conhecidos", () => {
    const rnd = mulberry32(1);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = rnd() - 0.5;
      const b = rnd() - 0.5;
      X.push([a, b]);
      y.push(2 * a - 1 * b + (rnd() - 0.5) * 0.01);
    }
    const [ba, bb] = fitOls(X, y);
    assert.ok(Math.abs(ba - 2) < 0.02, String(ba));
    assert.ok(Math.abs(bb + 1) < 0.02, String(bb));
  });

  it("demean remove o efeito fixo da célula e descarta célula de 1 linha", () => {
    const mk = (edition: string, y: number, score: number): DatasetRow =>
      ({ edition, section: "radar", position: 1, y, score_current: score } as DatasetRow);
    const d = demeanWithinCells([mk("e1", 10, 1), mk("e1", 12, 3), mk("e2", 5, 9)], [(r) => r.score_current]);
    assert.deepEqual(d.y, [-1, 1]);
    assert.deepEqual(d.X, [[-1], [1]]);
  });

  it("concordância conta só pares da mesma célula", () => {
    const r = withinCellConcordance([1, 2, 5, 0], [0.1, 0.2, 0.0, 9], ["a", "a", "b", "b"]);
    assert.equal(r.pairs, 2);
    assert.equal(r.concordance, 0.5);
  });
});

/** Dataset sintético: CTR depende de posição e, opcionalmente, de `people_gov`. */
function synthetic(effect: number): DatasetRow[] {
  const rnd = mulberry32(42);
  const rows: DatasetRow[] = [];
  for (let e = 0; e < 60; e++) {
    const edition = `26${String(1000 + e)}`;
    for (let p = 1; p <= 8; p++) {
      const people = rnd() < 0.4;
      const y = -0.3 * Math.log(p) + effect * (people ? 1 : 0) + (rnd() - 0.5) * 0.4;
      rows.push({
        edition,
        section: "radar",
        position: p,
        url: `u${e}-${p}`,
        clicks: 0,
        delivered: 500,
        y,
        score_current: 50 + Math.floor(rnd() * 30),
        score_base: 50,
        bonuses: [],
        signals: {
          people_gov: people,
          big_company: false,
          conflict_harm: false,
          money_scale: false,
          policy_geo: false,
          newsletter_mentions: 0,
          recent_36h: false,
        },
        viral_poc_points: people ? 3 : 0,
        viral_guard: null,
        has_inbox: true,
      });
    }
  }
  return rows;
}

describe("runCalibration / decide", () => {
  it("sinal plantado com efeito real → viral_predicts", () => {
    const res = runCalibration(synthetic(0.5), { holdoutFrac: 0.3, bootstrap: 60, seed: 1 });
    assert.equal(res.verdict.viral_predicts, true, res.verdict.reasons.join(" | "));
    const B = res.models.find((m) => m.name.startsWith("B "))!;
    assert.ok(B.coefficients["viral:people_gov"] > 0.4);
  });

  it("sinal sem efeito → não prevê (regra de descarte)", () => {
    const res = runCalibration(synthetic(0), { holdoutFrac: 0.3, bootstrap: 60, seed: 1 });
    assert.equal(res.verdict.viral_predicts, false);
  });

  it("coeficiente negativo robusto não conta como prever", () => {
    const m = (name: string, conc: number, coef = 0, ci: [number, number] = [0, 0]): ModelResult => ({
      name,
      features: ["viral:x"],
      coefficients: { "viral:x": coef },
      ci95: { "viral:x": ci },
      holdout_concordance: conc,
      holdout_pairs: 100,
      holdout_r2: 0,
      train_rows: 1,
      holdout_rows: 1,
    });
    const v = decide([m("A score", 0.5), m("B score+viral", 0.6, -0.3, [-0.5, -0.1])]);
    assert.equal(v.viral_predicts, false);
  });
});
