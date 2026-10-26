/**
 * test/circle-stack-estrutura-11186.test.ts (#11186)
 *
 * Estrutura revisada do post semanal do Radar de Notícias Stack:
 *   - abertura que resume a semana com os fatos dos destaques (1ª frase do
 *     corpo de cada um), no lugar da frase fixa;
 *   - `opening` escrito à mão na seleção vence o resumo; `--opening-file` vence tudo;
 *   - "Outros destaques da semana" reconhece destaque com título traduzido pelo
 *     `titleOriginal` (sem isso, o D1 voltava na lista do dia).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderCircleStackPost,
  firstSentence,
  circleStackSummaryOpening,
  DEFAULT_CIRCLE_STACK_OPENING,
  CIRCLE_STACK_SUMMARY_TAIL,
  type CircleStackItem,
  type CircleStackSelection,
} from "../scripts/lib/circle-stack-render.ts";
import { parseStoredCircleStackSelection } from "../scripts/publish-circle-stack.ts";

const item = (over: Partial<CircleStackItem>): CircleStackItem => ({
  editionDate: "261020", url: "https://ex.com/x", title: "T", body: "Corpo.", why: "", ...over,
});

const base: CircleStackSelection = {
  cycle: "26w43",
  contentWindow: ["261019", "261020", "261021", "261022", "261023"],
  destaques: [
    item({
      url: "https://www.anthropic.com/research/employment-at-anthropic",
      title: "Seu cargo de júnior sobreviveria na Anthropic?",
      body:
        "Na Anthropic, a fatia de contratações para vagas técnicas júnior caiu de 27% para 9%, segundo relatório da empresa. Em agosto, os agentes já somavam seis vezes mais horas.\n\nSegundo parágrafo.",
    }),
    item({
      url: "https://blog.cloudflare.com/clairic-extraction-model",
      title: "Cloudflare lança modelo que lê sem gerar texto",
      body: "A Cloudflare lançou o Clairic, que custa US$ 0,04 por 1.000 páginas lidas. Diferente de um LLM, ele não escreve.",
    }),
  ],
  lancamentos: [],
  useMelhor: [],
  radar: [],
  weeklyEditions: [],
};

describe("firstSentence (#11186)", () => {
  it("corta no primeiro ponto seguido de maiúscula; '1.000' e 'US$ 0,04' não cortam", () => {
    assert.equal(
      firstSentence("A Cloudflare lançou o Clairic, que custa US$ 0,04 por 1.000 páginas lidas. Diferente de um LLM."),
      "A Cloudflare lançou o Clairic, que custa US$ 0,04 por 1.000 páginas lidas.",
    );
  });
  it("usa só o 1º parágrafo e fecha com ponto quando falta", () => {
    assert.equal(firstSentence("Sem ponto final\n\nOutro parágrafo."), "Sem ponto final.");
  });
  it("tira negrito e link Markdown", () => {
    assert.equal(firstSentence("O **GPT-6** saiu no [blog](https://x.com/a). Mais."), "O GPT-6 saiu no blog.");
  });
  it("frase longa demais ou corpo vazio = null", () => {
    assert.equal(firstSentence(`${"palavra ".repeat(60)}fim.`), null);
    assert.equal(firstSentence("  \n "), null);
  });
});

describe("abertura do post (#11186)", () => {
  it("resume a semana com a 1ª frase de cada destaque, na ordem, e o fecho fixo", () => {
    const { markdown } = renderCircleStackPost(base);
    const firstPara = markdown.split("\n\n")[0];
    assert.equal(
      firstPara,
      "Na Anthropic, a fatia de contratações para vagas técnicas júnior caiu de 27% para 9%, segundo relatório da empresa. " +
        "A Cloudflare lançou o Clairic, que custa US$ 0,04 por 1.000 páginas lidas. " +
        CIRCLE_STACK_SUMMARY_TAIL,
    );
    assert.ok(!markdown.includes(DEFAULT_CIRCLE_STACK_OPENING), "frase fixa antiga não pode voltar");
  });

  it("nenhum destaque com frase utilizável cai na abertura de reserva", () => {
    assert.equal(circleStackSummaryOpening([{ body: "" }]), null);
    const { markdown } = renderCircleStackPost({ ...base, destaques: [item({ body: "" })] });
    assert.ok(markdown.startsWith(DEFAULT_CIRCLE_STACK_OPENING));
  });

  it("`opening` da seleção vence o resumo; --opening-file vence a seleção", () => {
    const sel = { ...base, opening: "Abertura escrita pelo editor." };
    assert.ok(renderCircleStackPost(sel).markdown.startsWith("Abertura escrita pelo editor.\n\n## Destaques da semana"));
    assert.ok(renderCircleStackPost(sel, { opening: "Do arquivo." }).markdown.startsWith("Do arquivo.\n\n"));
    // opening vazio na seleção = resumo automático
    assert.ok(renderCircleStackPost({ ...base, opening: "  " }).markdown.startsWith("Na Anthropic"));
  });

  it("seleção gravada aceita opening texto e recusa outro tipo", () => {
    const raw = (opening: unknown) => JSON.stringify({ ...base, opening });
    assert.equal(parseStoredCircleStackSelection(raw("Oi."), "/x.json", "26w43").selection.opening, "Oi.");
    assert.throws(() => parseStoredCircleStackSelection(raw(3), "/x.json", "26w43"), /opening não é texto/);
  });
});

describe("Outros destaques da semana — título traduzido (#11186)", () => {
  it("destaque com title reescrito na seleção não reaparece pelo título original da edição", () => {
    const sel: CircleStackSelection = {
      ...base,
      destaques: [item({ title: "Mercury 3 passa de mil tokens por segundo", titleOriginal: "Introducing Mercury 3" })],
      weeklyEditions: [
        { editionDate: "261020", url: "https://diar.ia.br/p/x", destaques: ["Introducing Mercury 3", "Outra notícia do dia"] },
      ],
    };
    const { markdown } = renderCircleStackPost(sel);
    const outros = markdown.split("## Outros destaques da semana")[1] ?? "";
    assert.ok(outros.includes("- Outra notícia do dia"));
    assert.ok(!outros.includes("Introducing Mercury 3"));
  });
});
