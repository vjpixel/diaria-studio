/**
 * spawn-types.ts (#2699)
 *
 * Tipos compartilhados para spawners de processo injetáveis (permitem mockar
 * `git`/`gh` CLI em testes sem side-effects nem destruir o repo real).
 *
 * Extraído porque `scripts/lib/git-sync.ts` e `scripts/check-pr-bugfix.ts`
 * cada um declarava um tipo local chamado `SpawnFn` com assinaturas
 * incompatíveis (2 args vs 3 args com `opts`). Sem colisão em runtime (cada
 * arquivo só usa o seu), mas risco de type-confusion se algum dia os dois
 * forem importados juntos. Nomes distintos aqui deixam a assinatura de cada
 * um inequívoca; cada módulo consumidor mantém seu próprio alias local
 * `SpawnFn` (back-compat com testes existentes) apontando pro tipo canônico.
 *
 * @see scripts/lib/git-sync.ts — usa GitSpawnFn (alias local: SpawnFn)
 * @see scripts/check-pr-bugfix.ts — usa PrCheckSpawnFn (alias local: SpawnFn)
 */

/** Resultado de uma chamada de processo injetável (testável sem processo real). */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawner de 2 args (cmd, args) — usado por scripts/lib/git-sync.ts. */
export type GitSpawnFn = (cmd: string, args: string[]) => SpawnResult;

/** Spawner de 3 args (cmd, args, opts) — usado por scripts/check-pr-bugfix.ts. */
export type PrCheckSpawnFn = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf8" },
) => SpawnResult;
