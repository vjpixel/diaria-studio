/**
 * test/article-page-merge-tags-7580.test.ts (#7580)
 *
 * O artigo mensal público (`artigo.diar.ia.br/{ciclo}`) é renderizado pelo
 * MESMO `draftToEmail` do envio Brevo — decisão do #3940, e boa: o artigo e o
 * e-mail compartilham o parser de seções em vez de duplicá-lo.
 *
 * O preço dessa reutilização é que o HTML chega com o rodapé de e-mail junto,
 * e ele traz `{{ unsubscribe }}` — merge tag que o provedor resolve no envio e
 * que na web **ninguém resolve**. Medido em 07/09/2026, antes desta correção:
 * uma ocorrência em cada um dos 5 ciclos com `draft.md`. Publicada crua, o
 * leitor veria o literal `{{ unsubscribe }}` e um link para URL inválida.
 *
 * A correção vive no caminho de RENDER, não numa limpeza por ciclo: vale para
 * os 5 existentes e para todo ciclo futuro, sem passo manual.
 *
 * Invariantes travados aqui:
 *
 * 1. **O parágrafo de e-mail some inteiro da web** — não só a tag. O texto
 *    ("Você está recebendo esse e-mail… pode se descadastrar") fala de um envio
 *    que não existe para quem abriu uma página; trocar só o `href` deixaria a
 *    frase mentindo em vez de quebrada.
 * 2. **Qualquer tag remanescente FALHA o build.** Se um template mensal futuro
 *    trouxer uma tag nova, o build para e a nomeia — em vez de gravá-la no KV e
 *    alguém notar meses depois olhando a página.
 * 3. **O caminho de E-MAIL não muda.** `draftToEmail` continua emitindo a tag;
 *    é o provedor que a resolve. A remoção é exclusiva da versão web.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  UnresolvedMergeTagInArticleError,
  buildArticleHtml,
  retagWebUtmMedium,
  stripEmailOnlyFooter,
  stripReplyByEmailSentence,
  verifyNoMergeTagsInArticle,
} from "../scripts/lib/mensal/build-article-page.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";

const PARAGRAFO_EMAIL =
  '<p style="margin:0 0 16px 0;font-family:\'Geist\', sans-serif;">Você está recebendo esse e-mail ' +
  'porque se cadastrou na <a href="https://clarice.ai/?via=diaria" style="color:#171411;">Clarice</a>. ' +
  'Caso não queira receber a newsletter, pode se <a href="{{ unsubscribe }}" style="color:#171411;">' +
  "descadastrar aqui</a>.</p>";

describe("#7580 — o rodapé de e-mail não vai para a web", () => {
  it("remove o parágrafo INTEIRO, não só a merge tag", () => {
    assert.equal(stripEmailOnlyFooter(PARAGRAFO_EMAIL), "");
  });

  it("preserva o resto do documento intacto", () => {
    const html = `<div>antes</div>${PARAGRAFO_EMAIL}<div>depois</div>`;
    assert.equal(stripEmailOnlyFooter(html), "<div>antes</div><div>depois</div>");
  });

  it("não toca em parágrafo vizinho sem a tag", () => {
    const outro = '<p style="x">Um parágrafo comum.</p>';
    assert.equal(stripEmailOnlyFooter(outro + PARAGRAFO_EMAIL), outro);
  });

  it("tolera variação de espaço dentro das chaves", () => {
    for (const tag of ["{{unsubscribe}}", "{{  unsubscribe  }}", "{{ unsubscribe }}"]) {
      assert.equal(stripEmailOnlyFooter(`<p><a href="${tag}">x</a></p>`), "", `falhou em ${tag}`);
    }
  });

  it("HTML sem o rodapé passa inalterado", () => {
    const limpo = "<div><p>Só conteúdo.</p></div>";
    assert.equal(stripEmailOnlyFooter(limpo), limpo);
  });
});

describe("#7580 — o guard recusa qualquer merge tag que sobre", () => {
  it("HTML limpo passa", () => {
    assert.doesNotThrow(() => verifyNoMergeTagsInArticle("<p>ok</p>", "2608-09"));
  });

  it("tag desconhecida LANÇA nomeando o ciclo e a tag", () => {
    assert.throws(
      () => verifyNoMergeTagsInArticle("<p>{{ first_name }}</p>", "2608-09"),
      (e: unknown) => {
        assert.ok(e instanceof UnresolvedMergeTagInArticleError);
        assert.match(e.message, /2608-09/);
        assert.match(e.message, /first_name/);
        return true;
      },
    );
  });

  it("lista as tags sem repetir", () => {
    try {
      verifyNoMergeTagsInArticle("<p>{{ a }} {{ a }} {{ b }}</p>", "2608-09");
      assert.fail("deveria ter lançado");
    } catch (e) {
      assert.ok(e instanceof UnresolvedMergeTagInArticleError);
      assert.deepEqual(e.tags, ["{{ a }}", "{{ b }}"]);
    }
  });
});

describe("#7580 — contra os drafts REAIS, não só fixtures", () => {
  // Fixture sintética não prova nada sobre o formato que o `draftToEmail`
  // realmente produz — e foi exatamente no HTML real que a tag apareceu.
  const ciclos = ["2604-05", "2605-06", "2606-07", "2607-08", "2608-09"];
  const disponiveis = ciclos.filter((c) => existsSync(`data/monthly/${c}/draft.md`));

  it("os drafts existem nesta máquina (senão o resto deste bloco não prova nada)", () => {
    // `data/` é gitignored (junction do OneDrive): em CI este bloco não roda.
    // Declarar isso em vez de deixar 5 testes passarem vazios.
    if (disponiveis.length === 0) {
      console.log("[#7580] data/monthly ausente — bloco de drafts reais pulado (esperado em CI)");
    }
    assert.ok(true);
  });

  for (const ciclo of ciclos) {
    it(`${ciclo}: HTML web sem nenhuma merge tag`, { skip: !existsSync(`data/monthly/${ciclo}/draft.md`) }, () => {
      const md = readFileSync(`data/monthly/${ciclo}/draft.md`, "utf8");
      const { html } = buildArticleHtml(md, ciclo);
      assert.deepEqual(html.match(/\{\{[^}]+\}\}/g), null, "nenhuma tag pode sobreviver");
      assert.ok(!html.includes("recebendo esse e-mail"), "o texto de e-mail também sai");
      assert.ok(html.length > 10_000, "e o artigo continua inteiro");
    });
  }

  it("REGRESSÃO: o caminho de E-MAIL continua com a tag — só a web perde", { skip: disponiveis.length === 0 }, () => {
    // Se esta asserção cair, alguém 'corrigiu' o render do e-mail e quebrou o
    // link de descadastro do envio real — o oposto do que esta issue pediu.
    const ciclo = disponiveis[0];
    const md = readFileSync(`data/monthly/${ciclo}/draft.md`, "utf8");
    const { html: email } = draftToEmail(md, null, ciclo.slice(0, 4));
    assert.match(email, /\{\{\s*unsubscribe\s*\}\}/, "o e-mail PRECISA manter a merge tag");
  });
});

describe("#7580 — 'responda a este e-mail' sai, mas o link de cadastro fica", () => {
  const PARAGRAFO =
    '<p style="x">Se você quiser receber essa newsletter com prioridade, responda a este e-mail ' +
    'dizendo &quot;quero&quot;. Se quiser receber tutoriais e notícias de IA todos os dias, se cadastre ' +
    'gratuitamente <a href="https://diar.ia.br/?utm_source=clarice">aqui</a>.</p>';

  it("remove a frase e PRESERVA o link — jogar o parágrafo fora perderia a conversão", () => {
    const out = stripReplyByEmailSentence(PARAGRAFO);
    assert.ok(!out.includes("responda a este e-mail"));
    assert.match(out, /se cadastre gratuitamente/, "o CTA da página não pode sair junto");
    assert.match(out, /href="https:\/\/diar\.ia\.br/);
  });

  it("não toca em texto que só menciona e-mail de passagem", () => {
    const outro = "<p>O agente lê o seu e-mail e responde sozinho.</p>";
    assert.equal(stripReplyByEmailSentence(outro), outro);
  });

  it("copy diferente degrada para 'a frase fica', nunca para corte no lugar errado", () => {
    // Ancoragem frouxa de propósito: sobrar uma frase estranha é aceitável;
    // recortar errado e comer o link de cadastro, não.
    const mudou = '<p>Responda o e-mail se quiser prioridade. <a href="https://x">aqui</a>.</p>';
    assert.match(stripReplyByEmailSentence(mudou), /href="https:\/\/x"/);
  });
});

describe("#7580 — o clique na PÁGINA não pode ser contado como clique de e-mail", () => {
  it("REGRESSÃO: casa mesmo com o & escapado como &amp;", () => {
    // A 1ª versão usava `[?&]utm_medium=` e não casava NADA, porque no HTML o
    // separador vem escapado — 10 links sobreviveram em silêncio.
    const html = '<a href="https://diar.ia.br/?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=c">x</a>';
    const out = retagWebUtmMedium(html);
    assert.ok(!out.includes("utm_medium=email"));
    assert.match(out, /utm_medium=artigo-web/);
  });

  it("preserva source e campaign — o clique continua rastreável até o ciclo", () => {
    const out = retagWebUtmMedium("?utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=clarice-2608-09");
    assert.match(out, /utm_source=clarice/);
    assert.match(out, /utm_campaign=clarice-2608-09/);
  });

  it("não mexe em outro medium nem em prefixo parecido", () => {
    assert.equal(retagWebUtmMedium("?utm_medium=cpc"), "?utm_medium=cpc");
    assert.equal(retagWebUtmMedium("?utm_medium=emailing"), "?utm_medium=emailing", "\b evita casar prefixo");
  });

  it("nos drafts REAIS não sobra nenhum utm_medium=email", { skip: !existsSync("data/monthly/2608-09/draft.md") }, () => {
    const { html } = buildArticleHtml(readFileSync("data/monthly/2608-09/draft.md", "utf8"), "2608-09");
    assert.ok(!html.includes("utm_medium=email"), "a versão web não pode carimbar clique como e-mail");
    assert.ok(html.includes("utm_medium=artigo-web"), "e precisa carimbar como web");
  });
});
