/**
 * test/site-archive-refresh-6202.test.ts (#6202)
 *
 * O gatilho que decide se o acervo do site precisa ser regenerado.
 *
 * Os dois invariantes:
 *
 * 1. **Edição nova no cache ⇒ precisa regenerar.** É a razão de a issue
 *    existir: sem isso o acervo congela nos posts já gerados.
 * 2. **Página órfã (fora do cache) TAMBÉM exige regenerar.** Um post
 *    despublicado, ou com slug alterado, continuaria sendo servido — o
 *    gerador apaga a árvore inteira e reescreve, então a regeneração é o que
 *    remove a órfã. Ignorar esse lado deixaria conteúdo removido no ar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideArchiveRefresh, renderRefreshDecision } from "../scripts/lib/site-archive-refresh.ts";

describe("#6202 decideArchiveRefresh — o caso que a issue existe pra resolver", () => {
  it("edição nova no cache, sem página ⇒ precisa", () => {
    const d = decideArchiveRefresh({
      slugsNoCache: ["edicao-a", "edicao-b"],
      slugsComPagina: ["edicao-a"],
    });
    assert.equal(d.precisa, true);
    assert.deepEqual(d.faltando, ["edicao-b"]);
    assert.deepEqual(d.orfas, []);
  });

  it("acervo em dia ⇒ NÃO precisa (não regenerar à toa)", () => {
    const d = decideArchiveRefresh({
      slugsNoCache: ["a", "b"],
      slugsComPagina: ["b", "a"],
    });
    assert.equal(d.precisa, false);
    assert.match(d.motivo, /em dia/);
  });

  it("ordem não importa — é comparação de conjunto", () => {
    const d = decideArchiveRefresh({ slugsNoCache: ["c", "a", "b"], slugsComPagina: ["b", "c", "a"] });
    assert.equal(d.precisa, false);
  });
});

describe("#6202 o lado que é fácil esquecer: páginas órfãs", () => {
  it("página sem post no cache ⇒ precisa regenerar (post despublicado)", () => {
    // Sem isto, uma edição removida da Beehiiv continuaria servida no acervo
    // público indefinidamente.
    const d = decideArchiveRefresh({ slugsNoCache: ["a"], slugsComPagina: ["a", "removida"] });
    assert.equal(d.precisa, true);
    assert.deepEqual(d.orfas, ["removida"]);
    assert.deepEqual(d.faltando, []);
  });

  it("slug alterado aparece dos DOIS lados — entrando e saindo", () => {
    // Renomear o slug de um post é, para conjuntos, uma remoção + uma adição.
    const d = decideArchiveRefresh({ slugsNoCache: ["titulo-novo"], slugsComPagina: ["titulo-velho"] });
    assert.equal(d.precisa, true);
    assert.deepEqual(d.faltando, ["titulo-novo"]);
    assert.deepEqual(d.orfas, ["titulo-velho"]);
  });

  it("cache vazio com páginas existentes ⇒ precisa, e NÃO silencia", () => {
    // Cenário perigoso: cache não carregou (falha de sync). A decisão correta
    // é acusar, não concluir "nada mudou" — quem lê decide se regenera.
    const d = decideArchiveRefresh({ slugsNoCache: [], slugsComPagina: ["a", "b", "c"] });
    assert.equal(d.precisa, true);
    assert.equal(d.orfas.length, 3);
  });

  it("os dois vazios ⇒ não precisa, sem falso alarme", () => {
    const d = decideArchiveRefresh({ slugsNoCache: [], slugsComPagina: [] });
    assert.equal(d.precisa, false);
  });
});

describe("#6202 renderRefreshDecision — instrui o caminho CERTO de deploy", () => {
  it("quando precisa, manda commitar+push, NÃO wrangler direto", () => {
    // Achado do review do #6209: o site publica por GitHub Actions no push,
    // e `workers/site/public/p/` é git-tracked. Chamar wrangler direto deixa
    // arquivos não-commitados num checkout compartilhado.
    const out = renderRefreshDecision(decideArchiveRefresh({ slugsNoCache: ["nova"], slugsComPagina: [] }));
    assert.match(out, /commitar e dar push/);
    assert.match(out, /deploy-site\.yml/);
    assert.doesNotMatch(out, /wrangler deploy`?\s*$/m);
  });

  it("quando não precisa, não sugere ação nenhuma", () => {
    const out = renderRefreshDecision(decideArchiveRefresh({ slugsNoCache: ["a"], slugsComPagina: ["a"] }));
    assert.doesNotMatch(out, /rodar/);
  });

  it("lista truncada em 5 com contagem do resto — log legível", () => {
    const muitos = Array.from({ length: 12 }, (_, i) => `e${i}`);
    const out = renderRefreshDecision(decideArchiveRefresh({ slugsNoCache: muitos, slugsComPagina: [] }));
    assert.match(out, /\(\+7\)/, "precisa dizer quantos ficaram de fora");
  });
});
