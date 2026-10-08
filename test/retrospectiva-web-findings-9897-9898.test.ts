/**
 * test/retrospectiva-web-findings-9897-9898.test.ts
 *
 * Dois achados do self-review do PR #9896 na retrospectiva web:
 *
 * - #9897: `cutDraftAfterFirstDestaque` tomava o título do DESTAQUE 1 em
 *   negrito (`**Título**`, formato do 2604-05) por marcador de seção e cortava
 *   logo depois do cabeçalho — o trecho saía sem o corpo do destaque.
 * - #9898: a frase "Responda a este e-mail." do PARA ENCERRAR dos drafts
 *   2608-09 e 2609-10 continuava na página web, que não é e-mail.
 *
 * Fixtures inline (rodam sem `data/`); os drafts reais entram como camada extra
 * quando o checkout tem `data/monthly`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildArticleHtml,
  cutDraftAfterFirstDestaque,
  stripReplyByEmailSentence,
} from "../scripts/lib/mensal/build-article-page.ts";

const ENCHIMENTO = "Texto de enchimento com tamanho realista. ".repeat(12);

function draft(tituloD1: string, encerramento: string): string {
  return [
    "**ASSUNTO (3 OPÇÕES)**",
    "",
    "1. diar.ia.br | Mês 2026 — Um título",
    "",
    "**PREVIEW**",
    "",
    "Uma linha de preview.",
    "",
    "**INTRO**",
    "",
    `Uma introdução. ${ENCHIMENTO}`,
    "",
    "---",
    "",
    "**DESTAQUE 1 | INDÚSTRIA**",
    "",
    tituloD1,
    "",
    `CORPO-DO-PRIMEIRO-DESTAQUE. ${"Mais texto do primeiro destaque. ".repeat(10)}`,
    "",
    "O fio condutor: o fecho do primeiro destaque.",
    "",
    "---",
    "",
    "**CLARICE — DIVULGAÇÃO**",
    "",
    "Texto patrocinado.",
    "",
    "**DESTAQUE 2 | BRASIL**",
    "",
    "Título do segundo",
    "",
    "SEGREDO-DO-SEGUNDO-DESTAQUE",
    "",
    "**PARA ENCERRAR**",
    "",
    encerramento,
    "",
  ].join("\n");
}

const ENCERRAMENTO_2608 =
  "Quer sugerir um tema ou tirar uma dúvida sobre o que está aqui? Responda a este e-mail. Se ainda não recebe a diar.ia.br diária, [assine aqui](https://diar.ia.br/?utm_source=clarice).";

describe("#9897 — título do D1 em negrito não é marcador de seção", () => {
  it("REGRESSÃO: com `**Título**`, o trecho leva o corpo inteiro do destaque", () => {
    const md = draft("**Anthropic vira centro de gravidade da indústria**", "Fim.");
    const trecho = cutDraftAfterFirstDestaque(md, "26xx-yy");
    assert.match(trecho, /\*\*Anthropic vira centro de gravidade da indústria\*\*/);
    assert.match(trecho, /CORPO-DO-PRIMEIRO-DESTAQUE/, "o corpo do D1 entra");
    assert.match(trecho, /O fio condutor/, "até o fecho do destaque");
    assert.ok(!trecho.includes("CLARICE — DIVULGAÇÃO"), "e corta antes do bloco seguinte");
    assert.ok(!trecho.includes("SEGREDO-DO-SEGUNDO-DESTAQUE"));
  });

  it("título sem negrito continua cortando no mesmo lugar", () => {
    const trecho = cutDraftAfterFirstDestaque(draft("Título comum", "Fim."), "26xx-yy");
    assert.match(trecho, /O fio condutor/);
    assert.ok(!trecho.includes("CLARICE — DIVULGAÇÃO"));
  });

  it("marcador em caixa-alta com acento, '?' e travessão segue sendo marcador", () => {
    const md = draft("Título", "Fim.").replace("**CLARICE — DIVULGAÇÃO**", "**É IA? — DESTAQUE**");
    const trecho = cutDraftAfterFirstDestaque(md, "26xx-yy");
    assert.ok(!trecho.includes("É IA?"));
    assert.ok(!trecho.includes("SEGREDO-DO-SEGUNDO-DESTAQUE"));
  });
});

