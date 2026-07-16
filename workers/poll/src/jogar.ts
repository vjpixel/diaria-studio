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
// #3517: share card pós-jogo — script de wiring dos botões (Web Share API +
// fallback copiar-link) reusado LITERALMENTE do mesmo helper que
// votePageHtml (index.ts) usa pro bloco renderizado direto, só com um
// container selector diferente. Rationale completo em share.ts.
import { shareButtonScript } from "./share";
// #3519: arquivo de pares passados — reusa 100% da extração/agrupamento já
// construído pro arquivo retroativo do brand `diaria`/`clarice` (#2867/#3113,
// leaderboard-routes.ts) em vez de duplicar a lógica de listagem de edições
// fechadas. Único ponto novo aqui é o HREF de cada item: em vez da página de
// voto por e-mail (`renderArchiveVoteHtml`, arquivo "assinante"), o arquivo
// standalone linka pra `/jogar?edition={AAMMDD}` (identidade anônima, mesmo
// mecanismo do #3516) — mantendo a experiência sem-email consistente com o
// resto de `/jogar`. `leaderboard-routes.ts` importa de `./index`, que por
// sua vez importa `handleJogarPage`/`handleJogarArchivePage` deste arquivo —
// ciclo de 3 módulos já existente hoje entre index.ts↔leaderboard-routes.ts
// (via `export * from "./leaderboard-routes"` em index.ts) e comprovadamente
// seguro: nenhum dos três usa o valor importado no top-level do módulo, só
// dentro de corpos de função executados em request-time (bindings vivos do
// ESM resolvem o ciclo sem problema).
import { extractEditionsForYear, groupEditionsByMonth, listAllKeys } from "./leaderboard-routes";

/** Brand fixo desta página — `/jogar` É o standalone, não um parâmetro. */
const JOGAR_BRAND = "web" as const;

/**
 * #3518: URL de assinatura da diária usada no CTA de conversão pós-voto do
 * jogo standalone (o passo de conversão do EPIC #3514). `diaria.beehiiv.com`
 * DIRETO — não `diar.ia.br` — mesma decisão já documentada em
 * `count-subscriptions-by-utm.ts` (#2457) e `monthly-render.ts` (#2975): o
 * redirect do Registro.br em `diar.ia.br` dropa a query string (#2613), o que
 * apagaria silenciosamente o UTM. `utm_source=eia-standalone` segue a MESMA
 * convenção de medição já usada pra Clarice (`utm_source=clarice`) —
 * `count-subscriptions-by-utm.ts --source eia-standalone` mede quantos
 * assinantes vieram por este funil sem nenhum código novo (o script já
 * agrega por qualquer utm_source presente na subscription do Beehiiv).
 */
export const SUBSCRIBE_UTM_SOURCE = "eia-standalone";
export const SUBSCRIBE_UTM_MEDIUM = "jogar";
export const SUBSCRIBE_UTM_CAMPAIGN = "eia-jogar-posvoto";

/**
 * Pure (#3518): URL de assinatura com UTM fixo do funil do jogo. Sem
 * variante A/B — a issue sugere "copy A/B-ável (guardar variante no KV pra
 * medir)" como ideia de expansão; decisão conservadora aqui é 1 única
 * copy/URL fixa, já mensurável via `count-subscriptions-by-utm.ts`. A/B real
 * (persistir variante + KV) fica de follow-up caso o editor queira testar
 * cópias — fora do escopo desta issue [S].
 */
export function buildSubscribeUrl(): string {
  const params = new URLSearchParams({
    utm_source: SUBSCRIBE_UTM_SOURCE,
    utm_medium: SUBSCRIBE_UTM_MEDIUM,
    utm_campaign: SUBSCRIBE_UTM_CAMPAIGN,
  });
  return `https://diaria.beehiiv.com/?${params.toString()}`;
}

/**
 * Pure (#3518): bloco HTML do CTA de assinatura pós-voto — a conversão do
 * EPIC #3514. `hidden` por padrão no HTML estático: revelado via JS só
 * depois do voto (novo OU repetido — ver `renderJogarPageHtml`), nunca antes
 * (mesma disciplina anti-spoiler/progressive-enhancement do resto da
 * página). Copy reusa quase literalmente a sugestão da própria issue #3518.
 * `target="_blank"` — não perder o estado do jogo (token/voto já registrado)
 * ao converter; assinatura abre em aba nova.
 */
