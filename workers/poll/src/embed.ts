/**
 * workers/poll/src/embed.ts (#3521)
 *
 * Widget EMBEDÁVEL (iframe) do "É IA?" standalone — sub-issue [S] do EPIC
 * #3514 ("motor de divulgação"). Sites parceiros (1º natural: Clarice.ai)
 * colam um `<iframe src="https://eia.diar.ia.br/embed">` (#3904 — domínio de
 * marca; era poll.diaria.workers.dev) na própria página e alcançam audiência
 * que ainda não conhece diar.ia.br. Construído
 * sobre a fundação #3516 (`/jogar`, identidade anônima, brand `web`), #3517
 * (share card pós-voto) e #3518 (CTA de assinatura pós-voto).
 *
 * Decisões de design (ver PR #3521 para rationale completo):
 *
 *   1. **Iframe, não script-injection.** A própria issue já resolve essa
 *      escolha ("iframe é o mais seguro") — um `<script>` de terceiro
 *      injetando DOM na página do parceiro exigiria Shadow DOM pra isolar
 *      CSS (#3521 item "isolamento do CSS") e daria ao nosso JS acesso ao
 *      DOM/cookies do parceiro (superfície de ataque desnecessária). Um
 *      `<iframe>` isola CSS/JS/storage por construção (mesma origem do
 *      navegador) — zero código extra pra "não vazar/quebrar no site
 *      parceiro", a proteção vem do próprio elemento HTML.
 *
 *   2. **Allowlist de embutimento via CSP `frame-ancestors`, fail-closed.**
 *      `X-Frame-Options` só suporta UM domínio (`ALLOW-FROM`, aliás já
 *      deprecated/ignorado pelos browsers modernos) — CSP `frame-ancestors`
 *      é a única forma correta de "váRIOS domínios específicos podem
 *      embutir". `EMBED_ALLOWED_ORIGINS` (wrangler.toml `[vars]`, mesmo
 *      padrão de `ALLOWED_ORIGINS`/CORS) é uma lista de origens completas
 *      separada por vírgula. Vazio (default até o editor confirmar o 1º
 *      parceiro, #3514 decisão 1) → `frame-ancestors 'none'` — ninguém pode
 *      embutir até ser configurado explicitamente ("não abrir iframe pro
 *      mundo", mandato literal da issue). `buildFrameAncestorsCsp` é pure,
 *      testável sem precisar de um Worker real.
 *
 *   3. **Achado de self-review #2038, CORRIGIDO (não só comentado — mesmo
 *      precedente do #3117/#3120): introduzir `frame-ancestors` neste PR
 *      expôs que NENHUMA outra rota do worker jamais restringiu framing.**
 *      Antes deste PR, `/vote`, `/jogar`, `/leaderboard*`, `/set-name` etc.
 *      podiam ser embutidas em iframe por QUALQUER site terceiro sem
 *      consentimento — um vetor clássico de clickjacking sobre `/vote`
 *      (ação real de escrita disparada por 1 clique). Ao introduzir o
 *      conceito de política de framing no worker (que não existia), o
 *      mínimo correto é fechar essa exposição pra tudo que NÃO pediu pra
 *      ser embutível, não só abrir a rota nova. Fix: `applyFrameDenyHeaders`
 *      em `index.ts`, aplicado a toda resposta exceto `/embed` — ver
 *      rationale completo lá.
 *
 *   4. **Consequência do item 3 — a página NÃO reusa 1:1 o padrão
 *      fetch+DOMParser de `/jogar` sem ajuste.** `frame-ancestors` só
 *      restringe NAVEGAÇÃO/embutimento (carregar um Document como browsing
 *      context filho) — nunca `fetch()` (que não cria browsing context).
 *      Então o padrão de `/jogar` (interceptar o submit, `fetch("/vote?...")`,
 *      `DOMParser` extrai `.msg`/`#jogar-share-card`, injeta no slot) é 100%
 *      SEGURO de reusar aqui — nenhuma parte disso é uma navegação. O único
 *      ponto que PRECISARIA de ajuste é o fallback quando o fetch falha: se
 *      esse fallback fizesse `window.location.href = voteUrl` (like
 *      `/jogar` faz), estaria navegando o PRÓPRIO iframe (ainda embutido no
 *      parceiro) pra `/vote`, que agora tem `frame-ancestors: 'none'` — a
 *      navegação seria bloqueada pelo browser, deixando o iframe com uma
 *      página em branco/erro. Fix aplicado: o fallback aqui NUNCA navega o
 *      iframe — mostra um link `target="_blank"` (abre nova aba, contexto
 *      de nível superior, imune a `frame-ancestors`) em vez de auto-navegar.
 *      Mesmo racional aplicado ao `<form>`: `target="_blank"` cobre o caso
 *      raro de submit nativo sem JS (o preventDefault do submit handler
 *      sempre roda primeiro quando JS está disponível, então o `target` só
 *      importa nesse fallback).
 *
 *   5. **Identidade: localStorage best-effort, SEM cookie (diferença
 *      deliberada de `/jogar`).** `/jogar` usa cookie `SameSite=Lax` como
 *      2º fallback de persistência — mas um cookie `SameSite=Lax` setado
 *      pelo worker DENTRO de um iframe cross-site nunca é enviado em
 *      requests subsequentes originadas de dentro desse mesmo iframe (o
 *      "site for cookies" é calculado a partir do frame de NÍVEL SUPERIOR,
 *      que é o domínio do parceiro — cross-site por definição aqui).
 *      Adicionar esse fallback no embed seria código morto garantido nesse
 *      cenário específico — omitido deliberadamente (não sobre-engenheirar
 *      um mecanismo comprovadamente inerte no seu próprio contexto de uso).
 *      `localStorage` sofre particionamento por top-level site em vários
 *      browsers modernos (Storage Partitioning/CHIPS, dFPI, ITP) — mas
 *      quando particiona (em vez de bloquear 100%), ainda funciona
 *      corretamente PRA ESTE CASO DE USO: o token persiste de forma
 *      consistente enquanto o leitor volta à MESMA página do MESMO parceiro
 *      — que é exatamente o cenário de um widget embutido. Quando bloqueado
 *      de vez (Safari com bloqueio total de storage de terceiro, ou
 *      navegador em modo privado), `getOrCreateToken` cai num token
 *      efêmero gerado em memória (perdido no reload) SEM lançar erro — o
 *      voto ainda funciona nessa visita, só não persiste "já votei" entre
 *      recarregamentos. Satisfaz literalmente o critério de aceite
 *      "Degradação sem cookies: joga sem ranking (sem erro)".
 *
 *   6. **`?partner=` é só medição (UTM), nunca autorização.** A allowlist de
 *      QUEM pode embutir é 100% server-side (`EMBED_ALLOWED_ORIGINS`, item
 *      2) — `?partner=slug` é um parâmetro de URL não-autenticado que
 *      qualquer um pode forjar; usá-lo pra decidir SE embutir seria
 *      trivialmente contornável. Aqui ele só rotula o `utm_campaign` do CTA
 *      de conversão (mesma convenção de medição do #3518,
 *      `count-subscriptions-by-utm.ts` agrega por `utm_source` livremente) —
 *      forjar um partner slug forja só a ATRIBUIÇÃO de uma conversão real
 *      (mesma classe de risco de baixo impacto já aceita pra `SIG_LENGTH`
 *      truncado do share token, ver header de share.ts).
 */
