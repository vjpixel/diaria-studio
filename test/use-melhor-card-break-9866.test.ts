/**
 * test/use-melhor-card-break-9866.test.ts (#9866)
 *
 * Marcador `{quebra}` no `## um`: 2 itens no MESMO card do carrossel, com linha
 * em branco entre eles no texto publicado. Edição 261008: sem marcador oficial,
 * o editor contornou com uma linha só com U+200B.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  USE_MELHOR_CARD_BREAK,
  isUseMelhorCardBreakLine,
  resolveUseMelhorCardBreaks,
  stripUseMelhorCardBreaks,
} from "../scripts/lib/use-melhor-card-break.ts";
import {
  buildUseMelhorSlides,
  countUseMelhorParagraphs,
  lintUseMelhorPostList,
  lintUseMelhorPostText,
  parseUseMelhorListItems,
} from "../scripts/lib/use-melhor-carousel.ts";
import { finalizeUseMelhorPostText, type UseMelhorReadyPlan } from "../scripts/lib/use-melhor-dispatch.ts";
import { useMelhorSlideImageKey } from "../scripts/lib/use-melhor-slide-files.ts";
import { lintLinkedinSchema } from "../scripts/lib/social-lint-rules.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import { extractPersonalPostText } from "../scripts/resolve-post-pixel.ts";

const I1 = "1) **Peça o primeiro rascunho** de e-mails e propostas.";
const I2 = "2) **Resuma documentos longos** pedindo os pontos principais.";
const I3 = "3) **Prepare reuniões** pedindo a pauta e as objeções possíveis.";
const I4 = "4) **Analise e-mails** perguntando qual é a solicitação.";
const I5 = "5) **Aprenda mais rápido** contando o seu nível.";
const I6 = "6) **Peça exemplos** antes de aplicar a regra nova.";

const WITH_BREAK = [`${I1}\n${I2}`, `${I3}\n${I4}`, `${I5}\n${USE_MELHOR_CARD_BREAK}\n${I6}`, "#Produtividade"].join("\n\n");
const WITHOUT_BREAK = [`${I1}\n${I2}`, `${I3}\n${I4}`, `${I5}\n${I6}`, "#Produtividade"].join("\n\n");
const TITLE = "Seis usos de IA no trabalho";

describe("marcador {quebra} — funções puras (#9866)", () => {
  it("reconhece só a linha inteira = marcador (com espaços), e o alias U+200B legado", () => {
    assert.equal(isUseMelhorCardBreakLine("{quebra}"), true);
    assert.equal(isUseMelhorCardBreakLine("  {quebra}  "), true);
    assert.equal(isUseMelhorCardBreakLine("{QUEBRA}\r"), true);
    assert.equal(isUseMelhorCardBreakLine("​"), true);
    assert.equal(isUseMelhorCardBreakLine("5) item {quebra}"), false);
    assert.equal(isUseMelhorCardBreakLine(""), false);
  });

  it("strip remove a linha; resolve troca por linha em branco", () => {
    assert.equal(stripUseMelhorCardBreaks(`a\n{quebra}\nb`), "a\nb");
    assert.equal(resolveUseMelhorCardBreaks(`a\n{quebra}\nb`), "a\n\nb");
    assert.equal(resolveUseMelhorCardBreaks(`a\n​\nb`), "a\n\nb");
    assert.equal(resolveUseMelhorCardBreaks("sem marcador"), "sem marcador");
  });
});

describe("carrossel e lints de forma ignoram o marcador (#9866)", () => {
  it("mesmos slides (texto, ordem, contagem) com e sem a linha {quebra}", () => {
    const a = buildUseMelhorSlides(WITH_BREAK, TITLE);
    const b = buildUseMelhorSlides(WITHOUT_BREAK, TITLE);
    assert.deepEqual(a, b);
    assert.equal(countUseMelhorParagraphs(WITH_BREAK), 3);
    assert.ok(a.every((s) => !s.text.title.includes("{quebra}")));
  });

  it("o item seguinte ao marcador não engole o marcador como continuação", () => {
    assert.deepEqual(parseUseMelhorListItems(`${I5}\n{quebra}\n${I6}`)?.map((i) => i.text), [I5, I6]);
  });

  it("lints de forma do ## um dão o mesmo veredito com e sem marcador", () => {
    assert.deepEqual(lintUseMelhorPostList(WITH_BREAK), lintUseMelhorPostList(WITHOUT_BREAK));
    assert.deepEqual(lintUseMelhorPostText(WITH_BREAK), lintUseMelhorPostText(WITHOUT_BREAK));
  });

  it("lintLinkedinSchema não conta o marcador nos chars do ## um", () => {
    const md = (um: string) => `# Social\n\n## d1\n\nTexto.\n\n## um\n\n${um}\n`;
    const err = (um: string) =>
      lintLinkedinSchema(md(um)).errors.find((e) => e.destaque === "um" && e.rule === "main_chars_out_of_range")?.detail;
    // Corpo no limite inferior da tolerância (300): o marcador não pode empurrar pra dentro.
    const body = `1) ${"a".repeat(140)}\n2) ${"b".repeat(140)}`;
    assert.equal(err(body), err(body.replace("\n", "\n{quebra}\n")));
  });
});

describe("publicadores trocam o marcador por linha em branco (#9866)", () => {
  const md = [
    "# Social", "", "## d1", "", "Texto do destaque.", "", "#Tag", "",
    "## um", "", WITH_BREAK, "",
    "# Curto", "", "## d1", "", "Curto. Mais em https://diar.ia.br/p/x #Tag", "",
  ].join("\n");
  const slots = buildUseMelhorSlides(WITH_BREAK, TITLE).map((s) => s.slot);
  const plan: UseMelhorReadyPlan = {
    status: "ready",
    time: "08:00",
    item: { url: "https://example.com/guia", title: TITLE, summary: "S", score: 80 },
    slots,
  };
  const images: Record<string, { url?: string }> = {};
  for (const s of slots) images[useMelhorSlideImageKey(s)] = { url: `https://cdn/um-${s}.jpg` };
  const BLANK_BETWEEN_5_6 = /Aprenda mais rápido[^\n]*\n\n[^\n]*Peça exemplos/;

  it("finalizeUseMelhorPostText resolve o marcador e aplica a UTM", () => {
    const out = finalizeUseMelhorPostText(`${I5}\n{quebra}\n${I6}\nMais em https://diar.ia.br/p/x`);
    assert.match(out, /\n\n6\)/);
    assert.doesNotMatch(out, /\{quebra\}/);
    assert.match(out, /utm_content=usemelhor/);
  });

  it("LinkedIn página", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: md, plan, images });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.doesNotMatch(r.text, /\{quebra\}/);
    assert.match(r.text, BLANK_BETWEEN_5_6);
  });

  it("Facebook", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: md, plan, images, editionDir: "x", fileExists: () => false });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.doesNotMatch(r.caption, /\{quebra\}/);
    assert.match(r.caption, BLANK_BETWEEN_5_6);
  });

  it("Instagram", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: md, plan, images, editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.doesNotMatch(r.caption, /\{quebra\}/);
    assert.match(r.caption, BLANK_BETWEEN_5_6);
  });

  it("LinkedIn pessoal (mesmo texto do ## um)", () => {
    const r = extractPersonalPostText(md);
    assert.equal(r?.source, "um");
    assert.doesNotMatch(r!.text, /\{quebra\}/);
    assert.match(r!.text, BLANK_BETWEEN_5_6);
  });
});