export function renderSubscribeCtaBlock(): string {
  const url = buildSubscribeUrl();
  return `<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>
  <p class="subscribe-text">Gostou? Um par novo desses todo dia na sua caixa de entrada, além das 3 notícias de IA mais importantes. Grátis.</p>
  <a class="subscribe-btn" href="${htmlEscape(url)}" target="_blank" rel="noopener">Assinar a Diar.ia</a>
</div>`;
}

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
  #jogar-form[hidden], #jogar-already[hidden], #jogar-result-slot[hidden], #jogar-subscribe-cta[hidden] { display: none; }
  /* #3517: estilo do resultado + card de compartilhamento injetados no slot
     via JS (mesmas classes de renderShareCardBlock/votePageHtml, index.ts —
     duplicado aqui pois é um <style> inline separado, mesmo padrão do resto
     do worker: cada página inline o próprio CSS). */
  .result-msg { font-family: ${DS_FONTS.serif}; font-size: 1.3rem; line-height: 1.4; margin: 20px 0; }
  .share-card { margin: 24px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .share-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .share-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .share-actions button { padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  /* #3518: CTA de assinatura pós-voto — mesmo padrão visual de .share-card
     (fundo paperAlt, cantos arredondados). Botão sólido em ink (não brand) —
     #3110 já documentou que ink+onInk é o único par que passa contraste AA
     (~15:1) pra botão de fundo cheio; brand/teal é só texto no DS. */
  .subscribe-cta { margin: 20px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .subscribe-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .subscribe-btn { display: inline-block; padding: 10px 20px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
    .share-card { max-width: 100%; padding: 20px 18px; }
    .share-actions { flex-direction: column; }
    .share-actions button { width: 100%; padding: 14px 16px; font-size: 1.05rem; }
    .subscribe-cta { max-width: 100%; padding: 20px 18px; }
    .subscribe-btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 1.05rem; }
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
<!-- #3517: preenchido via JS (fetch a /vote + DOMParser) com o '.msg' de
     resultado + o bloco '#jogar-share-card' (mesma estrutura de
     renderShareCardBlock, share.ts) — sem sair da página. Fallback pra
     navegação nativa (window.location.href) em qualquer falha de rede. -->
<div id="jogar-result-slot" hidden></div>
<div id="jogar-already" class="already" hidden></div>
<!-- #3518: CTA de assinatura — estático (SEM dado de servidor, ao contrário
     do result-slot/share-card), revelado via JS junto com o resultado (voto
     novo OU repetido, ver script abaixo). Nunca antes do voto (mesma
     disciplina anti-spoiler do resto da página). -->
${renderSubscribeCtaBlock()}

<p class="footer-links"><a href="${htmlEscape(info.siteUrl)}">← Voltar para a ${htmlEscape(info.name)}</a> &nbsp;|&nbsp; <a href="${leaderboardLink}">Ver leaderboard</a> &nbsp;|&nbsp; <a href="/jogar/arquivo">Jogar edições passadas</a></p>
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
  // #3518: CTA de assinatura — revelado junto com QUALQUER resultado (voto
  // novo abaixo, ou já-votou aqui). Bloco é estático (sem dado de servidor),
  // então só precisa desescondê-lo — nenhum fetch/injeção extra.
  var subscribeCta = document.getElementById("jogar-subscribe-cta");
  if (already && form && alreadyBox) {
    form.hidden = true;
    alreadyBox.hidden = false;
    alreadyBox.textContent = "Você já votou na edição de hoje (escolha: " + already + "). Resultado na página do seu voto ou no leaderboard.";
    if (subscribeCta) subscribeCta.hidden = false;
  } else if (form) {
    // #3517: intercepta o submit — em vez de deixar o browser navegar pro
    // /vote (comportamento nativo do form GET), busca a mesma URL via fetch
    // e injeta o resultado (mensagem + card de compartilhamento) no slot
    // reservado, sem sair de /jogar. QUALQUER falha de rede cai pra
    // navegação nativa (window.location.href) — o voto NUNCA se perde por
    // causa de um fetch que falhou (dedup no servidor cobre o retry).
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var choice = ev.submitter && ev.submitter.value;
      // Safety net: um <button type="submit"> sempre tem 'value', mas se o
      // browser não expuser 'ev.submitter' (API relativamente recente),
      // preferimos a navegação nativa garantida a silenciosamente não votar.
      if (!choice) { form.submit(); return; }
      try { window.localStorage.setItem(votedKey, choice); } catch (e) {}

      var params = new URLSearchParams();
      params.set("edition", edition);
      params.set("brand", ${JSON.stringify(JOGAR_BRAND)});
      params.set("email", email);
      params.set("choice", choice);
      var voteUrl = "/vote?" + params.toString();
      var resultSlot = document.getElementById("jogar-result-slot");

      function fallbackNativeNav() { window.location.href = voteUrl; }

      if (!resultSlot || typeof window.fetch !== "function" || typeof DOMParser === "undefined") {
        fallbackNativeNav();
        return;
      }

      fetch(voteUrl).then(function (res) {
        return res.text();
      }).then(function (html) {
        var parsed = new DOMParser().parseFromString(html, "text/html");
        var msgEl = parsed.querySelector(".msg");
        var shareCardEl = parsed.querySelector("#jogar-share-card");
        if (!msgEl && !shareCardEl) { fallbackNativeNav(); return; }
        var out = "";
        if (msgEl) out += '<p class="result-msg">' + msgEl.innerHTML + "</p>";
        if (shareCardEl) out += shareCardEl.outerHTML;
        resultSlot.innerHTML = out;
        resultSlot.hidden = false;
        form.hidden = true;
        // #3518: CTA de assinatura — revelado junto com o resultado do voto
        // NOVO (mesmo timing do share card acima).
        if (subscribeCta) subscribeCta.hidden = false;
      }).catch(fallbackNativeNav);
    });

    // #3517: delegação de clique pro(s) botão(ões) de compartilhamento
    // injetado(s) dinamicamente acima — mesmo script reusado por votePageHtml
    // (index.ts) pro card renderizado direto em /vote, ver share.ts.
  }
})();
</script>
${shareButtonScript("#jogar-result-slot")}
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

