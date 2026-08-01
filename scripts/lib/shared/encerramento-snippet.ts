/**
 * encerramento-snippet.ts (#3219, reescopo #4413/#4411)
 *
 * Loader/render do parágrafo de apoio (Apoia.se) + créditos de ferramentas em
 * `context/snippets/encerramento-social-apoio.md` — a ÚNICA parte da seção
 * `PARA ENCERRAR` que ainda é editável por edição (via painel Caixas do
 * Studio, `platform.config.json` → `para_encerrar.slot_a`).
 *
 * #4413 (decisão do editor, 260801): o convite social ("siga a diar.ia.br
 * no...") deixou de morar neste arquivo — virou BLOCO FIXO, a constante
 * `SOCIAL_INVITE` abaixo, montada a partir das URLs canônicas
 * (`canonical-urls.ts`). Motivo: o texto tinha 5 variantes divergentes entre
 * diário/mensal/config/docs (catalogadas no #4413); um bloco fixo elimina o
 * drift pela raiz — não é mais possível editar o convite social por edição.
 * #4411: mesma lógica pra `CURADORIA_PILLS` (pílulas "Cursos/Livros/
 * Equipamentos"), que tinha 3 grafias diferentes entre diário e mensal.
 *
 * Reusado pelo diário (`scripts/stitch-newsletter.ts`, injetado
 * deterministicamente na seção `PARA ENCERRAR`) e documentado como fonte pro
 * mensal (`.claude/agents/writer-monthly.md`, seção `PARA ENCERRAR` — o
 * writer-monthly é um prompt de LLM, então ele CITA `SOCIAL_INVITE`/
 * `CURADORIA_PILLS` literalmente no prompt, drift-guardado por
 * `test/encerramento-social-apoio-3219.test.ts` contra estas constantes, em
 * vez de importar este módulo). `shared/` (não `diaria/` nem `mensal/`)
 * porque o conteúdo é consumido pelos dois formatos — ver
 * test/lib-boundary.test.ts (#2747).
 */
import { readSnippetFile } from "./snippet-loader.ts";
import {
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_THREADS_URL,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_X_URL,
  DIARIA_CURSOS_URL,
  DIARIA_LIVROS_URL,
  DIARIA_AMAZON_LOJA_URL,
} from "../canonical-urls.ts";

/**
 * #4413: convite social FIXO — texto único, idêntico em diário e mensal,
 * nunca editável por edição (decisão do editor, 260801, comentário do
 * #4413/#4421 — já publicado no ciclo 2607-08, 9 campanhas #102–#110,
 * ~30 mil pessoas). Ordem das redes: LinkedIn → Instagram → Threads →
 * Facebook → X (o Facebook caiu do 2º pro 4º lugar em relação à redação
 * anterior). Sempre o ÚLTIMO parágrafo da seção `PARA ENCERRAR`
 * (invariante do #3219/#3368, preservada).
 */
export const SOCIAL_INVITE =
  `Para acompanhar as 3 principais notícias de IA todos os dias, siga a **diar.ia.br** no [LinkedIn](${DIARIA_LINKEDIN_PAGE_URL}), [Instagram](${DIARIA_INSTAGRAM_URL}), [Threads](${DIARIA_THREADS_URL}), [Facebook](${DIARIA_FACEBOOK_PAGE_URL}) ou [X](${DIARIA_X_URL}).`;

/**
 * #4411: lista de pílulas "Acesse nossas curadorias" — navegação estrutural
 * FIXA, idêntica em diário e mensal (labels curtos: Cursos/Livros/
 * Equipamentos). SEM label manual — o render de cada formato
 * (`newsletter-render-html.ts`/`monthly-render.ts`) gera o label "Acesse
 * nossas curadorias:" sozinho ao detectar esta lista na posição certa.
 */
export const CURADORIA_PILLS = `- [Cursos](${DIARIA_CURSOS_URL})
- [Livros](${DIARIA_LIVROS_URL})
- [Equipamentos](${DIARIA_AMAZON_LOJA_URL})`;

/**
 * Cláusula de abertura do parágrafo de apoio pro DIÁRIO — vazia, porque o
 * parágrafo já abre direto em "Apoie a curadoria...": dizer "essa edição
 * nasce da diar.ia.br" não faz sentido dentro do próprio diário.
 */
export const ENCERRAMENTO_OPENING_DAILY = "";

/**
 * Cláusula de abertura do parágrafo de apoio pro MENSAL — contextualiza a
 * relação mensal/diária antes do CTA de apoio (inclui o espaço final antes
 * de "Apoie").
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
 * Renderiza o bloco (hoje: parágrafo de apoio + créditos de ferramentas,
 * #4413 — o convite social saiu daqui, ver `SOCIAL_INVITE` acima)
 * substituindo `{{OPENING}}` pela cláusula de abertura do formato
 * (`ENCERRAMENTO_OPENING_DAILY`, `ENCERRAMENTO_OPENING_MONTHLY`, ou uma
 * string customizada). Retorna `null` se o template não existir/ficar vazio
 * (graceful).
 */
export function renderEncerramentoSocialApoio(opening: string): string | null {
  const template = loadEncerramentoSocialApoioTemplate();
  if (!template) return null;
  return template.replace("{{OPENING}}", opening);
}
