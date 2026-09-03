/**
 * replies-top-level-gate.ts (#7166)
 *
 * §0-replies não roda desde o #5744. Causa raiz: `/diaria-edicao` passou a
 * spawnar os Stages 1-3 num subprocesso `claude -p '/diaria-1-pesquisa ...'`
 * (`scripts/run-edition-stages.ts`) — e esse subprocesso **não recebe os
 * conectores nativos claude.ai** (Gmail/Beehiiv/Chrome MCP só existem na
 * sessão interativa). §0-replies é 100% MCP (rascunho de resposta +
 * alocação de número de sorteio via `mcp__claude_ai_Gmail__*`), então
 * qualquer tentativa de rodá-lo ali morre por falta de MCP — o #6719
 * consertou só a metade `pre_gate` do gate (fazendo `pre_gate` chegar
 * `true` no subprocesso via `--session-supervised`), mas isso apenas fez a
 * seção COMEÇAR a valer num lugar onde o passo 1 (busca Gmail) sempre falha.
 *
 * Fix: §0-replies roda EXCLUSIVAMENTE no TOP-LEVEL de `/diaria-edicao`
 * (`.claude/skills/diaria-edicao/SKILL.md`, Passo 1b — antes do Passo 2
 * spawnar os Stages 1-3 em background), onde os MCPs de fato existem.
 * `--session-supervised` deixa de controlar a execução de §0-replies dentro
 * do Stage 1 spawnado — o Stage 1 NUNCA mais tenta essa seção, independente
 * de `pre_gate` (ver `orchestrator-stage-0-preflight.md` § 0-replies, nota
 * de delegação). Uso direto/standalone de `/diaria-1-pesquisa` (sessão
 * interativa comum, sem spawn) continua tendo MCP de verdade e pode seguir
 * a prosa de `orchestrator-stage-0-preflight.md` normalmente — este gate só
 * decide o caminho `/diaria-edicao`.
 */

/**
 * Stage 1 nunca tenta §0-replies quando roda como subprocesso spawnado por
 * `run-edition-stages.ts` — MCP não existe ali, independente de
 * `pre_gate`/`--session-supervised`. Constante (não uma função) porque a
 * decisão não depende de nenhum input: é estrutural ao ambiente do
 * subprocesso, não a um parâmetro de invocação.
 */
export const STAGE1_SUBPROCESS_NEVER_RUNS_REPLIES = true as const;

/**
 * Decide, no TOP-LEVEL de `/diaria-edicao` (Passo 1b do SKILL.md, antes do
 * Passo 2 spawnar os Stages 1-3), se §0-replies deve rodar. Mesma semântica
 * que `pre_gate` sempre teve: roda quando o editor está presente — ou seja,
 * quando `--no-gates` NÃO foi passado à invocação original de
 * `/diaria-edicao`. Diferente do mecanismo antigo (flag `--session-
 * supervised` propagada por `run-edition-stages.ts` pro subprocesso), esta
 * decisão é tomada e consumida no mesmo processo — sem propagação entre
 * processos, sem janela pra regressão como a do #7166.
 */
export function shouldRunRepliesAtTopLevel(noGatesPassed: boolean): boolean {
  return !noGatesPassed;
}
