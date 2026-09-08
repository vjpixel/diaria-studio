/**
 * test/annual-relink.test.ts (#7587 item 2)
 *
 * O relink da anual reusa a lógica pura do mensal (`buildUrlToEdition`,
 * `buildRelink`), mas com um resolver de URL de edição DIFERENTE — e é
 * aqui que mora a armadilha medida na 1ª rodada real: o resolver do mensal
 * (`makeEditionUrlResolver`) indexa por `publish_date` cru, que nas edições
 * importadas em bloco (agosto/2025) carrega a data da IMPORTAÇÃO
 * (04/09/2025), não a data real da edição. Com ele, nenhuma edição de
 * agosto/2025 casaria — o resolver da anual (`makeAnnualEditionUrlResolver`)
 * precisa indexar por `editorialDate()` pra não repetir esse erro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";
import { makeAnnualEditionUrlResolver, relinkAnnualEditionHtml } from "../scripts/lib/anual/annual-relink.ts";

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function post(p: Partial<UnifiedCachedPost>): UnifiedCachedPost {
  return { origin: "beehiiv", status: "confirmed", ...p };
}

describe("resolver de URL de edição — editorialDate, não publish_date cru", () => {
  it("edição importada (publish_date = data da importação) ainda resolve, via displayed_date", () => {
    const posts = [
      post({
        web_url: "https://diar.ia.br/p/edicao-250827",
        publish_date: unix("2025-09-04T00:00:00Z"), // data da importação em bloco
        displayed_date: unix("2025-08-27T00:00:00Z"), // data editorial real
      }),
    ];
    const resolve = makeAnnualEditionUrlResolver(posts);
    assert.equal(resolve("250827"), "https://diar.ia.br/p/edicao-250827");
    // Pelo publish_date cru, esta edição indexaria em "250904" — não em
    // "250827". Confirma que o resolver não caiu nessa armadilha.
    assert.equal(resolve("250904"), null);
  });

  it("edição normal (sem displayed_date) resolve por publish_date", () => {
    const posts = [post({ web_url: "https://diar.ia.br/p/edicao-260715", publish_date: unix("2026-07-15T00:00:00Z") })];
    assert.equal(makeAnnualEditionUrlResolver(posts)("260715"), "https://diar.ia.br/p/edicao-260715");
  });

  it("rascunho (status != confirmed) nunca é usado como destino de relink", () => {
    const posts = [
      post({ status: "draft", web_url: "https://diar.ia.br/p/rascunho", publish_date: unix("2026-07-15T00:00:00Z") }),
    ];
    assert.equal(makeAnnualEditionUrlResolver(posts)("260715"), null);
  });

  it("diaria.beehiiv.com normaliza pra diar.ia.br, mesma disciplina do mensal", () => {
    const posts = [
      post({ web_url: "https://diaria.beehiiv.com/p/edicao-260715", publish_date: unix("2026-07-15T00:00:00Z") }),
    ];
    assert.equal(makeAnnualEditionUrlResolver(posts)("260715"), "https://diar.ia.br/p/edicao-260715");
  });
});

describe("relinkAnnualEditionHtml — escopo é TODO link, sem exceção de Use Melhor/Radar", () => {
  const posts = [
    post({ web_url: "https://diar.ia.br/p/edicao-260810", publish_date: unix("2026-08-10T00:00:00Z") }),
  ];

  it("um link cujo destaque foi rastreado numa edição vira link pra edição diária", () => {
    const html = '<a href="https://exemplo.com/materia-x">a matéria</a>';
    const destaques = [{ url: "https://exemplo.com/materia-x", edition: "260810" }];
    const r = relinkAnnualEditionHtml(html, destaques, posts, "anual-2026-aniversario");
    assert.equal(r.relinked, 1);
    assert.ok(r.html.includes("https://diar.ia.br/p/edicao-260810"), r.html);
    assert.ok(r.html.includes("utm_campaign=anual-2026-aniversario"));
    assert.ok(!r.html.includes("exemplo.com/materia-x"), "a URL original não deve sobrar no href");
  });

  it("link sem destaque mapeado é mantido na fonte original — nunca inventa link", () => {
    const html = '<a href="https://exemplo.com/sem-mapa">outra matéria</a>';
    const r = relinkAnnualEditionHtml(html, [], posts);
    assert.equal(r.relinked, 0);
    assert.equal(r.naoMapeado, 1);
    assert.ok(r.html.includes("https://exemplo.com/sem-mapa"));
  });

  it("URL cuja edição de origem não está no cache mantém a fonte (caso legítimo, não erro)", () => {
    const html = '<a href="https://exemplo.com/materia-orfa">matéria</a>';
    const destaques = [{ url: "https://exemplo.com/materia-orfa", edition: "251213" }]; // fora do cache
    const r = relinkAnnualEditionHtml(html, destaques, posts);
    assert.equal(r.relinked, 0);
    assert.equal(r.naoMapeado, 1);
    assert.ok(r.html.includes("https://exemplo.com/materia-orfa"));
  });

  it("host já em KEEP_HOSTS (ex: diar.ia.br) nunca é reescrito", () => {
    const html = '<a href="https://diar.ia.br/p/outra-edicao">link interno</a>';
    const r = relinkAnnualEditionHtml(html, [{ url: "https://diar.ia.br/p/outra-edicao", edition: "260810" }], posts);
    assert.equal(r.relinked, 0);
    assert.ok(r.html.includes("https://diar.ia.br/p/outra-edicao"));
  });
});
