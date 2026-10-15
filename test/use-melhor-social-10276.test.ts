/**
 * test/use-melhor-social-10276.test.ts (#10276)
 *
 * Dois defeitos do 4º post (USE MELHOR, `## um`):
 *   1. qualquer lista numerada da fonte (requisitos, prazos, sumário) virava
 *      `steps` → `useMelhorUmFormat` = "lista" → o social-writer inventava
 *      passos (o que o #10246 queria evitar). Agora só lista com sinal de
 *      TUTORIAL vira `steps`.
 *   2. a 1ª linha da legenda (`captionTitle`, #10201) usava o título resolvido
 *      no Stage 5, enquanto a capa mostra `stamp.cover_title` gravado no
 *      Stage 3 — título editado no gate 4 deixava legenda × capa diferentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  enrichUseMelhorItem,
  extractUseMelhorSteps,
  startsWithImperative,
  useMelhorUmFormat,
} from "../scripts/lib/use-melhor-post.ts";
import { planUseMelhorDispatchFrom } from "../scripts/lib/use-melhor-dispatch.ts";
import { buildUseMelhorSlides, hashUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";

const BASE = { url: "https://exemplo.com/programa", title: "Programa de bolsas abre inscrições", summary: "S", score: 80 };

describe("#10276 defeito 1 — lista numerada sem sinal de tutorial não vira steps", () => {
  it("página de requisitos numerados → sem steps → formato prosa (cenário da issue)", () => {
    const pagina = [
      "Programa de bolsas em IA abre inscrições",
      "Quem pode participar",
      "1. Ter mais de 18 anos e residir no Brasil",
      "2. Prazo de inscrição até 30 de outubro",
      "3. Experiência prévia com Python",
      "O resultado sai em novembro.",
    ].join("\n");
    assert.deepEqual(extractUseMelhorSteps(pagina), []);
    const item = enrichUseMelhorItem(BASE, pagina);
    assert.equal(item.steps, undefined);
    assert.equal(useMelhorUmFormat(item), "prosa");
  });

  it("sumário numerado sozinho não vira steps", () => {
    assert.deepEqual(extractUseMelhorSteps("Neste artigo\n1. Introdução\n2. Contexto histórico\n3. Conclusão"), []);
  });

  it("etapas de inscrição em substantivo (sem verbo de ação) não viram steps", () => {
    assert.deepEqual(extractUseMelhorSteps("Cronograma\n1. Inscrição online\n2. Análise de currículo\n3. Entrevista final"), []);
  });

  it("itens com verbo imperativo viram steps (tutorial real)", () => {
    const t = "Veja abaixo.\n1. Abra o ChatGPT\n2. Clique em Configurações\n3. Ative a memória";
    assert.deepEqual(extractUseMelhorSteps(t), ["Abra o ChatGPT", "Clique em Configurações", "Ative a memória"]);
    assert.equal(useMelhorUmFormat(enrichUseMelhorItem(BASE, t)), "lista");
  });

  it("cabeçalho de tutorial antes da lista basta, mesmo sem verbo imperativo", () => {
    const t = "Passo a passo\n1. Conta no Google Drive\n2. Pasta compartilhada com a equipe";
    assert.deepEqual(extractUseMelhorSteps(t), ["Conta no Google Drive", "Pasta compartilhada com a equipe"]);
    assert.deepEqual(
      extractUseMelhorSteps("## Como montar o fluxo\n1. Uma planilha de entrada\n2. Um gatilho no Zapier"),
      ["Uma planilha de entrada", "Um gatilho no Zapier"],
    );
  });

  it("'como' no meio de prosa não conta como cabeçalho", () => {
    assert.deepEqual(
      extractUseMelhorSteps("O programa funciona como uma ponte.\n1. Ter mais de 18 anos\n2. Morar no Brasil"),
      [],
    );
  });

  it("marcador explícito 'Passo N' segue valendo sozinho", () => {
    assert.deepEqual(extractUseMelhorSteps("Passo 1: Conta criada\nPasso 2: Formulário pronto"), ["Conta criada", "Formulário pronto"]);
  });

  it("requisitos antes e tutorial depois: fica com o tutorial, mesmo menor", () => {
    const t = [
      "Requisitos",
      "1. Ter conta paga",
      "2. Ter navegador atualizado",
      "3. Ter acesso ao beta",
      "Agora:",
      "1. Abra o painel",
      "2. Copie a chave",
    ].join("\n");
    assert.deepEqual(extractUseMelhorSteps(t), ["Abra o painel", "Copie a chave"]);
  });

  it("startsWithImperative: imperativo sim; infinitivo e substantivo não; ignora markup/acento", () => {
    assert.equal(startsWithImperative("Faça login"), true);
    assert.equal(startsWithImperative("**Vá** até o menu"), true);
    assert.equal(startsWithImperative("Open the app"), true);
    assert.equal(startsWithImperative("Ter conta"), false);
    assert.equal(startsWithImperative("Enviar até 30/10"), false);
    assert.equal(startsWithImperative("Inscrição online"), false);
  });
});

describe("#10276 defeito 2 — 1ª linha da legenda = título da capa", () => {
  const TITLE_STAGE3 = "Como saber se a assinatura de IA se paga";
  const TITLE_GATE4 = "A conta da assinatura de IA";
  const UM = "1) Some o custo total da assinatura.\n\n2) Estime as horas poupadas.\n\n#IA";
  const slides = buildUseMelhorSlides(UM, TITLE_STAGE3);
  const stamp = { hash: hashUseMelhorSlides(slides), slots: slides.map((s) => s.slot), cover_title: TITLE_STAGE3 };
  const item = { url: "https://exemplo.com/roi", title: TITLE_GATE4, summary: "R", score: 90 };
  const input = (st: typeof stamp | null) => ({
    config: { publishing: { social: { use_melhor_time: "07:45" } } },
    state: { enabled: true, time: "07:45", item, generated_at: "x" },
    reviewedMd: `**USE MELHOR**\n\n[${TITLE_GATE4}](${item.url})\nR\n`,
    approved: { use_melhor: [{ url: item.url, title: TITLE_STAGE3, summary: "R", score: 90 }] },
    socialUm: UM,
    stamp: st,
    ctaOverride: null,
  });

  it("título mudou no gate 4 com carrossel valendo → legenda usa o cover_title gravado", () => {
    const p = planUseMelhorDispatchFrom(input(stamp));
    assert.equal(p.status, "ready");
    if (p.status !== "ready") return;
    assert.ok(p.slots, "carrossel deve valer");
    assert.equal(p.captionTitle, TITLE_STAGE3);
    assert.ok(p.coverTitleWarning, "o aviso de drift continua");
  });

  it("sem carrossel (sem carimbo) → legenda usa o título resolvido agora", () => {
    const p = planUseMelhorDispatchFrom(input(null));
    assert.equal(p.status, "ready");
    if (p.status === "ready") {
      assert.equal(p.slots, null);
      assert.equal(p.captionTitle, TITLE_GATE4);
    }
  });
});
