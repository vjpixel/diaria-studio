/**
 * workers/poll/src/confirmado.ts (#5167 item 7)
 *
 * Destino do link de confirmação do double opt-in da Beehiiv — pensado pra
 * virar o valor de `opt_in_redirect_url` na publicação (item 8 da issue).
 *
 * **Item 9 investigado (achado, não relitigar):** o signup flow
 * `199e2a8d-…` ("Recommendations Flow") dispara no trigger "Signed up" —
 * imediatamente na SUBMISSÃO do formulário, um evento client-side só
 * aplicável a subscribe forms hospedados no Website Builder da Beehiiv
 * (embeds cross-origin como `/jogar/subscribe` não suportam signup flow,
 * confirmado na doc oficial da Beehiiv). `opt_in_redirect_url` dispara num
 * momento completamente diferente: quando o assinante clica no link de
 * confirmação DENTRO do e-mail — só depois de `double_opt_in` confirmar o
 * cadastro no backend, potencialmente outro dispositivo/sessão. Os dois
 * nunca competem pelo mesmo evento — não há precedência a resolver. Fonte:
 * docs oficiais da Beehiiv via MCP ("Double opt-in and Smart Nudge: How
 * they work and why they matter" + "Adding signup flows to your website
 * subscribe forms"), lidas ao vivo em 14/08/2026. **Item 8 segue PENDENTE
 * de execução** — `save_publication_settings` foi bloqueado pelo
 * classificador de auto-mode desta sessão (mudança de config de produção,
 * tratada com cautela por princípio do projeto); gravá-lo requer sessão com
 * essa permissão liberada, ou o editor fazer manualmente em Settings →
 * Emails → Preset Emails → Double Opt-in Email → Opt-in Redirect URL,
 * valor `https://eia.diar.ia.br/confirmado` (ver #5167).
 *
 * **Por que o Worker `poll` (eia.diar.ia.br), não um Worker novo nem
 * `arquivo`.** Levantamento antes de decidir: `workers/poll` já hospeda
 * `POST /jogar/subscribe` (o próprio endpoint cujo double opt-in este link
 * fecha o laço de), já tem o router de página simples/sem-KV que este tipo
 * de rota precisa (`/jogar/arquivo`, `/robots.txt`, `/sitemap.xml` — nenhum
 * depende de brand/KV), e já cruza-importa de `scripts/lib/shared/`
 * (`applyBrandWordmark` em `web-gate.ts`/`lib.ts`/`jogar.ts`,
 * `renderCuradoriaRobotsTxt` em `index.ts`) — não introduz um padrão novo de
 * fronteira. Um Worker dedicado provisionaria domínio/rota/deploy só pra uma
 * página estática; `workers/arquivo` serviria bem tematicamente, mas o link
 * de confirmação PRECISA sobreviver independente de qualquer coisa relativa
 * ao acervo de edições, e o `eia.diar.ia.br/jogar/subscribe` já é o
 * mecanismo que autentica esse fluxo — manter os dois no mesmo Worker deixa
 * a relação óbvia no código, não só na prosa desta issue.
 *
 * Página pura (sem KV, sem brand) — mesmo padrão de `/jogar/arquivo`,
 * `/robots.txt`, `/sitemap.xml`: `renderConfirmadoPage()` é testável sem
 * request/env, `handleConfirmadoPage()` só embrulha em `Response`.
 */
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "../../../scripts/lib/shared/curadoria-page.ts";
import { renderSeoMeta, renderAnalyticsHead } from "../../../scripts/lib/shared/seo-meta.ts"; // #5498: container GTM
import { DIARIA_EIA_URL, DIARIA_LIVROS_URL, DIARIA_ARQUIVO_URL } from "../../../scripts/lib/canonical-urls.ts";

/** URL pública canônica desta página. */
export const PAGE_URL = `${DIARIA_EIA_URL}/confirmado`;

const PAGE_TITLE = "Assinatura confirmada — diar.ia.br";
const PAGE_DESCRIPTION = "Sua assinatura da newsletter diar.ia.br está confirmada.";

/**
 * URL pública do survey de interesses (#5167 — "168 respostas, parado desde
 * 22/05, a página de confirmação é o momento de engajamento máximo e é boa
 * chance de reanimá-lo"). Confirmado ao vivo via MCP `get_survey` em
 * 13/08/2026 (`url` do payload) — NÃO é o `editor_url` do dashboard, que
 * exige login. Alimenta `context/audience-profile.md` via
 * `scripts/update-audience.ts`.
 */
