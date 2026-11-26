/**
 * test/claude-dir-candidate.test.ts (#14071)
 *
 * Detector de issue candidata a `claude-dir` (correção escreve em `.claude/`
 * sem a label). Fixtures são corpos REAIS resumidos (cabeçalhos e frases que
 * decidem mantidos literais) das issues da revisão #13984: as roteadas à mão
 * para `claude-dir` (#14029 a #14031, #14033 a #14046, #14048, #14049, #14060,
 * #14061) e as que citam `.claude/` sem escrever lá (#14003, #14004, #14050).
 * Lidos com `gh issue view N --json title,body` em 26/11/2026.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { claudeDirCandidateForIssue, detectClaudeDirTarget } from "../scripts/lib/claude-dir-candidate.ts";

const AGENTS = ["orchestrator", "orchestrator-stage-4", "orchestrator-stage-5", "orchestrator-stage-6", "fact-checker", "review-test-email", "social-writer", "dev-implementador", "dev-fixer", "writer"];

interface Fixture {
  n: number;
  title: string;
  body: string;
}

/** Roteadas à mão para `claude-dir` depois da revisão #13984. */
const POSITIVAS: Fixture[] = [
  {
    n: 14029,
    title: "Clarice no Stage 2: teto de 90 s quando o ping real do Stage 0 falha poupa ~7 min por edição",
    body: [
      "Achado da revisão de velocidade das skills #13988 (épico #13984).",
      "## Skill e passo",
      "`/diaria-2-escrita`, passos 3b (Clarice da newsletter) e 4b (Clarice do social), via `scripts/clarice-correct.ts` e `scripts/lib/clarice-pending.ts`.",
      "## Medição atual",
      "- `data/run-log.jsonl`, eventos `clarice_rest_attempt` de 20/10 a 25/11/2026: 1.510 tentativas.",
      "## Mudança proposta",
      "1. O ping do Stage 0 manda um chunk real de cerca de 1,8 KB com timeout de 60 s e grava o resultado em `preflight-state.json`.",
      "2. Ping degradado: o Stage 2 roda a Clarice com teto curto (90 s) e, estourando, vai direto para `clarice-pending.ts skip`.",
    ].join("\n\n"),
  },
  {
    n: 14030,
    title: "Tirar a prosa de fallback dos playbooks 0 e 1 do caminho padrão do Stage 1 poupa 0,7 a 1,6M tokens_in por edição",
    body: [
      "## Skill e passo",
      "`/diaria-1-pesquisa` (rodada headless pelo `run-edition-stages.ts`). A skill manda ler `orchestrator.md` e executar §0 e §1 (`.claude/skills/diaria-1-pesquisa/SKILL.md:5`).",
      "## Medição atual",
      "- Os dois playbooks dizem que a prosa detalhada é referência e fallback.",
      "## Mudança proposta",
      "Separar cada playbook em caminho principal e um arquivo de fallback lido só quando o runner falha fora dos codes previstos. Ajustar `orchestrator.md:41-42` e a skill para não puxar o fallback por padrão.",
    ].join("\n\n"),
  },
  {
    n: 14033,
    title: "Dividir o playbook da Etapa 4 e criar cartão de receitas do gate: uns 8M tokens e 5 a 7 min por edição",
    body: [
      "## Skill e passo",
      "`/diaria-4-revisao` e `/diaria-edicao`, loop do gate (§4d em diante) de `.claude/agents/orchestrator-stage-4.md`.",
      "## Mudança proposta",
      "1. Separar o playbook em pré-gate (4a a 4c) e loop do gate (4d a 4e), com a narrativa histórica movida para `docs/`.",
    ].join("\n\n"),
  },
  {
    n: 14035,
    title: "Fact-check incremental por unidade no gate da Etapa 4: uns 85 s e 0,4M tokens por edição",
    body: [
      "## Skill e passo",
      "`/diaria-4-revisao`, re-run do fact-checker no loop do gate (`scripts/run-fact-checker.ts`).",
      "## Mudança proposta",
      "Hash por unidade. Mudança só no pool continua disparando re-run, mas só do pool, porque o fact-checker pode checar itens do pool (`.claude/agents/fact-checker.md`).",
    ].join("\n\n"),
  },
  {
    n: 14036,
    title: "Gerar as imagens dos destaques em paralelo na Etapa 3: uns 4 a 5 min por edição",
    body: [
      "## Skill e passo",
      "`/diaria-3-imagens` (e a cascata de regeração no gate 4), laço por destaque em `scripts/stage-3-run.ts:439-468`.",
      "## Mudança proposta",
      "Gerar os destaques em paralelo (até 3 workers).",
    ].join("\n\n"),
  },
  {
    n: 14037,
    title: "Etapa 5: Brevo diária em background e publishers sociais concorrentes, ganho de 4 a 7 min por edição",
    body: [
      "## Skill e passo",
      "`/diaria-5-publicacao` e `/diaria-publica`, Etapa 5, passo 5c-3 (dispatch social e Brevo diária), `.claude/agents/orchestrator-stage-5.md:292-300`.",
      "## Mudança proposta",
      "3. Corrigir o texto do playbook: chamadas Bash na mesma mensagem não são paralelas.",
    ].join("\n\n"),
  },
  {
    n: 14040,
    title: "Skills de vídeo: mover casos raros do SKILL.md para reference, 3,5M a 5,6M tokens por dia de vídeo",
    body: [
      "## Skill e passo",
      "`/diaria-video-montagem`, `/diaria-publica` e `/diaria-video-roteiro`, carga do SKILL.md no início da sessão.",
      "## Mudança proposta",
      "Manter no SKILL.md o checklist do caminho feliz e mover casos raros, premissas e histórico para `reference/*.md` na pasta da skill.",
    ].join("\n\n"),
  },
  {
    n: 14041,
    title: "review-test-email: tirar o Processo Beehiiv morto do prompt, cerca de 0,14M tokens por edição",
    body: [
      "## Medição atual",
      "`.claude/agents/review-test-email.md` tem 89.668 B; o \"Processo Beehiiv\" ocupa as linhas 55 a 703.",
      "## Mudança proposta",
      "Tirar o Processo Beehiiv do prompt do subagente (mover para agent próprio ou para docs, para quem precisar reler edição antiga).",
    ].join("\n\n"),
  },
  {
    n: 14043,
    title: "Separar regras de subagente e de coordenador no overnight-dispatch-rules: uns 1M tokens por dev-implementador",
    body: [
      "## Skill e passo",
      "Rodadas autônomas (/diaria-overnight, /diaria-develop, /diaria-continuo): dispatch dos agents dev-implementador e dev-fixer.",
      "## Medição atual",
      "dev-implementador.md:14 manda ler context/overnight-dispatch-rules.md inteiro.",
      "## Mudança proposta",
      "Dividir em regras do subagente e regras do coordenador, com os incidentes movidos para docs/. Os dev-* passam a ler só o primeiro.",
    ].join("\n\n"),
  },
  {
    n: 14045,
    title: "Despachante único para os 16 hooks PreToolUse Bash: pelo menos 0,6 s por Bash, 1,7 min por develop",
    body: [
      "## Skill e passo",
      "Toda sessão no Windows: cada chamada Bash dispara os hooks PreToolUse e PostToolUse de .claude/settings.json.",
      "## Medição atual",
      "settings.json: 16 hooks em PreToolUse com matcher Bash.",
    ].join("\n\n"),
  },
  {
    n: 14046,
    title: "Logar review_instruction_suppressed só em gh pr create: 57% menos linhas no run-log",
    body: [
      "## Skill e passo",
      "Hook PostToolUse Bash .claude/hooks/pr-create-review.mjs, em toda chamada Bash de toda sessão.",
      "## Mudança proposta",
      "Logar no_pr_url só quando o comando casar com gh pr create.",
    ].join("\n\n"),
  },
  {
    n: 14048,
    title: "Apagar as 8 libs de Chrome do publisher Beehiiv aposentado (cerca de 4.500 linhas) e tirar do playbook histórico o pré-render vivo do Stage 4",
    body: [
      "## Evidência",
      "- Mesmo assim, `.claude/agents/orchestrator-stage-4.md:95` manda seguir os steps 1.1 a 1.3 dele.",
      "## Proposta",
      "1. Levar os passos vivos do pré-render (0, 0.1 e 1.1 a 1.4, com a tabela de exit codes) para `.claude/agents/orchestrator-stage-4.md` ou para um `context/publishers/newsletter-prerender.md`, e repontar as menções vivas.",
    ].join("\n\n"),
  },
  {
    n: 14049,
    title: "Limpeza dedicada do canal Brevo dos apoiadores mensais: 4 scripts e 4 testes (cerca de 3.170 linhas) e a chave brevo_apoiadores, preservando o registro da campanha 12",
    body: [
      "## Evidência",
      "- `.claude/skills/diaria-mensal-apoiadores/SKILL.md:752` e `.claude/skills/diaria-mensal/SKILL.md:902` registram que os scripts continuam.",
      "## Proposta",
      "5. Atualizar o trecho do CLAUDE.md e das duas SKILL.md que dizem que os scripts continuam.",
    ].join("\n\n"),
  },
  {
    n: 14060,
    title: "context/: apagar social-linkedin.md e publishers/facebook.md sem leitor (130 linhas, 2 arquivos)",
    body: [
      "## Evidência",
      "- `context/templates/social-linkedin.md` (51 linhas): o `social-writer` lê só `social-instagram.md` (`.claude/agents/social-writer.md:41`).",
      "## Proposta",
      "Apagar os dois arquivos, ajustar as três citações acima e citar `social-linkedin-weekly.md` por nome na skill da semanal.",
    ].join("\n\n"),
  },
];

