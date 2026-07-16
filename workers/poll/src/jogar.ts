/**
 * workers/poll/src/jogar.ts (#3516)
 *
 * Página jogável STANDALONE do "É IA?" — fundação do EPIC #3514 ("jogo
 * público em diar.ia.br com ranking próprio, motor de divulgação"). Serve
 * `GET /jogar`: mostra o par A/B do dia (mesmas imagens já geradas pela
 * pipeline diária, `/img/img-{edition}-01-eia-{A|B}.jpg`), deixa o visitante
 * votar SEM assinatura/email, e credita o voto no leaderboard isolado do
 * brand `web` (mecânica de brand namespacing #1905 — zero código novo de
 * isolamento, `web` só precisou entrar em `BRAND_INFO`, ver lib.ts).
 *
 * Decisões de design (ver PR #3516 para a versão completa com rationale):
 *   1. Identidade anônima: token opaco (UUID) gerado e persistido
 *      client-side (localStorage + cookie, ver `renderJogarPageHtml`), NUNCA
 *      no servidor — sem endpoint novo de "criar sessão". O token vira um
 *      pseudo-email sintético (`anonEmailForToken`) que reusa 100% da infra
 *      de voto/score/nickname existente (`/vote`, `/set-name`) sem alterar
 *      NENHUMA linha de `vote.ts`/`index.ts` — o pseudo-email só precisa
 *      satisfazer `isValidVoteEmailFormat` (lib.ts), que já aceita qualquer
 *      string no formato `local@dominio.tld`.
 *   2. Par do dia: "hoje" em BRT (`todayAammddBrt`) — pela convenção D+1 do
 *      pipeline (CLAUDE.md), a edição datada de hoje é a que está sendo/foi
 *      publicada hoje. `?edition=AAMMDD` explícito sobrepõe (hook de
 *      extensão pro arquivo retroativo, #3519 — não implementado aqui, só o
 *      ponto de entrada).
 *   3. Gabarito/reveal: lido DIRETO do KV compartilhado (`correct:{edition}`,
 *      sem prefixo de brand) — mesmo padrão já usado por `handleImage`
 *      (/img/*, sempre env cru): é um FATO público sobre a edição/par de
 *      imagens, não dado de usuário do brand `web`. `scripts/close-poll.ts`
 *      foi estendido (#3516) para espelhar automaticamente o gabarito da
 *      diária pro brand `web` via `/admin/correct?brand=web` (best-effort,
 *      fail-soft) — então o fluxo `/vote?brand=web` já revela corretamente
 *      "acertou/errou" no dia seguinte ao close-poll da diária rodar, sem
 *      NENHUM passo manual novo no pipeline.
 *   4. Voto em si: reusa literalmente o endpoint `/vote` existente (mesmo
 *      padrão de `renderArchiveVoteHtml` em leaderboard-routes.ts — form GET
 *      com choice A/B) com `?brand=web` e SEM `sig` (merge-tag mode, o mesmo
 *      caminho sem-HMAC que Beehiiv/arquivo já usam) — zero mudança em
 *      `handleVote`.
 */
import type { Env } from "./index";
import {
  AAMMDD_RE,
  BRAND_INFO,
  formatEditionDate,
  htmlEscape,
  leaderboardHref,
  renderBrandFooter,
  renderBrandShellStyles,
  renderSeoMeta,
  todayAammddBrt,
} from "./lib";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";

/** Brand fixo desta página — `/jogar` É o standalone, não um parâmetro. */
const JOGAR_BRAND = "web" as const;

/**
 * Pure (#3516): resolve a edição a ser jogada. `?edition=AAMMDD` explícito
 * (formato válido) tem prioridade — hook de extensão pro arquivo de pares
 * passados (#3519). Formato inválido/ausente → "hoje" em BRT.
 *
 * Nunca lança / nunca retorna algo que não seja AAMMDD válido — um param
 * malformado é ignorado silenciosamente em vez de gerar 400/500 numa página
 * pública de entrada (a página lida com "sem imagem pro par" no client via
 * `onerror` das `<img>`, não aqui).
 */
export function resolveJogarEdition(explicitEdition: string | null, now: Date): string {
  if (explicitEdition && AAMMDD_RE.test(explicitEdition)) return explicitEdition;
  return todayAammddBrt(now);
}

