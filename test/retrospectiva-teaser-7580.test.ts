/**
 * test/retrospectiva-teaser-7580.test.ts (#7580)
 *
 * `retrospectiva.diar.ia.br/AAMM` servia 2.066 bytes de paywall seco a QUALQUER
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
import { renderPaywall, renderTeaserWithPaywall } from "../workers/retrospectiva/src/render-mensal.ts";

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
    // #7658: a chave passou a ser o PATH público (`2608`), não o ciclo cru
    // (`2608-09`) — derivada por `mensalPathFromCycle`, a mesma função que o
    // Worker usa pra classificar a URL.
    assert.equal(articleKvKey(CICLO), "article:2608");
    assert.equal(articleTeaserKvKey(CICLO), "article:2608:teaser");
  });

  it("#7658: ciclo malformado LANÇA — nunca grava sob uma chave que o Worker não leria", () => {
    for (const ruim of ["2608", "26-09", "abcd-ef", ""]) {
      assert.throws(() => articleKvKey(ruim), /não vira path de retrospectiva/, ruim);
    }
  });
});

/**
 * Achado P1 do review da PR #7594: os testes acima que provam o invariante de
 * segurança dependem dos drafts em `data/monthly` — e `data` é gitignored
 * (junction do OneDrive). Em CI eles PULAM em silêncio, então a propriedade
 * "o artigo completo nunca vaza" não era verificada justamente no ambiente que
 * decide se a PR pode entrar.
 *
 * Este bloco usa uma fixture inline com a MESMA estrutura do draft real (as
 * seções, na ordem, com os marcadores como o `writer-monthly` os emite), então
 * roda em qualquer lugar. Os testes com draft real continuam acima como camada
 * extra — eles pegam mudança de FORMATO, que fixture nenhuma pega.
 */
const DRAFT_SINTETICO = [
  "**ASSUNTO (3 OPÇÕES)**",
  "",
  "1. diar.ia.br | Mês 2026 — Um título",
  "",
  "**PREVIEW**",
  "",
  "Uma linha de preview.",
  "",
  "**APRESENTAÇÃO**",
  "",
  "Esta é a newsletter mensal, em parceria com a Clarice.",
  "",
  "**INTRO**",
  "",
  `Uma introdução com corpo suficiente para o piso de 500 caracteres não disparar. ${"Texto de enchimento com tamanho realista. ".repeat(12)}`,
  "",
  "---",
  "",
  "**DESTAQUE 1 | INDÚSTRIA**",
  "",
  "Título do primeiro destaque",
  "",
  `Corpo do primeiro destaque. ${"Mais texto do primeiro destaque. ".repeat(10)}`,
  "",
  "O fio condutor: o fecho do primeiro destaque.",
  "",
  "---",
  "",
  "**CLARICE — DIVULGAÇÃO**",
  "",
  "Texto patrocinado que NAO deve entrar no trecho.",
  "",
  "**DESTAQUE 2 | BRASIL**",
  "",
  "SEGREDO-DO-SEGUNDO-DESTAQUE",
  "",
  "Corpo do segundo destaque, que é conteúdo pago.",
  "",
  "**DESTAQUE 3 | MERCADO**",
  "",
  "SEGREDO-DO-TERCEIRO-DESTAQUE",
  "",
  "**PARA ENCERRAR**",
  "",
  "SEGREDO-DO-FECHAMENTO",
  "",
].join("\n");

describe("#7580 — o invariante roda SEM data/ (achado P1 do review)", () => {
  it("o corte para no fim do 1º destaque, com fixture inline", () => {
    const trecho = cutDraftAfterFirstDestaque(DRAFT_SINTETICO, "26xx-yy");
    assert.match(trecho, /DESTAQUE 1/);
    assert.match(trecho, /O fio condutor/, "o 1º destaque entra inteiro");
    assert.ok(!trecho.includes("CLARICE — DIVULGAÇÃO"), "corta ANTES do bloco seguinte");
  });

  it("o conteúdo PAGO nunca aparece no trecho renderizado", () => {
    const html = buildArticleTeaserHtml(DRAFT_SINTETICO, "2608-09").html;
    for (const segredo of ["SEGREDO-DO-SEGUNDO-DESTAQUE", "SEGREDO-DO-TERCEIRO-DESTAQUE", "SEGREDO-DO-FECHAMENTO"]) {
      assert.ok(!html.includes(segredo), `${segredo} vazou para o trecho`);
    }
  });

  it("e continua fora depois de o Worker montar o bloco de conversão", () => {
    const servido = renderTeaserWithPaywall(buildArticleTeaserHtml(DRAFT_SINTETICO, "2608-09").html);
    assert.ok(!servido.includes("SEGREDO-DO-SEGUNDO-DESTAQUE"));
    assert.match(servido, /apoia\.se\/diaria/, "e o CTA está lá");
  });

  it("o trecho herda as transformações web (merge tag, UTM, copy de e-mail)", () => {
    const html = buildArticleTeaserHtml(DRAFT_SINTETICO, "2608-09").html;
    assert.deepEqual(html.match(/\{\{[^}]+\}\}/g), null);
    assert.ok(!html.includes("utm_medium=email"));
  });

  it("REGRESSÃO: marcador com espaço à direita não faz o corte varrer até o DESTAQUE 2", () => {
    // `SECTION_MARKER` exige a linha inteira; sem `.trim()` um cabeçalho com
    // espaço sobrando não casaria e o corte seguiria adiante — engolindo
    // conteúdo pago.
    const comEspaco = DRAFT_SINTETICO.replace("**CLARICE — DIVULGAÇÃO**", "**CLARICE — DIVULGAÇÃO**   ");
    const trecho = cutDraftAfterFirstDestaque(comEspaco, "26xx-yy");
    assert.ok(!trecho.includes("SEGREDO-DO-SEGUNDO-DESTAQUE"));
  });
});

describe("#7580 — injeção no ÚLTIMO </body> (regressão do #7592, reintroduzida e corrigida)", () => {
  it("com DOIS </body>, o bloco entra antes do último", () => {
    // O #7592 corrigiu isto nas páginas de edição e eu reintroduzi aqui: numa
    // newsletter que cita HTML como texto, o primeiro `</body>` é o do exemplo.
    const out = renderTeaserWithPaywall("<body>artigo <code>&lt;/body&gt;</code></body>resto</body>");
    assert.equal((out.match(/apoia\.se\/diaria/g) ?? []).length, 1, "injeta uma vez só");
    assert.match(out, /resto[\s\S]*apoia\.se\/diaria[\s\S]*<\/body>$/, "antes do ÚLTIMO </body>");
  });
});
