/**
 * test/weekly-shared-ranking-13022.test.ts (#13022)
 *
 * Seleção única compartilhada do `/diaria-pacote-semanal`:
 *   1. Um ranking por clique, dois recortes (clicked: destaque + RADAR, 5
 *      vagas; LinkedIn: só destaque, #8029, teto por semana curta).
 *   2. Regra de empate única = a do LinkedIn: #8817 (diversidade de dia
 *      decide sozinha quando cabe exato) e #5109 (empate maior que as vagas
 *      vai ao editor), agora valendo também no clicked; a sugestão do
 *      desempate editorial fica pré-marcada.
 *   3. Troca do gate propaga para os dois produtos só quando o item novo é
 *      elegível nos dois.
 *   4. Idade do dado de clique (premissa: aceitar e avisar a sexta imatura).
 *   5. Integração: CLI grava o arquivo, `select-linkedin-weekly.ts` e
 *      `publish-weekly-social.ts` consomem por `--shared-selection`, e a
 *      troca gravada é reaplicada na re-rodada.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLICKED_SLOTS,
  SharedSelectionError,
  applySharedSwap,
  buildSharedRanking,
  buildSharedSelection,
  clickAgeReport,
  isEligibleFor,
  selectForProduct,
} from "../scripts/lib/weekly-shared-ranking.ts";
import { selectHeadlines, type WeeklyRankedCandidate } from "../scripts/lib/weekly-linkedin-select.ts";
import { WEEKLY_EXPECTED_ITEMS } from "../scripts/publish-weekly-social.ts";
import { main as sharedMain, sharedSelectionPath } from "../scripts/weekly-shared-selection.ts";
import { main as selectLinkedinMain, applySharedLinkedinSelection } from "../scripts/select-linkedin-weekly.ts";
import { main as publishWeeklyMain, readSharedClickedSelection } from "../scripts/publish-weekly-social.ts";

function cand(
  o: Partial<WeeklyRankedCandidate> & { url: string; clicks: number; opens?: number },
): WeeklyRankedCandidate {
  const { clicks, opens = 400, ...rest } = o;
  return {
    editionDate: "260727",
    title: o.url.split("/").pop() ?? o.url,
    body: "Corpo.",
    why: "",
    kind: "destaque",
    category: "NOTÍCIAS",
    section: "destaque",
    uniqueVerifiedClicks: clicks,
    webUniqueClicks: 0,
    opens,
    ratePct: opens > 0 ? (clicks / opens) * 100 : 0,
    excluded: false,
    hasClickData: true,
    ...rest,
  };
}

const U = (s: string) => `https://exemplo.com/${s}`;

/** Semana-base: gaps ≥ 0,5pp com 400 aberturas (1 clique = 0,25pp), sem empate. */
function baseWeek(): WeeklyRankedCandidate[] {
  return [
    cand({ url: U("a"), clicks: 20, destaqueN: 1 }),
    cand({ url: U("a2"), clicks: 8, destaqueN: 2 }),
    cand({ url: U("r"), clicks: 12, kind: "section", section: "radar", category: "RADAR" }),
    cand({ url: U("um"), clicks: 30, kind: "section", section: "use_melhor", category: "USE MELHOR" }),
    cand({ url: U("lanc"), clicks: 25, kind: "section", section: "lancamentos", category: "LANÇAMENTOS" }),
    cand({ url: U("b"), clicks: 16, editionDate: "260728", destaqueN: 1 }),
    cand({ url: U("b2"), clicks: 4, editionDate: "260728", destaqueN: 2 }),
    cand({ url: U("r2"), clicks: 1, editionDate: "260728", kind: "section", section: "radar", category: "RADAR" }),
    cand({ url: U("c"), clicks: 14, editionDate: "260729", destaqueN: 1 }),
    cand({ url: "https://amazon.com.br/livro", clicks: 99, editionDate: "260729", kind: "section", section: "radar", excluded: true }),
  ];
}

