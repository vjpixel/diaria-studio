/**
 * test/circle-stack-curadoria-12549.test.ts
 *
 * #12549: seleção do post semanal da Stack, ciclo 26w45 (/diaria-stack 261109).
 * O editor trocou à mão itens que entraram só por termo genérico ou por
 * assunto de outro setor. Os textos abaixo são os do `02-reviewed.md` daquela
 * semana (título e corpo literais, encurtados onde não mudam a pontuação).
 *
 *   - "Agentes de compras com IA podem ameaçar Amazon e Walmart" (varejo) e
 *     "O candidato com 278 entrevistas" (recrutamento) entravam no Radar.
 *   - "Vale usa IA para transformar reuniões em código" (troca do sistema de
 *     gestão) entrava por "código" no título.
 *   - A invasão à Anthropic ficava como D3 sem aviso.
 *   - O editor manteve "Nem todo processo precisa de agente de IA" e itens com
 *     ferramenta do perfil: esses continuam entrando.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWeakStackDestaque,
  parseInterestProfile,
  scoreCandidate,
  selectCircleStack,
  STACK_INTEREST_PROFILE,
} from "../scripts/lib/circle-stack-select.ts";
import {
  CIRCLE_STACK_WEAK_AFFINITY_PREFIX,
  circleStackWeakAffinityDestaquesWarning,
  refreshCircleStackWarnings,
} from "../scripts/lib/circle-stack-warnings.ts";
import type { CircleStackItem, CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";

const radarItem = (over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261104",
  url: `https://ex.com/${over.title ?? Math.random()}`,
  title: "Título neutro",
  body: "",
  why: "",
  kind: "section",
  category: "RADAR",
  section: "radar",
  ...over,
});

const destaque = (n: 1 | 2 | 3, over: Partial<WeeklyRawCandidate>): WeeklyRawCandidate => ({
  editionDate: "261104",
  url: `https://ex.com/${over.title ?? Math.random()}`,
  title: "Título neutro",
  body: "Corpo neutro.",
  why: "",
  kind: "destaque",
  category: `DESTAQUE ${n} | negócios`,
  section: "destaque",
  destaqueN: n,
  ...over,
});

const compras = radarItem({
  title: "Agentes de compras com IA podem ameaçar os negócios de Amazon e Walmart",
  body: "Ferramentas digitais que realizam pedidos automatizados colocam em risco setor de publicidade nos Estados Unidos.",
});
const vale = radarItem({
  title: "Com 30 mil usuários em seu sistema de gestão, Vale usa IA para transformar reuniões em código",
  body: "Em parceria com a Accenture, mineradora usa inteligência artificial para trocar seu sistema de gestão e ganha até três semanas na etapa inicial de planejamento.",
});
const candidato = destaque(2, {
  editionDate: "261105",
  title: "O candidato com 278 entrevistas não era humano",
  body:
    "Octavius Fabrius acumulou 278 entrevistas de emprego em uma semana, sem ser uma pessoa. Era um agente criado por um desenvolvedor com o OpenClaw. " +
    "Uma empresa o chamou para um teste online e o recrutador achou que os textos pareciam escritos por IA.",
  why: "Quem procura emprego pode acabar disputando a atenção do recrutador com candidatos automatizados.",
});
const nemTodo = radarItem({
  title: "Nem todo processo precisa de agente de IA: 3 perguntas antes de investir",
  body: "Antes de adotar agentes autônomos, empresas precisam checar previsibilidade, tratamento de ordens duplicadas e proteção de dados. (10 min)",
  category: "USE MELHOR",
  section: "use_melhor",
  url: "https://exame.com/bussola/nem-todo-processo-precisa-de-agente-de-ia-3-perguntas-antes-de-investir/",
});
const googleAgente = radarItem({
  title: "Google vai encerrar agente de IA que programa sozinho",
  body: "O Jules sai do ar em dezembro.",
});
const anthropic = destaque(3, {
  title: "Agentes invadiram a Anthropic pela porta dos fundos",
  body:
    "A Cathedral, startup de segurança, usou agentes para entrar em sistemas internos da Anthropic por programas de terceiros. " +
    "A Anthropic confirma acesso a sistemas de vendas, RH e TI. Diz que código-fonte e pesos dos modelos não foram expostos.",
});
const lovable = destaque(2, {
  title: 'Lovable "sonha" e reescreve a memória do seu app',
  body: "O agente do Lovable reorganiza a memória do projeto enquanto você não está programando.",
});
const opus = destaque(1, {
  title: "Só o Claude Opus 5.5 supera a IA aberta da Mistral no teste às cegas",
  body: "O modelo sai com pesos abertos e API, e programa no nível dos fechados.",
});

describe("termo genérico precisa de segundo sinal (#12549)", () => {
  it("genérico só no corpo, sem termo no título nem ferramenta do perfil, não pontua", () => {
    const s = scoreCandidate(candidato);
    // Antes: agentes + automação + programação no corpo = 8, mais o bônus de D2.
    assert.deepEqual(s.matchedTerms, []);
    assert.equal(s.score, 1); // só o bônus de posição (D2)
    assert.equal(s.signal, "nenhum");
  });

  it("genérico no título pontua e marca o sinal como genérico", () => {
    const s = scoreCandidate(nemTodo);
    assert.deepEqual(s.matchedTerms, ["agentes"]);
    assert.equal(s.signal, "generico");
  });

  it("ferramenta do perfil no corpo é o segundo sinal: o genérico do corpo volta a contar", () => {
    const s = scoreCandidate(radarItem({ title: "Novidade da semana", body: "Os agentes do Cursor agora rodam workflows longos." }));
    assert.deepEqual(s.matchedTerms, ["Cursor", "agentes", "automação"]);
    assert.equal(s.signal, "especifico");
  });

  it("termo do perfil no título também é segundo sinal para o genérico do corpo (OAB-SP x Enter, mantido no 26w42)", () => {
    const s = scoreCandidate(
      destaque(1, {
        title: "OAB-SP vai à Justiça contra a startup Enter",
        body: "A Enter diz que seus agentes produzem a primeira versão de cada etapa do processo.",
        why: "Quem vai fazer o trabalho de alto volume que a Enter já automatiza?",
      }),
    );
    assert.deepEqual(s.matchedTerms, ["agentes", "automação", "startup"]);
  });

  it("termo de importância no título de destaque conta como sinal específico", () => {
    const s = scoreCandidate(destaque(1, { title: "Mistral desafia ElevenLabs com voz mais barata", body: "Agentes de voz." }));
    assert.equal(s.signal, "especifico");
  });
});

describe("assunto de outro setor sem sinal específico (#12549)", () => {
  it("varejo, recrutamento e sistema de gestão marcam offTopic", () => {
    assert.equal(scoreCandidate(compras).offTopic, true);
    assert.equal(scoreCandidate(vale).offTopic, true);
    assert.equal(scoreCandidate(candidato).offTopic, true);
  });

  it("ferramenta do perfil desarma: RH com no-code segue sendo assunto da Stack", () => {
    const s = scoreCandidate(destaque(1, { title: "RH da Riachuelo cria sistema em 12 dias sem código", body: "Com agentes." }));
    assert.equal(s.signal, "especifico");
    assert.equal(s.offTopic, false);
  });
});

describe("Radar do ciclo 26w45 (#12549)", () => {
  const picks = selectCircleStack([opus, lovable, anthropic, candidato, compras, vale, nemTodo, googleAgente]);
  const radarTitles = picks.radar.map((c) => c.title);

  it("os itens trocados à mão pelo editor ficam fora", () => {
    for (const out of [compras, vale, candidato]) assert.ok(!radarTitles.includes(out.title), out.title);
  });

  it("os que o editor manteve continuam", () => {
    assert.ok(radarTitles.includes(nemTodo.title));
    assert.ok(radarTitles.includes(googleAgente.title));
    assert.deepEqual(
      picks.destaques.map((c) => c.title).sort(),
      [lovable.title, opus.title, anthropic.title].sort(),
    );
  });

  it("o Radar fica mais curto em vez de completar com item fraco", () => {
    assert.equal(picks.radar.length, 2);
  });
});

describe("aviso de destaque sem aderência (#12549)", () => {
  it("D3 que só pontuou por termo genérico (a invasão à Anthropic) é fraco; Lovable e Opus não", () => {
    assert.equal(isWeakStackDestaque(scoreCandidate(anthropic)), true);
    assert.equal(isWeakStackDestaque(scoreCandidate(lovable)), false);
    assert.equal(isWeakStackDestaque(scoreCandidate(opus)), false);
  });

  it("o aviso nomeia o destaque e some quando não há nenhum", () => {
    const w = circleStackWeakAffinityDestaquesWarning([anthropic.title]);
    assert.ok(w?.startsWith(CIRCLE_STACK_WEAK_AFFINITY_PREFIX));
    assert.ok(w?.includes(anthropic.title));
    assert.equal(circleStackWeakAffinityDestaquesWarning([]), null);
  });

  const item = (title: string, extra: Record<string, unknown> = {}): CircleStackItem =>
    ({ editionDate: "261104", url: `https://ex.com/${title}`, title, body: "", why: "", ...extra }) as CircleStackItem;
  const sel = (destaques: CircleStackItem[]): CircleStackSelection =>
    ({ cycle: "26w45", contentWindow: [], destaques, lancamentos: [], useMelhor: [], radar: [], weeklyEditions: [] }) as unknown as CircleStackSelection;

  it("recontado a cada execução: destaque trocado à mão (sem marcação) sai do aviso", () => {
    const stored = [circleStackWeakAffinityDestaquesWarning([anthropic.title]) as string];
    const still = refreshCircleStackWarnings(sel([item(anthropic.title, { signal: "generico", offTopic: true })]), stored);
    assert.deepEqual(still, stored);
    const swapped = refreshCircleStackWarnings(sel([item("A thousand fewer paths to root")]), stored);
    assert.deepEqual(swapped, []);
  });
});

describe("circle_stack.interests aceita generic (#12549)", () => {
  it("generic: true é preservado; ausente fica de fora", () => {
    const p = parseInterestProfile([
      { label: "agentes", pattern: "agent\\p{L}*", weight: 3, generic: true },
      { label: "Lovable", pattern: "lovable", weight: 4 },
    ]);
    assert.deepEqual(p, [
      { label: "agentes", pattern: "agent\\p{L}*", weight: 3, generic: true },
      { label: "Lovable", pattern: "lovable", weight: 4 },
    ]);
  });

  it("generic que não é booleano é recusado", () => {
    assert.throws(() => parseInterestProfile([{ pattern: "x", weight: 1, generic: "sim" }]), /generic precisa ser true ou false/);
  });

  it("o perfil default marca como genéricos agentes, automação e programação", () => {
    const generic = STACK_INTEREST_PROFILE.filter((t) => t.generic).map((t) => t.label);
    for (const l of ["agentes", "automação", "programação"]) assert.ok(generic.includes(l), l);
    assert.ok(!generic.includes("Lovable"));
  });
});