/** Citam `.claude/` sem que a correção escreva lá. */
const CONTRA: Fixture[] = [
  {
    n: 14003,
    title: "Shardar o npm test do CI em 2 a 4 jobs, porque o job único voltou a 14 a 22 min e a paralelização dentro do runner já está no teto",
    body: [
      "## Evidência",
      "- 3.394 arquivos soltos no topo de `test/`; cerca de 280 testes leem `.claude/skills`, `.claude/agents`, CLAUDE.md ou `context/*.md`.",
      "## Proposta",
      "1. Shardar o job `npm test` em 2 a 4 jobs.",
      "2. Avaliar depois, em separado, se os testes de prosa podem rodar só quando `.claude/`, `context/` ou CLAUDE.md mudam. Não fazer junto: código que muda contrato descrito na prosa pularia o teste.",
    ].join("\n\n"),
  },
  {
    n: 14004,
    title: "Dividir session-registry.ts (9.161 linhas) em módulos sob scripts/lib/sessions mantendo o arquivo como reexport e CLI, para a coordenação ficar revisável por parte",
    body: [
      "## Evidência",
      "- 94 arquivos `.ts`/`.mjs` importam o módulo; 195 arquivos versionados citam o nome, inclusive os hooks em `.claude/hooks/inject-session-id.mjs`.",
      "## Proposta",
      "1. Criar `scripts/lib/sessions/` com módulos registry, claims, merge-lock, merge-grant e presence, e `cli.ts` com o `main`.",
      "2. Manter `scripts/lib/session-registry.ts` como reexport e entrada do CLI no mesmo caminho, para não quebrar hooks, skills, `inject-session-id.mjs` e os scripts do Hermes.",
      "## Custo e risco",
      "O hook `inject-session-id.mjs` casa o caminho do CLI: manter o arquivo de entrada.",
    ].join("\n\n"),
  },
  {
    n: 14050,
    title: "Trocar /diaria-publica-video por /diaria-publica nas 20 mensagens de alarme e ao editor dos timers de shorts e do publish-shorts",
    body: [
      "## O que é",
      "O #12620 renomeou `/diaria-publica-video` para `/diaria-publica` e deixou o nome antigo como alias.",
      "## Prova de que é seguro",
      "O alias `.claude/skills/diaria-publica-video/SKILL.md` só repassa os argumentos para `/diaria-publica`, que aceita os mesmos.",
      "## Proposta",
      "Trocar as 20 strings para `/diaria-publica`, mantendo o nome do Passo (B1, B3a, B3b). O alias e o `short-related-task.md` ficam onde estão; mover o roteiro exige recriar a task no Neo e seria outra issue, com label `windows`.",
      "## Redução",
      "O ganho é que o alarme passa a citar a skill canônica.",
    ].join("\n\n"),
  },
];

