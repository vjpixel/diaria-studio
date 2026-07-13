/**
 * encerramento-snippet.ts (#3219)
 *
 * Loader/render do bloco canônico de ENCERRAMENTO — convite social
 * (LinkedIn/Facebook) + apoio via Apoia.se — em
 * `context/snippets/encerramento-social-apoio.md`.
 *
 * Reusado pelo diário (`scripts/stitch-newsletter.ts`, injetado
 * deterministicamente na seção `PARA ENCERRAR`) e documentado como fonte pro
 * mensal (`.claude/agents/writer-monthly.md`, seção `PARA ENCERRAR` — o
 * writer-monthly é um prompt de LLM, então ele lê o arquivo e faz a mesma
 * substituição de `{{OPENING}}` descrita aqui, em vez de importar este
 * módulo). `shared/` (não `diaria/` nem `mensal/`) porque o conteúdo é
 * consumido pelos dois formatos — ver test/lib-boundary.test.ts (#2747).
 */
import { readSnippetFile } from "./snippet-loader.ts";

/**
 * Cláusula de abertura do parágrafo de apoio pro DIÁRIO — vazia, porque o
 * parágrafo já abre direto em "Quem quiser apoiar...": dizer "essa edição
 * nasce da diar.ia.br" não faz sentido dentro do próprio diário.
 */
export const ENCERRAMENTO_OPENING_DAILY = "";

/**
 * Cláusula de abertura do parágrafo de apoio pro MENSAL — contextualiza a
 * relação mensal/diária antes do CTA de apoio (inclui o espaço final antes
 * de "Quem quiser").
 */
export const ENCERRAMENTO_OPENING_MONTHLY =
  "Essa edição mensal nasce da **diar.ia.br**, newsletter diária gratuita sobre IA. ";

/**
 * Lê o template cru de `context/snippets/encerramento-social-apoio.md` (sem
 * o comentário HTML de header), com o marcador `{{OPENING}}` intacto.
 * Retorna `null` se o arquivo não existir ou ficar vazio após o strip do
 * comentário — graceful, igual ao `loadDivulgacaoSnippet` do stitch (caller
 * decide o fallback). Leitura crua delegada a `readSnippetFile` (#3219 —
 * extraído pra parar de duplicar essa lógica em paralelo com
 * `loadDivulgacaoSnippet`).
 */
export function loadEncerramentoSocialApoioTemplate(): string | null {
  return readSnippetFile("encerramento-social-apoio.md");
}

/**
 * Renderiza o bloco substituindo `{{OPENING}}` pela cláusula de abertura do
 * formato (`ENCERRAMENTO_OPENING_DAILY`, `ENCERRAMENTO_OPENING_MONTHLY`, ou
 * uma string customizada). Retorna `null` se o template não existir/ficar
 * vazio (graceful).
 */
export function renderEncerramentoSocialApoio(opening: string): string | null {
  const template = loadEncerramentoSocialApoioTemplate();
  if (!template) return null;
  return template.replace("{{OPENING}}", opening);
}

/**
 * #3368: mesmo render de `renderEncerramentoSocialApoio`, mas separado nos 2
 * parágrafos que compõem o bloco — `apoio` (Apoia.se) e `socialInvite`
 * (convite LinkedIn/Facebook) — pra permitir que o caller intercale outro
 * conteúdo ENTRE os dois (pedido do editor na edição 260713: mover o
 * parágrafo de apoio para o INÍCIO da seção `PARA ENCERRAR` do diário,
 * deixando o convite social por último — ver `buildParaEncerrar` em
 * `scripts/stitch-newsletter.ts`).
 *
 * O template (`encerramento-social-apoio.md`) já separa os 2 parágrafos por
 * linha em branco (apoio primeiro, convite social depois) — reusa essa
 * estrutura em vez de inventar heurística nova. Retorna `null` se o template
 * não existir/ficar vazio (graceful, mesmo contrato de
 * `renderEncerramentoSocialApoio`).
 */
export function splitEncerramentoSocialApoio(
  opening: string,
): { apoio: string; socialInvite: string } | null {
  const rendered = renderEncerramentoSocialApoio(opening);
  if (!rendered) return null;
  const [apoio, ...rest] = rendered.split(/\n\s*\n/);
  const socialInvite = rest.join("\n\n").trim();
  if (!apoio || !socialInvite) return null;
  return { apoio: apoio.trim(), socialInvite };
}
