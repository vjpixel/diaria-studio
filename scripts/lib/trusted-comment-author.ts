/**
 * trusted-comment-author.ts (#9632)
 *
 * Fonte única de "quem pode falar com as automações" via comentário de
 * PR/issue. O repo é PÚBLICO: qualquer conta do GitHub comenta em PR/issue
 * (permissão `read`). Incidente de 05/10/2026: a conta externa `@jlandon`
 * postou na PR #9624 um "Fixed in `16fafd6e5`: ..." — commit inexistente,
 * texto sobre código que não é nosso (provável agente de IA dele na PR
 * errada). Sem dano, mas expôs que os consumidores de comentário filtravam
 * por TEXTO, nunca por AUTOR:
 *
 *  - o gate de merge autônomo do contínuo (`pr-review-authenticity.ts`)
 *    aceitava um marcador `<!-- continuo-review: ... verdict=approve -->`
 *    postado por qualquer pessoa — e um terceiro também podia BLOQUEAR o
 *    merge com um `reject`/self-review como comentário mais recente;
 *  - fixers injetavam todos os comentários da PR/issue no prompt de um
 *    modelo com permissão de commit/push (prompt injection).
 *
 * ## Regra (fail-closed)
 *
 * Confiável = `author_association` ∈ {OWNER, MEMBER, COLLABORATOR} — o campo
 * que o próprio GitHub calcula, presente tanto no GraphQL (`gh pr view
 * --json comments` → `authorAssociation`) quanto no REST (`gh api
 * .../comments` → `author_association`). Campo ausente, vazio, de outro tipo
 * ou qualquer outro valor (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`,
 * `MANNEQUIN`...) = NÃO confiável. `CONTRIBUTOR` fica de fora de propósito:
 * qualquer pessoa vira "contributor" com um PR mergeado, não é vínculo.
 *
 * Por que associação e não allowlist de login: a associação acompanha o
 * repo sozinha (convidar um colaborador não exige mexer no código) e não
 * depende de qual conta o `gh` do `300` está autenticado. Bots do GitHub
 * Actions aparecem como `NONE` — nenhum consumidor deste filtro depende de
 * comentário de bot hoje (o review do contínuo posta com a conta do dono).
 *
 * Consumidores em shell (`dispatch-glm-lane-unit.sh`,
 * `hermes/scripts/watch-continuo-health.sh`) não importam `.ts`: repetem o
 * conjunto como literal em jq/python. A paridade é travada por
 * `test/trusted-comment-author-9632.test.ts` — editar o conjunto aqui sem
 * editar lá quebra o teste.
 */

export const TRUSTED_AUTHOR_ASSOCIATIONS: readonly string[] = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Filtro jq equivalente a `isTrustedCommentAuthor`, para quem filtra no
 * `--jq` do `gh` (ex.: `check-continuo-escalate-label.ts`). Aceita os dois
 * nomes de campo (GraphQL e REST). Os scripts shell repetem este literal
 * byte a byte — o teste de paridade compara.
 */
export const TRUSTED_AUTHOR_JQ_SELECT =
  'select((.authorAssociation // .author_association // "") as $a | $a == "OWNER" or $a == "MEMBER" or $a == "COLLABORATOR")';

/** Lê a associação do autor de um nó de comentário (GraphQL ou REST). Pura, nunca lança. */
export function commentAuthorAssociation(node: unknown): string | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { authorAssociation?: unknown; author_association?: unknown };
  if (typeof n.authorAssociation === "string") return n.authorAssociation;
  if (typeof n.author_association === "string") return n.author_association;
  return null;
}

/**
 * `true` só quando o autor do comentário tem vínculo com o repo. Pura, nunca
 * lança. Comparação exata (case-sensitive): o GitHub sempre devolve caixa
 * alta, e aceitar variações só alargaria a superfície de um campo que, se
 * vier diferente, já indica payload inesperado (fail-closed).
 */
export function isTrustedCommentAuthor(node: unknown): boolean {
  const association = commentAuthorAssociation(node);
  return association !== null && TRUSTED_AUTHOR_ASSOCIATIONS.includes(association);
}

/**
 * Corpos (string) dos comentários de autor confiável, na ordem original.
 * `null` quando `comments` não é array (payload desconhecido — o chamador
 * decide o lado conservador). Comentário sem `body` string é pulado.
 */
export function trustedCommentBodies(comments: unknown): string[] | null {
  if (!Array.isArray(comments)) return null;
  const out: string[] = [];
  for (const c of comments) {
    if (!isTrustedCommentAuthor(c)) continue;
    const body = (c as { body?: unknown }).body;
    if (typeof body === "string") out.push(body);
  }
  return out;
}