describe("#13022 — filtros por produto sobre o ranking único", () => {
  it("CLICKED_SLOTS acompanha WEEKLY_EXPECTED_ITEMS da retro", () => {
    assert.equal(CLICKED_SLOTS, WEEKLY_EXPECTED_ITEMS);
  });

  it("clicked aceita destaque e RADAR; LinkedIn só destaque; USE MELHOR/LANÇAMENTOS/comercial em nenhum", () => {
    const [a, , r, um, lanc] = baseWeek();
    assert.equal(isEligibleFor("clicked", a), true);
    assert.equal(isEligibleFor("linkedin", a), true);
    assert.equal(isEligibleFor("clicked", r), true);
    assert.equal(isEligibleFor("linkedin", r), false);
    for (const c of [um, lanc]) {
      assert.equal(isEligibleFor("clicked", c), false);
      assert.equal(isEligibleFor("linkedin", c), false);
    }
    const comercial = baseWeek()[9];
    assert.equal(isEligibleFor("clicked", comercial), false);
  });

  it("os dois recortes saem do MESMO ranking: a ordem do LinkedIn é subsequência da ordem do ranking", () => {
    const core = buildSharedSelection({ candidates: baseWeek(), editionsFound: 3 });
    assert.deepEqual(core.clicked.urls, [U("a"), U("b"), U("c"), U("r"), U("a2")]);
    assert.deepEqual(core.linkedin.urls, [U("a"), U("b"), U("c")]);
    const order = core.ranking.ranked.map((c) => c.url);
    const positions = core.linkedin.urls.map((u) => order.indexOf(u));
    assert.deepEqual(positions, [...positions].sort((x, y) => x - y));
    assert.ok(!order.includes(U("um")) && !order.includes("https://amazon.com.br/livro"));
    assert.deepEqual(core.ranking.excluded.map((c) => c.url), ["https://amazon.com.br/livro"]);
  });

  it("recorte do LinkedIn = selectHeadlines da skill isolada (mesma regra, mesmo resultado)", () => {
    const week = baseWeek();
    const core = buildSharedSelection({ candidates: week, editionsFound: 3 });
    assert.deepEqual(core.linkedin.urls, selectHeadlines(week, 3).selected.map((c) => c.url));
  });

  it("semana curta: teto do LinkedIn cai com as edições (computeHeadlineCap), clicked segue com 5 vagas", () => {
    const core = buildSharedSelection({ candidates: baseWeek(), editionsFound: 2 });
    assert.equal(core.linkedin.slots, 2);
    assert.equal(core.clicked.slots, 5);
  });
});

