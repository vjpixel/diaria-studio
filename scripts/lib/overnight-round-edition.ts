/**
 * Edição de run-log de uma rodada overnight/develop com sufixo (#13612).
 *
 * Rodada com colisão de path (`resolve-overnight-plan-path.ts` →
 * `derived-after-collision`) mora em `data/overnight/261118b/`. O
 * `record-overnight-wave.ts` grava o checkpoint de token sob o nome da pasta
 * (`261118b`), e a SKILL manda `--edition {AAMMDD}` nos demais emissores
 * (`261118`): a mesma sessão saía sob duas edições e o
 * `check-overnight-token-instrumentation.ts` acusava falta nas duas.
 *
 * As duas grafias são a mesma rodada só quando a SESSÃO é a mesma: a `261118`
 * sem sufixo é compartilhada com a outra rodada do dia. Por isso quem consome
 * `sameRoundEdition` só a usa com filtro de sessão ativo.
 *
 * Puro, sem I/O.
 */
import { basename, dirname, resolve } from "node:path";

const ROUND_EDITION = /^(\d{6})[a-z]*$/;

/** `261118b` → `261118`; `261118` → `261118`; fora do formato → `null`. */
export function roundEditionBase(edition: unknown): string | null {
  if (typeof edition !== "string") return null;
  const m = ROUND_EDITION.exec(edition);
  return m ? m[1] : null;
}

/** As duas grafias são do mesmo dia (`261118` e `261118b`, ou iguais)? Só faz sentido com filtro de sessão. */
export function sameRoundEdition(a: unknown, b: unknown): boolean {
  if (a === b && typeof a === "string") return true;
  const ba = roundEditionBase(a);
  return ba !== null && ba === roundEditionBase(b);
}

/**
 * O evento é da edição pedida? Exato sempre; a outra grafia do mesmo dia só
 * com `sessionId` (e o chamador ainda filtra o evento pela sessão).
 */
export function editionMatches(eventEdition: unknown, edition: string, sessionId: string | null | undefined): boolean {
  if (eventEdition === edition) return true;
  return Boolean(sessionId) && sameRoundEdition(eventEdition, edition);
}

/**
 * Edição canônica da rodada a partir do `plan.json`: o nome da pasta
 * (`data/overnight/261118b/plan.json` → `261118b`), a mesma que o
 * `record-overnight-wave.ts` usa. `null` = pasta fora do formato AAMMDD[sufixo].
 */
export function runEditionFromPlanPath(planPath: string): string | null {
  const dir = basename(dirname(resolve(planPath)));
  return roundEditionBase(dir) !== null ? dir : null;
}

/**
 * Edição dos emissores com `--plan` (#13612): a do plano vence a `--edition`
 * quando as duas são do mesmo dia (a SKILL passa o AAMMDD puro); de dias
 * diferentes é erro de uso. Sem `--plan`, a `--edition` como veio.
 */
export function resolveEmitterEdition(values: { edition?: string; plan?: string }): { edition: string; note?: string } | { error: string } {
  const explicit = values.edition?.trim() || undefined;
  if (!values.plan) return explicit ? { edition: explicit } : { error: "--edition ou --plan obrigatório" };
  const fromPlan = runEditionFromPlanPath(values.plan);
  if (!fromPlan) return explicit ? { edition: explicit, note: `--plan ${values.plan} fora de data/{kind}/AAMMDD[sufixo]/: vale a --edition ${explicit}` } : { error: `--plan ${values.plan} fora de data/{kind}/AAMMDD[sufixo]/ e sem --edition` };
  if (!explicit || explicit === fromPlan) return { edition: fromPlan };
  if (sameRoundEdition(explicit, fromPlan)) return { edition: fromPlan, note: `--edition ${explicit} trocada por ${fromPlan}, o nome da pasta do plano (#13612)` };
  return { error: `--edition ${explicit} e --plan ${values.plan} (rodada ${fromPlan}) são de dias diferentes` };
}