// ── #3519: arquivo de pares passados ────────────────────────────────────────
//
// Sub-issue [S] do EPIC #3514 — visitante novo (chegando via share, #3517)
// não deve esbarrar em "volte amanhã": oferece os pares de edições PASSADAS
// como conteúdo jogável imediato. Decisões de design (ver PR #3519):
//
//   1. Rota: `GET /jogar/arquivo` (índice) + `/jogar?edition={AAMMDD}` pro
//      par individual — reusa literalmente o hook `?edition=` que o #3516 já
//      deixou reservado (`resolveJogarEdition`), em vez de criar uma rota
//      nova `/jogar/{edicao}`. Zero mudança em `handleJogarPage`/
//      `renderJogarPageHtml` — o form de voto, a identidade anônima, o
//      anti-spoiler e o CTA de assinatura já funcionam para QUALQUER edição
//      válida passada pelo query param (comportamento já coberto pelos testes
//      do #3516: `?edition=` malformado cai no default; `?edition=` válido
//      mas sem gabarito ainda renderiza normalmente com a cópia "pré-
//      revelação" — mesmo tratamento gracioso que o par do dia já tem quando
//      a pipeline ainda não terminou. Não duplicamos esse guard aqui.).
//
//   2. Fonte da lista: as mesmas chaves `correct:{edition}` que já alimentam
//      `/leaderboard/{YYYY}/arquivo` (#2867/#3113) — `extractEditionsForYear`
//      + `listAllKeys` (leaderboard-routes.ts) reusados sem duplicação. Só
//      entram edições com gabarito FECHADO (`correct:{edition}` definido) e
//      não-futuras (mesma guarda defensiva #3113 item 9) — exatamente o
//      critério de aceite "arquivo lista pares fechados". Lido do KV CRU
//      (não branded) — mesmo racional do resto do arquivo: `correct:{edition}`
//      é fato público compartilhado entre brands, não dado do brand `web`.
//
//   3. Par corrente excluído: mesmo com gabarito já fechado, a edição de HOJE
//      nunca aparece na listagem — ela já é o padrão de `/jogar` (sem
//      `?edition=`); o arquivo é estritamente o retrospecto, evita conteúdo
//      duplicado entre as duas páginas.
//
//   4. Pontuação: NÃO reimplementamos gate nenhum em `/vote` — o voto em
//      edição arquivada via `/jogar?edition=X&brand=web` já é aceito hoje
//      pelo gate existente (`web:valid_editions` nunca populado → fail-open,
//      mesmo padrão do brand `clarice`, #2018) e conta pro leaderboard
//      mensal do brand `web` normalmente. Decisão conservadora: sem
//      diferenciação de pontos entre par do dia e par de arquivo (a issue
//      deixava em aberto "decidir na implementação"; manter o mesmo
//      mecanismo simples do resto do produto evita introduzir um sistema de
//      pontuação paralelo só pro brand `web` nesta entrega [S]).
//
//   5. Anti-spoiler: preservado por construção — `renderJogarPageHtml` nunca
//      rotula qual imagem é a IA antes do voto, fechada ou não (mesmo teste
//      `renderJogarPageHtml pure render` do #3516 cobre isso com
//      `revealed: true`). O arquivo só adiciona a LISTAGEM; a revelação
//      continua exclusivamente pós-voto via `/vote`.