describe("#13022 — regra de empate única (#8817 e #5109 preservados)", () => {
  it("#8817: banda maior que a vaga, candidato de dia novo cabe exato → entra sozinho, nos dois recortes", () => {
    // vagas 1-2 já do dia 260727; a 3ª é banda entre outro 260727 (taxa maior) e um 260728.
    const week = [
      cand({ url: U("x1"), clicks: 40, destaqueN: 1 }),
      cand({ url: U("x2"), clicks: 36, destaqueN: 2 }),
      cand({ url: U("x3"), clicks: 30, destaqueN: 3 }),
      cand({ url: U("y1"), clicks: 30 - 0.0001, editionDate: "260728", destaqueN: 1 }),
    ];
    const ranking = buildSharedRanking(week);
    const li = selectForProduct(ranking, "linkedin", 3);
    assert.deepEqual(li.urls, [U("x1"), U("x2"), U("y1")]);
    assert.equal(li.pending, null);
    assert.ok(li.warnings.some((w) => /#8817/.test(w)));
    const cl = selectForProduct(ranking, "clicked", 3);
    assert.deepEqual(cl.urls, [U("x1"), U("x2"), U("y1")], "a mesma regra vale no clicked");
  });

  it("#5109: banda maior que as vagas sem saída por dia → pending com sugestão pré-marcada, nunca decidido em silêncio", () => {
    const week = [
      cand({ url: U("p1"), clicks: 40, destaqueN: 1 }),
      cand({ url: U("p2"), clicks: 40, editionDate: "260728", destaqueN: 1 }),
      cand({ url: U("p3"), clicks: 40, editionDate: "260729", destaqueN: 1, title: "Emprego e carreira no Brasil" }),
      cand({ url: U("p4"), clicks: 40, editionDate: "260730", destaqueN: 1 }),
    ];
    const ranking = buildSharedRanking(week);
    const li = selectForProduct(ranking, "linkedin", 3);
    assert.ok(li.pending);
    assert.equal(li.pending!.slots, 3);
    assert.equal(li.pending!.group.length, 4);
    assert.equal(li.pending!.resolution, "suggestion");
    assert.equal(li.pending!.suggested.length, 3);
    assert.deepEqual(li.urls, li.pending!.suggested, "a prévia usa a sugestão");
    assert.ok(li.pending!.suggested.includes(U("p3")), "implicação profissional pesa na sugestão");
    assert.ok(li.warnings.some((w) => /#5109/.test(w)));
  });

  it("#5109: --pick do editor resolve o empate com exatidão; pick fora do grupo é erro explícito", () => {
    const week = [
      cand({ url: U("p1"), clicks: 40, destaqueN: 1 }),
      cand({ url: U("p2"), clicks: 40, editionDate: "260728", destaqueN: 1 }),
      cand({ url: U("p3"), clicks: 40, editionDate: "260729", destaqueN: 1 }),
      cand({ url: U("p4"), clicks: 40, editionDate: "260730", destaqueN: 1 }),
    ];
    const ranking = buildSharedRanking(week);
    const picked = selectForProduct(ranking, "linkedin", 3, { picks: [U("p4"), U("p1"), U("p2")] });
    assert.deepEqual(picked.urls, [U("p4"), U("p1"), U("p2")]);
    assert.equal(picked.pending!.resolution, "editor");
    assert.throws(() => selectForProduct(ranking, "linkedin", 3, { picks: [U("p1"), U("zz"), U("p2")] }), SharedSelectionError);
    const confirmed = selectForProduct(ranking, "linkedin", 3, { confirmSuggestion: true });
    assert.equal(confirmed.pending!.resolution, "editor");
  });

  it("clicked: a sugestão do empate preserva a preferência do #10378 (quem ficou fora do highlights)", () => {
    const week = [
      cand({ url: U("top"), clicks: 80, destaqueN: 1 }),
      cand({ url: U("d1"), clicks: 40, editionDate: "260728", destaqueN: 1 }),
      cand({ url: U("d2"), clicks: 40, editionDate: "260728", destaqueN: 2 }),
    ];
    const core = buildSharedSelection({ candidates: week, editionsFound: 2 });
    // 2 vagas de clicked aqui não existem (5), então força com recorte de 2.
    const cl = selectForProduct(core.ranking, "clicked", 2, { highlightUrls: new Set([U("top"), U("d1")]) });
    assert.deepEqual(cl.urls, [U("top"), U("d2")]);
    assert.equal(cl.pending!.resolution, "suggestion");
  });
});

describe("#13022 — troca do gate propaga quando elegível nos dois", () => {
  it("destaque por destaque: vale no clicked e no LinkedIn, na mesma posição", () => {
    const core = buildSharedSelection({
      candidates: baseWeek(),
      editionsFound: 3,
      overrides: { picks: {}, swaps: [{ out: U("c"), in: U("b2") }], confirmedSuggestions: [] },
    });
    assert.deepEqual(core.clicked.urls, [U("a"), U("b"), U("b2"), U("r"), U("a2")]);
    assert.deepEqual(core.linkedin.urls, [U("a"), U("b"), U("b2")]);
    assert.equal(core.clicked.manual, true);
    assert.equal(core.linkedin.manual, true);
    assert.deepEqual(core.swapLog[0].outcome.applied, ["clicked", "linkedin"]);
  });

  it("item novo de RADAR: vale só no clicked; o LinkedIn fica como estava, com o motivo", () => {
    const sel = buildSharedSelection({ candidates: baseWeek(), editionsFound: 3 });
    const outcome = applySharedSwap({ clicked: sel.clicked, linkedin: sel.linkedin }, sel.ranking, { out: U("b"), in: U("r2") });
    assert.deepEqual(outcome.applied, ["clicked"]);
    assert.deepEqual(outcome.skipped.map((s) => s.product), ["linkedin"]);
    assert.ok(sel.clicked.urls.includes(U("r2")));
    assert.deepEqual(sel.linkedin.urls, [U("a"), U("b"), U("c")]);
    assert.equal(sel.linkedin.manual, false);
  });

  it("item a sair só no clicked: troca só no clicked", () => {
    const sel = buildSharedSelection({ candidates: baseWeek(), editionsFound: 3 });
    const outcome = applySharedSwap({ clicked: sel.clicked, linkedin: sel.linkedin }, sel.ranking, { out: U("a2"), in: U("b2") });
    assert.deepEqual(outcome.applied, ["clicked"]);
    assert.equal(sel.clicked.urls[4], U("b2"));
  });

  it("erros: item comercial, fora da semana, ou troca que não se aplica a nenhum produto", () => {
    const sel = buildSharedSelection({ candidates: baseWeek(), editionsFound: 3 });
    const sels = { clicked: sel.clicked, linkedin: sel.linkedin };
    assert.throws(() => applySharedSwap(sels, sel.ranking, { out: U("a"), in: "https://amazon.com.br/livro" }), /comercial/);
    assert.throws(() => applySharedSwap(sels, sel.ranking, { out: U("a"), in: U("nao-existe") }), /não é candidato/);
    assert.throws(() => applySharedSwap(sels, sel.ranking, { out: U("b2"), in: U("r2") }), /não se aplica/);
    assert.throws(() => applySharedSwap(sels, sel.ranking, { out: U("a"), in: U("um") }), /não é candidato/, "USE MELHOR não é candidato de nenhum produto");
  });
});

describe("#13022 — idade do dado de clique (aceitar e avisar)", () => {
  it("edição com menos de 48h de clique sai como imatura, com aviso; sem post fica null e sem aviso", () => {
    const sent = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    const now = new Date("2026-08-01T12:00:00-03:00"); // sábado meio-dia
    const r = clickAgeReport(
      ["260727", "260731", "260730"],
      new Map([
        ["260727", sent("2026-07-27T06:00:00-03:00")],
        ["260731", sent("2026-07-31T06:00:00-03:00")],
      ]),
      now,
    );
    assert.equal(r.rows[0].immature, false);
    assert.equal(r.rows[1].hours, 30);
    assert.equal(r.rows[1].immature, true);
    assert.equal(r.rows[2].hours, null);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /260731.*30h.*não normaliza/);
  });
});

// ─── Integração: CLI → arquivo → consumidores ──────────────────────────────

function epochFor(aammdd: string): number {
  return Math.floor(new Date(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6)), 8).getTime() / 1000);
}

function editionMd(d: Array<{ n: number; title: string; url: string }>, radar: Array<{ title: string; url: string }>): string {
  const blocks = d.map((x) =>
    [`**DESTAQUE ${x.n} | 💼 MERCADO**`, "", `**[${x.title}](${x.url})**`, "", `Corpo de ${x.title}.`, "", "Por que isso importa:", "", "Explicação.", ""].join("\n"),
  );
  const radarBlock = radar.length
    ? ["**📡 RADAR**", "", ...radar.flatMap((r) => [`**[${r.title}](${r.url})**`, "Descrição curta.", ""])].join("\n")
    : "";
  return [...blocks, radarBlock].join("\n---\n\n");
}

function withMockedExit<T>(fn: () => T): { code: number | null; value?: T } {
  const orig = process.exit;
  let code: number | null = null;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new Error("__exit__");
  }) as typeof process.exit;
  try {
    return { code, value: fn() };
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
    return { code };
  } finally {
    process.exit = orig;
  }
}

