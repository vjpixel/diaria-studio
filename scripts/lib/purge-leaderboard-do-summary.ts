/**
 * scripts/lib/purge-leaderboard-do-summary.ts (#4477, achado 1 do fleet
 * review #4383)
 *
 * Lógica PURA de agregação das falhas de purga do DO ScoreCounter ao longo
 * de um plano com múltiplas identidades — extraída de
 * `scripts/purge-leaderboard.ts` pra ser testável sem depender de
 * wrangler/rede real (mesmo padrão de extração de `purge-leaderboard-plan.ts`
 * e `purge-score-counter-do.ts`: `purge-leaderboard.ts` fala com wrangler de
 * verdade via `execFileSync` no `main()`, então essa lógica não seria
 * testável fim-a-fim sem mock pesado).
 *
 * ## Por que isso precisa existir
 * `purgeScoreCounterDo` documenta "nunca lança" — uma falha (403 por
 * ADMIN_SECRET desatualizado, timeout de rede, DO indisponível, ou uma única
 * identidade anônima ligada — #4433 — falhando no meio do loop de múltiplas
 * identidades do plano) só produzia um `console.error` isolado por
 * identidade em `purge-leaderboard.ts`, sem nunca ser agregada. O script
 * sempre terminava com uma linha de sucesso incondicional ("...done — N keys
 * apagadas...") e `process.exitCode` nunca era setado, mesmo que a purga do
 * DO tivesse falhado pra 1, várias, ou TODAS as identidades. O cenário que o
 * #4474 existe pra fechar (identidade purgada ressuscita voto) podia
 * continuar acontecendo silenciosamente se a chamada ao admin route
 * falhasse — o único consumidor documentado deste script
 * (`.claude/skills/diaria-remover-votos-pixel/SKILL.md`) confirma sucesso
 * olhando o leaderboard, não lendo warnings no meio do output.
 */

export interface PurgeDoStepResult {
  email: string;
  ok: boolean;
}

export interface PurgeDoSummary {
  /** E-mails cuja purga do DO ScoreCounter falhou — vazio quando tudo OK. */
  failures: string[];
  /** true quando `process.exitCode = 1` deve ser setado (ao menos 1 falha). */
  shouldFailExitCode: boolean;
}

/**
 * Agrega os resultados de `purgeScoreCounterDoStep` (um por identidade do
 * plano) numa lista de e-mails cuja purga do DO falhou + a decisão de
 * `process.exitCode`. Pura — sem I/O, testável sem mock de rede/wrangler.
 */
export function summarizePurgeDoResults(results: PurgeDoStepResult[]): PurgeDoSummary {
  const failures = results.filter((r) => !r.ok).map((r) => r.email);
  return { failures, shouldFailExitCode: failures.length > 0 };
}
