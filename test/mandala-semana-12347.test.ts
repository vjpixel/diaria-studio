/**
 * test/mandala-semana-12347.test.ts (#12347)
 *
 * Núcleo puro do formulário semanal do Desafio Mandala. O fixture de posts é a
 * resposta real da Graph API (`/media`) para a semana 2 (29/10–04/11/2026),
 * lida em 11/11/2026, mais os 2 reels em collab do @vjpixel que a API não
 * devolve. O resultado esperado é a planilha montada à mão na semana 2
 * (`data/desafio-mandala-semana2.csv`): o teste trava a regra "1º do dia em
 * BRT" contra o caso real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brtDate,
  brtTime,
  canonicalPostUrl,
  captionStart,
  checkFormConsistency,
  combineNewFollowers,
  dailyLinks,
  mergePosts,
  parseCollabArg,
  parseTallyForm,
  postsFromGraphMedia,
  postsFromLocalRecord,
  readGraphPage,
  resolveDdmm,
  selectWeek,
  summarizeYoutubeSubs,
  weekCsv,
  youtubeSubsUnavailable,
  type PlannedDay,
} from "../scripts/lib/mandala-semana.ts";
import { buildPlan, fetchGraphPosts, isLocalRecordFile, parseCli, type PlanInput } from "../scripts/mandala-semana.ts";

// Trecho no formato do JSON embutido no HTML do Tally (semana 2).
const TALLY_HTML = [
  '<script id="__NEXT_DATA__">{"blocks":[',
  '{"type":"TITLE","payload":{"safeHTMLSchema":[["Desafio Mandala Mão na Massa - Semana 2"]]}},',
  '{"type":"TITLE","payload":{"safeHTMLSchema":[["4. Link do conteúdo do dia 9 (29/10)"]]}},',
  '{"type":"TITLE","payload":{"safeHTMLSchema":[["5. Link do conte\\u00fado do dia 10 (30/10)"]]}},',
  ...[
    ["11", "31/10"],
    ["12", "01/11"],
    ["13", "02/11"],
    ["14", "03/11"],
    ["15", "04/11"],
  ].map(([n, d], i) => `{"type":"TITLE","payload":{"safeHTMLSchema":[["${i + 6}. Link do conteúdo do dia ${n} (${d})"]]}},`),
  '{"type":"TEXT","payload":{"safeHTMLSchema":[["Considerar o período de 29/10 até 04/11 e apenas o número de novos seguidores"]]}}',
  "]}</script><title>Link do conteúdo do dia 9 (29/10)</title>",
].join("");

const NOW = new Date("2026-11-06T12:00:00Z");

// Graph API /media, semana 2 (timestamps e permalinks reais; caption encurtada).
const GRAPH = [
  ["2026-11-05T00:00:38+0000", "FEED", "https://www.instagram.com/p/DfVseGNDnod/", "A OpenAI criou uma prova em que o ChatGPT"],
  ["2026-11-04T20:00:36+0000", "FEED", "https://www.instagram.com/p/DfVRACrjjSK/", "Mandar uma selfie segurando o documento"],
  ["2026-11-04T12:00:33+0000", "FEED", "https://www.instagram.com/p/DfUaEPHjRK6/", "Uma linha minúscula"],
  ["2026-11-04T09:33:11+0000", "REELS", "https://www.instagram.com/reel/DfUJHiND6EE/", "Golpe da selfie"],
  ["2026-11-03T22:00:40+0000", "FEED", "https://www.instagram.com/p/DfS58jJCYg0/", "Octavius"],
  ["2026-11-03T18:00:29+0000", "FEED", "https://www.instagram.com/p/DfSedckl-ai/", "Mistral"],
  ["2026-11-03T15:01:46+0000", "REELS", "https://www.instagram.com/reel/DfSJ7pxieK2/", "Só o Claude"],
  ["2026-11-03T14:00:29+0000", "FEED", "https://www.instagram.com/p/DfSC_ypHKvR/", "Planilhas"],
  ["2026-11-03T10:00:33+0000", "FEED", "https://www.instagram.com/p/DfRniPGjZVU/", "A Cathedral"],
  ["2026-11-02T21:05:58+0000", "FEED", "https://www.instagram.com/p/DfQO44niBXJ/", "Haiku"],
  ["2026-11-02T17:00:32+0000", "FEED", "https://www.instagram.com/p/DfPyzb-F79f/", "OpenAI"],
  ["2026-11-02T15:37:53+0000", "REELS", "https://www.instagram.com/reel/DfPpQ7ajJs6/", "Você ainda"],
  ["2026-11-02T11:00:31+0000", "FEED", "https://www.instagram.com/p/DfPJmn-F6fE/", "Lupa"],
  ["2026-11-01T22:00:34+0000", "FEED", "https://www.instagram.com/p/DfNwWFsnTja/", "Mais lidas"],
  ["2026-10-31T17:15:31+0000", "FEED", "https://www.instagram.com/p/DfKq7sRjTlP/", "Resumo"],
  ["2026-10-30T22:05:47+0000", "FEED", "https://www.instagram.com/p/DfInWgnGxgr/", "Gemini Notebook"],
  ["2026-10-30T18:00:38+0000", "FEED", "https://www.instagram.com/p/DfILS3-DQXo/", "Golpistas"],
  ["2026-10-30T16:55:54+0000", "FEED", "https://www.instagram.com/p/DfID48GDcIh/", "15 funções"],
  ["2026-10-30T16:26:01+0000", "FEED", "https://www.instagram.com/p/DfIAd7qDWA1/", "Bowen Wan"],
  // 29/10 21:00 BRT: ainda é dia 9 em BRT, embora já seja 30/10 em UTC.
  ["2026-10-30T00:00:26+0000", "FEED", "https://www.instagram.com/p/DfGPrgZD_3k/", "IA expôs"],
  ["2026-10-29T20:00:41+0000", "FEED", "https://www.instagram.com/p/DfF0PUuCTLm/", "Apagar"],
  ["2026-10-29T16:00:37+0000", "FEED", "https://www.instagram.com/p/DfFYxSlDRmD/", "Videogame"],
  ["2026-10-29T12:00:36+0000", "FEED", "https://www.instagram.com/p/DfE9S1ujnci/", "Reeleito"],
  // Fora do período (28/10 19:00 BRT).
  ["2026-10-28T22:00:25+0000", "FEED", "https://www.instagram.com/p/DfDdJs1gNVE/", "Canva"],
].map(([timestamp, media_product_type, permalink, caption]) => ({ timestamp, media_product_type, permalink, caption }));

function weekDays(): PlannedDay[] {
  return parseTallyForm(TALLY_HTML).days.map((d) => ({ ...d, date: resolveDdmm(d.ddmm, NOW) }));
}

describe("parseTallyForm (#12347)", () => {
  it("lê semana, as 7 perguntas de dia (pelo texto, com \\u00fa) e o período", () => {
    const f = parseTallyForm(TALLY_HTML);
    assert.equal(f.semana, 2);
    assert.deepEqual(
      f.days.map((d) => [d.dayNum, d.ddmm]),
      [[9, "29/10"], [10, "30/10"], [11, "31/10"], [12, "01/11"], [13, "02/11"], [14, "03/11"], [15, "04/11"]],
    );
    assert.equal(f.days[1].question, "Link do conteúdo do dia 10 (30/10)");
    assert.deepEqual(f.period, { from: "29/10", to: "04/11" });
  });

  it("HTML sem perguntas de dia devolve days vazio (a skill cai para o navegador)", () => {
    const f = parseTallyForm("<html><body>Formulário fechado</body></html>");
    assert.deepEqual(f.days, []);
    assert.equal(f.period, null);
    assert.equal(f.semana, null);
  });
});

describe("resolveDdmm (#12347)", () => {
  it("usa o ano corrente para a semana que passou", () => {
    assert.equal(resolveDdmm("29/10", NOW), "2026-10-29");
  });
  it("virada de ano: 29/12 lido em janeiro é do ano anterior", () => {
    assert.equal(resolveDdmm("29/12", new Date("2027-01-03T12:00:00Z")), "2026-12-29");
    assert.equal(resolveDdmm("02/01", new Date("2027-01-03T12:00:00Z")), "2027-01-02");
  });
  it("rejeita data inválida", () => {
    assert.throws(() => resolveDdmm("32/13", NOW));
    assert.throws(() => resolveDdmm("2026-10-29", NOW));
  });
});

describe("fuso BRT (#12347)", () => {
  it("post às 00:00 UTC conta no dia anterior em BRT", () => {
    assert.equal(brtDate("2026-10-30T00:00:26+00:00"), "2026-10-29");
    assert.equal(brtTime("2026-10-30T00:00:26+00:00"), "21:00");
  });
  it("02:59 UTC ainda é o dia anterior; 03:00 UTC já é o dia seguinte", () => {
    assert.equal(brtDate("2026-11-03T02:59:00Z"), "2026-11-02");
    assert.equal(brtDate("2026-11-03T03:00:00Z"), "2026-11-03");
  });
});

describe("selectWeek — 1º do dia (#12347)", () => {
  const { posts, skipped } = postsFromGraphMedia(GRAPH);
  const collabs = [
    parseCollabArg("https://www.instagram.com/reel/DfExeVVqem3/@2026-10-29T07:17"),
    parseCollabArg("https://www.instagram.com/reel/DfHwG0uKZW8/@2026-10-30T11:02"),
  ];

  it("reproduz a escolha da planilha manual da semana 2", () => {
    assert.equal(skipped, 0);
    const sel = selectWeek(mergePosts(collabs, posts), weekDays());
    assert.deepEqual(
      sel.daily.map((d) => [d.dayNum, d.url]),
      [
        [9, "https://www.instagram.com/reel/DfExeVVqem3/"],
        [10, "https://www.instagram.com/reel/DfHwG0uKZW8/"],
        [11, "https://www.instagram.com/p/DfKq7sRjTlP/"],
        [12, "https://www.instagram.com/p/DfNwWFsnTja/"],
        [13, "https://www.instagram.com/p/DfPJmn-F6fE/"],
        [14, "https://www.instagram.com/p/DfRniPGjZVU/"],
        [15, "https://www.instagram.com/reel/DfUJHiND6EE/"],
      ],
    );
    assert.equal(sel.rows.length, 25);
    assert.equal(sel.extras.length, 18);
    assert.equal(sel.outOfPeriod, 1, "o post de 28/10 fica de fora");
    // 21:00 BRT de 29/10 é extra do dia 9, não 1º do dia 10.
    const late = sel.rows.find((r) => r.url.includes("DfGPrgZD_3k"))!;
    assert.deepEqual([late.dayNum, late.timeBrt, late.slot], [9, "21:00", "extra"]);
  });

  it("sem os collabs, o 1º do dia 9 passa a ser o carrossel das 09:00", () => {
    const sel = selectWeek(posts, weekDays());
    assert.equal(sel.daily[0].url, "https://www.instagram.com/p/DfE9S1ujnci/");
  });

  it("dia sem post sai com url null (a skill reporta, não inventa)", () => {
    const sel = selectWeek(posts.filter((p) => brtDate(p.timestamp) !== "2026-11-01"), weekDays());
    assert.equal(sel.daily.find((d) => d.dayNum === 12)!.url, null);
  });

  it("a ordem de entrada não muda o 1º do dia", () => {
    const a = selectWeek([...posts].reverse(), weekDays()).daily.map((d) => d.url);
    const b = selectWeek(posts, weekDays()).daily.map((d) => d.url);
    assert.deepEqual(a, b);
  });

  it("CSV sai com o cabeçalho da planilha e uma linha por post", () => {
    const csv = weekCsv(selectWeek(mergePosts(collabs, posts), weekDays()).rows).trimEnd().split("\n");
    assert.equal(csv[0], "dia_desafio;data;hora_brt;conta;formato;link;no_formulario;inicio_do_texto");
    assert.equal(csv[1], "9;29/10;07:17;vjpixel (collab);reel;https://www.instagram.com/reel/DfExeVVqem3/;dia 9;");
    assert.equal(csv.length, 26);
  });
});

describe("entradas (#12347)", () => {
  it("--collab exige horário e URL de post do Instagram", () => {
    assert.throws(() => parseCollabArg("https://www.instagram.com/reel/DfExeVVqem3/"), /sem horário/);
    assert.throws(() => parseCollabArg("https://example.com/x@2026-10-29T07:17"), /não é de post/);
    assert.throws(() => parseCollabArg("https://www.instagram.com/reel/X/@29/10 07:17"), /horário inválido/);
    assert.equal(parseCollabArg("https://www.instagram.com/reel/X/@2026-10-29T07:17").timestamp, "2026-10-29T07:17:00-03:00");
  });

  it("mergePosts dedup pelo shortcode (collab vence a API)", () => {
    const api = postsFromGraphMedia([
      { permalink: "https://www.instagram.com/reel/AAA/", timestamp: "2026-10-29T10:00:00+0000", media_product_type: "REELS" },
    ]).posts;
    const col = [parseCollabArg("https://www.instagram.com/vjpixel/reel/AAA/@2026-10-29T07:00")];
    const merged = mergePosts(col, api);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].account, "vjpixel (collab)");
    assert.equal(canonicalPostUrl("https://www.instagram.com/p/XYZ/?igsh=1"), "XYZ");
  });

  it("postsFromGraphMedia descarta item sem permalink/timestamp", () => {
    const r = postsFromGraphMedia([{ timestamp: "2026-10-29T10:00:00+0000" }, { permalink: "x" }, null]);
    assert.deepEqual([r.posts.length, r.skipped], [0, 3]);
  });

  it("postsFromLocalRecord pega só Instagram publicado com URL", () => {
    const posts = postsFromLocalRecord({
      posts: [
        { platform: "instagram", status: "scheduled", url: null, scheduled_at: "2026-11-04T17:00:00-03:00" },
        { platform: "instagram", status: "published", url: null, published_at: "2026-11-04T12:12:23.680Z" },
        { platform: "threads", status: "published", url: "https://www.threads.net/x", published_at: "2026-11-04T12:00:00Z" },
      ],
      entries: [
        { destination: "instagram", status: "published", url: "https://www.instagram.com/reel/DfUJHiND6EE/", at: "2026-11-04T09:33:21.081Z" },
        { destination: "tiktok", status: "published", url: "https://tiktok.com/x", at: "2026-11-04T09:51:22Z" },
      ],
    });
    assert.deepEqual(posts.map((p) => [p.url, p.format]), [["https://www.instagram.com/reel/DfUJHiND6EE/", "reel"]]);
  });

  it("captionStart corta na 1ª linha, sem ';'", () => {
    assert.equal(captionStart("Linha um; com ponto e vírgula\nsegunda"), "Linha um, com ponto e vírgula");
    assert.ok(captionStart("a ".repeat(60)).length <= 45);
  });

  it("parseCli: URL obrigatória, --collab/--print repetíveis", () => {
    assert.throws(() => parseCli([]), /tally-url/);
    const o = parseCli(["https://tally.so/r/abc", "--collab", "u1@x", "--collab=u2@y", "--print", "a.jpg"]);
    assert.equal(o.tallyUrl, "https://tally.so/r/abc");
    assert.deepEqual(o.collabs, ["u1@x", "u2@y"]);
    assert.deepEqual(o.prints, ["a.jpg"]);
    assert.throws(() => parseCli(["--tally-url", "u", "--bogus"]), /desconhecido/);
  });
});

describe("summarizeYoutubeSubs (#12347)", () => {
  const jsonl = [
    '{"capturedAt":"2026-11-03T10:00:00Z","day":"2026-11-02","subscribersGained":1}',
    '{"capturedAt":"2026-11-05T10:00:00Z","day":"2026-11-02","subscribersGained":3}',
    '{"capturedAt":"2026-11-05T10:00:00Z","day":"2026-11-03","subscribersGained":2}',
    "lixo",
  ].join("\n");

  it("usa o snapshot mais recente de cada dia", () => {
    assert.deepEqual(summarizeYoutubeSubs(jsonl, "2026-11-02", "2026-11-03"), {
      complete: true,
      value: 5,
      from: "2026-11-02",
      to: "2026-11-03",
      missingDays: [],
    });
  });

  it("dia ausente vai em missingDays", () => {
    const r = summarizeYoutubeSubs(jsonl, "2026-11-02", "2026-11-04");
    assert.deepEqual([r.value, r.missingDays], [5, ["2026-11-04"]]);
    assert.equal(summarizeYoutubeSubs("", "2026-11-02", "2026-11-02").value, null);
  });
});

describe("fallback local não vira resposta (#12347, review P1)", () => {
  const local = postsFromLocalRecord({
    entries: [
      { destination: "instagram", status: "published", url: "https://www.instagram.com/reel/DfUJHiND6EE/", at: "2026-11-04T09:33:21.081Z" },
    ],
  });

  it("com postsSource local, nenhum daily[] sai com url; o achado vai em candidate", () => {
    const sel = selectWeek(local, weekDays());
    const daily = dailyLinks(sel.daily, "local");
    assert.ok(daily.every((d) => d.url === null && d.verified === false));
    const d15 = daily.find((d) => d.dayNum === 15)!;
    assert.ok(!d15.verified && d15.candidate === "https://www.instagram.com/reel/DfUJHiND6EE/");
  });

  it("com postsSource graph, daily[] passa intacto", () => {
    const sel = selectWeek(postsFromGraphMedia(GRAPH).posts, weekDays());
    assert.deepEqual(dailyLinks(sel.daily, "graph"), sel.daily);
  });

  it("buildPlan local: dailyVerified false e uma falta por dia, citando o candidato", () => {
    const plan = buildPlan(planInput({ postsSource: "local", selection: selectWeek(local, weekDays()) }));
    assert.equal(plan.dailyVerified, false);
    const unverified = plan.missing.filter((m) => /NÃO VERIFICADO/.test(m));
    assert.equal(unverified.length, 7);
    assert.ok(unverified.some((m) => m.includes("dia 15") && m.includes("DfUJHiND6EE")));
  });
});

function planInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    generatedAt: "2026-11-06T12:00:00.000Z",
    tallyUrl: "https://tally.so/r/abc",
    semana: 2,
    title: "Desafio Mandala Mão na Massa - Semana 2",
    period: { from: "2026-10-29", to: "2026-11-04" },
    contatoFile: "/home/x/.config/diaria/mandala-contato.json",
    contato: { email: "editor-segredo@example.com", telefone: "+55 11 98888-7777" },
    postsSource: "graph",
    postsSourceNote: null,
    selection: selectWeek(postsFromGraphMedia(GRAPH).posts, weekDays()),
    instagram: { source: "insights", value: 42, from: "2026-10-29", to: "2026-11-04" },
    youtube: { complete: true, value: 19, from: "2026-10-29", to: "2026-11-04", missingDays: [] },
    prints: [],
    csvPath: "data/desafio-mandala/semana2.csv",
    missing: [],
    ...over,
  };
}

describe("buildPlan — contato fora do plano (#12347, review P2a)", () => {
  it("o plano serializado não contém e-mail nem telefone, só a presença", () => {
    const plan = buildPlan(planInput());
    const json = JSON.stringify(plan);
    assert.ok(!json.includes("editor-segredo@example.com"));
    assert.ok(!json.includes("98888-7777"));
    assert.deepEqual(plan.contato, { file: "/home/x/.config/diaria/mandala-contato.json", email_ok: true, telefone_ok: true });
    assert.equal(plan.dailyVerified, true);
  });

  it("contato ausente vira falta, sem valor no plano", () => {
    const plan = buildPlan(planInput({ contato: { email: null, telefone: null } }));
    assert.deepEqual([plan.contato.email_ok, plan.contato.telefone_ok], [false, false]);
    assert.ok(plan.missing.some((m) => /e-mail do Fluxer/.test(m)));
    assert.ok(plan.missing.some((m) => /telefone do grupo/.test(m)));
  });
});

describe("Graph API — 200 sem data é erro (#12347, review P2b)", () => {
  it("readGraphPage: corpo ilegível ou sem data em array = erro; data [] = página vazia", () => {
    assert.equal(readGraphPage(null).ok, false);
    assert.equal(readGraphPage({ paging: {} }).ok, false);
    assert.equal(readGraphPage({ data: "x" }).ok, false);
    assert.deepEqual(readGraphPage({ data: [] }), { ok: true, data: [], rawCount: 0, next: null });
  });

  const res = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
  const env = { id: "1", token: "t" };

  it("fetchGraphPosts: 200 com corpo sem data devolve erro (cai no local), não semana vazia", async () => {
    const r = await fetchGraphPosts("2026-10-29T00:00:00-03:00", env, (async () => res({ foo: 1 })) as typeof fetch);
    assert.match(r.error ?? "", /sem o campo data/);
  });

  it("fetchGraphPosts: 200 com JSON ilegível devolve erro", async () => {
    const bad = { ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } } as unknown as Response;
    const r = await fetchGraphPosts("2026-10-29T00:00:00-03:00", env, (async () => bad) as typeof fetch);
    assert.match(r.error ?? "", /ilegível/);
  });

  it("fetchGraphPosts: soma skipped e segue paginando quando a página só tem itens inválidos", async () => {
    const pages = [
      { data: [{ timestamp: "2026-11-04T10:00:00+0000" }], paging: { next: "p2" } },
      { data: [{ permalink: "https://www.instagram.com/p/A/", timestamp: "2026-10-28T10:00:00+0000" }] },
    ];
    let i = 0;
    const r = await fetchGraphPosts("2026-10-29T00:00:00-03:00", env, (async () => res(pages[i++])) as typeof fetch);
    assert.equal(r.error, null);
    assert.deepEqual([r.posts.length, r.skipped, r.truncated, i], [1, 1, false, 2]);
  });

  it("fetchGraphPosts: teto de páginas com next pendente marca truncated", async () => {
    const page = { data: [{ permalink: "https://www.instagram.com/p/A/", timestamp: "2026-11-04T10:00:00+0000" }], paging: { next: "again" } };
    const r = await fetchGraphPosts("2026-10-29T00:00:00-03:00", env, (async () => res(page)) as typeof fetch);
    assert.equal(r.truncated, true);
  });
});

describe("total de novos seguidores (#12347, review P2c)", () => {
  const ytFull = { complete: true as const, value: 19, from: "a", to: "b", missingDays: [] as [] };
  it("parte nula não vira 0: total null", () => {
    assert.deepEqual(combineNewFollowers({ source: "insights", value: 42 }, youtubeSubsUnavailable("2026-10-29", "2026-11-04")), {
      total: null,
      totalComplete: false,
    });
    assert.deepEqual(combineNewFollowers({ source: "net-balance", value: null }, ytFull), { total: null, totalComplete: false });
  });
  it("partes presentes mas parciais: soma com totalComplete false", () => {
    assert.deepEqual(combineNewFollowers({ source: "net-balance", value: 30 }, ytFull), { total: 49, totalComplete: false });
    assert.deepEqual(
      combineNewFollowers({ source: "insights", value: 42 }, { complete: false, value: 10, from: "a", to: "b", missingDays: ["x"] }),
      { total: 52, totalComplete: false },
    );
  });
  it("IG bruto + YouTube completo: totalComplete true; buildPlan não acusa falta", () => {
    assert.deepEqual(combineNewFollowers({ source: "insights", value: 42 }, ytFull), { total: 61, totalComplete: true });
    assert.ok(!buildPlan(planInput()).missing.some((m) => /pergunta 12/.test(m)));
  });
  it("YouTube ausente: todos os dias do período em missingDays", () => {
    assert.equal(youtubeSubsUnavailable("2026-10-29", "2026-11-04").missingDays.length, 7);
  });
});

describe("validações de entrada (#12347, review P2d/P2e/P3)", () => {
  it("--collab com horário impossível é erro citando o argumento, não RangeError", () => {
    for (const bad of ["2026-02-31T07:17", "2026-10-29T25:00", "2026-10-29T07:61", "2026-13-01T07:00"]) {
      const arg = `https://www.instagram.com/reel/X/@${bad}`;
      assert.throws(() => parseCollabArg(arg), (e: Error) => !(e instanceof RangeError) && e.message.includes(arg));
    }
  });

  it("resolveDdmm rejeita 31/02 e aceita 29/02 só em ano bissexto", () => {
    assert.throws(() => resolveDdmm("31/02", NOW), /não existe/);
    assert.throws(() => resolveDdmm("29/02", NOW), /não existe/);
    assert.equal(resolveDdmm("29/02", new Date("2028-03-05T12:00:00Z")), "2028-02-29");
  });

  it("registro local via Worker usa scheduled_at, não a hora da reconciliação", () => {
    const [p] = postsFromLocalRecord({
      posts: [
        {
          platform: "instagram",
          status: "published",
          url: "https://www.instagram.com/p/AAA/",
          scheduled_at: "2026-11-04T09:00:00-03:00",
          worker_queue_key: "queue:x",
          published_at: "2026-11-04T12:12:23.680Z",
        },
      ],
    });
    assert.equal(p.timestamp, "2026-11-04T09:00:00-03:00");
  });

  it("isLocalRecordFile ignora backups", () => {
    assert.equal(isLocalRecordFile("06-social-published.json"), true);
    assert.equal(isLocalRecordFile("06-social-published.bkp.json"), false);
    assert.equal(isLocalRecordFile("06-social-published-bak.json"), false);
  });

  it("checkFormConsistency: DD/MM repetido e --semana divergente são erro", () => {
    const f = parseTallyForm(TALLY_HTML);
    assert.equal(checkFormConsistency(f, null), 2);
    assert.equal(checkFormConsistency(f, 2), 2);
    assert.throws(() => checkFormConsistency(f, 3), /não bate/);
    const dup = { ...f, days: [...f.days, { dayNum: 16, ddmm: "04/11", question: "q" }] };
    assert.throws(() => checkFormConsistency(dup, null), /duas perguntas/);
    assert.throws(() => checkFormConsistency({ ...f, semana: null }, null), /--semana/);
  });
});
