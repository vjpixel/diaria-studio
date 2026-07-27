import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normUrl,
  slugifyAnchor,
  buildUrlToEdition,
  buildRelink,
  makeEditionUrlResolver,
  type RelinkMaps,
} from "../scripts/monthly-relink-to-diaria.ts";

// ---------------------------------------------------------------------------
// Guarda estrutural: importar este módulo NÃO pode rodar o script.
// Antes do review da PR #4066 o corpo do CLI era top-level — qualquer import
// lia data/monthly/… e SOBRESCREVIA o HTML de saída. Se este arquivo de teste
// carregou sem tocar em disco, a separação main()/isMainModule está de pé.
// ---------------------------------------------------------------------------

describe("normUrl", () => {
  it("ignora querystring de tracking (é o que dá identidade ao artigo)", () => {
    assert.equal(
      normUrl("https://exame.com/ia/x?utm_source=clarice&utm_term=topo"),
      normUrl("https://exame.com/ia/x"),
    );
  });

  it("ignora www., barra final e caixa", () => {
    assert.equal(normUrl("https://WWW.Exame.com/IA/X/"), normUrl("https://exame.com/ia/x"));
  });

  it("preserva querystring que NÃO é tracking (faz parte do artigo)", () => {
    assert.notEqual(normUrl("https://exame.com/p?id=1"), normUrl("https://exame.com/p?id=2"));
  });

  it("também descarta ?via= e ?ref= (usados nos links de parceiro)", () => {
    assert.equal(normUrl("https://clarice.ai/?via=diaria"), normUrl("https://clarice.ai/"));
  });

  it("string que não é URL não lança — cai no lowercase", () => {
    assert.equal(normUrl("{{ unsubscribe }}"), "{{ unsubscribe }}");
  });
});

describe("slugifyAnchor", () => {
  it("tira acento e pontuação, limita a 6 palavras", () => {
    assert.equal(
      slugifyAnchor("Fórum Econômico Mundial calculou que a América Latina pode perder"),
      "forum-economico-mundial-calculou-que-a",
    );
  });

  it("texto vazio devolve string vazia (chamador cai no fallback ed-AAMMDD)", () => {
    assert.equal(slugifyAnchor("   "), "");
    assert.equal(slugifyAnchor("—«»"), "");
  });

  it("não termina com hífen solto ao cortar pelo limite de caracteres", () => {
    const s = slugifyAnchor("abcdefghij klmnopqrst uvwxyzabcd efghijklmn opqrstuvwx");
    assert.ok(!s.endsWith("-"), `slug não deve terminar em hífen: ${s}`);
    assert.ok(s.length <= 44, `slug longo demais (${s.length}): ${s}`);
  });
});

describe("buildUrlToEdition", () => {
  it("mapeia url → edição e post id", () => {
    const { urlToEdition, editionToPostId } = buildUrlToEdition([
      { url: "https://exame.com/a", edition: "260601", beehiiv_post_id: "aaaa1111" },
    ]);
    assert.equal(urlToEdition.get(normUrl("https://exame.com/a")), "260601");
    assert.equal(editionToPostId.get("260601"), "aaaa1111");
  });

  it("REVIEW #4066: url em 2 edições vira aviso em `ambiguous`, não erro silencioso", () => {
    const { urlToEdition, ambiguous } = buildUrlToEdition([
      { url: "https://exame.com/a", edition: "260628" },
      { url: "https://exame.com/a", edition: "260605" },
    ]);
    assert.equal(urlToEdition.get(normUrl("https://exame.com/a")), "260628", "vence a primeira ocorrência");
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].editions, ["260605", "260628"]);
  });

  it("url que aparece 2× na MESMA edição não é ambígua", () => {
    const { ambiguous } = buildUrlToEdition([
      { url: "https://exame.com/a", edition: "260601" },
      { url: "https://exame.com/a?utm_source=x", edition: "260601" },
    ]);
    assert.equal(ambiguous.length, 0);
  });
});

