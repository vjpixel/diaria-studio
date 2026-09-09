/**
 * scripts/lib/shared/confirmado-page.ts (#7737)
 *
 * Render puro (sem I/O, sem env) da página de confirmação do double opt-in
 * da Beehiiv/Kit — extraído de `workers/poll/src/confirmado.ts`, onde toda a
 * história desta página (por que ela existe, o survey de interesses, as 4
 * "portas" de curadoria, a instrumentação GTM, e por que `gclid`/`fbclid`/
 * `msclkid`/`li_fat_id` não se aplicam aqui) segue documentada — não
 * repetida neste arquivo pra não duplicar a fonte da verdade.
 *
 * Motivo da extração (decisão do editor, comentário `decisao-editor` na
 * issue #7737): a página passa a ser servida em `diar.ia.br/confirmado`
 * (Worker `site`, o apex — #467) em vez de `eia.diar.ia.br/confirmado`
 * (Worker `poll`). `eia.diar.ia.br/confirmado` continua no ar — vira 301
 * pro apex, ver `workers/poll/src/confirmado.ts` — porque o link já está
 * gravado em e-mails de confirmação JÁ ENTREGUES e em `opt_in_redirect_url`
 * da Beehiiv.
 *
 * Dois Workers = dois bundles Cloudflare separados, sem import cross-worker
 * por convenção (ver docstring de `workers/cursos/src/subscribe.ts`) — por
 * isso o render puro mora aqui, em `scripts/lib/shared/`, e cada Worker
 * (`site` para a página real, `poll` só pro redirect) importa o que precisa
 * daqui em vez de duplicar/importar do bundle um do outro.
 */
import {
  renderCuradoriaRootStyles,
  renderCuradoriaHeaderStyles,
  renderCuradoriaFooterStyles,
  renderCuradoriaFooter,
} from "./curadoria-page.ts";
import { renderSeoMeta, renderAnalyticsHead } from "./seo-meta.ts"; // #5498: container GTM
import { DIARIA_LIVROS_URL, DIARIA_ARQUIVO_URL, DIARIA_CURSOS_URL, DIARIA_EIA_URL } from "../canonical-urls.ts";

/** URL pública canônica desta página — apex, desde #7737 (era `eia.diar.ia.br/confirmado`). */
export const PAGE_URL = "https://diar.ia.br/confirmado";

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
  .confirmado-survey { padding: 22px 26px; background: var(--card); border: 1px solid var(--rule); border-radius: 2px; margin: 0 0 40px; }
  .confirmado-survey p { font-size: 15px; line-height: 1.5; color: var(--ink); margin: 0 0 14px; }
  .confirmado-survey a { display: inline-block; font-family: Georgia, 'Times New Roman', serif; font-size: 15px;
    font-weight: 700; color: var(--paper); background: var(--teal); text-decoration: none; padding: 10px 20px;
    border-radius: 4px; }
  .confirmado-survey a:hover { opacity: 0.85; }`;
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
      <div class="confirmado-survey">
        <p>Quer receber notícias mais alinhadas com o seu interesse? Um formulário rápido ajuda a gente a calibrar o que entra na curadoria.</p>
        <a href="${INTEREST_SURVEY_URL}">Responder o formulário de interesses</a>
      </div>
      <div class="confirmado-portas">
        <h2>Enquanto isso</h2>
        <ul>
          <li>
            <a href="${DIARIA_CURSOS_URL}/">Cursos gratuitos de IA →</a>
            <p>Cursos verificados sobre inteligência artificial, a maioria gratuita, filtráveis por idioma, nível e plataforma.</p>
          </li>
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
