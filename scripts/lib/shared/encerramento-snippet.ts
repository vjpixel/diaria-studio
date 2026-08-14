/**
 * encerramento-snippet.ts (#3219, reescopo #4413/#4411)
 *
 * Loader/render do parágrafo de apoio (Apoia.se) + créditos de ferramentas em
 * `data/snippets/encerramento-social-apoio.md` (#5227, migrado de
 * `context/snippets/`) — a ÚNICA parte da seção
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
  DIARIA_ARQUIVO_URL,
  DIARIA_EIA_URL,
} from "../canonical-urls.ts";
import {
  CURSOS_RODAPE_UTM,
  LIVROS_RODAPE_UTM,
  EQUIPAMENTOS_RODAPE_UTM,
  ARQUIVO_RODAPE_UTM,
  JOGAR_RODAPE_UTM,
} from "./utm-registry.ts"; // #4536/#4553 — UTM da direção newsletter → curadoria; JOGAR_RODAPE_UTM #4550; EQUIPAMENTOS_RODAPE_UTM #4968

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
 * Monta `{url}?utm_source=...&utm_medium=...&utm_campaign=...` a partir de um
 * triplo do registry — mesmo padrão TEXTUAL já usado pelos emissores de
 * footer-nav (`renderCuradoriaFooter` em `curadoria-page.ts`, consumido por
 * `build-cursos-page.ts`/`build-livros-page.ts`/`render-archive.ts`):
 * concatenação simples, preservando a URL base EXATAMENTE como a constante
 * declara (`DIARIA_CURSOS_URL`/`DIARIA_LIVROS_URL`/`DIARIA_ARQUIVO_URL`, sem
 * `/` final). Deliberadamente NÃO usa `new URL()` aqui — diferente de
 * `buildFacebookCtaUrl`/`buildInstagramWeeklyArchiveUrl` (que partem de uma
 * URL genérica embutida em prosa e não têm essa restrição), `new URL(...)
 * .toString()` normaliza o path vazio pra `/`, o que mudaria a forma da URL
 * base em TODO outro lugar que a compara/hardcoda por igualdade de string
 * (ex: `FOOTER_DOMAINS`/testes que citam `DIARIA_CURSOS_URL` cru). Os valores
 * aqui são 100% ASCII estático (sem risco de encoding), então a concatenação
 * é segura. Centralizado porque as 3 pills abaixo repetem a mesma forma 3x
 * (#4536/#4553).
 */
function withRodapeUtm(
  url: string,
  utm: { source: string; medium: string; campaign: string },
): string {
  return `${url}?utm_source=${utm.source}&utm_medium=${utm.medium}&utm_campaign=${utm.campaign}`;
}

