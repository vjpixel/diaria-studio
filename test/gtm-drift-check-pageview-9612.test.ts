/**
 * test/gtm-drift-check-pageview-9612.test.ts (#9612)
 *
 * Eixo `meta-pageview-scope` do drift-check do GTM: a tag Meta PageView do
 * container não pode disparar nas páginas que já têm o pixel inline
 * (`diar.ia.br/evento/agente-ia/*`, #9590). Nunca bate rede: o `gtm.js` é uma
 * fixture com o formato `var data = {"resource": {macros, tags, predicates,
 * rules}}` do compilador do Tag Manager, montada a partir do container medido
 * em 05/10/2026 (tabela da PR #9611): PageView (tag_id 21) em `gtm.init` E
 * hostname `^(cursos|livros)\.diar\.ia\.br$`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateGtmDrift,
  evaluateMetaPageViewScope,
  extractGtmResource,
  hasGtmDrift,
  isMetaPageViewTag,
  type GtmExpectedConfig,
} from "../scripts/lib/gtm-drift-check.ts";
import {
  findInlinePixelPageUrls,
  hasInlinePixelAndGtm,
  sitePublicPathToUrl,
} from "../scripts/gtm-drift-check.ts";

const EVENTO_URLS = ["a", "b", "c", "d"].map((v) => `https://diar.ia.br/evento/agente-ia/${v}/`);

interface FixtureOpts {
  /** Predicados da regra que adiciona a tag PageView (índices em `predicates`). */
  pageViewIf?: number[];
  pageViewUnless?: number[];
  extraPredicates?: Record<string, unknown>[];
  extraMacros?: Record<string, unknown>[];
  pageViewTag?: Record<string, unknown>;
}

/** macros: 0=__e, 1=Page Hostname, 2=Page Path.
 *  predicates: 0=event gtm.init, 1=host ^(cursos|livros)..., 2=event gtm.js,
 *  3=path /confirmada, 4=event signedUp (+ extras a partir do 5). */
function buildGtmJs(opts: FixtureOpts = {}): string {
  const macros = [
    { function: "__e" },
    { function: "__u", vtp_component: "HOST", vtp_enableMultiQueryKeys: false },
    { function: "__u", vtp_component: "PATH", vtp_enableMultiQueryKeys: false },
    ...(opts.extraMacros ?? []),
  ];
  const predicates = [
    { function: "_eq", arg0: ["macro", 0], arg1: "gtm.init" },
    { function: "_re", arg0: ["macro", 1], arg1: "^(cursos|livros)\\.diar\\.ia\\.br$", ignore_case: true },
    { function: "_eq", arg0: ["macro", 0], arg1: "gtm.js" },
    { function: "_cn", arg0: ["macro", 2], arg1: "/confirmada" },
    { function: "_eq", arg0: ["macro", 0], arg1: "signedUp" },
    ...(opts.extraPredicates ?? []),
  ];
  const tags = [
    // 0 — Meta PageView (tag_id 21)
    opts.pageViewTag ?? {
      function: "__cvt_5RM3Q",
      vtp_pixelId: "1285191740325112",
      vtp_eventName: "standard",
      vtp_standardEventName: "PageView",
      tag_id: 21,
    },
    // 1 — Meta CompleteRegistration (tag_id 16)
    {
      function: "__cvt_5RM3Q",
      vtp_pixelId: "1285191740325112",
      vtp_standardEventName: "CompleteRegistration",
      vtp_eventId: ["macro", 0],
      tag_id: 16,
    },
    // 2 — Google tag (todas as páginas)
    { function: "__googtag", vtp_tagId: "AW-17790097065", tag_id: 3 },
    // 3 — Meta Lead em /confirmada (tag_id 25)
    { function: "__cvt_5RM3Q", vtp_pixelId: "1285191740325112", vtp_standardEventName: "Lead", tag_id: 25 },
  ];
  const pvRule: unknown[] = [["if", ...(opts.pageViewIf ?? [0, 1])]];
  if (opts.pageViewUnless) pvRule.push(["unless", ...opts.pageViewUnless]);
  pvRule.push(["add", 0]);
  const rules = [pvRule, [["if", 4], ["add", 1]], [["if", 0], ["add", 2]], [["if", 2, 3], ["add", 3]]];
  const data = { resource: { version: "42", macros, tags, predicates, rules }, runtime: [[50, "__cvt_5RM3Q", [46, "a"], [52, "b", "{}"]]] };
  return `(function(){\nvar data = ${JSON.stringify(data, null, 1)};\nvar ba,ca=function(a){return a}})();`;
}