import type { Env } from "./index";
import { htmlEscape, PUBLIC_GAME_BASE_URL, PUBLIC_GAME_DISPLAY_HOST } from "./lib";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";
import { resolveJogarEdition } from "./jogar";
import { shareButtonScript } from "./share";

/** Brand fixo — mesmo racional de `JOGAR_BRAND` em jogar.ts: o embed É o
 * standalone, não um parâmetro. */
const EMBED_BRAND = "web" as const;

// ── UTM de conversão do funil embed (#3521, convenção do #3518) ────────────

export const EMBED_UTM_SOURCE = "embed";
export const EMBED_UTM_MEDIUM = "widget";
/** Partner slug default quando `?partner=` está ausente/inválido — mantém o
 * funil mensurável ("origem desconhecida") em vez de quebrar o CTA. */
export const EMBED_DEFAULT_PARTNER = "generico";

/**
 * Pure: sanitiza o slug do parceiro pra uso em `utm_campaign` — minúsculo,
 * `[a-z0-9_-]`, ≤40 chars. Nunca lança; vazio/só-caracteres-inválidos cai no
 * default. Não é allowlist de autorização (ver item 6 do header) — só evita
 * que um valor arbitrário (espaços, `&`, etc.) quebre a URL de UTM montada.
 */
export function resolveEmbedPartnerSlug(raw: string | null): string {
  if (!raw) return EMBED_DEFAULT_PARTNER;
  const slug = raw.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return slug || EMBED_DEFAULT_PARTNER;
}

