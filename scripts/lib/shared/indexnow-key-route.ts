/**
 * scripts/lib/shared/indexnow-key-route.ts (#5703)
 *
 * Rota de arquivo de chave do IndexNow (`GET /{key}.txt`), generalizada a
 * partir do padrão que nasceu em `workers/arquivo/src/index.ts` (#4909 item
 * 2) — extraída pra `lib/shared/` pra ser reusada por `workers/cursos` e
 * `workers/livros` (#5703) sem duplicar a mesma checagem de path em cada
 * Worker. Pura — só decide SE um path casa com o arquivo de chave; a
 * construção da `Response` continua no Worker (cada um já tem seu próprio
 * helper de texto puro, sem ganho em centralizar isso também).
 *
 * `key` sempre `.trim()`ado antes de comparar (#5620: `wrangler secret put`
 * via `echo` em vez de `printf` grava um `\n` de sobra, que nunca casa
 * contra `pathname` — mesmo cuidado defensivo do Worker `arquivo` original).
 */

/**
 * Retorna a chave (já trimada) se `pathname` for exatamente `/{key}.txt`,
 * ou `null` se `key` vier vazia/ausente OU o path não casar. `key` ausente
 * (Worker sem a var configurada ainda) é tratado como "nenhuma rota" — não
 * um erro — mesma disciplina defensiva do restante do projeto pra secret
 * ainda não provisionada.
 */
export function matchIndexNowKeyPath(pathname: string, key: string | undefined): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return pathname === `/${trimmed}.txt` ? trimmed : null;
}