const INTEREST_SURVEY_URL = "https://diar.ia.br/forms/f7528798-f8d5-4fcd-98c2-dc113e8c268b";

/** CSS específico desta página — pequeno o bastante pra não justificar
 * extração pra `curadoria-page.ts` (só esta página usa este layout de
 * "portas" + confirmação). */
function renderConfirmadoStyles(): string {
  return `  main { padding: 40px 0 64px; max-width: 640px; }
  .confirmado-lede { font-size: 18px; line-height: 1.55; color: var(--ink); margin: 0 0 8px; }
  .confirmado-timing { font-size: 15px; line-height: 1.5; color: var(--ink); opacity: 0.8; margin: 0 0 40px; }
  .confirmado-portas h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; font-weight: 700;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--teal); margin: 0 0 16px; }
  .confirmado-portas ul { list-style: none; margin: 0 0 40px; padding: 0; border-top: 1px solid var(--rule); }
  .confirmado-portas li { border-bottom: 1px solid var(--rule); padding: 16px 0; }
  .confirmado-portas a { font-family: Georgia, 'Times New Roman', serif; font-size: 18px; font-weight: 700;
    color: var(--ink); text-decoration: none; }
  .confirmado-portas a:hover { color: var(--teal); }
  .confirmado-portas p { font-size: 14px; line-height: 1.5; color: var(--ink); opacity: 0.75; margin: 4px 0 0; }
  .confirmado-survey { padding: 22px 26px; background: var(--card); border: 1px solid var(--rule); border-radius: 2px; }
  .confirmado-survey p { font-size: 15px; line-height: 1.5; color: var(--ink); margin: 0 0 12px; }
  .confirmado-survey a { display: inline-block; font-family: Georgia, 'Times New Roman', serif; font-size: 15px;
    font-weight: 700; color: var(--teal); text-decoration: none; border-bottom: 1px solid var(--teal); padding-bottom: 2px; }
  .confirmado-survey a:hover { opacity: 0.75; }`;
}

/** Puro — sem I/O, sem env. Testável direto. */
export function renderConfirmadoPage(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
${renderSeoMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION, url: PAGE_URL })}
${renderAnalyticsHead()}
<meta name="robots" content="noindex, follow">
<style>
${renderCuradoriaRootStyles()}

${renderCuradoriaHeaderStyles()}

${renderConfirmadoStyles()}

${renderCuradoriaFooterStyles()}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="eyebrow">diar.ia.br</p>
      <hr class="rule">
      <h1>Assinatura confirmada<span class="dot" aria-hidden="true">.</span></h1>
    </div>
  </header>
  <main>
    <div class="wrap">
      <p class="confirmado-lede">Pronto — você já está na lista. Obrigado por confirmar.</p>
      <p class="confirmado-timing">Sua primeira edição chega numa manhã de segunda a sexta, direto no seu e-mail: 5 minutos de leitura com as notícias e tutoriais de IA que importam.</p>
      <div class="confirmado-portas">
        <h2>Enquanto isso</h2>
        <ul>
          <li>
            <a href="${DIARIA_LIVROS_URL}/">Livros sobre IA →</a>
            <p>Uma lista curada de livros sobre inteligência artificial, filtrável por idioma, nível e tema.</p>
          </li>
          <li>
            <a href="${DIARIA_EIA_URL}/jogar">Jogue "É IA?" →</a>
            <p>Adivinhe se cada imagem foi gerada por inteligência artificial ou é real.</p>
          </li>
          <li>
            <a href="${DIARIA_ARQUIVO_URL}/">Arquivo de edições →</a>
            <p>Todas as edições já publicadas da diar.ia.br, agrupadas por mês.</p>
          </li>
        </ul>
      </div>
      <div class="confirmado-survey">
        <p>Quer receber notícias mais alinhadas com o seu interesse? Um formulário rápido ajuda a gente a calibrar o que entra na curadoria.</p>
        <a href="${INTEREST_SURVEY_URL}">Responder o formulário de interesses →</a>
      </div>
    </div>
  </main>
  ${renderCuradoriaFooter("diar.ia.br — assinatura confirmada")}
</body>
</html>
`;
}

/** Embrulha `renderConfirmadoPage()` numa `Response` — sem KV, sem env. */
export function handleConfirmadoPage(): Response {
  return new Response(renderConfirmadoPage(), {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