describe("claude-dir-candidate — corpos reais da revisão #13984 (#14071)", () => {
  for (const f of POSITIVAS) {
    it(`#${f.n} (roteada à mão para claude-dir) é candidata`, () => {
      const r = claudeDirCandidateForIssue({ title: f.title, body: f.body, labels: ["P2"] }, { agentNames: AGENTS });
      assert.ok(r, `#${f.n} deveria ser candidata`);
      assert.ok(r.evidence.length > 0);
    });
  }

  for (const f of CONTRA) {
    it(`#${f.n} (cita .claude/ só como contexto) NÃO é candidata`, () => {
      const r = claudeDirCandidateForIssue({ title: f.title, body: f.body, labels: ["P3"] }, { agentNames: AGENTS });
      assert.equal(r, null, `#${f.n} não deveria ser candidata: ${JSON.stringify(r?.evidence)}`);
    });
  }

  it("caminho explícito numa seção alvo é sinal forte; referência indireta é fraca", () => {
    const forte = POSITIVAS.find((f) => f.n === 14046)!;
    const fraca = POSITIVAS.find((f) => f.n === 14036)!;
    assert.equal(detectClaudeDirTarget(forte.title, forte.body, { agentNames: AGENTS })?.strength, "forte");
    assert.equal(detectClaudeDirTarget(fraca.title, fraca.body, { agentNames: AGENTS })?.strength, "fraca");
  });

  it("falso negativo conhecido: #14061 só cita .claude/skills/... na Evidência", () => {
    const body = [
      "## Evidência",
      "- `docs/browser-publish-setup.md:3`: diz que o Claude in Chrome publica a newsletter no Beehiiv. Hoje o Chrome fica só no teste do Kit (`.claude/skills/diaria-5-publicacao/SKILL.md`).",
      "## Proposta",
      "1. Trocar a tabela manual por índice gerado com check de CI.",
      "2. Reescrever `docs/browser-publish-setup.md` para o uso atual do Chrome.",
    ].join("\n\n");
    assert.equal(detectClaudeDirTarget("docs/README.md: índice gerado", body), null);
  });
});