/**
 * #4411: lista de pílulas de navegação estrutural FIXA do PARA ENCERRAR,
 * idêntica em diário e mensal.
 *
 * #4968 (260811, decisão do editor): reorganizada em DOIS GRUPOS ROTULADOS —
 * o label único "Acesse nossas curadorias:" (gerado hardcoded pelo render)
 * mentia sobre parte da lista: descrevia Cursos/Livros mas não o Arquivo
 * (conteúdo próprio) nem o É IA? (jogo). Cada grupo agora carrega o próprio
 * rótulo EMBUTIDO NO TEXTO — um parágrafo curto terminado em `:`
 * imediatamente antes do respectivo `- [...]`. O render de cada formato
 * (`renderEncerrar` em `newsletter-render-html.ts`, `renderEncerramento` em
 * `monthly-render.ts`) reconhece esse parágrafo como o label DAQUELA lista
 * (consumido, não renderizado como corpo) — não é mais hardcoded, e suporta
 * N listas rotuladas na mesma seção. Uma `- [...]` SEM parágrafo-label
 * imediatamente anterior cai no fallback "Acesse nossas curadorias:" (mesmo
 * texto de antes — compatibilidade com edições já stitchadas/overrides de
 * teste que ainda não têm o parágrafo-label).
 *
 * Também #4968: as 3 pills também tiveram nome revisto — "Equipamentos"
 * mantido (decisão do editor: o grupo "Curadorias:" já dá o contexto que
 * faltava no rótulo solto), "Arquivo" → "Edições anteriores" (diz
 * literalmente o que tem lá) e "É IA?" → "Jogar É IA?" (o verbo separa da
 * seção homônima da própria edição e sinaliza que é jogo).
 *
 * #4536 (pill original "Arquivo" — antes dessa issue `arquivo.diar.ia.br`
 * não tinha NENHUM link de entrada a partir da newsletter) + #4553 (UTM nas
 * pills que apontam pra domínio próprio — Cursos/Livros/Arquivo — na direção
 * newsletter → curadoria; convenção `source: newsletter, medium: email,
 * campaign` único por pill, ver `utm-registry.ts`). #4968 estende esse UTM
 * pra "Equipamentos" também (`EQUIPAMENTOS_RODAPE_UTM`) — antes ficava de
 * fora por estar fora do escopo original do #4553, não por impossibilidade
 * técnica; ver docstring de `EQUIPAMENTOS_RODAPE_UTM`/`CURSOS_RODAPE_UTM`
 * em `utm-registry.ts` pro que isso compra de verdade (desambiguação entre
 * colocações do mesmo storefront, não analytics do lado da Amazon).
 *
 * #4550 (pill original "É IA?", 260804): distribuição própria do jogo —
 * decisão do editor de dar tratamento de produto ao "É IA?" (motor de
 * divulgação inteiro construído, ~8 votos/edição, "ninguém chega na porta").
 * Esta é 1 das 3 superfícies acordadas no briefing overnight do #4550
 * (rodapé + post/story dedicado + link em bio — ver `jogar-promo-urls.ts`
 * pras outras 2). Desde #4968, mora no grupo "Da diar.ia.br:" (conteúdo/
 * produto da própria newsletter, não curadoria de terceiro) — separado das
 * pills de curadoria (Cursos/Livros/Equipamentos), que ficam no grupo
 * "Curadorias:".
 */
export const CURADORIA_PILLS = `Curadorias:
- [Cursos](${withRodapeUtm(DIARIA_CURSOS_URL, CURSOS_RODAPE_UTM)})
- [Livros](${withRodapeUtm(DIARIA_LIVROS_URL, LIVROS_RODAPE_UTM)})
- [Equipamentos](${withRodapeUtm(DIARIA_AMAZON_LOJA_URL, EQUIPAMENTOS_RODAPE_UTM)})

Da diar.ia.br:
- [Edições anteriores](${withRodapeUtm(DIARIA_ARQUIVO_URL, ARQUIVO_RODAPE_UTM)})
- [Jogar É IA?](${withRodapeUtm(`${DIARIA_EIA_URL}/jogar`, JOGAR_RODAPE_UTM)})`;

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
 * Lê o template cru de `data/snippets/encerramento-social-apoio.md` (sem
 * o comentário HTML de header), com o marcador `{{OPENING}}` intacto.
 * Retorna `null` se o arquivo não existir ou ficar vazio após o strip do
 * comentário — graceful, igual ao `loadDivulgacaoSnippet` do stitch (caller
 * decide o fallback). Leitura crua delegada a `readSnippetFile` (#3219 —
 * extraído pra parar de duplicar essa lógica em paralelo com
 * `loadDivulgacaoSnippet`). `rootDir` (opcional) — override de teste
 * repassado pra `readSnippetFile`; produção nunca passa (sempre resolve a
 * raiz real do repo).
 */
export function loadEncerramentoSocialApoioTemplate(rootDir?: string): string | null {
  return readSnippetFile("encerramento-social-apoio.md", rootDir);
}

/**
 * Renderiza o bloco (hoje: parágrafo de apoio + créditos de ferramentas,
 * #4413 — o convite social saiu daqui, ver `SOCIAL_INVITE` acima)
 * substituindo `{{OPENING}}` pela cláusula de abertura do formato
 * (`ENCERRAMENTO_OPENING_DAILY`, `ENCERRAMENTO_OPENING_MONTHLY`, ou uma
 * string customizada). Retorna `null` se o template não existir/ficar vazio
 * (graceful). `rootDir` (opcional) — mesmo override de teste de
 * `loadEncerramentoSocialApoioTemplate`.
 */
export function renderEncerramentoSocialApoio(opening: string, rootDir?: string): string | null {
  const template = loadEncerramentoSocialApoioTemplate(rootDir);
  if (!template) return null;
  return template.replace("{{OPENING}}", opening);
}