describe("buildRelink", () => {
  const maps = (over: Partial<RelinkMaps> = {}): RelinkMaps => ({
    urlToEdition: new Map([[normUrl("https://exame.com/a"), "260601"]]),
    servicoUrls: new Set<string>(),
    editionUrl: (ed) => `https://diar.ia.br/p/edicao-${ed}`,
    ...over,
  });

  it("reescreve link de destaque com utm_term = slug do texto âncora", () => {
    const r = buildRelink(`<a href="https://exame.com/a">Brasil debate soberania</a>`, maps());
    assert.equal(r.relinked, 1);
    assert.match(r.html, /diar\.ia\.br\/p\/edicao-260601/);
    assert.match(r.html, /utm_term=brasil-debate-soberania/);
    assert.match(r.html, /utm_source=clarice/);
    assert.match(r.html, /utm_medium=email/);
  });

  it("preserva o texto âncora intacto", () => {
    const r = buildRelink(`<a href="https://exame.com/a">Brasil <b>debate</b> soberania</a>`, maps());
    assert.match(r.html, /Brasil <b>debate<\/b> soberania/);
  });

  it("Use Melhor / Radar ficam na fonte original (decisão do editor 260726)", () => {
    const r = buildRelink(
      `<a href="https://exame.com/a">Tutorial</a>`,
      maps({ servicoUrls: new Set([normUrl("https://exame.com/a")]) }),
    );
    assert.equal(r.relinked, 0);
    assert.equal(r.servico, 1);
    assert.match(r.html, /href="https:\/\/exame\.com\/a"/);
  });

  it("host da KEEP list nunca é reescrito", () => {
    const html = `<a href="https://clarice.ai/?via=diaria">Clarice</a><a href="https://link.amazon/B01">Livro</a>`;
    const r = buildRelink(html, maps());
    assert.equal(r.relinked, 0);
    assert.match(r.html, /clarice\.ai/);
    assert.match(r.html, /link\.amazon/);
  });

  it("merge tag não é tocada", () => {
    const r = buildRelink(`<a href="{{ unsubscribe }}">sair</a>`, maps());
    assert.match(r.html, /href="\{\{ unsubscribe \}\}"/);
    assert.equal(r.relinked, 0);
  });

  it("url sem mapeamento fica na fonte original e é contada", () => {
    const r = buildRelink(`<a href="https://desconhecido.com/x">?</a>`, maps());
    assert.equal(r.relinked, 0);
    assert.equal(r.naoMapeado, 1);
    assert.match(r.html, /desconhecido\.com/);
  });

  it("textos âncora repetidos ganham a edição como sufixo (não se fundem no relatório)", () => {
    const m = maps({
      urlToEdition: new Map([
        [normUrl("https://a.com/1"), "260602"],
        [normUrl("https://a.com/2"), "260610"],
      ]),
    });
    const r = buildRelink(
      `<a href="https://a.com/1">pediu abertura de capital</a><a href="https://a.com/2">pediu abertura de capital</a>`,
      m,
    );
    const terms = [...r.html.matchAll(/utm_term=([a-z0-9-]+)/g)].map((x) => x[1]);
    assert.equal(terms.length, 2);
    assert.notEqual(terms[0], terms[1], `utm_term duplicado: ${terms.join(", ")}`);
    assert.ok(terms[1].endsWith("-260610"), `esperava sufixo de edição: ${terms[1]}`);
  });

  it("âncora sem texto legível cai no fallback ed-AAMMDD", () => {
    const r = buildRelink(`<a href="https://exame.com/a"><img src="x.jpg"></a>`, maps());
    assert.match(r.html, /utm_term=ed-260601/);
  });

  it("campaign herda o do HTML base, sem o sufixo de braço", () => {
    const r = buildRelink(
      `<a href="https://diar.ia.br/?utm_campaign=clarice-2606-07-cta-a">x</a><a href="https://exame.com/a">y</a>`,
      maps(),
    );
    assert.equal(r.campaign, "clarice-2606-07");
    assert.doesNotMatch(r.html, /-cta-a/);
    assert.equal(r.ctaSuffixRemovidos, 1);
  });

  it("normaliza diaria.beehiiv.com e poll.diaria.workers.dev", () => {
    const r = buildRelink(
      `<a href="https://diaria.beehiiv.com/p/x">a</a><a href="https://poll.diaria.workers.dev/vote?brand=clarice">b</a>`,
      maps(),
    );
    assert.match(r.html, /https:\/\/diar\.ia\.br\/p\/x/);
    assert.match(r.html, /https:\/\/eia\.diar\.ia\.br\/vote\?brand=clarice/);
    assert.equal(r.beehiivNormalizados, 1);
    assert.equal(r.pollNormalizados, 1);
  });

  it("é idempotente: rodar 2× não muda mais nada", () => {
    const html = `<a href="https://exame.com/a">Brasil debate soberania</a>`;
    const once = buildRelink(html, maps()).html;
    const twice = buildRelink(once, maps()).html;
    assert.equal(twice, once);
  });
});

describe("makeEditionUrlResolver", () => {
  const idx = [
    { id: "post_aaaa1111-2222-3333-4444-555555555555", web_url: "https://diaria.beehiiv.com/p/antigo", publish_date: 1780000000 },
    { id: "post_bbbb1111-2222-3333-4444-555555555555", web_url: "https://diar.ia.br/p/novo", publish_date: 1780086400 },
  ];

  it("resolve por prefixo do post id", () => {
    const r = makeEditionUrlResolver(idx, new Map([["260601", "bbbb1111"]]));
    assert.equal(r("260601"), "https://diar.ia.br/p/novo");
  });

  it("normaliza o domínio antigo do cache para o canônico", () => {
    const r = makeEditionUrlResolver(idx, new Map([["260601", "aaaa1111"]]));
    assert.equal(r("260601"), "https://diar.ia.br/p/antigo");
  });

  it("edição sem post devolve null (chamador conta como não mapeada)", () => {
    const r = makeEditionUrlResolver(idx, new Map());
    assert.equal(r("990101"), null);
  });
});
