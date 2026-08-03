/**
 * weekly-linkedin-filter.ts (#4456)
 *
 * Exclusão de links comerciais/afiliados/propriedades próprias da seleção
 * por clique da newsletter semanal do LinkedIn — comentário 260802 (2º) do
 * #4456: "Excluir do cálculo: blocos de Divulgação, afiliados (Amazon,
 * Wispr Flow, Clarice, Beehiiv), apoia.se, propriedades próprias (cursos.,
 * livros., eia., o próprio diar.ia.br), links de preferências e
 * descadastro." — sem isso, `prepara.com.br` (Divulgação, 6 cliques, o mais
 * clicado de julho) e `livros.diar.ia.br` (propriedade própria, 5 cliques)
 * contaminam o topo do ranking com clique de anúncio/link próprio em vez de
 * matéria.
 *
 * **#4511 fleet review IMPORTANTE:** a implementação de `isCommercialOrOwnLink`/
 * `hasSuspiciousCommercialLanguage` foi movida pra
 * `scripts/lib/weekly-social-click-rank.ts` (compartilhada com
 * `weekly-instagram-select.ts`, #4483 — a mesma blocklist estava duplicada
 * byte-a-byte nos 2 lados). Este arquivo agora é um re-export fino —
 * mantido pra não quebrar os imports existentes (`weekly-linkedin-select.ts`,
 * `select-linkedin-weekly.ts`, `test/weekly-linkedin-parse.test.ts`).
 */

export { isCommercialOrOwnLink, hasSuspiciousCommercialLanguage } from "./weekly-social-click-rank.ts";
