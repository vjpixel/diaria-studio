/**
 * scripts/lib/hermes-runtime-sensitive-paths.ts (#6817 item 5)
 *
 * Responde "este path de config de runtime do Hermes precisa passar pelo
 * verbo único (`scripts/write-hermes-config.ts`), nunca por escrita direta
 * (`Edit`/`Write`)?" — o mesmo tipo de pergunta que `scripts/lib/sensitive-
 * path-guard.ts` responde pro diff DESTE repo, mas por que este é um módulo
 * IRMÃO em vez de mais 3 `SENSITIVE_RULES` ali:
 *
 * `sensitive-path-guard.ts` carrega um invariante próprio, endurecido por
 * um review anterior (#6277) e travado em CI (`test/sensitive-path-
 * guard.test.ts`, describe "cada regra casa com arquivo REAL do repo"):
 * TODA regra em `SENSITIVE_RULES` precisa casar com pelo menos 1 arquivo
 * RASTREADO por `git ls-files` deste repo — a lição de uma regra que já
 * nasceu morta (path certo, arquivo errado) e nunca casou com nada. Paths
 * de runtime do Hermes (`~/.hermes/config.yaml`, `~/hermes-agent/...`)
 * vivem FORA deste repo por construção — adicioná-los ali quebraria esse
 * invariante por design, não por engano (toda run de CI acusaria "regra
 * morta" pra sempre). Este módulo tem o mesmo formato de regra e reusa
 * `matchesGlob` (de `sensitive-path-guard.ts`, sem duplicar a
 * implementação de glob), mas com hygiene test próprio contra os paths
 * REAIS nomeados na issue #6817 (fixtures explícitas, não `git ls-files`).
 *
 * ## Contrato
 *
 * `isHermesRuntimeSensitivePath` é PURA — recebe o path absoluto já
 * resolvido e `homeDir`, nunca toca disco. Consumido por `scripts/check-
 * continuo-workdir.ts --check-runtime-sensitive` (o gate que o tick chama
 * ANTES de qualquer escrita direta) — ver docstring de lá.
 */

import { matchesGlob } from "./sensitive-path-guard.ts";

export interface HermesRuntimeSensitiveRule {
  readonly id: string;
  /** Pattern casado contra o path HOME-relativo (sem `~`, sem barra
   * inicial) — ex: `.hermes/config.yaml`. Mesmo subconjunto de glob de
   * `matchesGlob` (`*`, `**`, `{a,b}`). */
  readonly pattern: string;
  readonly reason: string;
}

export const HERMES_RUNTIME_SENSITIVE_RULES: readonly HermesRuntimeSensitiveRule[] = [
  {
    id: "hermes-runtime-config",
    pattern: ".hermes/config.yaml",
    reason:
      "config de produção do próprio orquestrador do contínuo — falha silenciosa aqui não tem CI que pegue, e a correção exige entender o que o diff não mostra (#6817 item 5)",
  },
  {
    id: "hermes-runtime-cron",
    pattern: ".hermes/cron/jobs.json",
    reason: "define os próprios crons que executam o contínuo — editar direto arrisca a mesma classe de auto-modificação do item 4 (#6059/#6060)",
  },
  {
    id: "hermes-runtime-profiles",
    pattern: ".hermes/profiles/**",
    reason: "perfis de modelo/reasoning-effort consumidos pelo loop autônomo em todo tick — regressão aqui é silenciosa até o custo/qualidade degradar",
  },
];

/** `path` relativo a `homeDir`, sem `~`/barra inicial — `""` quando `path`
 * é o próprio `homeDir`. `path` fora de `homeDir` retorna o path original
 * intacto (nunca casará com um pattern `.hermes/...`, o que é o
 * comportamento correto: não é sensível por este critério). */
export function homeRelative(path: string, homeDir: string): string {
  if (path === homeDir) return "";
  return path.startsWith(`${homeDir}/`) ? path.slice(homeDir.length + 1) : path;
}

/** `true` sse `path` (absoluto, resolvido) casa com alguma regra de
 * `HERMES_RUNTIME_SENSITIVE_RULES`. */
export function isHermesRuntimeSensitivePath(path: string, homeDir: string): boolean {
  const rel = homeRelative(path, homeDir);
  return HERMES_RUNTIME_SENSITIVE_RULES.some((rule) => matchesGlob(rel, rule.pattern));
}

/** Regras que casaram, com a razão — mesmo formato de `matchingRules` de
 * `sensitive-path-guard.ts`, pro CLI poder imprimir o motivo. */
export function matchingHermesRuntimeRules(path: string, homeDir: string): HermesRuntimeSensitiveRule[] {
  const rel = homeRelative(path, homeDir);
  return HERMES_RUNTIME_SENSITIVE_RULES.filter((rule) => matchesGlob(rel, rule.pattern));
}
