/**
 * test/retrospectiva-seo-7720.test.ts (#7720)
 *
 * `retrospectiva.diar.ia.br/{AAMM,AAAA,aniversarioAAAA}` servia, pra quem NÃO
 * passou no gate, o HTML puro do e-mail — sem `<meta name="description">`,
 * `<link rel="canonical">` nem JSON-LD (`application/ld+json`), medido nas 5
 * páginas publicadas (#7720). Este teste cobre os dois lados:
 *
 *   1. `scripts/lib/shared/retrospectiva-seo.ts` — os helpers PUROS
 *      (`extractTitleText`, `deriveDescription`, `buildRetrospectivaJsonLd`,
 *      `injectRetrospectivaHeadMeta`).
 *   2. `workers/retrospectiva/src/index.ts` (`handleGet`) — os dois produtos
 *      NÃO levam o mesmo JSON-LD: `/AAMM` é paywall (`isAccessibleForFree:
 *      false` + `hasPart`), `/AAAA`/`/aniversarioAAAA` são cadastro grátis
 *      (`isAccessibleForFree: true`, sem `hasPart`) — #7658/#7715.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractTitleText,
  deriveDescription,
  buildRetrospectivaJsonLd,
  injectRetrospectivaHeadMeta,
} from "../scripts/lib/shared/retrospectiva-seo.ts";
import { handleGet, type Env } from "../workers/retrospectiva/src/index.ts";

// ── retrospectiva-seo.ts — funções puras ────────────────────────────────────

describe("extractTitleText (#7720)", () => {
  it("extrai o texto de <title>", () => {
    assert.equal(extractTitleText("<html><head><title>Retrospectiva de Julho</title></head></html>"), "Retrospectiva de Julho");
  });
  it("decodifica entidades comuns", () => {
    assert.equal(extractTitleText("<title>A &amp; B &mdash; teste</title>"), "A & B — teste");
  });
  it("sem <title> → null", () => {
    assert.equal(extractTitleText("<html><head></head></html>"), null);
  });
  it("<title></title> vazio → null", () => {
    assert.equal(extractTitleText("<title>   </title>"), null);
  });
});

describe("deriveDescription (#7720)", () => {
  it("extrai texto corrido do <body>, sem tags", () => {
    const html = "<html><head><title>X</title></head><body><h1>Título</h1><p>Este é o resumo real do conteúdo da edição, com bastante texto para testar o corte.</p></body></html>";
    const desc = deriveDescription(html);
    assert.ok(desc.includes("resumo real do conteúdo"), desc);
    assert.doesNotMatch(desc, /<[^>]+>/, "sem tags residuais");
  });
  it("trunca em ~155 chars, no limite de palavra, com reticências", () => {
    const longText = "palavra ".repeat(40).trim(); // bem acima de 155 chars
    const html = `<body><p>${longText}</p></body>`;
    const desc = deriveDescription(html);
    assert.ok(desc.length <= 156, `description tem ${desc.length} chars`);
    assert.match(desc, /…$/, "termina com reticências quando truncado");
    assert.doesNotMatch(desc, / $/, "sem espaço solto antes da reticência");
  });
  it("texto curto (abaixo do limite) não trunca nem adiciona reticências", () => {
    const html = "<body><p>Texto curto.</p></body>";
    assert.equal(deriveDescription(html), "Texto curto.");
  });
  it("<style>/<script> não vazam pro texto extraído", () => {
    const html = "<body><style>.x{color:red}</style><script>var x=1;</script><p>Conteúdo real.</p></body>";
    const desc = deriveDescription(html);
    assert.doesNotMatch(desc, /color:red|var x/);
    assert.match(desc, /Conteúdo real/);
  });
  it("teaser sem texto aproveitável → fallback genérico, nunca lança", () => {
    assert.doesNotThrow(() => deriveDescription("<body></body>"));
    assert.ok(deriveDescription("<body>   </body>").length > 0);
  });
});

describe("buildRetrospectivaJsonLd (#7720) — JSON válido nos dois formatos", () => {
  it("mensal (paywall): isAccessibleForFree false + hasPart com o selector", () => {
    const str = buildRetrospectivaJsonLd({
      headline: "Retrospectiva de Julho",
      description: "resumo",
      url: "https://retrospectiva.diar.ia.br/2607",
      isAccessibleForFree: false,
      paywallCssSelector: "#retrospectiva-paywall",
    });
    const obj = JSON.parse(str); // lança se não for JSON válido
    assert.equal(obj["@type"], "Article");
    assert.equal(obj.isAccessibleForFree, false);
    assert.deepEqual(obj.hasPart, {
      "@type": "WebPageElement",
      isAccessibleForFree: false,
      cssSelector: "#retrospectiva-paywall",
    });
  });
  it("anual/aniversário (cadastro grátis): isAccessibleForFree true, SEM hasPart", () => {
    const str = buildRetrospectivaJsonLd({
      headline: "Retrospectiva anual 2026",
      description: "resumo",
      url: "https://retrospectiva.diar.ia.br/2026",
      isAccessibleForFree: true,
    });
    const obj = JSON.parse(str);
    assert.equal(obj.isAccessibleForFree, true);
    assert.equal(obj.hasPart, undefined, "gate de cadastro não é paywall — sem hasPart");
  });
  it("isAccessibleForFree true + paywallCssSelector passado por engano → ainda sem hasPart", () => {
    const obj = JSON.parse(
      buildRetrospectivaJsonLd({
        headline: "h",
        description: "d",
        url: "https://x",
        isAccessibleForFree: true,
        paywallCssSelector: "#foo",
      }),
    );
    assert.equal(obj.hasPart, undefined);
  });
});

describe("injectRetrospectivaHeadMeta (#7720)", () => {
  it("injeta description/canonical/JSON-LD antes do </head>", () => {
    const html = "<html><head><title>X</title></head><body>corpo</body></html>";
    const jsonLd = buildRetrospectivaJsonLd({
      headline: "X",
      description: "desc",
      url: "https://retrospectiva.diar.ia.br/2607",
      isAccessibleForFree: false,
      paywallCssSelector: "#retrospectiva-paywall",
    });
    const out = injectRetrospectivaHeadMeta(html, {
      description: "descrição de teste",
      canonical: "https://retrospectiva.diar.ia.br/2607",
      jsonLd,
    });
    assert.match(out, /<meta name="description" content="descrição de teste" \/>/);
    assert.match(out, /<link rel="canonical" href="https:\/\/retrospectiva\.diar\.ia\.br\/2607" \/>/);
    assert.match(out, /<script type="application\/ld\+json">/);
    // JSON-LD embutido continua válido — extrai e reparsa.
    const scriptMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out);
    assert.ok(scriptMatch, "script tag presente");
    assert.doesNotThrow(() => JSON.parse(scriptMatch![1]));
    // Tudo entra ANTES do </head> — nada vaza pro <body>.
    const headEnd = out.indexOf("</head>");
    const bodyStart = out.indexOf("<body>");
    assert.ok(out.indexOf("descrição de teste") < headEnd);
    assert.ok(headEnd < bodyStart);
  });

  it("HTML sem </head> → fail-soft, devolve o HTML original sem lançar", () => {
    const html = "<html><body>sem head nenhum</body></html>";
    const out = injectRetrospectivaHeadMeta(html, {
      description: "x",
      canonical: "https://x",
      jsonLd: "{}",
    });
    assert.equal(out, html);
  });

  it("escapa </script> dentro do JSON-LD para não fechar a tag cedo", () => {
    const jsonLd = buildRetrospectivaJsonLd({
      headline: "Título com </script> literal",
      description: "d",
      url: "https://x",
      isAccessibleForFree: true,
    });
    const out = injectRetrospectivaHeadMeta("<head></head><body></body>", {
      description: "d",
      canonical: "https://x",
      jsonLd,
    });
    assert.doesNotMatch(out, /<\/script>[\s\S]*headline/, "não fecha a tag antes do fim do JSON");
  });

  it("usa o ÚLTIMO </head> quando o HTML cita a tag como exemplo antes do head real", () => {
    const html = "<p>exemplo: &lt;/head&gt; não conta</p><html><head><title>X</title></head><body>corpo</body></html>";
    const out = injectRetrospectivaHeadMeta(html, { description: "d", canonical: "https://x", jsonLd: "{}" });
    // A injeção deve acontecer no ÚLTIMO </head> real, não em qualquer match antecipado.
    const lastHeadClose = out.lastIndexOf("</head>");
    assert.ok(out.indexOf("<body>") > lastHeadClose - 1);
  });
});

// ── handleGet — os dois produtos NÃO levam o mesmo JSON-LD (#7658/#7715) ────

type MockKV = Map<string, string>;

const MENSAL_TEASER =
  "<html><head><title>Retrospectiva de Julho</title></head><body><h1>Julho em revisão</h1><p>O mês trouxe avanços importantes em modelos de linguagem e uma disputa regulatória na Europa.</p></body></html>";

const ANUAL_TEASER =
  "<html><head><title>Retrospectiva anual 2026</title></head><body><h1>2026 em revisão</h1><p>O ano consolidou a IA agêntica como o tema central da indústria, com impacto direto no mercado de trabalho.</p></body></html>";

function makeApoioEnv(articles: MockKV, allowlistRaw: string | null): Env {
  return {
    ARTICLES: { async get(key: string) { return articles.get(key) ?? null; } },
    ALLOWLIST: { async get(_key: string) { return allowlistRaw; } },
  } as unknown as Env;
}

function makeCadastroEnv(articles: MockKV): Env {
  return {
    ARTICLES: { async get(key: string) { return articles.get(key) ?? null; } },
    KIT_API_KEY: undefined, // sem key → fail-closed, cai no teaser (não precisamos do Kit pra este teste)
  } as unknown as Env;
}

describe("#7720 — /AAMM (mensal, paywall Mantenedor) leva isAccessibleForFree: false + hasPart", () => {
  it("página do não-apoiador tem os 3 sinais, com JSON-LD de paywall", async () => {
    const articles: MockKV = new Map([
      ["article:2607", "<html><body>artigo completo</body></html>"],
      ["article:2607:teaser", MENSAL_TEASER],
    ]);
    const env = makeApoioEnv(articles, JSON.stringify(["apoiador@x.com"])); // ninguém passa (sem ?email=)
    const res = await handleGet(new Request("https://retrospectiva.diar.ia.br/2607"), env);
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.match(body, /<meta name="description" content="[^"]+" \/>/);
    assert.match(body, /<link rel="canonical" href="https:\/\/retrospectiva\.diar\.ia\.br\/2607" \/>/);

    const scriptMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body);
    assert.ok(scriptMatch, "JSON-LD presente");
    const jsonLd = JSON.parse(scriptMatch![1]); // lança se JSON inválido
    assert.equal(jsonLd["@type"], "Article");
    assert.equal(jsonLd.isAccessibleForFree, false, "/AAMM é pago — Mantenedor R$25+");
    assert.equal(jsonLd.hasPart.cssSelector, "#retrospectiva-paywall");
    assert.equal(jsonLd.hasPart.isAccessibleForFree, false);

    // O artigo pago continua fora — a #7720 é só sobre SEO, não muda o gate.
    assert.doesNotMatch(body, /artigo completo</);
  });
});

describe("#7720 — /AAAA e /aniversarioAAAA (cadastro grátis) levam isAccessibleForFree: true, sem hasPart", () => {
  for (const slug of ["2026", "aniversario2026"]) {
    it(`${slug}: 3 sinais presentes, JSON-LD sem hasPart`, async () => {
      const articles: MockKV = new Map([[`article:${slug}:teaser`, ANUAL_TEASER]]);
      const env = makeCadastroEnv(articles);
      const res = await handleGet(new Request(`https://retrospectiva.diar.ia.br/${slug}`), env);
      assert.equal(res.status, 200);
      const body = await res.text();

      assert.match(body, /<meta name="description" content="[^"]+" \/>/);
      assert.match(body, new RegExp(`<link rel="canonical" href="https://retrospectiva\\.diar\\.ia\\.br/${slug}" />`));

      const scriptMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body);
      assert.ok(scriptMatch, "JSON-LD presente");
      const jsonLd = JSON.parse(scriptMatch![1]);
      assert.equal(jsonLd.isAccessibleForFree, true, "cadastro grátis, não paywall");
      assert.equal(jsonLd.hasPart, undefined, "sem hasPart — não é paywall");
    });
  }
});

describe("#7720 — description deriva do CONTEÚDO real, não da copy do bloco de conversão", () => {
  it("mensal: a description não é a copy do CTA de apoio", async () => {
    const articles: MockKV = new Map([[`article:2608:teaser`, MENSAL_TEASER]]);
    const env = makeApoioEnv(articles, JSON.stringify([]));
    const body = await (await handleGet(new Request("https://retrospectiva.diar.ia.br/2608"), env)).text();
    const m = /<meta name="description" content="([^"]+)" \/>/.exec(body);
    assert.ok(m);
    assert.doesNotMatch(m![1], /Apoiar a diar\.ia\.br/, "description não deve ser a copy do CTA");
  });
});