/** Pure: URL de assinatura com UTM do funil embed — mesmo destino
 * (`diaria.beehiiv.com` DIRETO, #2613) e mesma disciplina de `buildSubscribeUrl`
 * (jogar.ts, #3518), `utm_campaign` = slug do parceiro em vez de fixo. */
export function buildEmbedSubscribeUrl(partnerSlug: string): string {
  const params = new URLSearchParams({
    utm_source: EMBED_UTM_SOURCE,
    utm_medium: EMBED_UTM_MEDIUM,
    utm_campaign: partnerSlug,
  });
  return `https://diaria.beehiiv.com/?${params.toString()}`;
}

/** Pure: link "jogue mais" pro `/jogar` completo (mesmo worker, sem o
 * problema de query-string dropada do redirect `diar.ia.br` — #2613, ver
 * `buildSubscribeUrl` em jogar.ts) — carrega o mesmo UTM do funil embed. */
export function buildEmbedJogarUrl(partnerSlug: string): string {
  const params = new URLSearchParams({
    utm_source: EMBED_UTM_SOURCE,
    utm_medium: EMBED_UTM_MEDIUM,
    utm_campaign: partnerSlug,
  });
  return `${PUBLIC_GAME_BASE_URL}/jogar?${params.toString()}`;
}

// ── Allowlist de embutimento (CSP frame-ancestors) ──────────────────────────

/** Pure: parseia `EMBED_ALLOWED_ORIGINS` (mesmo formato CSV de
 * `ALLOWED_ORIGINS`, index.ts). `null`/`undefined`/vazio → lista vazia. */
export function parseEmbedAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * Pure: monta a diretiva `frame-ancestors` do header `Content-Security-Policy`
 * de `/embed`. Lista vazia (config ausente) → `'none'`, fail-closed (item 2 do
 * header). Nunca produz `*` implicitamente — se um operador configurar `*`
 * literal em `EMBED_ALLOWED_ORIGINS`, isso é repassado como está (decisão
 * consciente do operador, fora do escopo desta função validar contra si
 * mesma — documentado em wrangler.toml pra nunca usar `*` aqui).
 */
export function buildFrameAncestorsCsp(raw: string | undefined | null): string {
  const origins = parseEmbedAllowedOrigins(raw);
  if (origins.length === 0) return "frame-ancestors 'none'";
  return `frame-ancestors ${origins.join(" ")}`;
}

// ── Widget HTML ──────────────────────────────────────────────────────────────

export interface EmbedPageOptions {
  edition: string;
  /** true quando `correct:{edition}` já existe no KV compartilhado (poll fechado). */
  revealed: boolean;
  partnerSlug: string;
}

/**
 * Pure render (#3521): página compacta servida dentro do iframe do parceiro.
 * Mirror estrutural de `renderJogarPageHtml` (jogar.ts) — mesmo padrão de
 * form GET pro `/vote` existente com par A/B sem rótulo (anti-gaming/anti-
 * spoiler idêntico) — mas: (a) layout de largura fixa/compacta pensada pra
 * caber numa coluna de widget (~360px), sem nav de leaderboard/arquivo (fora
 * de escopo de um widget de 1 par), (b) SEM `<meta name="robots">` de
 * indexação (`noindex,nofollow` — o widget não é uma página própria a ser
 * indexada, é conteúdo servido pra dentro de outra página) e sem
 * `renderSeoMeta`/canonical (nenhum unfurler busca a URL do iframe
 * diretamente), (c) `target="_blank"` em TODO link/form que sai do fluxo
 * in-widget — ver item 4 do header do arquivo (nunca navegar o iframe pra
 * uma rota com `frame-ancestors: 'none'`).
 */