/**
 * Pure (#3516): pseudo-email sintético que representa a identidade anônima
 * do jogador. Formato `{token}@web.eia.diaria.local` — satisfaz
 * `isValidVoteEmailFormat` (lib.ts: `local@dominio.tld`, sem espaço/`@`/`:`
 * extra) sem exigir NENHUMA mudança em `handleVote`/`handleSetName`. `token`
 * já deve vir sanitizado (UUID v4 gerado client-side); validação real
 * acontece no `/vote` via `isValidVoteEmailFormat` (autoridade única —
 * pure aqui só monta a string, não valida).
 */
export function anonEmailForToken(token: string): string {
  return `${token}@web.eia.diaria.local`;
}

export interface JogarPageOptions {
  edition: string;
  /** true quando `correct:{edition}` já existe no KV compartilhado (poll fechado). */
  revealed: boolean;
}

/**
 * Pure (#3516): renderiza a página jogável. Mirror estrutural de
 * `renderArchiveVoteHtml` (leaderboard-routes.ts) — mesmo padrão de form GET
 * pro `/vote` existente, mesmas duas imagens A/B SEM rótulo (anti-gaming,
 * não revela qual é a IA antes do voto mesmo se o poll já fechou — o
 * resultado só aparece na página de `/vote` após votar, igual ao resto do
 * produto). Diferença: o `email` do form é um `<input type="hidden">`
 * preenchido via JS (token anônimo) em vez de um campo digitado pelo leitor.
 *
 * `revealed` só ajusta a cópia de apoio ("resultado sai quando o poll
 * fechar" vs "resultado aparece assim que você votar") — não muda o HTML do
 * form nem revela a resposta antes do clique.
 */
