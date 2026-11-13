/**
 * #12958: o alarme de defasagem das páginas de entidade só lia título e
 * subtítulo do cache e não via 23 das 33 menções do lote brasileiro (#8350).
 * O scanner de texto completo lê o HTML do site, descontando rodapé de links
 * ("Mais sobre…", "Anterior/Próxima") e o concurso de erros.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  computeFullTextCoverage,
  extractEditionBodyText,
  findFullTextStaleMentions,
  loadSiteEditions,
  type SiteEdition,
} from "../scripts/lib/entity-fulltext-scan.ts";
import { mergeStaleEntityEditions, BODY_ONLY_COVERAGE_SLUGS, findStaleEntityMentions } from "../scripts/lib/entity-staleness-check.ts";
import { ENTITY_EXCLUDED_EDITIONS, ENTITY_FULLTEXT_SCAN_SINCE, ENTITY_KEYWORD_PATTERNS } from "../scripts/lib/entities/patterns.ts";
import { ENTITY_LOADERS } from "../scripts/build-entity-page.ts";
import type { RawCachedPost } from "../scripts/generate-arquivo-titles.ts";
import type { PublishDateOverridesResult } from "../scripts/lib/beehiiv-publish-date.ts";

function page(opts: { date?: string; title?: string; body: string }): string {
  return [
    "<!doctype html><html><head>",
    `<title>${opts.title ?? "Edição"}</title>`,
    opts.date ? `<meta property="article:published_time" content="${opts.date}">` : "",
    '<script type="application/ld+json">{"about":"TSE"}</script>',
    "</head><body>",
    '<nav class="archive-nav"><a href="/p/x" rel="prev">Anterior: TSE multa partido por deepfake</a></nav>',
    opts.body,
    '<p style="x">Mais sobre Brasil e regulação:</p><table role="presentation"><tr><td><a href="/p/y">Nubank lança assistente (01/01/2026)</a></td></tr></table>',
    "</body></html>",
  ].join("");
}

const NOV = "2026-11-20";
const since = { tse: "2026-11-12", nubank: "2026-11-12" };
const none = { tse: new Set<string>(), nubank: new Set<string>() };

describe("#12958: extractEditionBodyText", () => {
  it("descarta head, script, nav (Anterior/Próxima), 'Mais sobre…' e o concurso de erros", () => {
    const text = extractEditionBodyText(
      page({
        body:
          "<p>OpenAI lança modelo novo.</p>" +
          "<p>Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição. Na última edição, no texto sobre o <b>TSE</b>, chamei ele de STF.</p>" +
          "<p>Uma pequena errata: o Nubank não é banco digital.</p>",
      }),
    );
    assert.match(text, /OpenAI lanca modelo novo/);
    assert.doesNotMatch(text, /tse/i);
    assert.doesNotMatch(text, /nubank/i);
  });

  it("mantém o corpo e o Radar, sem acento e com entidades HTML decodificadas", () => {
    const text = extractEditionBodyText(page({ body: "<p>O Tribunal Superior Eleitoral&nbsp;aprovou regras.</p><p>RADAR: Nubank &amp; Itaú.</p>" }));
    assert.match(text, /Tribunal Superior Eleitoral aprovou/);
    assert.match(text, /Nubank & Itau/);
  });
});

describe("#12958: findFullTextStaleMentions", () => {
  const ed = (editionSlug: string, date: string | null, body: string): SiteEdition => ({
    editionSlug,
    date,
    title: editionSlug,
    html: page({ ...(date ? { date } : {}), body }),
  });

  it("menção nova só no CORPO alarma (o cenário da issue: título não cita o TSE)", () => {
    const eds = [ed("openai-lanca-modelo", NOV, "<p>No Brasil, o TSE abriu consulta sobre IA nas eleições.</p>")];
    const { stale } = findFullTextStaleMentions(eds, ENTITY_KEYWORD_PATTERNS, since, none);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].entitySlug, "tse");
    assert.equal(stale[0].editionSlug, "openai-lanca-modelo");
    assert.match(stale[0].matchedHeadlines[0], /TSE abriu consulta.*texto completo/);
    // O alarme por título não veria esta edição.
    const posts: RawCachedPost[] = [
      { slug: "openai-lanca-modelo", title: "OpenAI lança modelo", status: "confirmed", publish_date: Date.parse(`${NOV}T12:00:00Z`) / 1000 },
    ];
    const noOverrides: PublishDateOverridesResult = { overrides: {}, discarded: [] };
    assert.equal(findStaleEntityMentions(posts, none, noOverrides).stale.length, 0);
  });

  it("menção só no rodapé (Anterior/Mais sobre) ou no concurso de erros não alarma", () => {
    const eds = [ed("so-rodape", NOV, "<p>OpenAI lança modelo.</p><p>Na última edição, escrevi 'Nubak', quando o certo é Nubank.</p>")];
    assert.deepEqual(findFullTextStaleMentions(eds, ENTITY_KEYWORD_PATTERNS, since, none).stale, []);
  });

  it("antes do corte, já no mentions, excluída de propósito ou sem data: não alarma", () => {
    const body = "<p>O TSE aprovou regras.</p>";
    const eds = [ed("antiga", "2026-05-14", body), ed("conhecida", NOV, body), ed("excluida", NOV, body), ed("sem-data", null, body)];
    const r = findFullTextStaleMentions(eds, ENTITY_KEYWORD_PATTERNS, since, { ...none, tse: new Set(["conhecida"]) }, { tse: ["excluida"] });
    assert.deepEqual(r.stale, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /sem-data/);
  });

  it("mergeStaleEntityEditions não duplica a edição vista pelo título e pelo texto completo", () => {
    const a = { entitySlug: "tse", date: NOV, editionSlug: "e", matchedHeadlines: ["TSE (título)"] };
    const b = { entitySlug: "tse", date: NOV, editionSlug: "e", matchedHeadlines: ["… (texto completo)"] };
    const c = { entitySlug: "nubank", date: "2026-11-13", editionSlug: "f", matchedHeadlines: ["x"] };
    assert.deepEqual(mergeStaleEntityEditions([a], [b, c]), [c, a]);
  });

  it("computeFullTextCoverage conta as menções publicadas que o texto completo vê", () => {
    const eds = [ed("com", NOV, "<p>O Nubank lançou.</p>"), ed("sem", NOV, "<p>Outro assunto.</p>")];
    assert.deepEqual(
      computeFullTextCoverage(eds, ENTITY_KEYWORD_PATTERNS, ["nubank"], { nubank: new Set(["com", "sem", "fora-do-site"]) }),
      { nubank: 1 },
    );
  });

  it("loadSiteEditions lê data e título da página; diretório ausente = []", () => {
    assert.deepEqual(loadSiteEditions(join(tmpdir(), "nao-existe-12958-xyz")), []);
    const dir = mkdtempSync(join(tmpdir(), "site-12958-"));
    mkdirSync(join(dir, "uma-edicao"));
    writeFileSync(join(dir, "uma-edicao", "index.html"), page({ date: NOV, title: "Uma edição &amp; outra", body: "<p>x</p>" }));
    const [e] = loadSiteEditions(dir);
    assert.equal(e.editionSlug, "uma-edicao");
    assert.equal(e.date, NOV);
    assert.equal(e.title, "Uma edição & outra");
  });
});

describe("#12958: configuração e corpus real", () => {
  it("ENTITY_FULLTEXT_SCAN_SINCE: só entidades reais com padrão, data YYYY-MM-DD; é a lista de cobertura", () => {
    for (const [slug, date] of Object.entries(ENTITY_FULLTEXT_SCAN_SINCE)) {
      assert.ok(slug in ENTITY_LOADERS, slug);
      assert.ok(slug in ENTITY_KEYWORD_PATTERNS, slug);
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.deepEqual([...BODY_ONLY_COVERAGE_SLUGS].sort(), Object.keys(ENTITY_FULLTEXT_SCAN_SINCE).sort());
  });

  it("no HTML real do site, o texto completo vê as menções publicadas que o título não via", () => {
    const eds = loadSiteEditions(resolve(import.meta.dirname, "..", "workers/site/public/p"));
    assert.ok(eds.length > 300, `esperava o arquivo do site, achei ${eds.length} edições`);
    const known: Record<string, Set<string>> = {};
    for (const slug of Object.keys(ENTITY_FULLTEXT_SCAN_SINCE)) {
      known[slug] = new Set(ENTITY_LOADERS[slug]().mentions.map((m) => m.editionUrl.replace(/^https:\/\/diar\.ia\.br\/p\//, "")));
    }
    const cov = computeFullTextCoverage(eds, ENTITY_KEYWORD_PATTERNS, Object.keys(known), known);
    // Medido em 13/11/2026: tse 10/10, nubank 7/7, maritaca-ai 4/4, pl-2338 9/12
    // (3 menções do PL citam "PL da IA"/relator, fora da família estreita do alarme).
    assert.equal(cov.tse, known.tse.size);
    assert.equal(cov.nubank, known.nubank.size);
    assert.equal(cov["maritaca-ai"], known["maritaca-ai"].size);
    assert.ok(cov["pl-2338"] >= 9, `pl-2338: ${cov["pl-2338"]}`);
    // Sem corte, só as 2 edições lidas e descartadas no #8350 ficam fora do mentions.
    const noCut = Object.fromEntries(Object.keys(known).map((s) => [s, "0000-00-00"]));
    const all = findFullTextStaleMentions(eds.filter((e) => (e.date ?? "") < "2026-11-12"), ENTITY_KEYWORD_PATTERNS, noCut, known, ENTITY_EXCLUDED_EDITIONS);
    assert.deepEqual(all.stale.map((s) => `${s.entitySlug}:${s.editionSlug}`).sort(), [
      "nubank:openai-cria-assistente-proativo",
      "pl-2338:advogadas-paraenses-multadas-por-burlar-ia",
    ]);
  });
});