describe("claude-dir-candidate — regras", () => {
  it("label claude-dir presente → null, mesmo com sinal forte", () => {
    const body = "## Proposta\n\nEditar `.claude/skills/diaria-edicao/SKILL.md`.";
    assert.ok(detectClaudeDirTarget("t", body));
    assert.equal(claudeDirCandidateForIssue({ title: "t", body, labels: ["claude-dir"] }), null);
  });

  it("corpo nulo ou sem menção → null", () => {
    assert.equal(detectClaudeDirTarget("bug no stage 2", null), null);
    assert.equal(detectClaudeDirTarget("bug no stage 2", "## Proposta\n\nCorrigir `scripts/stage-2.ts`."), null);
  });

  it("caminho no título conta como alvo", () => {
    const r = detectClaudeDirTarget("Ajustar .claude/hooks/block-x.mjs para aceitar heredoc", "");
    assert.equal(r?.strength, "forte");
    assert.equal(r?.evidence[0].section, "(título)");
  });

  it("seção neutra exige verbo de escrita para o caminho explícito", () => {
    const sem = "## O que é\n\nO hook `.claude/hooks/x.mjs` dispara em todo Bash.";
    const com = "## O que é\n\nAtualizar `.claude/hooks/x.mjs` para disparar só em gh pr create.";
    assert.equal(detectClaudeDirTarget("t", sem), null);
    assert.equal(detectClaudeDirTarget("t", com)?.strength, "forte");
  });

  it("negação de escopo na frase descarta a menção", () => {
    const body = "## Proposta\n\nMudar só o script. `.claude/agents/writer.md` fica como está, não mexer no prompt.";
    assert.equal(detectClaudeDirTarget("t", body, { agentNames: AGENTS }), null);
  });

  it("cabeçalho de contexto vence palavra de alvo (\"Fora de escopo\")", () => {
    const body = "## Fora de escopo\n\nEditar `.claude/skills/diaria-overnight/SKILL.md` fica para outra rodada.";
    assert.equal(detectClaudeDirTarget("t", body), null);
  });

  it(".claude/worktrees/ e marcador HTML não são sinal", () => {
    const body = "## Proposta\n\nLimpar `.claude/worktrees/agent-x` depois da rodada.\n\n<!-- .claude/skills/x/SKILL.md -->";
    assert.equal(detectClaudeDirTarget("t", body), null);
  });

  it("nome de skill só conta em cabeçalho que fala de skill", () => {
    assert.equal(detectClaudeDirTarget("t", "## Proposta\n\nTrocar o texto para `/diaria-publica`."), null);
    assert.equal(detectClaudeDirTarget("t", "## Skill e passo\n\n`/diaria-3-imagens`, laço por destaque.")?.strength, "fraca");
  });

  it("sem lista de agents, orchestrator*.md e dev-*.md ainda contam", () => {
    const r = detectClaudeDirTarget("t", "## Proposta\n\nSeparar `orchestrator-stage-4.md` em dois arquivos.");
    assert.equal(r?.strength, "fraca");
    assert.equal(detectClaudeDirTarget("t", "## Proposta\n\nAjustar `writer.md`."), null);
    assert.equal(detectClaudeDirTarget("t", "## Proposta\n\nAjustar `writer.md`.", { agentNames: AGENTS })?.strength, "fraca");
  });
});
