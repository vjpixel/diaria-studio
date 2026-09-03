/**
 * scripts/lib/orchestrator-files.ts (#7277)
 *
 * Lista canônica dos arquivos que compõem o playbook do orchestrator
 * (`.claude/agents/orchestrator*.md`) — basenames relativos a
 * `.claude/agents/`. Fonte única, puxada por dois consumidores que
 * precisam concordar sem duplicar o glob:
 *
 *   - `test/orchestrator-prompt.test.ts` (#634 frente C) — snapshot de
 *     conteúdo, detecta remoção acidental de seção/invariante.
 *   - `scripts/which-set-guards.ts` (SET_GUARDS, #7056/#7277) — mapeia
 *     "editar QUALQUER um destes arquivos" pro guard de snapshot acima, sem
 *     que o subagente precise saber de cor que `orchestrator-stage-*.md`
 *     dispara `test/orchestrator-prompt.test.ts`.
 *
 * Antes do #7277, `which-set-guards.ts` não tinha NENHUMA entrada cobrindo
 * este conjunto — o guard existia (#634) mas `which-set-guards --files
 * .claude/agents/orchestrator-stage-4.md` respondia "nenhum guard afetado",
 * o que já derrubou master 1x (PR #7271) e é o padrão documentado no #6767.
 * Extrair a lista pra cá (em vez de o script importar direto do arquivo de
 * teste, que registraria suites de `node:test` como efeito colateral do
 * import) fecha o gap sem duplicar o array em dois lugares.
 */

/** Basenames sob `.claude/agents/`, na mesma ordem/cobertura que
 * `test/orchestrator-prompt.test.ts` já mantinha inline antes do #7277. */
export const ORCHESTRATOR_FILES = [
  "orchestrator.md",
  "orchestrator-stage-0-preflight.md",
  "orchestrator-stage-1-research.md",
  "orchestrator-stage-2.md",
  "orchestrator-stage-3.md",
  "orchestrator-stage-4.md",
  "orchestrator-stage-5.md",
  "orchestrator-stage-6.md",
] as const;
