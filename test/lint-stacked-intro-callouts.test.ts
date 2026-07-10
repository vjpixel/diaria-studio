/**
 * test/lint-stacked-intro-callouts.test.ts (#2729, marcador-agnóstico desde #3232)
 *
 * `extractIntroCallout` (scripts/lib/newsletter-parse.ts) foi tornado greedy
 * pelo #2727 para permitir sub-linhas `**bold**` (ex: "**Sorteio**") dentro
 * do box de início de mês (campeões do É IA? + sorteio, #2725), e desde #3232
 * deixou de exigir um marcador 🎉/📣 — QUALQUER bloco bold-wrap na região de
 * intro (antes do 1º `**DESTAQUE`) é candidato. O regex greedy
 * (`/^\*\*\s*([\s\S]+)\*\*\s*$/m`) assume que essa região contém NO MÁXIMO 1
 * bloco de callout.
 *
 * Se o editor colar 2 blocos empilhados na região de intro (ex: um
 * patrocinado ACIMA do CTA de campeões/sorteio — `inject-champions-callout.ts`
 * já pula a auto-injeção quando um callout preexiste, mas isso não impede
 * colagem manual pelo editor no Drive), o greedy funde os 2 blocos: os `**`
 * internos (fechamento do 1º + abertura do 2º) vazam como texto literal, e o
 * bloco patrocinado perde o separador "Divulgação" que o renderer usa pra
 * distinguir patrocínio de callout editorial.
 *
 * `lintStackedIntroCallouts` (scripts/lib/lint-checks/callout-placement.ts)
 * é o backstop determinístico: erra quando encontra ≥2 parágrafos de abertura
 * bold-wrap na região de intro — marcador-agnóstico desde #3232 (antes exigia
 * literalmente `^\*\*\s*(🎉|📣)`, o que deixava passar sem flag um par de
 * blocos empilhados com marcador novo/nenhum).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lintStackedIntroCallouts,
  type StackedIntroCalloutResult,
} from "../scripts/lib/lint-checks/callout-placement.ts";
import { extractIntroCallout } from "../scripts/lib/newsletter-parse.ts";
// Re-export de back-compat — confirma que lint-newsletter-md.ts aponta pra
// mesma função (mesmo padrão de test/lint-checks-extracted.test.ts).
import { lintStackedIntroCallouts as lintReexport } from "../scripts/lint-newsletter-md.ts";

const TITULO_SUBTITULO = "TÍTULO\n\nSubtítulo da edição.\n";
const COVERAGE_LINE =
  "Para esta edição, eu (o editor) enviei 2 submissões e a Diar.ia encontrou outros 8 artigos. Selecionamos os 3 mais relevantes.";

function destaque(n: number): string {
  return [
    `**DESTAQUE ${n} | LANÇAMENTO**`,
    "",
    `**[Título ${n}](https://x.com/${n})**`,
    "",
    `Corpo do destaque ${n}.`,
    "",
    "Por que isso importa:",
    "",
    `Why do D${n}.`,
  ].join("\n");
}

describe("lintStackedIntroCallouts (#2729)", () => {
  it("re-export de lint-newsletter-md.ts é a MESMA função do módulo", () => {
    assert.strictEqual(lintReexport, lintStackedIntroCallouts);
  });

  it("ok: caso normal — 1 único bloco de callout (🎉 campeões #2725) na intro", () => {
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**🎉 Os campeões do É IA? em junho:",
      "",
      "🥇 fulano",
      "",
      "🥈 beltrano",
      "",
      "🥉 sicrano",
      "",
      "**Sorteio**",
      "",
      "O sorteio será ao vivo no dia 2 de julho.**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  it("ok: caso normal — 1 único bloco 📣 patrocinado na intro", () => {
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**📣 Patrocinado por Clarice. Divulgação: [saiba mais](https://clarice.ai).**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    assert.equal(lintStackedIntroCallouts(md).ok, true);
  });

  it("ok: sem nenhum callout na intro", () => {
    const md = [TITULO_SUBTITULO, COVERAGE_LINE, "", "---", "", destaque(1)].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
  });

  it("FALHA: 2 blocos empilhados na intro (📣 patrocinado ACIMA do 🎉 de campeões)", () => {
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**📣 Patrocinado por Clarice. Divulgação: [saiba mais](https://clarice.ai).**",
      "",
      "**🎉 Os campeões do É IA? em junho:",
      "",
      "🥇 fulano",
      "",
      "**Sorteio**",
      "",
      "O sorteio será ao vivo no dia 2 de julho.**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, false);
    assert.equal(r.count, 2);
    // linha 4 (📣) e linha 6 (🎉) — 1-based, contando TITULO_SUBTITULO como
    // 3 linhas ("TÍTULO", "", "Subtítulo da edição.") + a linha vazia extra
    // do template literal + COVERAGE_LINE + linha vazia.
    assert.equal(r.lines.length, 2);
  });

  it("regressão #2729: extractIntroCallout funde os 2 blocos empilhados (demonstra o bug que o lint pega)", () => {
    const md = [
      "**📣 Patrocinado por Clarice. Divulgação: [saiba mais](https://clarice.ai).**",
      "",
      "**🎉 Os campeões do É IA? em junho: 🥇 fulano**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    // Confirma que o lint pega ANTES do parse corromper:
    assert.equal(lintStackedIntroCallouts(md).ok, false);
    // Demonstra a corrupção real: extractIntroCallout funde os 2 blocos num
    // só — o `**` de fechamento do 1º bloco + abertura do 2º vazam como
    // texto literal dentro do resultado (não fica limpo em 2 blocos distintos).
    const fused = extractIntroCallout(md);
    assert.ok(fused !== null);
    // O resultado fundido contém literalmente os `**` internos (marcador de
    // bold que deveria ter fechado o 1º bloco) — prova da corrupção.
    assert.match(fused as string, /\*\*/, "fusão greedy vaza '**' interno no texto — corrupção real que o lint previne");
  });

  it("ok: callouts ENTRE destaques (boxDivulgacao1) não contam pra intro — só a região antes do 1º DESTAQUE", () => {
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**🎉 Único callout de intro.**",
      "",
      "---",
      "",
      destaque(1),
      "",
      "---",
      "",
      "**📣 Callout entre D1 e D2 — boxDivulgacao1, escopo diferente.**",
      "",
      "---",
      "",
      destaque(2),
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, true, `boxDivulgacao1 não deve contar pra intro: ${JSON.stringify(r)}`);
    assert.equal(r.count, 1);
  });

  it("ok: sem nenhum **DESTAQUE (edge case) ainda escaneia a região inteira", () => {
    const md = [
      "**📣 Callout 1.**",
      "",
      "**🎉 Callout 2.**",
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, false);
    assert.equal(r.count, 2);
  });

  it("#3232 marcador-agnóstico: 📚 (ou QUALQUER outro marcador) TAMBÉM conta como abertura de bloco — extractIntroCallout não reconhece mais só 🎉/📣", () => {
    // #3232: lintStackedIntroCallouts detecta abertura de bloco por ESTRUTURA
    // (parágrafo bold-wrap), não por um allowlist de 2 emojis — espelha o fato
    // de extractIntroCallout também ter deixado de exigir 🎉/📣. Este é
    // exatamente o caso que o lint precisa pegar agora: 2 blocos bold-wrap
    // empilhados na intro, com QUALQUER marcador (inclusive um novo, ex: 🎥),
    // se fundiriam no parse greedy — igual ao caso 📣+🎉 já coberto acima.
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**🎉 Único callout de intro.**",
      "",
      "**📚 Um segundo bloco bold-wrap empilhado — conta como 2ª abertura agora.**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, false, `2 blocos bold-wrap empilhados devem ser flagrados, marcador-agnóstico: ${JSON.stringify(r)}`);
    assert.equal(r.count, 2);
  });

  it("#3232: marcador NOVO (nunca visto, ex: 🎥) sozinho na intro — 1 bloco só, sem falso-positivo", () => {
    const md = [
      TITULO_SUBTITULO,
      COVERAGE_LINE,
      "",
      "**🎥 Assista: bastidores da produção com IA. [Veja](https://x.com/v).**",
      "",
      "---",
      "",
      destaque(1),
    ].join("\n");
    const r = lintStackedIntroCallouts(md);
    assert.equal(r.ok, true, `1 bloco com marcador novo não deveria ser flagrado: ${JSON.stringify(r)}`);
    assert.equal(r.count, 1);
  });
});