export function renderJogarPageHtml(opts: JogarPageOptions): string {
  const { edition, revealed } = opts;
  const info = BRAND_INFO[JOGAR_BRAND];
  const imgA = `/img/img-${htmlEscape(edition)}-01-eia-A.jpg`;
  const imgB = `/img/img-${htmlEscape(edition)}-01-eia-B.jpg`;
  const dateLabel = htmlEscape(formatEditionDate(edition));
  const pageTitle = `É IA? — jogue e vote | ${info.name}`;
  const subCopy = revealed
    ? "Vote e veja na hora se acertou."
    : "Vote — o resultado sai assim que o poll de hoje fechar.";
  const leaderboardLink = leaderboardHref(JOGAR_BRAND);
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Duas imagens, uma gerada por IA. Adivinhe qual e entre no ranking público do É IA? — edição de ${dateLabel}.`,
    path: "/jogar",
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  /* #1936/#3111: design system canônico via ds-tokens.generated.ts — nunca
     hardcodear cor/fonte inline (test/poll-ds-tokens.test.ts trava isso). */
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; margin-bottom: 4px; letter-spacing: -0.01em; }
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  .choices { display: flex; gap: 12px; margin: 20px 0; justify-content: center; flex-wrap: wrap; }
  .choice { flex: 1 1 240px; max-width: 260px; }
  .choice img { width: 100%; height: auto; border-radius: 6px; display: block; background: ${DS_COLORS.paperAlt}; }
  .choice button { margin-top: 8px; width: 100%; padding: 10px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .choice button:disabled { opacity: 0.5; cursor: not-allowed; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .already { margin: 24px auto; padding: 16px 18px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; font-size: 0.95rem; }
  .scroll-hint { display: none; }
  #jogar-form[hidden], #jogar-already[hidden] { display: none; }
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
  }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
<h1>Qual imagem foi gerada por IA?</h1>
<p class="sub">${subCopy}</p>

<form id="jogar-form" action="/vote" method="GET">
  <input type="hidden" name="edition" value="${htmlEscape(edition)}">
  <input type="hidden" name="brand" value="${JOGAR_BRAND}">
  <input type="hidden" name="email" id="jogar-email" value="">
  <div class="choices" id="jogar-choices">
    <div class="choice"><img id="jogar-img-a" src="${imgA}" alt="Imagem A" loading="lazy"><button type="submit" name="choice" value="A">Essa é a IA (A)</button></div>
    <p class="scroll-hint">↓ Veja também a Imagem B antes de decidir</p>
    <div class="choice"><img id="jogar-img-b" src="${imgB}" alt="Imagem B" loading="lazy"><button type="submit" name="choice" value="B">Essa é a IA (B)</button></div>
  </div>
</form>
<!-- #3516: slot pra card de compartilhamento pós-jogo (#3517, OG dinâmica) —
     não implementado aqui, só o ponto de extensão marcado. -->
<div id="jogar-result-slot" hidden></div>
<div id="jogar-already" class="already" hidden></div>

<p class="footer-links"><a href="${htmlEscape(info.siteUrl)}">← Voltar para a ${htmlEscape(info.name)}</a> &nbsp;|&nbsp; <a href="${leaderboardLink}">Ver leaderboard</a></p>
${renderBrandFooter(JOGAR_BRAND)}

<script>
(function () {
  // #3516: par de hoje pode ainda não estar pronto (pipeline roda ao longo
  // do dia) — se QUALQUER uma das duas imagens falhar, substitui o bloco
  // inteiro por um aviso em vez de deixar o leitor votando às cegas com um
  // ícone de imagem quebrada. Simétrico nas duas (onerror antes só cobria a
  // imagem A).
  var choicesFailed = false;
  function onImgError() {
    if (choicesFailed) return;
    choicesFailed = true;
    var choices = document.getElementById("jogar-choices");
    if (choices) choices.innerHTML = "<p>O par de hoje ainda não está pronto — volte mais tarde.</p>";
  }
  var imgA0 = document.getElementById("jogar-img-a");
  var imgB0 = document.getElementById("jogar-img-b");
  if (imgA0) imgA0.addEventListener("error", onImgError);
  if (imgB0) imgB0.addEventListener("error", onImgError);

  // #3516: identidade anônima — token opaco (UUID) em localStorage + cookie
  // (fallback pra navegadores/config com localStorage bloqueado). Gerado UMA
  // vez no primeiro voto/visita, reusado sempre. NUNCA enviado a nenhum
  // servidor além deste Worker (via o pseudo-email do /vote); sem PII.
  var STORAGE_KEY = "eia_web_token";
  var COOKIE_KEY = "eia_web_token";

  function readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function writeCookie(name, value) {
    var oneYear = 365 * 24 * 60 * 60;
    document.cookie = name + "=" + encodeURIComponent(value) + "; path=/; max-age=" + oneYear + "; SameSite=Lax";
  }
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback pra navegador sem crypto.randomUUID — não precisa de
    // qualidade criptográfica (é só um id opaco de dedup/leaderboard, não
    // segredo), só unicidade prática.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function getOrCreateToken() {
    var t = null;
    try { t = window.localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (!t) t = readCookie(COOKIE_KEY);
    if (!t) {
      t = uuid();
      try { window.localStorage.setItem(STORAGE_KEY, t); } catch (e) {}
      writeCookie(COOKIE_KEY, t);
    } else {
      try { window.localStorage.setItem(STORAGE_KEY, t); } catch (e) {}
      writeCookie(COOKIE_KEY, t);
    }
    return t;
  }

  var edition = ${JSON.stringify(edition)};
  var token = getOrCreateToken();
  var email = token + "@web.eia.diaria.local";
  var emailInput = document.getElementById("jogar-email");
  if (emailInput) emailInput.value = email;

  // #3516: "já votou" é só UX local (evita re-clique confuso) — a
  // deduplicação REAL/autoritativa continua no Durable Object VoteDedup do
  // Worker (mesma garantia de qualquer outro brand). Se o localStorage for
  // limpo, o pior caso é o Worker mostrar "já votou" na página de resultado
  // (nenhuma escrita duplicada acontece).
  var votedKey = "eia_web_voted_" + edition;
  var already = null;
  try { already = window.localStorage.getItem(votedKey); } catch (e) {}
  var form = document.getElementById("jogar-form");
  var alreadyBox = document.getElementById("jogar-already");
  if (already && form && alreadyBox) {
    form.hidden = true;
    alreadyBox.hidden = false;
    alreadyBox.textContent = "Você já votou na edição de hoje (escolha: " + already + "). Resultado na página do seu voto ou no leaderboard.";
  } else if (form) {
    form.addEventListener("submit", function (ev) {
      var choice = ev.submitter && ev.submitter.value;
      if (choice) {
        try { window.localStorage.setItem(votedKey, choice); } catch (e) {}
      }
    });
  }
})();
</script>
</body>
</html>`;
}

/**
 * Handler `GET /jogar` (#3516). Lê o gabarito compartilhado direto do KV cru
 * (sem branding — ver rationale no header do arquivo) só pra decidir a cópia
 * de apoio; todo resto (voto, score, nickname, leaderboard) passa pelos
 * endpoints existentes com `?brand=web`, sem tocar em `env` branded aqui.
 */
export async function handleJogarPage(url: URL, env: Env): Promise<Response> {
  const edition = resolveJogarEdition(url.searchParams.get("edition"), new Date());
  const correctRaw = await env.POLL.get(`correct:${edition}`);
  return new Response(renderJogarPageHtml({ edition, revealed: correctRaw !== null }), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=120",
    },
  });
}
