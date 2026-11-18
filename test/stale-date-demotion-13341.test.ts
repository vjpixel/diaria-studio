/**
 * #13341 (resíduo da #13313): destaque com `date_unverified: true` e data
 * velha declarada no texto da página sai do top-3 já no Stage 1. Caso 261117:
 * D2 "introducing-gpt-6-sol-and-luna" (OpenAI), `date: 2026-11-14` com
 * `date_unverified: true`, e "Update on September 29, 2026" na página —
 * chegou ao gate 4 como D2.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  demoteStaleDateHighlights,
  staleDateCandidates,
  formatStaleDateNote,
  type StaleDateHighlight,
} from "../scripts/lib/stale-date-demotion.ts";
import { findSourceStaleDate, type SourceDateHit } from "../scripts/lib/stale-highlight.ts";
import { runStaleDateDemotion, makePageTextLoader, type PageTextLoader } from "../scripts/demote-stale-date-highlights.ts";
import { saveCachedBody } from "../scripts/lib/url-body-cache.ts";

const GPT6 = "https://openai.com/index/introducing-gpt-6-sol-and-luna/";
const LUPA = "https://www.agencialupa.org/observatorio/2026/10/19/desinformacao";
const G1 = "https://g1.globo.com/agentes-openai-invadiram";

function hl(rank: number, url: string, title: string, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): StaleDateHighlight {
  return { rank, score: 90 - rank, bucket: "radar", ...top, article: { url, title, date_unverified: false, ...extra } };
}

const hit = (iso: string, days: number, text = `Updated ${iso}`): SourceDateHit => ({ iso, days, text });

const HIGHLIGHTS = (): StaleDateHighlight[] => [
  hl(1, LUPA, "Desinformação em saúde", { date_unverified: true, negative_impact: true }),
  hl(2, GPT6, "OpenAI corta pela metade o preço do GPT-6", { date_unverified: true }),
  hl(3, G1, "Agentes da OpenAI invadiram sistemas", { negative_impact: true }),
  hl(4, "https://a.example/4", "Quarto"),
  hl(5, "https://a.example/5", "Quinto"),
  hl(6, "https://a.example/6", "Sexto"),
];

test("#13341: candidatos são só o top-3 com date_unverified", () => {
  const c = staleDateCandidates([...HIGHLIGHTS(), hl(7, "https://a.example/7", "Sétimo", { date_unverified: true })]);
  assert.deepEqual(c.map((h) => h.article?.url), [LUPA, GPT6]);
});

test("#13341 caso 261117: o D2 da OpenAI com data velha sai do top-3 e o 4º sobe", () => {
  const stale = new Map([[GPT6, hit("2026-09-29", 49, "Update on September 29, 2026")]]);
  const r = demoteStaleDateHighlights(HIGHLIGHTS(), stale);
  assert.deepEqual(r.highlights.slice(0, 3).map((h) => h.article?.url), [LUPA, G1, "https://a.example/4"]);
  assert.equal(r.highlights.length, 6, "nenhum item sai da edição");
  assert.deepEqual(r.highlights.map((h) => h.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.demoted.length, 1);
  assert.equal(r.demoted[0].from_rank, 2);
  assert.equal(r.demoted[0].replaced_by, "Quarto");
  const moved = r.highlights.find((h) => h.article?.url === GPT6)!;
  assert.deepEqual(moved.stale_date_demoted, { declared_iso: "2026-09-29", days: 49 });
  assert.match(formatStaleDateNote(r.demoted[0]), /DATA VELHA NA FONTE.*D2.*2026-09-29, 49 dias/);
});

test("#13341: sem data velha nada muda", () => {
  const input = HIGHLIGHTS();
  const r = demoteStaleDateHighlights(input, new Map());
  assert.deepEqual(r.highlights, input);
  assert.equal(r.demoted.length, 0);
});

test("#13341: pedido do editor nunca sai (só aviso)", () => {
  const h = HIGHLIGHTS();
  h[1] = hl(2, GPT6, "Pedido do editor", { date_unverified: true, flag: "editor_submitted" });
  const r = demoteStaleDateHighlights(h, new Map([[GPT6, hit("2026-09-29", 49)]]));
  assert.equal(r.highlights[1].article?.url, GPT6);
  assert.equal(r.demoted.length, 0);
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0].reason, /pedido do editor/);
});

// #13497: o campo guarda o slot ("d1"/"d2"/"d3", ou "destaque" sem posição),
// nunca `true` — o teste `=== true` não casava e a reserva era rebaixada.
for (const request of ["d1", "d2", "d3", "destaque"]) {
  test(`#13497: editor_destaque_request="${request}" é pedido do editor (só aviso)`, () => {
    const h = HIGHLIGHTS();
    h[1] = hl(2, GPT6, "Reserva do editor", { date_unverified: true, editor_destaque_request: request });
    const r = demoteStaleDateHighlights(h, new Map([[GPT6, hit("2026-09-29", 49)]]));
    assert.equal(r.highlights[1].article?.url, GPT6);
    assert.equal(r.demoted.length, 0);
    assert.equal(r.kept.length, 1);
    assert.match(r.kept[0].reason, /pedido do editor/);
  });
}

test("#13497: editor_destaque_request vazio não protege (o item velho sai)", () => {
  const h = HIGHLIGHTS();
  h[1] = hl(2, GPT6, "Sem pedido", { date_unverified: true, editor_destaque_request: "" });
  const r = demoteStaleDateHighlights(h, new Map([[GPT6, hit("2026-09-29", 49)]]));
  assert.equal(r.demoted.length, 1);
  assert.equal(r.demoted[0].url, GPT6);
});

test("#13341 / #3916: o único negativo do top-3 não sai sem substituto negativo", () => {
  const h = [
    hl(1, LUPA, "Negativo velho", { date_unverified: true, negative_impact: true }),
    hl(2, GPT6, "Positivo"),
    hl(3, G1, "Positivo 2"),
    hl(4, "https://a.example/4", "Quarto"),
  ];
  const r = demoteStaleDateHighlights(h, new Map([[LUPA, hit("2026-09-01", 77)]]));
  assert.ok(r.highlights.slice(0, 3).some((x) => x.article?.url === LUPA));
  assert.equal(r.demoted.length, 0);
  assert.match(r.kept[0].reason, /#3916/);
});

test("#13341 / #3916: com negativo limpo no pool, ele sobe no lugar do negativo velho", () => {
  const h = [
    hl(1, LUPA, "Negativo velho", { date_unverified: true, negative_impact: true }),
    hl(2, GPT6, "Positivo"),
    hl(3, G1, "Positivo 2"),
    hl(4, "https://a.example/4", "Quarto"),
    hl(5, "https://a.example/5", "Negativo novo", { negative_impact: true }),
  ];
  const r = demoteStaleDateHighlights(h, new Map([[LUPA, hit("2026-09-01", 77)]]));
  assert.deepEqual(r.highlights.slice(0, 3).map((x) => x.article?.url), [GPT6, G1, "https://a.example/5"]);
  assert.equal(r.demoted.length, 1);
});

test("#13341: com menos de 3 candidatos limpos o velho completa o top-3", () => {
  const h = [hl(1, LUPA, "A"), hl(2, GPT6, "Velho", { date_unverified: true }), hl(3, G1, "C")];
  const r = demoteStaleDateHighlights(h, new Map([[GPT6, hit("2026-09-29", 49)]]));
  assert.equal(r.highlights.length, 3);
  assert.equal(r.demoted.length, 0);
  assert.match(r.kept[0].reason, /insuficientes/);
});

test("#13341: item já rebaixado por outro passo nunca sobe por causa deste", () => {
  const h = [
    hl(1, LUPA, "A"),
    hl(2, GPT6, "Velho", { date_unverified: true }),
    hl(3, G1, "C"),
    hl(4, "https://a.example/4", "Mesmo fato", {}, { same_fact_demoted: { with: "x" } }),
    hl(5, "https://a.example/5", "Quinto"),
  ];
  const r = demoteStaleDateHighlights(h, new Map([[GPT6, hit("2026-09-29", 49)]]));
  assert.equal(r.highlights[2].article?.url, "https://a.example/5");
  assert.equal(r.highlights[4].article?.url, "https://a.example/4");
});

function withEdition(fn: (dir: string, categorizedPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "stale-date-13341-"));
  const categorizedPath = join(dir, "01-categorized.json");
  writeFileSync(categorizedPath, JSON.stringify({ highlights: HIGHLIGHTS(), radar: [] }, null, 2));
  return fn(dir, categorizedPath).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("#13341 ponta a ponta: o texto da página do D2 de 261117 rebaixa o D2 e anota a data", () =>
  withEdition(async (dir, categorizedPath) => {
    const pages: Record<string, string> = {
      [GPT6]: "Introducing GPT-6 Sol and Luna\n\nUpdate on September 29, 2026: GPT-6.1 Sol is now available.",
      [LUPA]: "Publicado: 19/10/2026 Atualizado: 19/10/2026 Da pandemia aos vídeos com IA",
    };
    const loadText: PageTextLoader = async (url) => ({ text: pages[url] ?? null, via: "cache" });
    const outLog = join(dir, "01-stale-date-demoted.json");
    const res = await runStaleDateDemotion({ categorizedPath, edition: "261117", loadText, outLog, rootDir: dir });
    assert.equal(res.error, undefined);
    assert.equal(res.examined, 2);
    assert.equal(res.resolved, 2);
    assert.equal(res.demoted, 1);
    const out = JSON.parse(readFileSync(categorizedPath, "utf8"));
    assert.deepEqual(out.highlights.slice(0, 3).map((h: StaleDateHighlight) => h.article?.url), [LUPA, G1, "https://a.example/4"]);
    // A Lupa (29 dias) fica no top-3, com a data declarada registrada.
    assert.deepEqual(out.highlights[0].article.declared_source_date, { iso: "2026-10-19", text: "Publicado: 19/10/2026", days: 29 });
    assert.ok(Array.isArray(out.radar), "o resto do JSON é preservado");
    const log = JSON.parse(readFileSync(outLog, "utf8"));
    assert.equal(log.demoted[0].url, GPT6);
    assert.ok(res.notes.some((n) => n.includes("OpenAI corta pela metade")));
  }));

test("#13341: página publicada há meses e atualizada há 2 dias não rebaixa (#13364)", () =>
  withEdition(async (_dir, categorizedPath) => {
    const loadText: PageTextLoader = async (url) => ({
      text: url === GPT6 ? "Published March 3, 2026. Updated November 15, 2026: preços novos." : null,
      via: "cache",
    });
    const res = await runStaleDateDemotion({ categorizedPath, edition: "261117", loadText });
    assert.equal(res.demoted, 0);
    const out = JSON.parse(readFileSync(categorizedPath, "utf8"));
    assert.equal(out.highlights[1].article.url, GPT6);
  }));

test("#13341: sem texto da página nada muda e o JSON não é regravado", () =>
  withEdition(async (_dir, categorizedPath) => {
    const before = readFileSync(categorizedPath, "utf8");
    const res = await runStaleDateDemotion({
      categorizedPath,
      edition: "261117",
      loadText: async () => ({ text: null, via: "fetch", error: "HTTP 403" }),
    });
    assert.equal(res.demoted, 0);
    assert.equal(readFileSync(categorizedPath, "utf8"), before);
  }));

test("#13341: JSON ilegível é fail-soft", () =>
  withEdition(async (dir, categorizedPath) => {
    writeFileSync(categorizedPath, "{nao é json");
    const res = await runStaleDateDemotion({ categorizedPath, edition: "261117", loadText: async () => ({ text: null, via: "none" }), rootDir: dir });
    assert.ok(res.error);
    assert.equal(res.demoted, 0);
  }));

test("#13341: dry-run não grava nada", () =>
  withEdition(async (dir, categorizedPath) => {
    const before = readFileSync(categorizedPath, "utf8");
    const outLog = join(dir, "log.json");
    const res = await runStaleDateDemotion({
      categorizedPath,
      edition: "261117",
      loadText: async (url) => ({ text: url === GPT6 ? "Update on September 29, 2026" : null, via: "cache" }),
      outLog,
      dryRun: true,
    });
    assert.equal(res.demoted, 1);
    assert.equal(readFileSync(categorizedPath, "utf8"), before);
    assert.ok(!existsSync(outLog));
  }));

test("#13341: o leitor de página usa o corpo em cache antes da rede", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-date-13341-cache-"));
  try {
    const bodies = join(dir, "bodies");
    mkdirSync(bodies);
    saveCachedBody(bodies, GPT6, "<html><body><p>Update on September 29, 2026: GPT-6.1</p><script>x</script></body></html>");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("<p>Atualizado em 03/03/2026</p>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const load = makePageTextLoader({ bodiesDir: bodies, fetchImpl });
    const cached = await load(GPT6);
    assert.equal(cached.via, "cache");
    assert.match(cached.text ?? "", /Update on September 29, 2026/);
    assert.equal(calls, 0);
    const fetched = await load("https://outro.example/x");
    assert.equal(fetched.via, "fetch");
    assert.equal(findSourceStaleDate(fetched.text ?? "", "261117")?.iso, "2026-03-03");
    assert.equal(calls, 1);
    const none = await makePageTextLoader({ bodiesDir: bodies, fetch: false, fetchImpl })("https://outro.example/y");
    assert.equal(none.text, null);
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
