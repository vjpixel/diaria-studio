/**
 * test/circle-stack-copy-select-11781-11784.test.ts
 *
 * Lote do post semanal da Stack (ciclo 26w44, 01/11/2026):
 *   - #11781: título em português sem acento ("Apagou a conversa? O Android
 *     ainda guarda") era acusado como sem sinal de português.
 *   - #11782: a seleção de destaques contava só palavras; o GPT-6.1 Terra (D1,
 *     modelo novo pela metade do preço) perdia para "Hackers usam Claude e
 *     Grok contra bancos".
 *   - #11783: abertura do stack-writer com teto de 600 caracteres; o editor
 *     aprovou uma de 200 depois de recusar duas de ~560.
 *   - #11784: /diaria-stack sem data, num domingo, assumia o ciclo já publicado.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  circleStackUnreviewedTitles,
  hasPortugueseSignal,
  looksEnglishTitle,
  scoreCandidate,
  selectCircleStack,
  STACK_INTEREST_PROFILE,
} from "../scripts/lib/circle-stack-select.ts";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";
import {
  buildStackWriterInput,
  STACK_COPY_OPENING_MAX_CHARS,
  STACK_COPY_OPENING_TARGET_CHARS,
  stackCopyTextProblems,
} from "../scripts/lib/circle-stack-copy.ts";
import { resolveSkillDefaultMonday } from "../scripts/publish-circle-stack.ts";
import type { PublishState } from "../scripts/lib/publish-state.ts";

describe("hasPortugueseSignal (#11781)", () => {
  it("título da diária sem acento e sem as palavras da lista antiga tem sinal de português", () => {
    assert.equal(hasPortugueseSignal("Apagou a conversa? O Android ainda guarda"), true);
  });

  it("não vira guard do item: o título do ciclo 26w44 sai de circleStackUnreviewedTitles", () => {
    const it = { editionDate: "261029", url: "https://ex.com/android", title: "Apagou a conversa? O Android ainda guarda", body: "", why: "" };
    assert.deepEqual(circleStackUnreviewedTitles({ destaques: [], lancamentos: [], useMelhor: [], radar: [it] }), []);
  });

  it("título em inglês continua sem sinal de português e continua acusado", () => {
    for (const t of ["Codex Launch Notes", "Introducing Codex", "No-code agents as a service", "Do more with a new model"]) {
      assert.equal(hasPortugueseSignal(t), false, t);
    }
    for (const t of ["How to build agents with the SDK", "Claude for your team", "Diffusion at Scale: Introducing Mercury 3"]) {
      assert.equal(looksEnglishTitle(t), true, t);
    }
  });
});

const destaque = (over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261026",
  url: `https://ex.com/${Math.random()}`,
  title: "Título neutro",
  body: "Corpo neutro.",
  why: "",
  kind: "destaque",
  category: "DESTAQUE 1 | negócios",
  section: "destaque",
  ...over,
});

describe("seleção de destaques considera a importância da notícia (#11782)", () => {
  // Reconstrução enxuta do ciclo 26w44: antes, Hackers (D1, cita o Cursor e
  // "código de ataque") somava 9 e o Terra 8, e o Terra ficava fora.
  const terra = destaque({
    editionDate: "261028",
    destaqueN: 1,
    title: "OpenAI lança GPT-6.1 Terra pela metade do preço",
    body: "O modelo chega ao Codex e à API, com automação de tarefas longas.",
  });
  const hackers = destaque({
    editionDate: "261026",
    destaqueN: 1,
    title: "Hackers usam Claude e Grok contra bancos",
    body: "Os ataques usaram o Cursor para gerar código de ataque com agentes.",
  });
  const vigia = destaque({
    editionDate: "261026",
    destaqueN: 3,
    title: "Agentes da OpenAI podiam desligar o próprio vigia",
    body: "O METR achou brechas no Codex; a programação do monitor tinha falhas.",
  });
  const kimi = destaque({
    editionDate: "261027",
    destaqueN: 2,
    title: "Kimi K3.1 Pro encosta no Claude e abre os pesos",
    body: "Agentes, app e API: o modelo de código aberto roda programação longa.",
  });

  it("D1 com modelo novo e preço no título entra nos destaques", () => {
    const picks = selectCircleStack([hackers, terra, vigia, kimi]);
    assert.ok(picks.destaques.some((d) => d.title === terra.title), picks.destaques.map((d) => `${d.title} ${d.score}`).join(" | "));
    assert.ok(scoreCandidate(terra).score > scoreCandidate(hackers).score);
  });

  it("registra os termos de importância e o bônus de posição", () => {
    const s = scoreCandidate(terra);
    assert.ok(s.matchedTerms.includes("modelo novo"));
    assert.ok(s.matchedTerms.includes("custo/preço"));
    const semPosicao = scoreCandidate({ ...terra, destaqueN: 3 });
    assert.equal(s.score - semPosicao.score, 2);
  });

  it("importância só conta no título: 'modelo' de passagem no corpo não pontua", () => {
    const base = destaque({ destaqueN: 3, title: "Lula promete uma IA brasileira", body: "Sem detalhe." });
    const comCorpo = { ...base, body: "O modelo e o custo ainda não foram definidos." };
    assert.equal(scoreCandidate(comCorpo).score, scoreCandidate(base).score);
  });

  it("item de seção não ganha importância (não muda o filtro de Lançamentos/Use melhor)", () => {
    const sec: WeeklyRawCandidate = { ...terra, kind: "section", section: "radar", category: "RADAR", destaqueN: undefined };
    assert.ok(!scoreCandidate(sec).matchedTerms.includes("modelo novo"));
  });

  it("perfil de interesse do config não apaga a importância", () => {
    const custom = [{ label: "Lovable", pattern: "lovable", weight: 4 }];
    assert.ok(scoreCandidate(terra, custom).matchedTerms.includes("custo/preço"));
    assert.ok(STACK_INTEREST_PROFILE.every((t) => t.label !== "modelo novo"));
  });
});

describe("abertura curta do stack-writer (#11783)", () => {
  const aprovada =
    "O METR achou brechas no sistema que vigia os agentes da OpenAI. O GPT-6.1 Terra chegou custando metade do modelo anterior. " +
    "Para quem constrói, há ainda o Monitoring Agent da Replit e o beta do n8n 3.0.";

  it("a abertura aprovada no 26w44 passa e uma de ~560 caracteres é recusada", () => {
    assert.deepEqual(stackCopyTextProblems(aprovada, STACK_COPY_OPENING_MAX_CHARS), []);
    const longa = `${aprovada} ${aprovada} ${aprovada}`.slice(0, 560);
    assert.match(stackCopyTextProblems(longa, STACK_COPY_OPENING_MAX_CHARS)[0], /teto/);
  });

  it("teto e alvo baixos, e o manifest leva o alvo ao agente", () => {
    assert.equal(STACK_COPY_OPENING_TARGET_CHARS, 200);
    assert.ok(STACK_COPY_OPENING_MAX_CHARS <= 300);
    const m = buildStackWriterInput(
      { cycle: "26w44", contentWindow: [], destaques: [], lancamentos: [], useMelhor: [], radar: [], weeklyEditions: [] },
      "/tmp/x.json",
    );
    assert.equal(m.limits.openingTargetChars, STACK_COPY_OPENING_TARGET_CHARS);
    assert.equal(m.limits.openingMaxChars, STACK_COPY_OPENING_MAX_CHARS);
  });

  it("prompt do agente e Passo 3 da skill não falam mais em 600 caracteres", () => {
    const agent = readFileSync(".claude/agents/stack-writer.md", "utf8");
    const skill = readFileSync(".claude/skills/diaria-stack/SKILL.md", "utf8");
    assert.doesNotMatch(agent, /600/);
    assert.match(agent, /openingTargetChars/);
    assert.match(agent, /Monitoring Agent da Replit/);
    const passo3 = skill.slice(skill.indexOf("## Passo 3"), skill.indexOf("## Passo 4"));
    assert.doesNotMatch(passo3, /600/);
    assert.match(passo3, /280 caracteres/);
  });
});

describe("data padrão do /diaria-stack pula ciclo publicado (#11784)", () => {
  const states = (published: string[]) => (c: string): PublishState => (published.includes(c) ? "published" : "draft");

  it("domingo 01/11/2026 com 26w43 publicado assume 261102", () => {
    const r = resolveSkillDefaultMonday(new Date(2026, 10, 1, 20), states(["26w43"]));
    assert.equal(r.baseMonday, "261026");
    assert.equal(r.publishMonday, "261102");
    assert.equal(r.cycle, "26w44");
    assert.equal(r.advanced, true);
    assert.match(r.banner, /261102/);
    assert.match(r.banner, /26w43/);
    assert.match(r.banner, /publicado/);
  });

  it("ciclo base não publicado fica na regra do publicador", () => {
    const r = resolveSkillDefaultMonday(new Date(2026, 10, 1, 20), states([]));
    assert.equal(r.publishMonday, "261026");
    assert.equal(r.advanced, false);
  });

  it("terça com o ciclo da semana publicado não salta para semana de conteúdo aberta", () => {
    const r = resolveSkillDefaultMonday(new Date(2026, 10, 3, 10), states(["26w44"]));
    assert.equal(r.publishMonday, "261102");
    assert.equal(r.advanced, false);
    assert.match(r.banner, /já está publicado/);
  });

  it("estado ambíguo (unknown) não salta", () => {
    const r = resolveSkillDefaultMonday(new Date(2026, 10, 1, 20), () => "unknown");
    assert.equal(r.publishMonday, "261026");
  });

  it("a skill manda resolver pela CLI, e o publicador sem data segue na regra antiga", () => {
    const skill = readFileSync(".claude/skills/diaria-stack/SKILL.md", "utf8");
    const args = skill.slice(skill.indexOf("## Argumentos"), skill.indexOf("## Guard de execução"));
    assert.match(args, /--resolve-skill-default-monday/);
    const pub = readFileSync("scripts/publish-circle-stack.ts", "utf8");
    assert.match(pub, /publishMonday = currentOrPreviousMondayAAMMDD\(new Date\(\)\)/);
  });
});