export function renderEmbedPageHtml(opts: EmbedPageOptions): string {
  const { edition, revealed, partnerSlug } = opts;
  const imgA = `/img/img-${htmlEscape(edition)}-01-eia-A.jpg`;
  const imgB = `/img/img-${htmlEscape(edition)}-01-eia-B.jpg`;
  const subscribeUrl = buildEmbedSubscribeUrl(partnerSlug);
  const jogarUrl = buildEmbedJogarUrl(partnerSlug);
  const subCopy = revealed
    ? "Vote e veja na hora se acertou."
    : "Vote — o resultado sai assim que o poll de hoje fechar.";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>É IA? — widget</title>
<style>
  /* #3521: layout compacto pensado pra iframe estreito (~340-420px), sempre
     em coluna única — diferente de /jogar (jogar.ts), que assume largura de
     artigo (~560px) e só empilha A/B abaixo de 600px. Cores/fontes via
     DS_COLORS/DS_FONTS (ds-tokens.generated.ts) — nunca hardcodear inline
     (test/poll-ds-tokens.test.ts trava isso pros arquivos listados). */
  * { box-sizing: border-box; }
  body { font-family: ${DS_FONTS.sans}; font-size: 14px; max-width: 100%; margin: 0; padding: 14px; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.15rem; margin: 0 0 2px; letter-spacing: -0.01em; line-height: 1.3; }
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.82rem; margin: 0 0 12px; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.62rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${DS_COLORS.brand}; margin: 0 0 6px; }
  .choices { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
  .choice img { width: 100%; height: auto; border-radius: 6px; display: block; background: ${DS_COLORS.paperAlt}; }
  .choice button { margin-top: 6px; width: 100%; padding: 9px 10px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.88rem; font-family: ${DS_FONTS.sans}; }
  .choice button:disabled { opacity: 0.5; cursor: not-allowed; }
  a { color: ${DS_COLORS.ink}; }
  .already { margin: 14px 0; padding: 10px 12px; background: ${DS_COLORS.paperAlt}; border-radius: 6px; font-size: 0.85rem; }
  #embed-form[hidden], #embed-already[hidden], #embed-result-slot[hidden], #embed-subscribe-cta[hidden] { display: none; }
  .result-msg { font-family: ${DS_FONTS.serif}; font-size: 1rem; line-height: 1.4; margin: 12px 0; }
  .fallback-link { font-size: 0.85rem; }
  .share-card { margin: 14px 0; padding: 12px 14px; background: ${DS_COLORS.paperAlt}; border-radius: 6px; }
  .share-text { font-family: ${DS_FONTS.serif}; font-size: 0.9rem; margin: 0 0 10px; line-height: 1.4; }
  .share-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .share-actions button { padding: 8px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.8rem; font-family: ${DS_FONTS.sans}; }
  .subscribe-cta { margin: 14px 0 0; padding: 12px 14px; background: ${DS_COLORS.paperAlt}; border-radius: 6px; }
  .subscribe-text { font-family: ${DS_FONTS.serif}; font-size: 0.9rem; margin: 0 0 10px; line-height: 1.4; }
  .subscribe-btn { display: block; text-align: center; padding: 9px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 0.85rem; font-family: ${DS_FONTS.sans}; }
  .widget-footer { margin-top: 14px; padding-top: 10px; border-top: 1px solid ${DS_COLORS.rule}; font-size: 0.72rem; text-align: right; }
  .widget-footer a { font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<h1>Qual imagem foi gerada por IA?</h1>
<p class="sub">${subCopy}</p>

<form id="embed-form" action="/vote" method="GET" target="_blank">
  <input type="hidden" name="edition" value="${htmlEscape(edition)}">
  <input type="hidden" name="brand" value="${EMBED_BRAND}">
  <input type="hidden" name="email" id="embed-email" value="">
  <div class="choices" id="embed-choices">
    <div class="choice"><img id="embed-img-a" src="${imgA}" alt="Imagem A" loading="lazy"><button type="submit" name="choice" value="A">Essa é a IA (A)</button></div>
    <div class="choice"><img id="embed-img-b" src="${imgB}" alt="Imagem B" loading="lazy"><button type="submit" name="choice" value="B">Essa é a IA (B)</button></div>
  </div>
</form>
<!-- #3521: preenchido via JS (fetch a /vote + DOMParser, mesmo padrão de
     /jogar) com o '.msg' de resultado + '#jogar-share-card', sem sair do
     widget. fetch() NÃO é navegação — não é afetado pelo
     'frame-ancestors: none' que /vote carrega (ver item 4 do header). -->
<div id="embed-result-slot" hidden></div>
<div id="embed-already" class="already" hidden></div>
<div id="embed-subscribe-cta" class="subscribe-cta" hidden>
  <p class="subscribe-text">Gostou? Um par novo desses todo dia na sua caixa de entrada, além das 3 notícias de IA mais importantes. Grátis.</p>
  <a class="subscribe-btn" href="${htmlEscape(subscribeUrl)}" target="_blank" rel="noopener">Assinar a Diar.ia</a>
</div>

<p class="widget-footer"><a href="${htmlEscape(jogarUrl)}" target="_blank" rel="noopener">Jogar mais em ${PUBLIC_GAME_DISPLAY_HOST} →</a></p>

<script>
(function () {
  // #3521: par de hoje pode ainda não estar pronto — mesma disciplina de
  // /jogar (jogar.ts): QUALQUER imagem falhando substitui o bloco inteiro
  // por aviso, nunca deixa o visitante votando às cegas com ícone quebrado.
  var choicesFailed = false;
  function onImgError() {
    if (choicesFailed) return;
    choicesFailed = true;
    var choices = document.getElementById("embed-choices");
    if (choices) choices.innerHTML = "<p>O par de hoje ainda não está pronto — volte mais tarde.</p>";
  }
  var imgA0 = document.getElementById("embed-img-a");
  var imgB0 = document.getElementById("embed-img-b");
  if (imgA0) imgA0.addEventListener("error", onImgError);
  if (imgB0) imgB0.addEventListener("error", onImgError);

  // #3521 (item 5 do header): identidade anônima via localStorage
  // best-effort, SEM cookie (cookie SameSite=Lax é código morto garantido
  // num iframe cross-site — ver rationale completo no header do arquivo).
  // Qualquer falha de storage (particionado/bloqueado) cai num token
  // efêmero em memória — o voto ainda funciona nesta visita, sem erro.
  var STORAGE_KEY = "eia_embed_token";
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function getOrCreateToken() {
    try {
      var existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      var fresh = uuid();
      window.localStorage.setItem(STORAGE_KEY, fresh);
      return fresh;
    } catch (e) {
      // Storage bloqueado/particionado sem persistência — token efêmero,
      // válido só pra esta visita. "Joga sem ranking (sem erro)".
      return uuid();
    }
  }

  var edition = ${JSON.stringify(edition)};
  var token = getOrCreateToken();
  var email = token + "@web.eia.diaria.local";
  var emailInput = document.getElementById("embed-email");
  if (emailInput) emailInput.value = email;

  // #3521: "já votou" é só UX local best-effort (mesma disciplina de
  // /jogar) — dedup REAL continua no Durable Object VoteDedup do Worker.
  var votedKey = "eia_embed_voted_" + edition;
  var already = null;
  try { already = window.localStorage.getItem(votedKey); } catch (e) {}
  var form = document.getElementById("embed-form");
  var alreadyBox = document.getElementById("embed-already");
  var subscribeCta = document.getElementById("embed-subscribe-cta");
  if (already && form && alreadyBox) {
    form.hidden = true;
    alreadyBox.hidden = false;
    alreadyBox.textContent = "Você já votou na edição de hoje (escolha: " + already + ").";
    if (subscribeCta) subscribeCta.hidden = false;
  } else if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var choice = ev.submitter && ev.submitter.value;
      if (!choice) { form.submit(); return; } // sem ev.submitter: target=_blank cobre o fallback nativo
      try { window.localStorage.setItem(votedKey, choice); } catch (e) {}

      var params = new URLSearchParams();
      params.set("edition", edition);
      params.set("brand", ${JSON.stringify(EMBED_BRAND)});
      params.set("email", email);
      params.set("choice", choice);
      var voteUrl = "/vote?" + params.toString();
      var resultSlot = document.getElementById("embed-result-slot");

      // #3521 (item 4 do header, achado de self-review CORRIGIDO): NUNCA
      // navegar o próprio iframe pra voteUrl (window.location.href) — /vote
      // carrega 'frame-ancestors: none' (ver applyFrameDenyHeaders,
      // index.ts) e o browser bloquearia a renderização dentro deste
      // iframe, deixando o widget em branco. O fallback abre em nova aba
      // (contexto de nível superior, imune a frame-ancestors) via link
      // clicável — nunca auto-navega (window.open() chamado fora do gesto
      // síncrono do clique seria bloqueado como popup pela maioria dos
      // browsers de qualquer forma).
      function fallbackLink() {
        if (!resultSlot) return;
        resultSlot.innerHTML = '<p class="result-msg fallback-link">Não deu pra carregar o resultado aqui — <a href="' + voteUrl + '" target="_blank" rel="noopener">veja seu resultado</a>.</p>';
        resultSlot.hidden = false;
        form.hidden = true;
      }

      if (!resultSlot || typeof window.fetch !== "function" || typeof DOMParser === "undefined") {
        fallbackLink();
        return;
      }

      fetch(voteUrl).then(function (res) {
        return res.text();
      }).then(function (html) {
        var parsed = new DOMParser().parseFromString(html, "text/html");
        var msgEl = parsed.querySelector(".msg");
        var shareCardEl = parsed.querySelector("#jogar-share-card");
        if (!msgEl && !shareCardEl) { fallbackLink(); return; }
        var out = "";
        if (msgEl) out += '<p class="result-msg">' + msgEl.innerHTML + "</p>";
        if (shareCardEl) out += shareCardEl.outerHTML;
        resultSlot.innerHTML = out;
        resultSlot.hidden = false;
        form.hidden = true;
        if (subscribeCta) subscribeCta.hidden = false;
      }).catch(fallbackLink);
    });
  }
})();
</script>
${shareButtonScript("#embed-result-slot")}
</body>
</html>`;
}

/**
 * Handler `GET /embed` (#3521). `env` CRU (não `bEnv`) — mesmo padrão de
 * `handleJogarPage`: lê `correct:{edition}` compartilhado (fato público),
 * voto/score/nickname passam pelos endpoints normais com `?brand=web`.
 * `Content-Security-Policy: frame-ancestors ...` é o header que TORNA a
 * rota embutível dentro da allowlist configurada — ver item 2 do header do
 * arquivo. Deliberadamente SEM `X-Frame-Options` aqui (só suporta 1 domínio
 * — emiti-lo bloquearia embutimento em qualquer allowlist com >1 origem;
 * browsers modernos usam CSP `frame-ancestors` quando presente, browsers
 * legados sem suporte a CSP simplesmente não aplicam restrição nenhuma
 * nesta rota — trade-off aceito, o objetivo desta rota é EXATAMENTE ser
 * embutível).
 */
export async function handleEmbedPage(url: URL, env: Env): Promise<Response> {
  const edition = resolveJogarEdition(url.searchParams.get("edition"), new Date());
  const partnerSlug = resolveEmbedPartnerSlug(url.searchParams.get("partner"));
  const correctRaw = await env.POLL.get(`correct:${edition}`);
  const csp = buildFrameAncestorsCsp(env.EMBED_ALLOWED_ORIGINS);
  return new Response(renderEmbedPageHtml({ edition, revealed: correctRaw !== null, partnerSlug }), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "public, max-age=120",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
