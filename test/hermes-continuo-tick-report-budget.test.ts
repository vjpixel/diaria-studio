/**
 * test/hermes-continuo-tick-report-budget.test.ts (#6716)
 *
 * Guard de regressão contra o item 2 do #6712 voltar a acontecer em
 * silêncio: o cron do `hermes-diaria-continuo` roda com
 * `context_from: ["self"]` (config do Hermes, fora deste repo) — o corpo do
 * relatório de tick é REINJETADO INTEIRO como contexto do tick seguinte.
 * Medido em 29/08/2026: 23–31 KB por tick, elevando o baseline de entrada de
 * cada delegação de ~54k para até 144k tokens dentro de um único tick — o
 * crescimento de contexto que motivou a investigação do #6716 sobre o custo
 * do "supporting model" (Sonnet 5 faturado a preço cheio em chamadas de
 * background invisíveis no transcript).
 *
 * Decisão do editor (30/08/2026, comentário de #6716): atacar o TAMANHO do
 * contexto reinjetado por tick, sem esperar a medição do dashboard
 * OpenRouter e sem desligar `autoCompactEnabled`. Este teste trava que a
 * skill documenta um orçamento explícito de tamanho pro relatório e as
 * regras que o mantêm dentro do orçamento (referenciar por número, nunca
 * colar saída bruta de ferramenta) — sem essas regras escritas, o próximo
 * tick que "só quis deixar claro o que aconteceu" volta a produzir um
 * relatório de dezenas de KB, e o guard de custo desaparece silenciosamente
 * (a mesma classe de regressão do #6716: nada no repo detecta isso sozinho
 * além de auditoria manual do billing).
 *
 * Nada aqui executa o cron nem mede tamanho real de output em produção —
 * isto é um teste de PARSING ESTÁTICO do SKILL.md, mesmo padrão de
 * `test/hermes-budget-guard.test.ts` e `test/hermes-background-model-pin.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md");

describe("contrato de tamanho do relatório de tick (#6716)", () => {
  const source = readFileSync(SKILL_PATH, "utf8");

  it("documenta o mecanismo context_from: [\"self\"] e o baseline medido (#6712)", () => {
    assert.match(
      source,
      /context_from:\s*\[?"self"\]?/,
      "SKILL.md não menciona context_from: [\"self\"] — sem isso, o motivo do orçamento de tamanho fica implícito e alguém pode remover as regras achando que são só estilo",
    );
    assert.match(
      source,
      /23[–-]31\s*KB/,
      "SKILL.md não cita o baseline medido de 23-31 KB (#6712) — o número concreto é o que justifica o orçamento abaixo dele",
    );
  });

  it("declara um orçamento explícito de tamanho para o relatório de tick", () => {
    assert.match(
      source,
      /~?2\s*KB/,
      "SKILL.md não declara um orçamento em KB pro relatório de tick — sem um número, 'seja conciso' não é verificável",
    );
  });

  it("instrui referenciar por número em vez de reproduzir texto", () => {
    assert.match(
      source,
      /[Rr]eferenciar por número/,
      "regra de referenciar issue/PR por número (em vez de colar o texto) não está presente",
    );
  });

  it("proíbe colar saída bruta de ferramenta (diff, JSON do gh, stderr)", () => {
    assert.match(
      source,
      /[Nn]unca colar saída bruta de ferramenta/,
      "regra de nunca colar saída bruta de ferramenta (git diff, JSON do gh, stderr) não está presente",
    );
  });

  it("mantém a regra pré-existente de não reimprimir backlog/git status/worktree list quando normal", () => {
    assert.match(
      source,
/reimprimir\s+o\s+backlog|backlog inteiro/,
      "a regra pré-existente (pitfall do ciclo 26/08) de não reimprimir backlog inteiro quando normal desapareceu",
    );
  });

  it("changelog registra a versão que introduziu o contrato, citando #6716", () => {
    assert.match(
      source,
      /0\.5\.3.*#6716/s,
      "changelog não registra a entrada 0.5.3 citando #6716 — versão/changelog desalinhados do conteúdo da seção",
    );
  });
});

describe("filtro de coerência da fila do contínuo (#6752)", () => {
  const source = readFileSync(SKILL_PATH, "utf8");

  it("define os 4 critérios de baixa coerência que tiram uma issue da fila do contínuo", () => {
    assert.match(source, /abstração compartilhada/, "critério 1 (abstração compartilhada) ausente");
    assert.match(source, /[Rr]efactor.*consolidação de duplicação|consolidação de duplicação/, "critério 2 (refactor/consolidação) ausente");
    assert.match(source, /outra PR aberta ou mergeada/, "critério 3 (depende de outra PR) ausente");
    assert.match(source, /fatia de épico/, "critério 4 (fatia de épico) ausente");
  });

  it("deixa explícito que o filtro é no passo de seleção de fila, não em classifyExecTrack nem label dedicada", () => {
    assert.match(
      source,
      /classifyExecTrack/,
      "SKILL.md não referencia classifyExecTrack — precisa deixar claro que o mecanismo NÃO é um eixo novo lá (decisão do editor, #6752)",
    );
    assert.match(
      source,
      /não cria um 7º valor de\s*\n?\s*`ExecTrack`\s*nem uma label nova/,
      "SKILL.md não declara explicitamente que o mecanismo NÃO cria um eixo novo em ExecTrack nem uma label dedicada — decisão do editor foi checagem no passo de seleção da skill (opção 2), não label",
    );
  });

  it("changelog registra o filtro de coerência citando #6752", () => {
    assert.match(source, /#6752/, "changelog/seção não cita #6752");
  });
});
