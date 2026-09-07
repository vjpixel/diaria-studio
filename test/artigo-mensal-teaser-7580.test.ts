/**
 * test/artigo-mensal-teaser-7580.test.ts (#7580)
 *
 * `artigo.diar.ia.br/{ciclo}` servia 2.066 bytes de paywall seco a QUALQUER
 * visitante — e, até 07/09/2026, também a apoiador, porque os dois KV estavam
 * vazios. Agora o não-apoiador recebe o começo real do artigo, cortado no fim
 * do 1º destaque, com o bloco de conversão por cima.
 *
 * O invariante que mais importa aqui não é "o trecho aparece" — é **o artigo
 * completo NUNCA aparecer** no corpo servido a quem não passou no gate. O corte
 * é do servidor: o texto pago não sai do KV, então ver código-fonte ou
 * desabilitar CSS não revela nada. Estes testes provam isso sobre o HTML, não
 * sobre o status.
 *
 * O fail-closed vale nas DUAS direções, e a segunda é a que se esquece:
 *   - nunca servir o artigo completo a não-apoiador (óbvia);
 *   - nunca servir o trecho SEM o bloco de conversão — entregaria conteúdo de
 *     graça sem pedir nada em troca, o pior dos dois mundos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  TeaserCutError,
  buildArticleHtml,
  buildArticleTeaserHtml,
  cutDraftAfterFirstDestaque,
} from "../scripts/lib/mensal/build-article-page.ts";
import { articleKvKey, articleTeaserKvKey } from "../scripts/build-article-page.ts";
import { renderPaywall, renderTeaserWithPaywall } from "../workers/artigo-mensal/src/render.ts";

const CICLO = "2608-09";
const draftPath = (c: string) => `data/monthly/${c}/draft.md`;
const temDraft = (c: string) => existsSync(draftPath(c));

describe("#7580 — o corte é no fim do 1º destaque", () => {
  it("corta no próximo marcador de seção depois do DESTAQUE 1", { skip: !temDraft(CICLO) }, () => {
    const md = readFileSync(draftPath(CICLO), "utf8");
    const trecho = cutDraftAfterFirstDestaque(md, CICLO);
    assert.match(trecho, /\*\*DESTAQUE 1/, "o 1º destaque entra inteiro");
    assert.ok(!trecho.includes("**DESTAQUE 2"), "o 2º não");
    assert.ok(!trecho.includes("**CLARICE — DIVULGAÇÃO**"), "corta ANTES do bloco seguinte");
    assert.match(trecho, /O fio condutor/, "termina no fecho do destaque, que é o gancho");
  });

  it("o trecho é uma fração do artigo, não quase tudo", { skip: !temDraft(CICLO) }, () => {
    const md = readFileSync(draftPath(CICLO), "utf8");
    const razao = buildArticleTeaserHtml(md, CICLO).html.length / buildArticleHtml(md, CICLO).html.length;
    assert.ok(razao < 0.75, `trecho é ${Math.round(razao * 100)}% do artigo — alto demais para amostra`);
    assert.ok(razao > 0.2, `trecho é ${Math.round(razao * 100)}% do artigo — baixo demais para convencer`);
  });

  it("draft SEM marcador de destaque lança em vez de devolver trecho torto", () => {
    assert.throws(() => cutDraftAfterFirstDestaque("**INTRO**\n\ntexto\n", "26xx-yy"), TeaserCutError);
  });

  it("destaque sem seção depois lança — o trecho seria o artigo inteiro", () => {
    const md = `**INTRO**\n\n${"x".repeat(600)}\n\n**DESTAQUE 1 | TEMA**\n\ncorpo\n`;
    assert.throws(() => cutDraftAfterFirstDestaque(md, "26xx-yy"), /artigo inteiro/);
  });

  it("corte que não deixa corpo lança em vez de publicar trecho vazio", () => {
    const md = "**DESTAQUE 1 | TEMA**\n\ncurto\n\n**LIVROS**\n\nresto\n";
    assert.throws(() => cutDraftAfterFirstDestaque(md, "26xx-yy"), /estrutura inesperada/);
  });

  it("o ciclo 2604-05 é anterior à convenção e NÃO tem trecho — pulo consciente", { skip: !temDraft("2604-05") }, () => {
    // Publicá-lo exigiria um 2º parser para um formato descontinuado. O Worker
    // cai no paywall seco, que é o comportamento de antes desta issue.
    assert.throws(() => buildArticleTeaserHtml(readFileSync(draftPath("2604-05"), "utf8"), "2604-05"), TeaserCutError);
  });
});

describe("#7580 — o artigo completo NUNCA vai no corpo do não-apoiador", () => {
  it("o trecho não contém o 2º nem o 3º destaque", { skip: !temDraft(CICLO) }, () => {
    const md = readFileSync(draftPath(CICLO), "utf8");
    const html = renderTeaserWithPaywall(buildArticleTeaserHtml(md, CICLO).html);
    // Âncoras tiradas do draft REAL, não inventadas: se o corte regredir, é
    // este texto que aparece.
    const doSegundo = md.split("**DESTAQUE 2")[1]?.split("\n").find((l) => l.trim().length > 80);
    assert.ok(doSegundo, "fixture: o draft precisa ter um 2º destaque com corpo");
    assert.ok(!html.includes(doSegundo.slice(0, 60)), "conteúdo do 2º destaque vazou para o trecho");
  });

  it("o trecho passa pelas mesmas transformações web do artigo completo", { skip: !temDraft(CICLO) }, () => {
    const html = buildArticleTeaserHtml(readFileSync(draftPath(CICLO), "utf8"), CICLO).html;
    assert.deepEqual(html.match(/\{\{[^}]+\}\}/g), null, "nenhuma merge tag");
    assert.ok(!html.includes("utm_medium=email"), "nenhum clique de página contado como e-mail");
    assert.ok(!html.includes("responda a este e-mail"), "nenhuma copy de e-mail");
  });
});

describe("#7580 — o bloco de conversão, e o fail-closed nas duas direções", () => {
  const teaser = "<html><body><p>começo do artigo</p></body></html>";

  it("injeta apoio em destaque e cadastro como linha secundária", () => {
    const out = renderTeaserWithPaywall(teaser);
    assert.match(out, /apoia\.se\/diaria/, "CTA de apoio");
    assert.match(out, /diar\.ia\.br\/assinar/, "CTA de cadastro");
    // Hierarquia: o apoio é o único `<a>` com fundo sólido (botão).
    const posApoio = out.indexOf("apoia.se/diaria");
    const posCadastro = out.indexOf("diar.ia.br/assinar");
    assert.ok(posApoio < posCadastro, "o apoio vem primeiro");
  });

  it("preserva o conteúdo do trecho", () => {
    assert.match(renderTeaserWithPaywall(teaser), /começo do artigo/);
  });

  it("o CTA do apoiador aponta pra porta explícita, não pra `?` (que serve o trecho)", () => {
    // `href="?"` voltaria ao trecho e deixaria o formulário de e-mail
    // inalcançável — um laço.
    assert.match(renderTeaserWithPaywall(teaser), /href="\?entrar=1"/);
  });

  it("REGRESSÃO: trecho sem </body> LANÇA — servir sem o bloco seria dar conteúdo de graça", () => {
    assert.throws(() => renderTeaserWithPaywall("<html><body><p>sem fim</p></html>"), /sem <\/body>/);
  });

  it("o paywall seco continua existindo para quando não há trecho", () => {
    const seco = renderPaywall();
    assert.match(seco, /exclusivo para apoiadores/);
    assert.match(seco, /apoia\.se\/diaria/);
  });
});

describe("#7580 — chaves do KV", () => {
  it("o trecho é sufixo da chave do artigo, não um namespace paralelo", () => {
    assert.equal(articleKvKey(CICLO), "article:2608-09");
    assert.equal(articleTeaserKvKey(CICLO), "article:2608-09:teaser");
  });
});