describe("#9612 — extractGtmResource", () => {
  it("parseia o resource mesmo com chaves/aspas escapadas dentro de strings", () => {
    const res = extractGtmResource(buildGtmJs());
    assert.ok(res);
    assert.equal(res.tags.length, 4);
    assert.equal(res.predicates[1].arg1, "^(cursos|livros)\\.diar\\.ia\\.br$");
  });

  it("devolve null (sem lançar) em texto sem resource ou truncado", () => {
    assert.equal(extractGtmResource(""), null);
    assert.equal(extractGtmResource('var data = {"resource": {"tags": [ {'), null);
    assert.equal(extractGtmResource('"resource": {"tags": 1}'), null);
  });
});

describe("#9612 — isMetaPageViewTag", () => {
  it("template oficial com PageView e Custom HTML com fbq PageView contam; CompleteRegistration não", () => {
    assert.equal(isMetaPageViewTag({ function: "__cvt_5RM3Q", vtp_standardEventName: "PageView" }), true);
    assert.equal(isMetaPageViewTag({ function: "__html", vtp_html: "<script>fbq('track', 'PageView');</script>" }), true);
    assert.equal(isMetaPageViewTag({ function: "__cvt_5RM3Q", vtp_standardEventName: "CompleteRegistration" }), false);
  });
});

describe("#9612 — evaluateMetaPageViewScope", () => {
  it("container de 05/10/2026 (PageView só em cursos|livros): match nas 4 páginas do evento", () => {
    const r = evaluateMetaPageViewScope(buildGtmJs(), EVENTO_URLS);
    assert.equal(r.status, "match", r.message);
  });

  it("REGRESSÃO DO RISCO DA ISSUE: gatilho ampliado pra All Pages (gtm.js sem filtro de host) vira mismatch", () => {
    const r = evaluateMetaPageViewScope(buildGtmJs({ pageViewIf: [2] }), EVENTO_URLS);
    assert.equal(r.status, "mismatch", r.message);
    assert.match(r.message, /tag_id 21/);
    assert.match(r.message, /\/evento\/agente-ia\/a\//);
    assert.match(r.message, /gtm\.js/);
  });

  it("Initialization - All Pages (gtm.init sem host) também vira mismatch", () => {
    const r = evaluateMetaPageViewScope(buildGtmJs({ pageViewIf: [0] }), EVENTO_URLS);
    assert.equal(r.status, "mismatch");
  });

  it("filtro de hostname incluindo diar.ia.br vira mismatch", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [0, 5],
        extraPredicates: [{ function: "_ew", arg0: ["macro", 1], arg1: "diar.ia.br" }],
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "mismatch");
  });

  it("All Pages com exceção (unless) pra /evento/ continua match", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [2],
        pageViewUnless: [5],
        extraPredicates: [{ function: "_sw", arg0: ["macro", 2], arg1: "/evento/" }],
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "match", r.message);
  });

  it("predicado negado (negate) é respeitado", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [2, 5],
        extraPredicates: [{ function: "_cn", arg0: ["macro", 2], arg1: "/evento/", negate: true }],
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "match", r.message);
  });

  it("macro que o simulador não entende (ex: cookie) vira not-found, nunca mismatch", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [2, 5],
        extraMacros: [{ function: "__k", vtp_name: "_fbp" }],
        extraPredicates: [{ function: "_eq", arg0: ["macro", 3], arg1: "x" }],
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "not-found", r.message);
  });

  it("um predicado conhecidamente falso decide mesmo com outro desconhecido (AND)", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [1, 5],
        extraMacros: [{ function: "__k", vtp_name: "_fbp" }],
        extraPredicates: [{ function: "_eq", arg0: ["macro", 3], arg1: "x" }],
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "match", r.message);
  });

  it("Custom HTML com fbq PageView em All Pages vira mismatch", () => {
    const r = evaluateMetaPageViewScope(
      buildGtmJs({
        pageViewIf: [2],
        pageViewTag: { function: "__html", vtp_html: "<script>fbq('track','PageView')</script>", tag_id: 30 },
      }),
      EVENTO_URLS,
    );
    assert.equal(r.status, "mismatch");
  });

  it("lista de páginas vazia, resource ausente ou container sem tag Meta → not-found", () => {
    assert.equal(evaluateMetaPageViewScope(buildGtmJs(), []).status, "not-found");
    assert.equal(evaluateMetaPageViewScope("nada aqui", EVENTO_URLS).status, "not-found");
    const semMeta = JSON.stringify({ resource: { macros: [], tags: [{ function: "__googtag" }], predicates: [], rules: [] } });
    assert.equal(evaluateMetaPageViewScope(`var data = ${semMeta};`, EVENTO_URLS).status, "not-found");
  });

  it("mensagem de mismatch é determinística (vira fingerprint do alarme)", () => {
    const a = evaluateMetaPageViewScope(buildGtmJs({ pageViewIf: [2] }), EVENTO_URLS);
    const b = evaluateMetaPageViewScope(buildGtmJs({ pageViewIf: [2] }), [...EVENTO_URLS].reverse());
    assert.equal(a.message, b.message);
  });
});

