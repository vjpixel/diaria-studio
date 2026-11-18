/** `true` quando `command` executa `gh pr create` em posição de comando (#13550). */
export function runsGhPrCreate(command: unknown): boolean;
/** O regex de antes do #13550, mantido em OR para não reconhecer menos. */
export function legacyAnchoredMatch(command: unknown): boolean;