/**
 * Pure (#3519): resolve o ano da listagem do arquivo. `?year=YYYY` explícito
 * (formato + range sensato) tem prioridade; ausente/malformado cai no ano
 * corrente em BRT — nunca lança, mesma disciplina de `resolveJogarEdition`
 * (página pública de entrada não pode 400/500 por um param mal formado).
 */
export function resolveJogarArchiveYear(rawYear: string | null, now: Date): string {
  if (rawYear && /^\d{4}$/.test(rawYear)) {
    const y = parseInt(rawYear, 10);
    if (y >= 2000 && y <= 2099) return rawYear;
  }
  const today = todayAammddBrt(now);
  return `20${today.slice(0, 2)}`;
}

/**
 * Pure render (#3519): página de índice do arquivo — lista as edições
 * FECHADAS do ano (já filtradas/ordenadas DESC pelo caller via
 * `extractEditionsForYear`), agrupadas por mês (`groupEditionsByMonth`,
 * reusado de leaderboard-routes.ts). Cada item linka pra `/jogar?edition=…`
 * (identidade anônima) — NÃO pra `/leaderboard/{year}/arquivo/{edition}`
 * (fluxo de e-mail digitado do arquivo "assinante", #2867), que exigiria o
 * visitante sair do modo anônimo do `/jogar`.
 */
export function renderJogarArchiveHtml(editions: string[], year: string): string {
  const info = BRAND_INFO[JOGAR_BRAND];
  const sections = groupEditionsByMonth(editions, JOGAR_BRAND, year)
    .map((g) => {
      const items = g.editions
        .map((ed) => `<li><a href="/jogar?edition=${htmlEscape(ed)}">${htmlEscape(formatEditionDate(ed))}</a></li>`)
        .join("\n");
      return `<h2 class="month-heading">${htmlEscape(g.monthLabel)}</h2>\n<ul>${items}</ul>`;
    })
    .join("\n");
  const rows = sections || "<ul><li>Nenhuma edição disponível ainda.</li></ul>";
  const pageTitle = `Arquivo — É IA? | ${info.name}`;
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Jogue pares de edições passadas do "É IA?" — arquivo de ${htmlEscape(year)} da ${info.name}. Adivinhe qual imagem foi gerada por IA.`,
    path: "/jogar/arquivo",
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  body { font-family: ${DS_FONTS.sans}; max-width: 640px; margin: 40px auto; padding: 0 20px; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.7rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  ul { list-style: none; padding: 0; margin-top: 20px; }
  li { padding: 12px 8px; border-bottom: 1px solid ${DS_COLORS.rule}; font-size: 1.02rem; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  .month-heading { font-family: ${DS_FONTS.sans}; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${DS_COLORS.brand}; margin: 28px 0 0; }
  .month-heading + ul { margin-top: 8px; }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA? — arquivo</p>
<hr class="rule">
<h1>Jogue edições passadas</h1>
<p class="sub">Pares de dias anteriores — vote e veja na hora se acertou. Só edições já reveladas entram aqui, o par de hoje fica em <a href="/jogar">/jogar</a>.</p>
${rows}
<p class="footer-links"><a href="/jogar">← Voltar pro par de hoje</a> &nbsp;|&nbsp; <a href="${leaderboardHref(JOGAR_BRAND)}">Ver leaderboard</a></p>
${renderBrandFooter(JOGAR_BRAND)}
</body>
</html>`;
}

/**
 * Handler `GET /jogar/arquivo` (#3519). `env` CRU (não branded) — mesmo
 * padrão de `handleJogarPage`: lê `correct:{edition}` compartilhado, fato
 * público sobre a edição, não dado do brand `web`.
 */
export async function handleJogarArchivePage(url: URL, env: Env): Promise<Response> {
  const now = new Date();
  const year = resolveJogarArchiveYear(url.searchParams.get("year"), now);
  const yy = year.slice(2);
  const keys: string[] = [];
  for await (const k of listAllKeys(env, `correct:${yy}`)) keys.push(k);
  const today = todayAammddBrt(now);
  const editions = extractEditionsForYear(keys, year, now).filter((ed) => ed !== today);
  return new Response(renderJogarArchiveHtml(editions, year), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