function quiet<T>(fn: () => T): T {
  const ol = console.log;
  const oe = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

describe("#13022 — integração: weekly-shared-selection.ts alimenta LinkedIn e retro", () => {
  let root: string;
  const now = new Date("2026-08-01T12:00:00-03:00");

  before(() => {
    root = mkdtempSync(join(tmpdir(), "shared-selection-13022-"));
    const ed = (date: string, md: string) => {
      mkdirSync(join(root, "data/editions", date), { recursive: true });
      writeFileSync(join(root, "data/editions", date, "02-reviewed.md"), md, "utf8");
    };
    ed(
      "260727",
      editionMd(
        [
          { n: 1, title: "Matéria A", url: U("a") },
          { n: 2, title: "Matéria A2", url: U("a2") },
        ],
        [{ title: "Radar R", url: U("r") }],
      ),
    );
    ed("260728", editionMd([{ n: 1, title: "Matéria B", url: U("b") }, { n: 2, title: "Matéria B2", url: U("b2") }], []));
    ed("260729", editionMd([{ n: 1, title: "Matéria C", url: U("c") }], []));
    const post = (date: string, clicks: Record<string, number>) => {
      const dir = join(root, "data/beehiiv-cache/posts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `post_${date}.json`),
        JSON.stringify({
          id: `post_${date}`,
          slug: `post_${date}`,
          status: "confirmed",
          publish_date: epochFor(date),
          stats: {
            email: { clicks: 1, unique_opens: 400 },
            clicks: Object.entries(clicks).map(([u, n]) => ({ url: U(u), base_url: U(u), email: { unique_verified_clicks: n } })),
          },
        }),
        "utf8",
      );
    };
    post("260727", { a: 20, a2: 8, r: 12 });
    post("260728", { b: 16, b2: 4 });
    post("260729", { c: 14 });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const sharedFile = () => sharedSelectionPath(root, "26w31");
  const readShared = () => JSON.parse(readFileSync(sharedFile(), "utf8"));

  it("grava shared-selection.json com os dois recortes e a idade do clique", () => {
    const r = withMockedExit(() => quiet(() => sharedMain(root, ["--saturday", "260801"], now)));
    assert.equal(r.code, null);
    assert.ok(existsSync(sharedFile()));
    const s = readShared();
    assert.equal(s.publishMonday, "260803");
    assert.equal(s.cycle, "26w31");
    assert.deepEqual(s.clicked.urls, [U("a"), U("b"), U("c"), U("r"), U("a2")]);
    assert.deepEqual(s.linkedin.urls, [U("a"), U("b"), U("c")]);
    assert.equal(s.clickAge.find((x: { editionDate: string }) => x.editionDate === "260729").immature, false);
    assert.equal(s.clickAge.find((x: { editionDate: string }) => x.editionDate === "260731").hours, null);
  });

  it("sábado inválido → exit 2 sem gravar", () => {
    const r = withMockedExit(() => quiet(() => sharedMain(root, ["--saturday", "260731"], now)));
    assert.equal(r.code, 2);
  });

  it("--swap grava a troca e ela é reaplicada na re-rodada sem flag", () => {
    let r = withMockedExit(() => quiet(() => sharedMain(root, ["--saturday", "260801", "--swap", U("c"), "--with", U("b2")], now)));
    assert.equal(r.code, null);
    r = withMockedExit(() => quiet(() => sharedMain(root, ["--saturday", "260801"], now)));
    assert.equal(r.code, null);
    const s = readShared();
    assert.deepEqual(s.linkedin.urls, [U("a"), U("b"), U("b2")]);
    assert.deepEqual(s.clicked.urls, [U("a"), U("b"), U("b2"), U("r"), U("a2")]);
    assert.equal(s.overrides.swaps.length, 1);
  });

  it("troca inválida → exit 2 e o arquivo anterior fica intacto", () => {
    const before = readFileSync(sharedFile(), "utf8");
    const r = withMockedExit(() => quiet(() => sharedMain(root, ["--saturday", "260801", "--swap", U("a"), "--with", U("nao-existe")], now)));
    assert.equal(r.code, 2);
    assert.equal(readFileSync(sharedFile(), "utf8"), before);
  });

  it("select-linkedin-weekly.ts --shared-selection usa as manchetes do ranking compartilhado", () => {
    const orig = process.argv;
    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260803", "--shared-selection", sharedFile()];
    try {
      const r = withMockedExit(() => quiet(() => selectLinkedinMain(root)));
      assert.equal(r.code, null);
    } finally {
      process.argv = orig;
    }
    const ln = JSON.parse(readFileSync(join(root, "data/weekly/26w31/_internal/ln-selection.json"), "utf8"));
    assert.deepEqual(ln.headlines.map((h: { url: string }) => h.url), [U("a"), U("b"), U("b2")]);
    assert.equal(ln.pendingGroup, null);
    assert.equal(ln.sharedSelection, sharedFile());
  });

  it("select-linkedin-weekly.ts: --shared-selection com --picks, ou de outra segunda, é recusado (exit 2)", () => {
    const orig = process.argv;
    try {
      process.argv = ["node", "s", "--publish-monday", "260803", "--shared-selection", sharedFile(), "--picks", U("a")];
      assert.equal(withMockedExit(() => quiet(() => selectLinkedinMain(root))).code, 2);
    } finally {
      process.argv = orig;
    }
    const other = applySharedLinkedinSelection(sharedFile(), "260810", []);
    assert.match(other.error ?? "", /segunda 260803, não de 260810/);
  });

  it("publish-weekly-social.ts --mode clicked --shared-selection usa o recorte clicked (ordem do arquivo)", async () => {
    const out: string[] = [];
    const ol = console.log;
    const oe = console.error;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    console.error = () => {};
    try {
      await publishWeeklyMain(
        ["--saturday", "260801", "--mode", "clicked", "--editions-root", join(root, "data/editions"), "--shared-selection", sharedFile(), "--summary-manifest"],
        { dataRoot: join(root, "data"), now },
      );
    } finally {
      console.log = ol;
      console.error = oe;
    }
    const manifest = JSON.parse(out.join("\n"));
    assert.deepEqual(manifest.items.map((i: { url: string }) => i.url), [U("a"), U("b"), U("b2"), U("r"), U("a2")]);
  });

  it("publish-weekly-social.ts: --force-urls junto com --shared-selection sai 1; arquivo de outro sábado é recusado", async () => {
    const codes: number[] = [];
    const orig = process.exit;
    process.exit = ((c?: number) => {
      codes.push(c ?? 0);
      throw new Error("__exit__");
    }) as typeof process.exit;
    const oe = console.error;
    const ol = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      for (const argv of [["--saturday", "260801", "--mode", "clicked", "--shared-selection", sharedFile(), "--force-urls", U("a")]]) {
        await publishWeeklyMain(argv, { dataRoot: join(root, "data"), now }).catch((e: Error) => {
          if (e.message !== "__exit__") throw e;
        });
      }
    } finally {
      process.exit = orig;
      console.error = oe;
      console.log = ol;
    }
    assert.deepEqual(codes, [1]);
    const other = readSharedClickedSelection(sharedFile(), "260808");
    assert.ok("error" in other && /sábado 260801, não de 260808/.test(other.error));
  });
});

describe("#13022 — LinkedIn: empate ainda só sugerido volta como pendingGroup (#5109)", () => {
  it("resolution 'suggestion' mantém pendingGroup (gate confirma antes do paste); 'editor' zera", () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-ln-13022-"));
    try {
      const eligible = [cand({ url: U("a"), clicks: 9 }), cand({ url: U("b"), clicks: 9 }), cand({ url: U("c"), clicks: 9 })];
      const write = (resolution: string) => {
        const p = join(dir, `shared-${resolution}.json`);
        writeFileSync(
          p,
          JSON.stringify({
            version: 1,
            publishMonday: "260803",
            linkedin: { urls: [U("a"), U("b")], pending: { group: [U("a"), U("b"), U("c")], slots: 2, resolution }, warnings: [] },
          }),
        );
        return p;
      };
      const sug = applySharedLinkedinSelection(write("suggestion"), "260803", eligible);
      assert.equal(sug.error, null);
      assert.deepEqual(sug.headlines.map((c) => c.url), [U("a"), U("b")]);
      assert.equal(sug.pendingGroup?.length, 3);
      assert.equal(sug.pendingSlots, 2);
      assert.ok(sug.warnings.some((w) => /SUGESTÃO/.test(w)));
      const ed = applySharedLinkedinSelection(write("editor"), "260803", eligible);
      assert.equal(ed.pendingGroup, null);
      const bad = applySharedLinkedinSelection(write("editor"), "260803", eligible.slice(1));
      assert.match(bad.error ?? "", /não são destaque elegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
