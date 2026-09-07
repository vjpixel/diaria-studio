/**
 * test/edition-page-cta-7576.test.ts (#7576)
 *
 * As páginas de edição (`diar.ia.br/p/{slug}`) perderam o convite a assinar no
 * cutover do apex (#467) e ficaram sendo a superfície mais visitada do domínio
 * sem nenhuma forma de virar assinante. Medido em 07/09/2026, mesma edição nos
 * dois hosts: `diaria.beehiiv.com` servia 2 formulários e 1 campo de e-mail;
 * `diar.ia.br/p/{slug}` servia 0 e 0.
 *
 * O que estes testes travam:
 *
 * 1. **A página publicada TEM formulário.** É a regressão literal.
 * 2. **O modal nasce escondido e depende de JS.** Sem script ele nunca aparece;
 *    o formulário do rodapé é HTML nativo e funciona sozinho.
 * 3. **A injeção falha ALTO se não houver `</body>`**, em vez de virar um
 *    `.replace()` no-op que publicaria a página sem convite e sem erro — a
 *    mesma disciplina do guard de `<html>` que já existe na função.
 * 4. **O gatilho é 50% de rolagem** (decisão do editor), com as guardas que
 *    decorrem dele: uma vez por leitor, nunca em página curta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_PAGE_VIEWPORTS_FOR_MODAL,
  MODAL_DISMISSED_KEY,
  MODAL_SCROLL_TRIGGER,
  editionCtaBlock,
  editionCtaFooter,
  editionCtaModal,
} from "../scripts/lib/edition-page-cta.ts";
import { injectBeforeBodyEnd } from "../scripts/lib/site-archive-pages.ts";

describe("#7576 — a página de edição volta a ter formulário", () => {
  const bloco = editionCtaBlock();

  it("tem formulário e campo de e-mail — a regressão literal do cutover", () => {
    assert.equal((bloco.match(/<form\b/g) ?? []).length, 2, "rodapé + modal");
    // Contado sobre a MARCAÇÃO, não sobre o bloco inteiro: o script de envio
    // também carrega a string `input[type="email"]` num seletor, e contá-la
    // faria o teste passar por acidente mesmo sem nenhum campo de verdade.
    const marcacao = editionCtaFooter() + editionCtaModal();
    assert.equal((marcacao.match(/type="email"/g) ?? []).length, 2);
  });

  it("aponta pro MESMO endpoint já em produção, sem inventar um segundo mecanismo", () => {
    assert.match(bloco, /action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
  });

  it("carrega opt-in obrigatório e honeypot — o form do repo inteiro exige os dois", () => {
    assert.match(bloco, /name="optin"/);
    assert.match(bloco, /name="website"/);
  });

  it("os dois formulários têm id distinto — o script conecta cada um isoladamente", () => {
    assert.match(bloco, /id="cta-rodape"/);
    assert.match(bloco, /id="cta-modal"/);
  });
});

describe("#7576 — o modal é aprimoramento progressivo, nunca obstáculo", () => {
  it("nasce `hidden`: sem JS o leitor nunca o vê", () => {
    assert.match(editionCtaModal(), /id="diaria-cta-modal"[^>]*\bhidden\b/);
  });

  it("o rodapé NÃO depende de JS — é form nativo com method e action", () => {
    const rodape = editionCtaFooter();
    assert.match(rodape, /method="POST"/);
    assert.match(rodape, /action="https:/);
    assert.doesNotMatch(rodape, /<script/);
  });

  it("fecha por Esc, por botão e por clique no fundo", () => {
    const bloco = editionCtaBlock();
    assert.match(bloco, /"Escape"/);
    assert.match(bloco, /id="diaria-cta-close"/);
    assert.match(bloco, /ev\.target === modal/);
  });

  it("devolve o foco para onde estava ao fechar", () => {
    assert.match(editionCtaBlock(), /focoAnterior/);
  });

  it("é acessível: role, aria-modal e rótulo", () => {
    const modal = editionCtaModal();
    assert.match(modal, /role="dialog"/);
    assert.match(modal, /aria-modal="true"/);
    assert.match(modal, /aria-labelledby=/);
  });
});

describe("#7576 — o gatilho é 50% de rolagem, com as guardas que decorrem dele", () => {
  it("50%, a decisão do editor", () => {
    assert.equal(MODAL_SCROLL_TRIGGER, 0.5);
    assert.match(editionCtaBlock(), /0\.5/);
  });

  it("uma vez por leitor — quem fechou não vê de novo", () => {
    const bloco = editionCtaBlock();
    assert.match(bloco, new RegExp(MODAL_DISMISSED_KEY.replace(/[:]/g, "[:]")));
    assert.match(bloco, /localStorage/);
  });

  it("localStorage indisponível NÃO quebra a página nem some com o convite", () => {
    // Janela privada / cookies bloqueados fazem `localStorage` lançar. O
    // default em qualquer erro é MOSTRAR: um detalhe de armazenamento não pode
    // nem derrubar a página nem silenciar o convite.
    const bloco = editionCtaBlock();
    assert.match(bloco, /catch \(e\) \{ return false; \}/);
  });

  it("página curta não dispara — 50% chegaria junto com o load", () => {
    assert.ok(MIN_PAGE_VIEWPORTS_FOR_MODAL > 1);
    assert.match(editionCtaBlock(), new RegExp(String(MIN_PAGE_VIEWPORTS_FOR_MODAL)));
  });

  it("assinar pelo RODAPÉ evita o modal depois — não pede duas vezes", () => {
    assert.match(editionCtaBlock(), /form\.signup/);
  });

  it("o listener de scroll é passivo e se remove depois de abrir", () => {
    const bloco = editionCtaBlock();
    assert.match(bloco, /passive: true/);
    assert.match(bloco, /removeEventListener\("scroll"/);
  });
});

describe("#7576 — injeção antes de </body> falha alto, nunca em silêncio", () => {
  it("insere o bloco imediatamente antes do fechamento do body", () => {
    const out = injectBeforeBodyEnd("<html><body><p>edição</p></body></html>", "<!--CTA-->", "slug-x");
    assert.match(out, /<p>edição<\/p>\n?<!--CTA-->\n<\/body>/);
  });

  it("aceita a tag com espaço antes do fecha-sinal e em maiúsculas", () => {
    assert.match(injectBeforeBodyEnd("<body>x</BODY >", "<!--C-->", "s"), /<!--C-->/);
  });

  it("HTML sem </body> LANÇA nomeando o slug — publicar sem convite é a falha silenciosa", () => {
    assert.throws(
      () => injectBeforeBodyEnd("<html><body><p>sem fechamento</p></html>", "<!--C-->", "slug-y"),
      /slug-y/,
    );
  });

  it("REGRESSÃO: com DOIS </body>, injeta antes do ÚLTIMO", () => {
    // O título deste teste afirmava "último" enquanto o código usava
    // `String.replace` com regex não-global, que casa o PRIMEIRO — e a fixture
    // tinha só um `</body>`, então nunca exercitou a diferença (achado do
    // review da PR #7588). Numa edição que cite HTML como texto, o primeiro
    // seria o do exemplo: o convite entraria no meio do artigo e o resto da
    // edição cairia depois do fechamento, sem quebrar visivelmente.
    const out = injectBeforeBodyEnd("<body>a</body>resto</body>", "<!--C-->", "s");
    assert.equal((out.match(/<!--C-->/g) ?? []).length, 1, "injeta uma vez só");
    assert.match(out, /resto<!--C-->\n<\/body>$/, "o bloco precisa ficar antes do ÚLTIMO </body>");
  });
});

describe("#7576 — o CSS é escopado: a página é HTML de e-mail", () => {
  it("não usa seletor de elemento global que atropelaria as tabelas da edição", () => {
    const estilos = editionCtaBlock().match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    for (const seletor of ["\ntable {", "\ntd {", "\nbody {", "\np {", "\nimg {", "\na {"]) {
      assert.ok(!estilos.includes(seletor), `CSS global "${seletor.trim()}" atropelaria o HTML da edição`);
    }
  });

  it("o modal é position: fixed — não empurra o conteúdo da edição", () => {
    assert.match(editionCtaBlock(), /\.diaria-cta-modal \{[\s\S]*?position: fixed/);
  });
});