describe("#9612 — evaluateGtmDrift integra o eixo", () => {
  const base: GtmExpectedConfig = { pixelId: "1285191740325112", eventName: "CompleteRegistration", value: "1", currency: "BRL" };

  it("sem inlinePixelPageUrls o eixo não roda (compatível com os 5 eixos do #8585)", () => {
    const results = evaluateGtmDrift(buildGtmJs(), base);
    assert.equal(results.some((r) => r.check === "meta-pageview-scope"), false);
  });

  it("com as páginas, PageView ampliado vira drift acionável", () => {
    const results = evaluateGtmDrift(buildGtmJs({ pageViewIf: [2] }), { ...base, inlinePixelPageUrls: EVENTO_URLS });
    const axis = results.find((r) => r.check === "meta-pageview-scope");
    assert.equal(axis?.status, "mismatch");
    assert.equal(hasGtmDrift(results), true);
  });
});

describe("#9612 — scanner de páginas com pixel inline + GTM", () => {
  it("sitePublicPathToUrl mapeia index.html pro diretório", () => {
    assert.equal(sitePublicPathToUrl("evento/agente-ia/a/index.html"), "https://diar.ia.br/evento/agente-ia/a/");
    assert.equal(sitePublicPathToUrl("index.html"), "https://diar.ia.br/");
    assert.equal(sitePublicPathToUrl("x/pagina.html"), "https://diar.ia.br/x/pagina.html");
  });

  it("hasInlinePixelAndGtm exige as duas coisas", () => {
    assert.equal(hasInlinePixelAndGtm("fbq('track', 'PageView'); GTM-TC8C65ZN"), true);
    assert.equal(hasInlinePixelAndGtm("fbq('track', 'PageView');"), false);
    assert.equal(hasInlinePixelAndGtm("GTM-TC8C65ZN"), false);
  });

  it("diretório temporário: acha só a página com as duas coisas; diretório ausente → []", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtm-9612-"));
    try {
      mkdirSync(join(dir, "evento", "x"), { recursive: true });
      writeFileSync(join(dir, "evento", "x", "index.html"), "<script>fbq('track','PageView')</script>GTM-TC8C65ZN");
      writeFileSync(join(dir, "index.html"), "GTM-TC8C65ZN");
      assert.deepEqual(findInlinePixelPageUrls(dir), ["https://diar.ia.br/evento/x/"]);
      assert.deepEqual(findInlinePixelPageUrls(join(dir, "nao-existe")), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repo real: as 4 variantes de evento/agente-ia entram no eixo (o índice, que só redireciona, não)", () => {
    const urls = findInlinePixelPageUrls();
    for (const u of EVENTO_URLS) assert.ok(urls.includes(u), `faltou ${u} em ${urls.join(", ")}`);
    assert.equal(urls.includes("https://diar.ia.br/evento/agente-ia/"), false);
  });
});
