/**
 * #8672 item 1 — calibração dos sinais viral contra CTR sobre entregues.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aammddBrt,
  absentIsZero,
  assignSends,
  buildEditionRows,
  cellKey,
  combineSends,
  decide,
  demeanWithinCells,
  editionHintFromUrls,
  fitOls,
  indexApproved,
  inestimableFeatures,
  loadDataset,
  MIN_CONCORDANCE_GAIN,
  parseCliOptions,
  parseNewsletterLinks,
  pocBonusPoints,
  readJson,
  runCalibration,
  sectionSlug,
  signalFeature,
  toSend,
  withinCellConcordance,
  mulberry32,
  type DatasetRow,
  type ModelResult,
  type Send,
} from "../scripts/calibrate-viral-score.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";

const MD = [
  "**DESTAQUE 1 | 🛡️ SEGURANÇA**",
  "",
  "**[ONU alerta](https://news.un.org/story/1)**  ",
  "Texto com [link de corpo](https://corpo.example.com/x).",
  "**[Leia também, em negrito](https://outro.example.com/y)**",
  "",
  "**DESTAQUE 2 | 🚀 LANÇAMENTO**",
  "**[Googlebook](https://blog.google/googlebook/?utm_source=x)**",
  "",
  "**📡 RADAR**",
  "**[Radar 1](https://a.example.com/r1)**",
  "**[Radar 2](https://a.example.com/r2)**",
  "**[Repetida](https://a.example.com/dup)**",
  "**[Repetida de novo](https://a.example.com/dup)**",
  "**É IA?**",
].join("\n");

describe("parseNewsletterLinks / sectionSlug", () => {
  it("extrai só manchetes, com seção e posição — 1 por bloco DESTAQUE", () => {
    const links = parseNewsletterLinks(MD);
    assert.deepEqual(
      links.map((l) => [l.section, l.position, l.url]),
      [
        ["destaque", 1, "https://news.un.org/story/1"],
        ["destaque", 2, "https://blog.google/googlebook/?utm_source=x"],
        ["radar", 1, "https://a.example.com/r1"],
        ["radar", 2, "https://a.example.com/r2"],
        ["radar", 3, "https://a.example.com/dup"],
        ["radar", 4, "https://a.example.com/dup"],
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
  const { delivered, clicks, ...rest } = over;
  return {
    origin: "kit",
    status: "confirmed",
    publish_date: Date.parse("2026-09-22T09:00:00Z") / 1000,
    stats: {
      email: { recipients: delivered ?? 500 },
      clicks: clicks?.map(([url, n]) => ({ url, email: { unique_clicks: n, unique_verified_clicks: n, verified_clicks: n } })),
    },
    ...rest,
  } as UnifiedCachedPost;
}

function sendOf(p: UnifiedCachedPost, id = "s"): Send {
  const s = toSend(p, id);
  assert.equal(typeof s, "object", `envio descartado: ${String(s)}`);
  return s as Send;
}

describe("toSend / editionHintFromUrls", () => {
  it("descarta envio pequeno (teste ou variante), não publicado, sem cliques buscados e zero-clique total", () => {
    assert.equal(toSend(post({ delivered: 1, clicks: [["https://a.example.com/r1", 1]] }), "a"), "small_send");
    assert.equal(toSend(post({ status: "draft", clicks: [["https://a.example.com/r1", 1]] }), "b"), "not_confirmed");
    assert.equal(toSend(post({}), "c"), "no_click_data");
    assert.equal(toSend(post({ clicks: [["https://a.example.com/r1", 0]] }), "d"), "all_zero_clicks");
  });

  it("canoniza URL de clique, guarda a data BRT e o hint do poll", () => {
    const s = sendOf(
      post({
        clicks: [
          ["https://a.example.com/r1?utm_source=newsletter", 3],
          ["https://poll.diar.ia.br/vote?edition=260922&choice=A", 1],
        ],
      }),
    );
    assert.equal(s.clicks.get("https://a.example.com/r1"), 3);
    assert.equal(s.date, "260922");
    assert.equal(s.editionHint, "260922");
    assert.equal(editionHintFromUrls(["https://x/?edition=260922", "https://x/?edition=260923"]), null);
    assert.equal(editionHintFromUrls(["https://x/?edition=abc", "nao-e-url"]), null);
  });
});

describe("assignSends", () => {
  const links = new Map([
    ["260921", new Set(["https://a.example.com/old1", "https://a.example.com/old2"])],
    ["260922", new Set(["https://a.example.com/r1", "https://a.example.com/r2", "https://a.example.com/r3"])],
  ]);

  it("usa o hint do poll quando a edição existe e há overlap", () => {
    const s = sendOf(post({ clicks: [["https://a.example.com/old1", 1], ["https://p/?edition=260921", 1]] }));
    const a = assignSends([s], links);
    assert.equal(a.byEdition.get("260921")?.[0].method, "poll_hint");
  });

  it("sem hint, atribui pelo maior overlap — não pela data", () => {
    // publish_date diz 260922, mas as URLs são da 260921
    const s = sendOf(post({ clicks: [["https://a.example.com/old1", 2], ["https://a.example.com/old2", 1]] }));
    const a = assignSends([s], links);
    assert.equal(a.byEdition.get("260921")?.[0].method, "overlap");
    assert.equal(a.byEdition.has("260922"), false);
  });

  it("cache de fixture (URLs que não casam com edição nenhuma) fica sem atribuição", () => {
    const s = sendOf(post({ origin: "beehiiv", clicks: [["https://example0.com/a", 5], ["https://example1.com/b", 2]] }));
    const a = assignSends([s], links);
    assert.equal(a.unassigned, 1);
    assert.equal(a.byEdition.size, 0);
  });

  it("empate de overlap desempata pela data; sem desempate é ambíguo", () => {
    const tie = new Map([
      ["260921", new Set(["https://a.example.com/x", "https://a.example.com/y"])],
      ["260922", new Set(["https://a.example.com/x", "https://a.example.com/y"])],
    ]);
    const s = sendOf(post({ clicks: [["https://a.example.com/x", 1], ["https://a.example.com/y", 1]] }));
    assert.ok(assignSends([s], tie).byEdition.has("260922"));
    const other = sendOf(post({ publish_date: Date.parse("2026-09-25T09:00:00Z") / 1000, clicks: [["https://a.example.com/x", 1], ["https://a.example.com/y", 1]] }));
    assert.equal(assignSends([other], tie).ambiguous, 1);
  });
});

describe("combineSends — ausente na lista ≠ zero (por origem)", () => {
  const urls = ["https://a.example.com/r1", "https://a.example.com/r2"];

  it("Kit: ausente = sem dado; presente com 0 = zero medido", () => {
    const k = sendOf(post({ clicks: [["https://a.example.com/r1", 3], ["https://a.example.com/r9", 0]] }));
    const c = combineSends([k], [...urls, "https://a.example.com/r9"]);
    assert.equal(c.clicks.get("https://a.example.com/r1"), 3);
    assert.equal(c.clicks.has("https://a.example.com/r2"), false);
    assert.equal(c.clicks.get("https://a.example.com/r9"), 0);
  });

  it("Beehiiv: lista só traz link clicado, então ausente = zero — salvo em modo estrito", () => {
    const b = sendOf(post({ origin: "beehiiv", clicks: [["https://a.example.com/r1", 2]] }));
    assert.equal(absentIsZero(b, false), true);
    assert.equal(combineSends([b], urls).clicks.get("https://a.example.com/r2"), 0);
    assert.equal(combineSends([b], urls, true).clicks.has("https://a.example.com/r2"), false);
  });

  it("Beehiiv + Kit somam; link sem dado no Kit fica sem dado na edição", () => {
    const b = sendOf(post({ origin: "beehiiv", delivered: 200, clicks: [["https://a.example.com/r1", 2]] }), "b");
    const k = sendOf(post({ clicks: [["https://a.example.com/r1", 3]] }), "k");
    const c = combineSends([b, k], urls);
    assert.equal(c.delivered, 700);
    assert.equal(c.sends, 2);
    assert.equal(c.clicks.get("https://a.example.com/r1"), 5);
    assert.equal(c.clicks.has("https://a.example.com/r2"), false);
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
    radar: [
      { url: "https://a.example.com/r1", title: "Trump hack" },
      { url: "https://a.example.com/dup", title: "Repetida", score: 60, score_base: 60 },
    ],
  };

  it("junta link publicado ↔ artigo aprovado ↔ cliques e conta cada descarte", () => {
    const clicks = {
      delivered: 1000,
      sends: 1,
      clicks: new Map([
        ["https://news.un.org/story/1", 9],
        ["https://a.example.com/dup", 7],
        ["https://a.example.com/r1", 4],
      ]),
    };
    const b = buildEditionRows({ edition: "260922", reviewedMd: MD, approved, newsletterBodies: null }, clicks);
    assert.equal(b.counts.links, 6);
    assert.equal(b.counts.unmatched_links, 1); // r2 não está no approved
    assert.equal(b.counts.duplicate_links, 2); // URL publicada 2x: clique não atribuível
    assert.equal(b.counts.links_without_click_data, 1); // googlebook sem dado — NÃO vira zero
    assert.equal(b.counts.rows_missing_score, 1); // r1 sem score nem score_base
    assert.equal(b.rows.length, 1);
    assert.equal(b.coverage, 2 / 3); // casados: onu, googlebook, r1; com dado: onu, r1
    const onu = b.rows[0];
    assert.equal(onu.score_current, 72);
    assert.deepEqual(onu.bonuses, ["primary_source:+2"]);
    assert.equal(onu.clicks, 9);
    assert.ok(Math.abs(onu.y - Math.log(9.5 / 1000)) < 1e-12);
    assert.equal(onu.signals.policy_geo, true);
    assert.equal(onu.has_inbox, false);
  });

  it("aceita manchete no formato antigo [**título**](url)", () => {
    const md = "**DESTAQUE 1 | X**\n[**ONU alerta**](https://news.un.org/story/1)\n**📡 RADAR**\n[**R1**](https://a.example.com/r1)";
    assert.deepEqual(
      parseNewsletterLinks(md).map((l) => [l.section, l.url]),
      [
        ["destaque", "https://news.un.org/story/1"],
        ["radar", "https://a.example.com/r1"],
      ],
    );
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
    assert.ok((B.coefficients["viral:people_gov"] ?? 0) > 0.4);
  });

  it("sinal sem efeito → não prevê (regra de descarte)", () => {
    const res = runCalibration(synthetic(0), { holdoutFrac: 0.3, bootstrap: 60, seed: 1 });
    assert.equal(res.verdict.viral_predicts, false);
  });

  it("coeficiente negativo robusto não conta como prever", () => {
    const m = (name: string, conc: number, coef = 0, ci: [number, number] = [0, 0]): ModelResult => ({
      name,
      features: ["viral:x"],
      inestimable: [],
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
    // limiar de ganho: exatamente 1 p.p. passa, abaixo não
    assert.equal(MIN_CONCORDANCE_GAIN, 0.01);
    assert.equal(decide([m("A score", 0.5), m("B score+viral", 0.5 + MIN_CONCORDANCE_GAIN, 0.3, [0.1, 0.5])]).viral_predicts, true);
    assert.equal(decide([m("A score", 0.5), m("B score+viral", 0.5 + MIN_CONCORDANCE_GAIN - 0.001, 0.3, [0.1, 0.5])]).viral_predicts, false);
    // inestimável: coeficiente/IC null não conta como sinal e aparece nas razões
    const inest: ModelResult = { ...m("B score+viral", 0.9), inestimable: ["viral:x"], coefficients: { "viral:x": null }, ci95: { "viral:x": null } };
    const vi = decide([m("A score", 0.5), inest]);
    assert.equal(vi.viral_predicts, false);
    assert.ok(vi.reasons.some((r) => r.startsWith("inestimáveis")));
  });

  it("feature sem variância dentro da célula sai marcada como inestimável, não como efeito zero", () => {
    const rows = synthetic(0.5).map((r) => ({ ...r, signals: { ...r.signals, money_scale: true } }));
    const res = runCalibration(rows, { holdoutFrac: 0.3, bootstrap: 5, seed: 1 });
    const B = res.models.find((m) => m.name.startsWith("B "))!;
    assert.ok(B.inestimable.includes("viral:money_scale"));
    assert.ok(!B.inestimable.includes("viral:people_gov"));
    assert.equal(B.coefficients["viral:money_scale"], null);
    assert.equal(B.ci95["viral:money_scale"], null);
    assert.deepEqual(inestimableFeatures([[0, 1], [0, -1]], ["a", "b"]), ["a"]);
  });
});

describe("pocBonusPoints (réplica congelada do POC descartado)", () => {
  const none = {
    people_gov: false,
    big_company: false,
    conflict_harm: false,
    money_scale: false,
    policy_geo: false,
    newsletter_mentions: 0,
    recent_36h: false,
  };
  const opts = { guard: null, negativeImpact: false, scoreCurrent: 60 };

  it("pesos e tetos do POC", () => {
    assert.equal(pocBonusPoints({ ...none, people_gov: true, big_company: true, recent_36h: true }, opts), 6);
    assert.equal(pocBonusPoints({ ...none, conflict_harm: true, money_scale: true, policy_geo: true }, opts), 8);
    assert.equal(pocBonusPoints({ ...none, newsletter_mentions: 5 }, opts), 6);
    const all = { people_gov: true, big_company: true, conflict_harm: true, money_scale: true, policy_geo: true, newsletter_mentions: 3, recent_36h: true };
    assert.equal(pocBonusPoints(all, opts), 15);
    assert.equal(pocBonusPoints(all, { ...opts, scoreCurrent: 96 }), 4);
  });

  it("guarda zera; dano não soma em negative_impact", () => {
    assert.equal(pocBonusPoints({ ...none, people_gov: true }, { ...opts, guard: "social_post" }), 0);
    assert.equal(pocBonusPoints({ ...none, conflict_harm: true }, { ...opts, negativeImpact: true }), 0);
  });
});

describe("cellKey / signalFeature", () => {
  const base = synthetic(0)[0];

  it("mesma edição, seções diferentes = células diferentes (não se misturam no efeito fixo)", () => {
    const a = { ...base, edition: "260922", section: "radar", y: 1, score_current: 10 };
    const b = { ...base, edition: "260922", section: "radar", y: 3, score_current: 30 };
    const c = { ...base, edition: "260922", section: "destaque", y: 100, score_current: 0 };
    const d = { ...base, edition: "260922", section: "destaque", y: 102, score_current: 20 };
    assert.notEqual(cellKey(a), cellKey(c));
    const dm = demeanWithinCells([a, b, c, d], [(r) => r.score_current]);
    assert.deepEqual(dm.y, [-1, 1, -1, 1]);
    assert.equal(new Set(dm.cells).size, 2);
  });

  it("guarda de tipo zera o sinal; piso de score não zera", () => {
    const on = { ...base, signals: { ...base.signals, people_gov: true } };
    const f = signalFeature("people_gov");
    assert.equal(f({ ...on, viral_guard: null }), 1);
    assert.equal(f({ ...on, viral_guard: "below_min_base" }), 1);
    assert.equal(f({ ...on, viral_guard: "social_post" }), 0);
    assert.equal(f({ ...on, viral_guard: "verdict:paywall" }), 0);
    assert.equal(signalFeature("newsletter_mentions")({ ...on, signals: { ...on.signals, newsletter_mentions: 5 } }), 2);
  });
});

describe("parseCliOptions / readJson", () => {
  it("defaults e validação", () => {
    const o = parseCliOptions({});
    assert.equal(o.holdoutFrac, 0.3);
    assert.equal(o.bootstrap, 500);
    assert.equal(o.strictMissing, false);
    assert.equal(parseCliOptions({}, new Set(["absent-is-missing"])).strictMissing, true);
    assert.throws(() => parseCliOptions({ "holdout-frac": "1" }), /holdout-frac/);
    assert.throws(() => parseCliOptions({ "holdout-frac": "0" }), /holdout-frac/);
    assert.throws(() => parseCliOptions({ bootstrap: "0" }), /bootstrap/);
    assert.throws(() => parseCliOptions({ bootstrap: "2.5" }), /bootstrap/);
    assert.throws(() => parseCliOptions({ seed: "abc" }), /finito/);
    assert.throws(() => parseCliOptions({ "min-age-days": "-1" }), /min-age-days/);
    assert.throws(() => parseCliOptions({ "min-coverage": "1.5" }), /min-coverage/);
  });

  it("ausente, inválido e ok são distintos", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-viral-json-"));
    try {
      writeFileSync(join(dir, "bad.json"), "{ nao json");
      writeFileSync(join(dir, "ok.json"), '{"a":1}');
      assert.deepEqual(readJson(join(dir, "nope.json")), { ok: false, reason: "missing" });
      assert.deepEqual(readJson(join(dir, "bad.json")), { ok: false, reason: "invalid" });
      assert.deepEqual(readJson(join(dir, "ok.json")), { ok: true, value: { a: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadDataset (fixture em diretório temporário)", () => {
  it("atribui envio por overlap, ignora fixture, separa sem-dado de zero e conta edições puladas", () => {
    const root = mkdtempSync(join(tmpdir(), "calib-viral-data-"));
    try {
      const mkEdition = (ed: string, md: string, approved: unknown) => {
        mkdirSync(join(root, "editions", ed, "_internal"), { recursive: true });
        writeFileSync(join(root, "editions", ed, "02-reviewed.md"), md);
        writeFileSync(join(root, "editions", ed, "_internal", "01-approved.json"), JSON.stringify(approved));
      };
      const md = [
        "**DESTAQUE 1 | X**",
        "**[A](https://a.example.com/1)**",
        "**DESTAQUE 2 | X**",
        "**[B](https://a.example.com/2)**",
        "**📡 RADAR**",
        "**[C](https://a.example.com/3)**",
        "**[D](https://a.example.com/4)**",
      ].join("\n");
      const art = (n: number, title: string) => ({ url: `https://a.example.com/${n}`, title, score: 60, score_base: 60 });
      mkEdition("260922", md, { highlights: [art(1, "Trump hack"), art(2, "neutro")], radar: [art(3, "neutro"), art(4, "neutro")] });
      mkEdition("260923", "**📡 RADAR**\nsem manchete nenhuma", { radar: [] }); // no_headlines
      mkEdition("261006", md, { radar: [] }); // too_recent
      mkdirSync(join(root, "beehiiv-cache", "posts"), { recursive: true });
      mkdirSync(join(root, "kit-cache", "broadcasts"), { recursive: true });
      // Beehiiv: só lista link clicado; 4 ausente = zero. Data errada de propósito (260925).
      writeFileSync(
        join(root, "beehiiv-cache", "posts", "post_1.json"),
        JSON.stringify({
          slug: "real",
          status: "confirmed",
          publish_date: Date.parse("2026-09-25T09:00:00Z") / 1000,
          stats: {
            email: { delivered: 400 },
            clicks: [
              { url: "https://a.example.com/1", email: { unique_clicks: 5 } },
              { url: "https://a.example.com/2", email: { unique_clicks: 2 } },
              { url: "https://a.example.com/3", email: { unique_clicks: 1 } },
            ],
          },
        }),
      );
      // Fixture poluindo o cache: mesma data, URLs que não casam.
      writeFileSync(
        join(root, "beehiiv-cache", "posts", "post_fixture.json"),
        JSON.stringify({
          slug: "fixture",
          status: "confirmed",
          publish_date: Date.parse("2026-09-22T09:00:00Z") / 1000,
          stats: { email: { delivered: 900 }, clicks: [{ url: "https://example0.com/x", email: { unique_clicks: 50 } }] },
        }),
      );
      const ds = loadDataset(root, { minAgeDays: 3, minCoverage: 0.5, today: new Date("2026-10-07T12:00:00Z") });
      assert.equal(ds.sends_unassigned, 1); // fixture
      assert.equal(ds.assign_methods.overlap, 1);
      assert.deepEqual(ds.editions_skipped.no_headlines, ["260923"]);
      assert.deepEqual(ds.editions_skipped.too_recent, ["261006"]);
      assert.equal(ds.rows.length, 4);
      assert.equal(ds.rows.every((r) => r.delivered === 400), true);
      assert.equal(ds.rows.find((r) => r.url === "https://a.example.com/4")?.clicks, 0);
      assert.equal(ds.coverage_by_edition["260922"], 1);

      // Modo estrito: o 4 vira sem-dado e sai do ajuste.
      const strict = loadDataset(root, { minAgeDays: 3, minCoverage: 0.5, strictMissing: true, today: new Date("2026-10-07T12:00:00Z") });
      assert.equal(strict.rows.length, 3);
      assert.equal(strict.counts.links_without_click_data, 1);
      // Cobertura abaixo do limiar derruba a edição inteira.
      const high = loadDataset(root, { minAgeDays: 3, minCoverage: 0.9, strictMissing: true, today: new Date("2026-10-07T12:00:00Z") });
      assert.deepEqual(high.editions_skipped.low_click_coverage, ["260922"]);
      assert.equal(high.rows.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