describe("#9903 finding 1 — marcador conhecido com minúscula continua cortando", () => {
  it("REGRESSÃO: `**Destaque 2 | IA generativa**` corta (conteúdo pago não vaza)", () => {
    const md = draft("Título", "Fim.")
      .replace("**CLARICE — DIVULGAÇÃO**", "**Destaque 2 | IA generativa**");
    const trecho = cutDraftAfterFirstDestaque(md, "26xx-yy");
    assert.match(trecho, /O fio condutor/);
    assert.ok(!trecho.includes("IA generativa"), "corta no marcador em caixa mista");
    assert.ok(!trecho.includes("Texto patrocinado"));
    assert.ok(!trecho.includes("SEGREDO-DO-SEGUNDO-DESTAQUE"));
  });

  it("`**É IA? — Destaque**` (caixa mista) também corta", () => {
    const md = draft("Título", "Fim.").replace("**CLARICE — DIVULGAÇÃO**", "**É IA? — Destaque**");
    const trecho = cutDraftAfterFirstDestaque(md, "26xx-yy");
    assert.ok(!trecho.includes("É IA?"));
    assert.ok(!trecho.includes("Texto patrocinado"));
  });

  it("título do D1 em negrito continua NÃO sendo marcador", () => {
    const trecho = cutDraftAfterFirstDestaque(draft("**Anthropic vira centro de gravidade da indústria**", "Fim."), "26xx-yy");
    assert.match(trecho, /CORPO-DO-PRIMEIRO-DESTAQUE/);
    assert.match(trecho, /O fio condutor/);
  });
});

describe("#9903 findings 3-4 — limpeza da frase 'Responda…'", () => {
  it("pergunta após dois espaços ou &nbsp; também sai", () => {
    assert.equal(
      stripReplyByEmailSentence(`<p>Fim.  Quer sugerir? Responda a este e-mail. Assine.</p>`),
      `<p>Fim.  Assine.</p>`,
    );
    assert.equal(
      stripReplyByEmailSentence(`<p>Fim.&nbsp;Quer sugerir? Responda a este e-mail. Assine.</p>`),
      `<p>Fim.&nbsp;Assine.</p>`,
    );
  });

  it("parágrafo só com pergunta + frase sai inteiro, sem deixar <p></p>", () => {
    assert.equal(
      stripReplyByEmailSentence(`<p>Antes.</p>\n<p>Quer sugerir um tema? Responda a este e-mail.</p>\n<p>Depois.</p>`),
      `<p>Antes.</p>\n<p>Depois.</p>`,
    );
  });
});

describe("#9898 — 'Responda a este e-mail.' sai da página web", () => {
  it("REGRESSÃO: a copy do PARA ENCERRAR 2608/2609 perde a pergunta e a frase, mantém o CTA", () => {
    const html = buildArticleHtml(draft("Título", ENCERRAMENTO_2608), "2608-09").html;
    assert.ok(!/Responda a este e-mail/i.test(html), "a frase saiu");
    assert.ok(!html.includes("Quer sugerir um tema"), "a pergunta que a introduz também");
    assert.match(html, /<p>Se ainda não recebe a /, "o CTA de cadastro fica, abrindo o parágrafo");
    assert.match(html, /assine aqui/);
  });

  it("unitário: corta só a pergunta + frase, sem tocar o resto do parágrafo", () => {
    const p = `<p>Quer sugerir um tema? Responda a este e-mail. Se ainda não recebe, <a href="https://x">assine aqui</a>.</p>`;
    assert.equal(stripReplyByEmailSentence(p), `<p>Se ainda não recebe, <a href="https://x">assine aqui</a>.</p>`);
  });

  it("não come frase anterior que não é pergunta", () => {
    const p = `<p>Gostou da edição. Responda a este e-mail. Fim.</p>`;
    assert.equal(stripReplyByEmailSentence(p), `<p>Gostou da edição. Fim.</p>`);
  });

  it("pergunta não é cortada a partir de maiúscula no meio da frase", () => {
    // Sem o limite de frase, o corte poderia partir de "OpenAI" e deixar
    // "Fale com a gente sobre a " pendurado.
    const p = `<p>Ok. Fale com a gente sobre a OpenAI? Responda a este e-mail.</p>`;
    assert.equal(stripReplyByEmailSentence(p), `<p>Ok. </p>`);
  });

  it("a forma antiga (2606-07, 'Se você quiser receber…') continua saindo", () => {
    const p = `<p>Se você quiser receber com prioridade, responda a este e-mail dizendo "quero". Se quiser, <a href="https://x">cadastre-se</a>.</p>`;
    assert.equal(stripReplyByEmailSentence(p), `<p>Se quiser, <a href="https://x">cadastre-se</a>.</p>`);
  });

  it("variante 'responda esse e-mail' (2605-06) também sai", () => {
    const p = `<p>Se você quiser receber com prioridade, responda esse e-mail dizendo "quero". Se quiser, <a href="https://x">cadastre-se</a>.</p>`;
    assert.equal(stripReplyByEmailSentence(p), `<p>Se quiser, <a href="https://x">cadastre-se</a>.</p>`);
  });

  for (const ciclo of ["2605-06", "2608-09", "2609-10"]) {
    const path = `data/monthly/${ciclo}/draft.md`;
    it(`draft real ${ciclo}: página sem 'Responda a este e-mail'`, { skip: !existsSync(path) }, () => {
      const html = buildArticleHtml(readFileSync(path, "utf8"), ciclo).html;
      assert.ok(!/responda (?:a )?(?:este|esse) e-mail/i.test(html));
    });
  }
});
