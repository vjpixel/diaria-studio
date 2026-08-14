/**
 * hub-index-page.ts (#5256)
 *
 * Página-índice de `/temas/` — o Worker `arquivo` só roteava `/temas/{slug}`
 * pros slugs de `HUB_REGISTRY` (slug vazio não casava nada, achado da
 * análise editorial "Raio-X de /temas/" de 14/08/2026); `GET /temas/` e
 * `GET /temas` respondiam 404 cru. Este módulo gera a página que lista os
 * hubs publicados — mesmo DS das páginas de curadoria (`curadoria-page.ts`,
 * grid de cards já usado por livros/cursos), **zero prosa nova**: título,
 * janela coberta e `metaDescription` de cada card são os mesmos campos que
 * `HubContent` já carrega, só reformatados aqui.
 *
 * Mesma disciplina de `hub-page.ts` — HTML gerado e COMMITADO
 * (`workers/arquivo/src/hubs/index-page.generated.ts`, escrito por
 * `scripts/build-hub-page.ts`), nunca renderizado em runtime no Worker.
 * `renderHubIndexPage`/`renderHubNotFoundPage` são pure — sem I/O, sem
 * `Date.now()`.
 */
import { escHtml as esc } from "../html-escape.ts";
import { renderSeoMeta } from "./seo-meta.ts";
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaGridCardStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "./curadoria-page.ts";
import { DIARIA_ARQUIVO_URL } from "../canonical-urls.ts";
import { HUB_INDEX_FOOTER_NAV_UTM } from "./utm-registry.ts";

/** URL do índice — `/temas/` (com barra final; `/temas` sem barra também
 * serve o MESMO HTML, ver `workers/arquivo/src/index.ts`). */
export const HUB_INDEX_URL = `${DIARIA_ARQUIVO_URL}/temas/`;

/** 1 entrada por hub publicado — subconjunto de `HubContent` já existente em
 * cada `scripts/lib/hubs/{slug}.ts` (via `get{Hub}Hub()`), nada digitado à
 * mão aqui. `since`/`until` vêm de `hubCoverageWindow(hub.sourceEditions)`
 * (mesma função que já deriva o H1 de cada hub) — quem monta a lista
 * (`scripts/build-hub-page.ts`) resolve isso, este módulo só formata. */
export interface HubIndexEntry {
  readonly slug: string;
  /** Rótulo de exibição — `HUB_META[].label`, o MESMO texto da nav "Por
   * tema" do arquivo (paridade entre as duas superfícies). */
  readonly label: string;
  /** `HubContent.metaDescription` do hub — já ≤160 chars (validado em
   * `validateHubContent`), reusado tal qual como resumo do card. */
  readonly metaDescription: string;
  /** "mês de ANO a mês de ANO" — `hubCoverageWindow(...).between`. */
  readonly coverageLabel: string;
}

function pageUrl(slug: string): string {
  return `${DIARIA_ARQUIVO_URL}/temas/${slug}`;
}

/** CSS específico do índice — só o kicker/lede do header (o resto vem de
 * `renderCuradoriaHeaderStyles`/`renderCuradoriaGridCardStyles`, idênticos a
 * livros/cursos). */
function renderHubIndexBodyStyles(): string {
  return `  main { padding: 40px 0 64px; }
  .hub-index-note { font-size: 13px; color: var(--ink); opacity: 0.72; margin: 6px 0 0; }`;
}

/** Renderiza o HTML completo da página-índice `/temas/`. Pure. `entries`
 * precisa ter ≥1 item (hub novo entra sozinho via `HUB_META`/`HUB_LOADERS`
 * — nunca uma lista vazia em produção; o build falharia bem antes disso se
 * `HUB_LOADERS` estivesse vazio). */
export function renderHubIndexPage(entries: readonly HubIndexEntry[]): string {
  const pageTitle = "Temas — cobertura por assunto da diar.ia.br";
  const description =
    "Os temas que a diar.ia.br acompanha de perto: cada página reúne meses de edições sobre um assunto específico, com cronologia e fontes.";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
${renderSeoMeta({ title: pageTitle, description, url: HUB_INDEX_URL })}
<meta name="robots" content="index, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderHubIndexBodyStyles()}

${renderCuradoriaGridCardStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Arquivo · Temas</p>
      <hr class="rule">
      <h1>Temas<span class="dot" aria-hidden="true">.</span></h1>
      <p class="lede">Cobertura organizada por assunto — cada página abaixo reúne meses de edições da diar.ia.br sobre um tema específico, com cronologia e fontes.</p>
    </div>
  </header>
  <main>
    <div class="wrap">
      <div class="grid">
${entries
  .map(
    (e) => `        <article class="card">
          <div class="title-row">
            <h2><a href="${esc(pageUrl(e.slug))}">${esc(e.label)}</a></h2>
          </div>
          <p class="hub-index-note">${esc(e.coverageLabel)}</p>
          <p class="summary">${esc(e.metaDescription)}</p>
          <a class="cta" href="${esc(pageUrl(e.slug))}">Ver cobertura completa →</a>
        </article>`,
  )
  .join("\n")}
      </div>
    </div>
  </main>
  ${renderCuradoriaFooter(
    "diar.ia.br — temas do arquivo",
    `utm_source=${HUB_INDEX_FOOTER_NAV_UTM.source}&utm_medium=${HUB_INDEX_FOOTER_NAV_UTM.medium}`,
  )}
</body>
</html>
`;
}

/** Mini-página de "tema não encontrado" — issue #5256: 404 de slug
 * inexistente em `/temas/{slug}` deixa de ser `Not found` cru, ganha link
 * pro índice. `workers/arquivo/src/index.ts` continua respondendo status
 * 404 (só o BODY muda). Sem lista de hubs aqui de propósito — o índice logo
 * abaixo já lista todos, não precisa duplicar. Pure, sem parâmetro: não
 * depende de qual slug foi pedido (mensagem genérica é suficiente e evita
 * refletir o slug do path — sem qualquer risco de escaping — de volta na
 * página, o que não traria valor real ao leitor). */
export function renderHubNotFoundPage(): string {
  const pageTitle = "Tema não encontrado — diar.ia.br";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="robots" content="noindex">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

main { padding: 40px 0 64px; }
main p { font-size: 17px; line-height: 1.6; }
main a { color: var(--teal); text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 2px; }
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br · Arquivo · Temas</p>
      <hr class="rule">
      <h1>Tema não encontrado<span class="dot" aria-hidden="true">.</span></h1>
    </div>
  </header>
  <main>
    <div class="wrap">
      <p>Esse tema não existe (ou o link está desatualizado). Veja a lista completa de temas cobertos pela diar.ia.br em <a href="${esc(HUB_INDEX_URL)}">${esc(HUB_INDEX_URL)}</a>.</p>
    </div>
  </main>
</body>
</html>
`;
}
