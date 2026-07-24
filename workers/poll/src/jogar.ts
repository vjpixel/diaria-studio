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
// #3520: `json`/`corsHeaders` (valores, não só tipo) — mesmo padrão de
// import circular já em produção em vote.ts (`import { hmacSign, hmacVerify,
// json, ... } from "./index"` + index.ts importa `handleVote` de volta de
// vote.ts). Seguro porque nenhum dos dois módulos usa o valor importado no
// top-level, só dentro de corpos de função executados em request-time
// (bindings vivos do ESM resolvem o ciclo).
import { corsHeaders, json } from "./index";
import {
  AAMMDD_RE,
  BRAND_INFO,
  buildBrandSiteUrl, // #3978: href com UTM do funil "É IA?" → site (CTA + footers "Voltar")
  formatEditionDate,
  htmlEscape,
  isValidVoteEmailFormat, // #3595: valida o pseudo-email recebido por /jogar/seq-state
  isValidWebToken, // #3976: /jogar/seq-state é exclusivo do brand `web` — token deve ser UUID v4
  leaderboardHref,
  renderBrandFooter,
  renderBrandShellStyles,
  renderSeoMeta,
  SUBSCRIBE_UTM_SOURCE, // #3978: fonte única de verdade movida pra lib.ts — reexportada abaixo por back-compat
  todayAammddBrt,
} from "./lib";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";
// #3517: share card pós-jogo — script de wiring dos botões (Web Share API +
// fallback copiar-link) reusado LITERALMENTE do mesmo helper que
// votePageHtml (index.ts) usa pro bloco renderizado direto, só com um
// container selector diferente. Rationale completo em share.ts.
// #3520: encodeQuizShareToken/renderQuizShareCardBlock — mesmo motor,
// payload/rotas próprios do quiz relâmpago (rationale em share.ts).
import { encodeQuizShareToken, renderQuizShareCardBlock, shareButtonScript, type QuizSharePayload } from "./share";
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
 *
 * #3978: `SUBSCRIBE_UTM_SOURCE` mudou de declaração LOCAL pra reexport de
 * `lib.ts` (fonte única de verdade — `buildBrandSiteUrl`/`share.ts` também
 * precisam do mesmo valor). Reexportado aqui por back-compat: `subscribe.ts`
 * historicamente importa este binding de `./jogar`.
 */
export { SUBSCRIBE_UTM_SOURCE };
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
 * Pure (#3589, rework do #3518): a "caixa do meio" pós-voto — decisão do
 * editor (review 260716, #3589 item 4): deixa de EMPURRAR assinatura (função
 * redundante com o form inline #3580, que já é a conversão primária) e passa
 * a convidar o visitante a CONHECER o projeto Diar.ia — link pro site
 * (`BRAND_INFO.web.siteUrl`), NÃO pro subscribe do Beehiiv.
 *
 * `buildSubscribeUrl`/`SUBSCRIBE_UTM_SOURCE` acima NÃO foram removidos por
 * esta mudança — continuam em uso por dois outros callers que este rework
 * não toca: (a) `subscribe.ts` importa `SUBSCRIBE_UTM_SOURCE` como o
 * `utm_source` real do form inline (#3580) — a atribuição de conversões
 * `eia-standalone` continua idêntica; (b) `renderArchiveSubscribeReinforcement`
 * (arquivo, #3524) segue linkando pro subscribe Beehiiv — reforço de um
 * fluxo diferente (índice do arquivo, sempre visível, não gated por voto),
 * fora do escopo desta issue.
 *
 * `hidden` por padrão no HTML estático: revelado via JS só depois do
 * voto/rodada (nunca antes — mesma disciplina anti-spoiler do resto da
 * página). `target="_blank"` — não perder o estado do jogo ao navegar pro
 * site.
 *
 * #3978: href passa a carregar UTM (`buildBrandSiteUrl`, medium
 * "posvoto-cta") — antes ia pro site SEM parâmetro nenhum (achado #3978,
 * único CTA de saída do funil sem nenhuma medição).
 */
export function renderSubscribeCtaBlock(): string {
  const url = buildBrandSiteUrl(JOGAR_BRAND, "posvoto-cta", "eia-jogar-conhecer");
  return `<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>
  <p class="subscribe-text">Quer entender o que a Diar.ia faz? Conheça o projeto.</p>
  <a class="subscribe-btn" href="${htmlEscape(url)}" target="_blank" rel="noopener">Conhecer a Diar.ia</a>
</div>`;
}

// ── CTA de assinatura do quiz relâmpago (#3579, divulgação — enhancement do
// #3520) ──────────────────────────────────────────────────────────────────
//
// UTM PRÓPRIO (medium/campaign distintos do CTA pós-voto de par único acima,
// mesma disciplina de "funil distingue origem" do #3524/#3521/#3518) — mede
// separadamente quantos assinantes vêm do quiz (várias rodadas, mais
// engajamento) vs. do jogo de par único. `utm_source` continua
// `eia-standalone` (mesma convenção de `count-subscriptions-by-utm.ts`).
export const QUIZ_SUBSCRIBE_UTM_SOURCE = "eia-standalone";
export const QUIZ_SUBSCRIBE_UTM_MEDIUM = "quiz";
export const QUIZ_SUBSCRIBE_UTM_CAMPAIGN = "eia-quiz-posvoto";

/**
 * Pure (#3579): URL de assinatura com UTM próprio do funil do quiz relâmpago
 * — mesmo destino (`diaria.beehiiv.com`) do `buildSubscribeUrl` (#3518), UTM
 * distinto pra medir o quiz separadamente.
 */
export function buildQuizSubscribeUrl(): string {
  const params = new URLSearchParams({
    utm_source: QUIZ_SUBSCRIBE_UTM_SOURCE,
    utm_medium: QUIZ_SUBSCRIBE_UTM_MEDIUM,
    utm_campaign: QUIZ_SUBSCRIBE_UTM_CAMPAIGN,
  });
  return `https://diaria.beehiiv.com/?${params.toString()}`;
}

/**
 * Pure (#3579): bloco HTML do CTA de assinatura no resultado final do quiz
 * relâmpago — copy própria do editor (review 260716), distinta do CTA
 * genérico pós-voto de par único (`renderSubscribeCtaBlock`). Enquadra as
 * imagens do quiz como o arquivo de edições passadas da Diar.ia (o jogador
 * acabou de jogar vários pares de edições anteriores em sequência, contexto
 * que o CTA genérico não menciona) e convida pra assinatura. Mesmo `id`/
 * `class`/mecânica `hidden` de `renderSubscribeCtaBlock` — o JS do quiz
 * (`renderJogarQuizPageHtml`) já revela via `getElementById("jogar-subscribe-cta")`
 * em `showFinal()`, sem precisar de nenhuma mudança no script (anti-spoiler
 * preservado: nunca aparece antes do fim do quiz).
 */
export function renderQuizSubscribeCtaBlock(): string {
  const url = buildQuizSubscribeUrl();
  return `<div id="jogar-subscribe-cta" class="subscribe-cta" hidden>
  <p class="subscribe-text">Essas imagens são do arquivo de edições passadas da Diar.ia. Quer receber notícias de IA, tutoriais pra usar no dia a dia e um par desses todo dia? Assine a Diar.ia (grátis).</p>
  <a class="subscribe-btn" href="${htmlEscape(url)}" target="_blank" rel="noopener">Assinar a Diar.ia</a>
</div>`;
}

// ── #3580: cadastro INLINE pós-jogo (nome + e-mail + opt-in → assina direto) ─
//
// Evolução do funil #3518 (que só linkava pro Beehiiv): o visitante assina a
// newsletter SEM sair da página, via `POST /jogar/subscribe` (ver subscribe.ts
// pro mecanismo/anti-abuso). COMPLEMENTA — não remove — o CTA-link do #3518
// (`#jogar-subscribe-cta`, contrato coberto por poll-jogar-cta-3518.test.ts):
// o form é a conversão primária (direta), o link continua como fallback pra
// quem prefere a página hospedada da Beehiiv. Mesma disciplina anti-spoiler:
// `hidden` no HTML estático, revelado via JS SÓ junto com o resultado do voto
// (nunca antes). Opt-in é o consentimento LGPD explícito; honeypot (`website`)
// é o campo invisível anti-bot.

/**
 * Pure (#3580): bloco do form de cadastro inline. `hidden` por padrão (mesma
 * disciplina do CTA-link). `novalidate` — a validação real é server-side
 * (subscribe.ts) + uma checagem leve no JS pra UX; não dependemos da validação
 * nativa do browser (inconsistente entre navegadores). Honeypot: `.signup-hp`
 * fica fora da tela via CSS + `aria-hidden` + `tabindex="-1"` + `autocomplete
 * ="off"` — humano nunca vê/preenche; bot que preenche é descartado no
 * servidor.
 */
export function renderInlineSignupFormBlock(): string {
  return `<form id="jogar-signup-form" class="signup-form" hidden novalidate>
  <p class="signup-text">Prefere direto? Assine aqui — sem sair da página.</p>
  <label class="signup-field"><span>Nome</span><input type="text" name="name" autocomplete="name" maxlength="100"></label>
  <label class="signup-field"><span>E-mail</span><input type="email" name="email" autocomplete="email" maxlength="254" required></label>
  <div class="signup-hp" aria-hidden="true"><label>Deixe em branco<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <label class="signup-optin"><input type="checkbox" name="optin" value="on"> Quero receber a Diar.ia — notícias de IA + tutoriais + um par desses todo dia.</label>
  <button type="submit" class="signup-btn">Assinar a Diar.ia (grátis)</button>
  <p class="signup-status" role="status" aria-live="polite" hidden></p>
</form>`;
}

/**
 * Pure (#3580): CSS do form inline — reusa o visual de `.subscribe-cta`
 * (fundo paperAlt, cantos arredondados) + campos/botão em tokens do DS
 * (test/poll-ds-tokens.test.ts trava hardcode). Fatorado numa função porque
 * as DUAS páginas (`/jogar` e `/jogar/quiz`) embutem o form e precisam do mesmo
 * bloco de estilo.
 */
export function renderInlineSignupFormStyles(): string {
  return `  /* #3580: form de cadastro inline pós-jogo */
  .signup-form { margin: 20px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; text-align: left; }
  .signup-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .signup-field { display: block; margin: 0 0 10px 0; font-size: 0.85rem; font-family: ${DS_FONTS.sans}; }
  .signup-field span { display: block; margin-bottom: 4px; font-weight: 600; }
  .signup-field input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid ${DS_COLORS.rule}; border-radius: 4px; font-size: 1rem; font-family: ${DS_FONTS.sans}; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  .signup-optin { display: block; margin: 4px 0 14px 0; font-size: 0.9rem; font-family: ${DS_FONTS.sans}; line-height: 1.4; }
  .signup-optin input { margin-right: 8px; }
  .signup-btn { display: block; width: 100%; box-sizing: border-box; padding: 12px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .signup-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .signup-status { margin: 10px 0 0 0; font-size: 0.9rem; font-family: ${DS_FONTS.sans}; }
  .signup-status.ok { color: ${DS_COLORS.brand}; }
  .signup-status.err { color: ${DS_COLORS.ink}; font-weight: 600; }
  .signup-hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; overflow: hidden; }`;
}

/**
 * Pure (#3580): script (IIFE) que faz o wiring do submit do form inline —
 * intercepta o submit, valida leve (opt-in marcado + e-mail com `@`), POSTa
 * JSON pra `/jogar/subscribe` e mostra status inline. NÃO revela o form (a
 * revelação é feita pelas duas páginas junto com o resultado, mesma disciplina
 * do CTA-link). No-op se o form não existir. Reusado LITERALMENTE por
 * `/jogar` e `/jogar/quiz` (por isso é uma função — 1 fonte de verdade).
 */
export function inlineSignupScript(): string {
  return `<script>
(function () {
  var form = document.getElementById("jogar-signup-form");
  if (!form) return;
  var status = form.querySelector(".signup-status");
  function setStatus(msg, ok) {
    if (!status) return;
    status.hidden = false;
    status.textContent = msg;
    status.className = "signup-status" + (ok ? " ok" : " err");
  }
  function val(sel) { var el = form.querySelector(sel); return el ? el.value : ""; }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var optin = form.querySelector('input[name="optin"]');
    if (!optin || !optin.checked) { setStatus("Marque a caixinha de consentimento pra assinar.", false); return; }
    var email = (val('input[name="email"]') || "").trim();
    if (!email || email.indexOf("@") < 0) { setStatus("Digite um e-mail válido.", false); return; }
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    setStatus("Enviando…", true);
    var payload = {
      name: (val('input[name="name"]') || "").trim(),
      email: email,
      optin: true,
      website: val('input[name="website"]') || ""
    };
    if (typeof window.fetch !== "function") {
      setStatus("Seu navegador não suporta o cadastro direto — use o link de assinatura acima.", false);
      if (btn) btn.disabled = false;
      return;
    }
    window.fetch("/jogar/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().then(function (d) { return { status: res.status, body: d }; }, function () { return { status: res.status, body: null }; });
    }).then(function (r) {
      if (r.status === 200 && r.body && r.body.ok) {
        form.reset();
        setStatus("Pronto! Confira seu e-mail pra confirmar a assinatura.", true);
        var fields = form.querySelectorAll("input, button");
        for (var i = 0; i < fields.length; i++) fields[i].disabled = true;
      } else if (r.status === 429) {
        setStatus("Muitas tentativas. Tente de novo mais tarde.", false);
        if (btn) btn.disabled = false;
      } else if (r.status === 503) {
        setStatus("Cadastro direto indisponível agora — use o link de assinatura acima.", false);
        if (btn) btn.disabled = false;
      } else {
        setStatus("Não deu pra assinar agora. Confira o e-mail e tente de novo.", false);
        if (btn) btn.disabled = false;
      }
    }).catch(function () {
      setStatus("Erro de conexão. Tente de novo.", false);
      if (btn) btn.disabled = false;
    });
  });
})();
</script>`;
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
    brand: JOGAR_BRAND,
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
  /* #3607: aspect-ratio reserva o box na proporção 16:9 (800x450, mesma das
     imagens do É IA) ANTES do load — combinado com os atributos width/height
     nos <img> (reforço, cobre browser que ignora aspect-ratio), evita o
     colapso de altura que causava o layout shift reportado pelo editor. */
  .choice img { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: 6px; display: block; background: ${DS_COLORS.paperAlt}; }
  .choice button { margin-top: 8px; width: 100%; padding: 10px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .choice button:disabled { opacity: 0.5; cursor: not-allowed; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .already { margin: 24px auto; padding: 16px 18px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; font-size: 0.95rem; }
  .scroll-hint { display: none; }
  #jogar-form[hidden], #jogar-already[hidden], #jogar-result-slot[hidden], #jogar-subscribe-cta[hidden], #jogar-signup-form[hidden] { display: none; }
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
${renderInlineSignupFormStyles()}
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
    .share-card { max-width: 100%; padding: 20px 18px; }
    .share-actions { flex-direction: column; }
    .share-actions button { width: 100%; padding: 14px 16px; font-size: 1.05rem; }
    .subscribe-cta { max-width: 100%; padding: 20px 18px; }
    .subscribe-btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 1.05rem; }
    .signup-form { max-width: 100%; padding: 20px 18px; }
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
    <div class="choice"><img id="jogar-img-a" src="${imgA}" width="800" height="450" alt="Imagem A" loading="lazy"><button type="submit" name="choice" value="A">Essa é a IA</button></div>
    <p class="scroll-hint">↓ Veja também a Imagem B antes de decidir</p>
    <div class="choice"><img id="jogar-img-b" src="${imgB}" width="800" height="450" alt="Imagem B" loading="lazy"><button type="submit" name="choice" value="B">Essa é a IA</button></div>
  </div>
</form>
<!-- #3517: preenchido via JS (fetch a /vote + DOMParser) com o '.msg' de
     resultado + o bloco '#jogar-share-card' (mesma estrutura de
     renderShareCardBlock, share.ts) — sem sair da página. Fallback pra
     navegação nativa (window.location.href) em qualquer falha de rede. -->
<div id="jogar-result-slot" hidden></div>
<div id="jogar-already" class="already" hidden></div>
<!-- #3580: cadastro INLINE (nome + e-mail + opt-in) — conversão primária,
     assina direto sem sair da página. Revelado via JS junto com o resultado
     (mesma disciplina anti-spoiler). Vem ANTES do CTA-link (fallback #3518). -->
${renderInlineSignupFormBlock()}
<!-- #3518: CTA de assinatura — estático (SEM dado de servidor, ao contrário
     do result-slot/share-card), revelado via JS junto com o resultado (voto
     novo OU repetido, ver script abaixo). Nunca antes do voto (mesma
     disciplina anti-spoiler do resto da página). Complementado pelo form
     inline acima (#3580) — segue como fallback pra página hospedada. -->
${renderSubscribeCtaBlock()}

<!-- #3589: link do arquivo removido daqui — /jogar (visão default, sem
     ?edition=) agora É a sequência do mês anterior; o par individual
     servido por esta função só existe pra ?edition= explícito (ponte
     clarice/#3524, ver handleJogarPage). A rota /jogar/arquivo continua
     viva (destino dessa ponte), só não é mais auto-promovida em NENHUMA
     view web (issue #3589 item 3). -->
<p class="footer-links"><a href="${htmlEscape(buildBrandSiteUrl(JOGAR_BRAND, "jogar-footer", "eia-jogar-footer"))}">← Voltar para a ${htmlEscape(info.name)}</a> &nbsp;|&nbsp; <a href="${leaderboardLink}">Ver leaderboard</a></p>
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
  // #3580: form de cadastro inline — revelado junto com o CTA-link, mesma
  // disciplina anti-spoiler (nunca antes do voto). Lido 1x, reusado nos 2
  // caminhos (voto novo e já-votou).
  var signupForm = document.getElementById("jogar-signup-form");
  if (already && form && alreadyBox) {
    form.hidden = true;
    alreadyBox.hidden = false;
    alreadyBox.textContent = "Você já votou na edição de hoje (escolha: " + already + "). Resultado na página do seu voto ou no leaderboard.";
    if (subscribeCta) subscribeCta.hidden = false;
    if (signupForm) signupForm.hidden = false;
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
        // #3580: form de cadastro inline — mesmo timing.
        if (signupForm) signupForm.hidden = false;
      }).catch(fallbackNativeNav);
    });

    // #3517: delegação de clique pro(s) botão(ões) de compartilhamento
    // injetado(s) dinamicamente acima — mesmo script reusado por votePageHtml
    // (index.ts) pro card renderizado direto em /vote, ver share.ts.
  }
})();
</script>
${shareButtonScript("#jogar-result-slot")}
${inlineSignupScript()}
</body>
</html>`;
}

// ── #3589: /jogar VIRA a sequência do mês anterior ──────────────────────────
//
// Rework do EPIC #3514 — feedback do editor no review do deploy (260716):
// o modelo mental final dos 3 É IAs distingue diário (email, 1 par/dia),
// mensal (email/clarice, vota meses anteriores) e WEB (ação RELÂMPAGO,
// divulgada em momentos específicos — NUNCA "o par de hoje"). O web é
// SEMPRE uma sequência: os pares do MÊS COMPLETO ANTERIOR, jogados em
// ordem, com % de acerto + entrada no leaderboard MENSAL (`BRAND_INFO.web`
// já é `leaderboardPeriod: "month"` desde #3516 — zero mudança ali).
//
// Decisões de design (ver PR #3589 para rationale completo):
//
//   1. **Mecânica reaproveitada do quiz relâmpago (#3520)**: mesmo shell de
//      rodadas sequenciais (`renderJogarQuizPageHtml`) — progress bar, 1 par
//      por vez, resultado de rodada, tela final com share. DIFERENÇA
//      CRÍTICA: o quiz (`/jogar/quiz`) é 100% client-side/sem side-effect
//      (não grava no KV, não conta pro ranking — ver header de share.ts) —
//      a sequência da issue #3589 PRECISA contar pro leaderboard mensal
//      ("entra no ranking"), então cada rodada AQUI chama o `/vote` REAL
//      (mesmo endpoint que o par único sempre usou), com o mesmo token
//      anônimo (`anonEmailForToken`) reusado em todas as rodadas — cada
//      edição do mês vira um voto de verdade, dedup/streak/score
//      inalterados (mesmo DO VoteDedup, mesmo `score:{email}` do resto do
//      produto).
//
//   2. **Fonte dos pares**: `correct:{edition}` do MÊS DE CONTEÚDO anterior
//      ao mês corrente (BRT) — reusa o mesmo filtro de forma/futuro de
//      `extractEditionsForYear` (leaderboard-routes.ts, #2867/#3519), só
//      recortado pelo mês em vez do ano inteiro. Ordem CRESCENTE
//      (cronológica) — joga-se a sequência na ordem em que foi publicada.
//
//   3. **Streak (#3522) — decisão "rethink" (avaliado, não removido do
//      backend)**: o streak (`score:{email}.streak`) já é calculado com a
//      MESMA cadência "month" pra diaria/web (`nextWeekdayAammdd`) — como a
//      sequência aqui vota em ordem cronológica através de dias úteis
//      consecutivos, o streak semanticamente CONTINUA correto (cada edição
//      É o próximo dia útil da anterior, dentro do mês) — mesmo mecanismo
//      já validado pelo brand `web` jogando o arquivo edição-a-edição
//      (test/poll-streak-3522.test.ts, describe "streak via /vote — brand=
//      web"). O que MUDARIA de sentido é EXIBIR "🔥 N dias seguidos" depois
//      de uma sequência inteira jogada numa única sentada (o texto sugere
//      cadência diária real de uso, não replay em lote). Resolução: o
//      backend/KV não muda (zero risco pro resto do produto que depende de
//      streak) — a UI da sequência simplesmente NÃO exibe o texto bruto de
//      `.msg` por rodada (mesmo padrão que o quiz relâmpago JÁ usa — o quiz
//      nunca mostrou streak/stats, mesmo antes desta issue), evitando a
//      leitura confusa sem tocar no modelo de dados. Se o editor quiser
//      reconsiderar streak no nível de dado (não só de exibição) pro brand
//      web, é um follow-up isolado (P3, cosmético/produto).
//
//   4. **Caixa do meio → descoberta** (item 4 da issue): `renderSubscribeCtaBlock`
//      (rework do #3518, ver acima) já muda pra convite "conhecer o
//      projeto" — reusado aqui sem alteração adicional.
//
//   5. **Par único preservado só via `?edition=` explícito** (não é mais o
//      default): a ponte clarice→arquivo (#3524/#3578, `votePageHtml` linka
//      "Jogar edições passadas" pra `/jogar/arquivo`, que por sua vez linka
//      pra `/jogar?edition=X`) continua funcionando sem nenhuma mudança —
//      `renderJogarPageHtml`/`resolveJogarEdition` seguem intactos, só não
//      são mais o comportamento DEFAULT de `GET /jogar` sem parâmetro.
//
//   6. **`/jogar/arquivo` NÃO foi deletado** — desvio deliberado e
//      documentado da issue #3589 item 3 ("deletar /jogar/arquivo... rota
//      some"). A issue escopa as mudanças "só brand web" — mas o MESMO
//      route é o destino da ponte clarice→arquivo (#3524/#3578, reconfirmada
//      pelo editor no MESMO dia 260716 desta issue, ver
//      test/eia-cross-canal-3524.test.ts). Deletar a rota quebraria essa
//      ponte silenciosamente — regressão não-documentada de uma feature
//      fora do escopo desta issue. Resolução: a rota continua servindo
//      (compat com a ponte clarice), mas deixa de ser um "feature web"
//      auto-promovido — nenhuma view web (`/jogar` default OU `?edition=`)
//      linka mais pra ela (ver remoção do link "Jogar edições passadas" no
//      footer de `renderJogarPageHtml` acima). Se o editor quiser a
//      remoção literal (inclusive pra clarice), é uma decisão de #3524 a
//      parte — flagged aqui pro editor decidir.
//
//   7. **`/jogar/quiz` intocado**: mecanismo distinto e complementar (casual,
//      random, sem crédito de leaderboard) — a sequência oficial da issue
//      #3589 não o substitui nem reusa sua rota, só o PADRÃO de UI/JS.
//
//   8. **Embed (#3521) intocado**: widget pra parceiros (Clarice.ai) segue
//      mostrando o par de HOJE (`resolveJogarEdition`, ainda exportado e
//      usado por `embed.ts`) — produto/superfície diferente (iframe de
//      terceiro), fora do escopo desta issue. Decisão: não mudar (a issue
//      pede pra "avaliar" — avaliado, mantido como está; rework do embed
//      pra sequência é follow-up isolado se o editor quiser).

/**
 * Pure (#3589): mês de CONTEÚDO anterior ao "hoje" (BRT), como `{yy, mm}`
 * (2 dígitos cada, mesma convenção AAMMDD). Usado só pra resolver a
 * sequência default de `/jogar` — nunca lança (entrada sempre um `Date`
 * válido).
 */
export function resolvePreviousCalendarMonth(now: Date): { yy: string; mm: string } {
  const today = todayAammddBrt(now);
  const yy = parseInt(today.slice(0, 2), 10);
  const mm = parseInt(today.slice(2, 4), 10);
  let prevMonth = mm - 1;
  let prevYearFull = 2000 + yy;
  if (prevMonth < 1) {
    prevMonth = 12;
    prevYearFull -= 1;
  }
  return { yy: String(prevYearFull % 100).padStart(2, "0"), mm: String(prevMonth).padStart(2, "0") };
}

/**
 * Pure (#3589): edições AAMMDD FECHADAS (gabarito definido) do mês de
 * CONTEÚDO imediatamente anterior a "hoje" (BRT), em ordem CRESCENTE
 * (cronológica — a ordem em que a sequência é jogada). Reusa
 * `extractEditionsForYear` (leaderboard-routes.ts, #2867/#3519) pra herdar
 * o mesmo filtro de forma AAMMDD + exclusão de edição futura, recortando
 * pelo mês depois (a função original filtra só por ano). `correctKeyNames`
 * já deve vir da listagem `correct:*` do KV (caller decide o prefixo —
 * `handleJogarPage` usa o prefixo do mês pra economizar I/O de list).
 */
export function resolveJogarSequenceEditions(correctKeyNames: string[], now: Date = new Date()): string[] {
  const { yy, mm } = resolvePreviousCalendarMonth(now);
  const yearEditions = extractEditionsForYear(correctKeyNames, `20${yy}`, now); // DESC, já filtra forma/futuro
  return yearEditions.filter((ed) => ed.slice(2, 4) === mm).sort(); // ASC — ordem de jogo
}

// ── #3595: rework "Suspense" + skip-and-credit (feedback do editor 260716) ──
//
// Segundo review do editor sobre a sequência web (#3589), no mesmo dia do
// deploy. TRÊS mudanças:
//
//   1. Rótulo dos botões some o sufixo "(A)"/"(B)" — a posição embaixo de
//      cada imagem já identifica a escolha; `data-choice`/`value` internos
//      (o que de fato vai pro /vote) são intocados.
//
//   2. Modelo "Suspense": cada clique avança IMEDIATAMENTE pro próximo par
//      (sem esperar a resposta do /vote) — o /vote roda em BACKGROUND
//      (`voteInBackground` no script de `renderJogarSequencePageHtml`) e o
//      resultado por rodada NUNCA é revelado (sem "Acertou!/Errou" no meio —
//      só a tela final, depois de `Promise.all(pending)`, mostra o placar +
//      quais pares foram errados).
//
//   3. Skip-and-credit: o bug visto pelo editor era um token que já tinha
//      votado (por outro caminho/sessão) ver "já votou" em TODOS os pares —
//      a sequência re-tentava votar em edições já respondidas. Fix: um
//      endpoint novo (`GET /jogar/seq-state`) reporta, PRA CADA edição
//      pedida, se este token já votou e (só nesse caso, anti-spoiler) se
//      acertou — reusando a MESMA chave `vote:{edition}:{email}` que
//      `handleVote`/`buildAlreadyVotedResponse` (vote.ts) já leem/escrevem,
//      zero esquema novo de persistência. O <script> consulta esse endpoint
//      ANTES de montar a play list: edições já votadas nunca são rejogadas
//      (pré-creditadas se corretas, marcadas como erro conhecido se não), e
//      a play list vira só as NÃO votadas. `?reset=1` em `/jogar` limpa a
//      identidade anônima local (token+cookie) pra permitir re-testar do
//      zero (só client-side — votos antigos no servidor não são apagados).
//
// `computeSeqSkipAndCredit`/`parseSeqStateEditionsParam` abaixo são os
// gêmeos TS puros e testáveis da lógica de skip-and-credit — o <script>
// inline de `renderJogarSequencePageHtml` (`startGame`) reimplementa a MESMA
// lógica em JS literal (não há bundler no worker pra reusar o TS em runtime
// de browser); qualquer mudança num lado precisa ser espelhada no outro
// (mesma disciplina já documentada pra `resolveQuizResultParams` vs. uso
// client em `showFinal`).

/** Estado de voto de UMA edição pro token consultante, tal como devolvido
 * por `GET /jogar/seq-state` — ver `handleJogarSeqState`. */
export interface SeqStateEntry {
  edition: string;
  voted: boolean;
  /** Anti-spoiler: só populado (não-null) quando `voted === true`. */
  correct: boolean | null;
}

/**
 * Pure (#3595): dado o array de edições da sequência (ASC, mesma ordem que
 * `GET /jogar/seq-state` recebeu) + o `state` alinhado (mesmo índice),
 * calcula o plano de skip-and-credit — gêmeo testável da lógica embutida no
 * `<script>` de `renderJogarSequencePageHtml` (`startGame`, ver header da
 * seção acima). `state[i]` ausente/malformado é tratado como "não votado"
 * (nunca lança — mesma disciplina defensiva do resto de jogar.ts).
 */
export function computeSeqSkipAndCredit(
  editions: string[],
  state: Array<SeqStateEntry | null | undefined>,
): { playIndices: number[]; preCredited: number; knownWrongIndices: number[] } {
  const playIndices: number[] = [];
  const knownWrongIndices: number[] = [];
  let preCredited = 0;
  for (let i = 0; i < editions.length; i++) {
    const entry = state[i];
    if (entry?.voted) {
      if (entry.correct === true) preCredited++;
      else if (entry.correct === false) knownWrongIndices.push(i);
      // entry.correct === null && voted === true: voto sem gabarito ainda
      // conhecido no momento do voto original — não pré-credita nem soma
      // erro (edge case improvável pra edições já fechadas do mês anterior,
      // mas nunca lança/perde a edição — ela simplesmente não conta nem
      // pra score nem pra wrong list, igual a uma rodada nunca jogada).
    } else {
      playIndices.push(i);
    }
  }
  return { playIndices, preCredited, knownWrongIndices };
}

/**
 * Pure (#3595): parseia o CSV de edições recebido por
 * `GET /jogar/seq-state?editions=...` — só aceita AAMMDD válidos, ignora
 * silenciosamente qualquer item malformado/vazio (endpoint de suporte de
 * página pública — nunca 500 por um param malformado do próprio cliente,
 * mesma disciplina do resto de jogar.ts).
 */
export function parseSeqStateEditionsParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => AAMMDD_RE.test(s));
}

/**
 * Pure render (#3589): página `/jogar` DEFAULT — a sequência oficial do mês
 * anterior. Mirror estrutural de `renderJogarQuizPageHtml` (#3520, mesmo
 * shell de rodadas/progress/share), mas cada rodada vota DE VERDADE (chama
 * `/vote?brand=web`, ver rationale item 1 acima) em vez do endpoint
 * read-only `/jogar/quiz/answer`. `editions` já vem ordenada (ASC) do
 * caller (`handleJogarPage` → `resolveJogarSequenceEditions`).
 *
 * `editions.length === 0` (ex: 1º mês do produto, sem mês anterior fechado
 * ainda) → mensagem amigável com link pro quiz relâmpago (alternativa
 * imediata, mesmo padrão de `renderJogarQuizPageHtml`'s emptyStateHtml).
 */
export function renderJogarSequencePageHtml(editions: string[]): string {
  const info = BRAND_INFO[JOGAR_BRAND];
  const total = editions.length;
  const leaderboardLink = leaderboardHref(JOGAR_BRAND);
  const pageTitle = `É IA? — sequência do mês | ${info.name}`;
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `Jogue a sequência de pares do "É IA?" do mês anterior — acerte o máximo possível e entre no leaderboard mensal.`,
    path: "/jogar",
    brand: JOGAR_BRAND,
  });

  // Self-review #2038 (achado corrigido, não só comentado): esta função
  // originalmente duplicava "Ver leaderboard" (um par nesta mensagem +
  // outro no footer-links comum logo abaixo, fora do ternário) — mesmo
  // padrão de duplicação já presente em `renderJogarQuizPageHtml`'s próprio
  // `emptyStateHtml` (pré-existente, fora do escopo desta issue — não
  // tocado aqui). Fix aqui: `emptyStateHtml` some fica só com a mensagem;
  // o link alternativo pro quiz relâmpago é injetado no footer-links ÚNICO
  // e comum (ver `quizFallbackLink` mais abaixo).
  const emptyStateHtml = `<p class="sub">Ainda não há uma sequência fechada do mês anterior — volte em breve.</p>`;
  const quizFallbackLink = total === 0 ? ` &nbsp;|&nbsp; <a href="/jogar/quiz">Jogar o quiz relâmpago</a>` : "";

  // #3595 (rework "Suspense", feedback do editor 260716): cada rodada avança
  // IMEDIATAMENTE pro próximo par ao clicar — o /vote roda em BACKGROUND
  // (ver script abaixo) e o acerto/erro NUNCA é revelado por rodada (some o
  // bloco de resultado intermediário que existia aqui, `#seq-round-result` —
  // não há mais "Próximo", o avanço já É automático). Por isso a barra de
  // progresso mostra só "Par X de N" (sem "acertos: Y" incremental — mostrar
  // um contador que atualiza de forma assíncrona conforme os votos em
  // background respondem vazaria parcialmente o resultado de rodadas
  // anteriores enquanto o leitor já está jogando outras). O placar completo
  // só aparece na tela final, após `Promise.all(pending)`.
  const bodyHtml = total === 0 ? emptyStateHtml : `<p class="sub" id="seq-progress">Carregando sequência…</p>

<noscript><p class="sub">A sequência precisa de JavaScript pra jogar. <a href="${leaderboardLink}">Ver leaderboard</a>.</p></noscript>

<div id="seq-play">
  <div class="choices" id="seq-choices"></div>
</div>

<div id="seq-final" class="quiz-final" hidden>
  <p class="result-msg seq-final-score"></p>
  <p class="sub seq-final-wrong" hidden></p>
  <div id="seq-share-slot" hidden></div>
</div>

${renderSubscribeCtaBlock()}
${renderInlineSignupFormBlock()}`;

  const scriptHtml = total === 0 ? "" : `<script>
(function () {
  var editions = ${JSON.stringify(editions)};
  var total = editions.length;

  var choicesEl = document.getElementById("seq-choices");
  var progressEl = document.getElementById("seq-progress");
  var playEl = document.getElementById("seq-play");
  var finalEl = document.getElementById("seq-final");
  var subscribeCta = document.getElementById("jogar-subscribe-cta");
  var signupForm = document.getElementById("jogar-signup-form"); // #3580

  // #3595: ?reset=1 (ou ?reset) — limpa a identidade anônima local (token +
  // cookie) + qualquer cache legado por edição (eia_web_seq_result_*, o
  // mecanismo de retomada client-side do #3589, substituído nesta revisão
  // pelo /jogar/seq-state servidor-autoritativo abaixo) ANTES de resolver o
  // token. Só client-side — votos antigos sob o token velho permanecem no
  // servidor; o objetivo é só permitir re-testar do zero (editor/QA).
  (function maybeReset() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    if (!params.has("reset")) return;
    try {
      window.localStorage.removeItem("eia_web_token");
      var toRemove = [];
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf("eia_web_seq_result_") === 0) toRemove.push(k);
      }
      for (var j = 0; j < toRemove.length; j++) window.localStorage.removeItem(toRemove[j]);
    } catch (e) {}
    document.cookie = "eia_web_token=; path=/; max-age=0; SameSite=Lax";
  })();

  // #3589 (mesmo mecanismo #3516): identidade anônima — token opaco (UUID)
  // em localStorage + cookie. Reusado em TODAS as rodadas — cada edição
  // vota de verdade via /vote, mesmo pseudo-email em todas.
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
  var token = getOrCreateToken();
  var email = token + "@web.eia.diaria.local";

  function imgUrl(edition, side) {
    return "/img/img-" + edition + "-01-eia-" + side + ".jpg";
  }

  // #3595 (skip-and-credit): preenchido só depois que /jogar/seq-state
  // responde (ver startGame abaixo, espelha computeSeqSkipAndCredit
  // exportado/testado em jogar.ts). playIndices = posições (0-based) em
  // editions que este token AINDA não votou — a play list real. Edições já
  // votadas nunca são rejogadas: preCredited soma as já corretas,
  // knownWrongIndices guarda as já erradas (ambas fora da play list).
  var playIndices = [];
  var preCredited = 0;
  var knownWrongIndices = [];
  var round = 0; // índice dentro de playIndices, NÃO de editions
  var results = {}; // originalIndex (string) -> true | false | null
  var pending = []; // promises do /vote em background — NUNCA rejeitam (ver voteInBackground)

  function updateProgress(originalIndex) {
    progressEl.textContent = "Par " + (originalIndex + 1) + " de " + total;
  }

  // #3607: aquece o cache do browser pras imagens do PRÓXIMO par ENQUANTO o
  // leitor ainda olha o par atual — não bloqueia nada (new Image() só
  // dispara o fetch, sem inserir no DOM), só faz a troca de par no
  // renderRound() seguinte ser cache-hit instantâneo em vez de piscar
  // branco/carregar do zero.
  function preloadRound(originalIndex) {
    if (originalIndex == null || originalIndex < 0 || originalIndex >= editions.length) return;
    var edition = editions[originalIndex];
    try {
      var imgA = new Image();
      imgA.src = imgUrl(edition, "A");
      var imgB = new Image();
      imgB.src = imgUrl(edition, "B");
    } catch (e) {}
  }

  function renderRound() {
    if (round >= playIndices.length) { showFinal(); return; }
    var originalIndex = playIndices[round];
    var edition = editions[originalIndex];
    updateProgress(originalIndex);
    // #3607: width/height reservam o box na proporção 16:9 (800x450, mesma
    // proporção das imagens do É IA) ANTES do load — combinado com
    // aspect-ratio: 16 / 9 no CSS '.choice img' (reforço pra browser que
    // ignorar os atributos), evita o colapso de altura que causava o layout
    // shift reportado pelo editor ao trocar de par via innerHTML.
    choicesEl.innerHTML =
      '<div class="choice"><img src="' + imgUrl(edition, "A") + '" width="800" height="450" alt="Imagem A" loading="lazy"><button type="button" class="seq-choice-btn" data-choice="A">Essa é a IA</button></div>' +
      '<p class="scroll-hint">↓ Veja também a Imagem B antes de decidir</p>' +
      '<div class="choice"><img src="' + imgUrl(edition, "B") + '" width="800" height="450" alt="Imagem B" loading="lazy"><button type="button" class="seq-choice-btn" data-choice="B">Essa é a IA</button></div>';
    // #3607: pré-carrega o PRÓXIMO par (se existir) — troca instantânea
    // (cache-hit) no próximo clique em vez de aguardar o fetch das novas
    // imagens.
    preloadRound(playIndices[round + 1]);
  }

  // #3595 (modelo "Suspense"): vota em BACKGROUND — 1 retry em falha de
  // rede, e NUNCA rejeita (resolve com null = "não pontuado") pra que
  // Promise.all(pending) na tela final nunca trave por causa de um /vote que
  // falhou. Parseia só o prefixo ✅/❌ de '.msg' — nunca exibe o texto bruto
  // do servidor (pode incluir sufixo de streak/stats, deliberadamente
  // suprimido nesta UI, mesma disciplina do #3589).
  function voteInBackground(voteUrl, attempt) {
    if (typeof window.fetch !== "function" || typeof DOMParser === "undefined") {
      // Sem fetch/DOMParser (browser muito antigo): não há como disparar o
      // /vote em background sem navegar a página inteira embora (o que
      // abandonaria a sequência) — trade-off aceito: esta rodada não é
      // registrada/pontuada nesse caso raro, mas o jogo nunca trava.
      return Promise.resolve(null);
    }
    return fetch(voteUrl).then(function (res) {
      return res.text();
    }).then(function (html) {
      var parsed = new DOMParser().parseFromString(html, "text/html");
      var msgEl = parsed.querySelector(".msg");
      var text = msgEl ? (msgEl.textContent || "") : "";
      if (text.indexOf("✅") === 0) return true;
      if (text.indexOf("❌") === 0) return false;
      return null; // ambíguo (já votado por outro caminho, etc.) — não pontua
    }).catch(function () {
      if (attempt < 1) return voteInBackground(voteUrl, attempt + 1);
      return null; // 2ª falha — segue sem pontuar esta rodada, nunca trava a tela final
    });
  }

  function advance() {
    round++;
    renderRound();
  }

  // #3595: clicar avança IMEDIATAMENTE pro próximo par (advance() síncrono
  // abaixo) — o /vote roda em background (voteInBackground) e só ajusta
  // results quando responder. Nenhum "Acertou!/Errou" por rodada — o
  // feedback só existe na tela final.
  function onChoice(choice) {
    var originalIndex = playIndices[round];
    var edition = editions[originalIndex];

    var params = new URLSearchParams();
    params.set("edition", edition);
    params.set("brand", ${JSON.stringify(JOGAR_BRAND)});
    params.set("email", email);
    params.set("choice", choice);
    var voteUrl = "/vote?" + params.toString();

    var voteDone = voteInBackground(voteUrl, 0).then(function (correct) {
      results[String(originalIndex)] = correct;
    });
    pending.push(voteDone);

    advance();
  }

  function showFinal() {
    if (playEl) playEl.hidden = true;
    finalEl.hidden = false;
    var scoreEl = finalEl.querySelector(".seq-final-score");
    var wrongEl = finalEl.querySelector(".seq-final-wrong");
    if (scoreEl) scoreEl.textContent = "Calculando placar…";
    // #3595: aguarda TODOS os votos em background terminarem (nunca
    // rejeitam, ver voteInBackground) antes de fechar o placar final —
    // "acertou/errou" só é revelado aqui, pós-jogo, nunca por rodada.
    Promise.all(pending).then(function () {
      var score = preCredited;
      var wrongIndices = knownWrongIndices.slice();
      for (var key in results) {
        if (!Object.prototype.hasOwnProperty.call(results, key)) continue;
        var idx = parseInt(key, 10);
        if (results[key] === true) score++;
        else if (results[key] === false) wrongIndices.push(idx);
      }
      wrongIndices.sort(function (a, b) { return a - b; });
      if (scoreEl) scoreEl.textContent = "Você acertou " + score + " de " + total + "!";
      if (wrongEl) {
        if (wrongIndices.length > 0) {
          var pairLabels = wrongIndices.map(function (i) { return i + 1; }).join(", ");
          wrongEl.textContent = "Errou nos pares " + pairLabels + ".";
          wrongEl.hidden = false;
        } else {
          wrongEl.hidden = true;
        }
      }
      var slot = document.getElementById("seq-share-slot");
      // #3589: reusa LITERALMENTE /jogar/quiz/result (#3520) — mesmo endpoint,
      // mesmo QuizSharePayload {score,total}, zero mudança em share.ts/handleQuizResult.
      fetch("/jogar/quiz/result?score=" + encodeURIComponent(String(score)) + "&total=" + encodeURIComponent(String(total)))
        .then(function (res) { if (!res.ok) throw new Error("result fetch failed"); return res.text(); })
        .then(function (html) {
          if (!slot) return;
          slot.innerHTML = html;
          slot.hidden = false;
        })
        .catch(function () {});
      if (subscribeCta) subscribeCta.hidden = false;
      if (signupForm) signupForm.hidden = false;
    });
  }

  choicesEl.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".seq-choice-btn") : null;
    if (!btn) return;
    onChoice(btn.getAttribute("data-choice"));
  });

  // #3595 (skip-and-credit, MUDANÇA 3): consulta /jogar/seq-state pra saber
  // quais edições este token JÁ votou (e se acertou) ANTES de montar a play
  // list — pares já respondidos nunca são rejogados (o bug visto pelo
  // editor: um token que já tinha votado via outro caminho via "já votou" em
  // TODOS os pares). Fail-open: qualquer falha de rede aqui faz a sequência
  // jogar do zero (playIndices = todas, sem pré-crédito) — nunca bloqueia.
  function startGame() {
    if (typeof window.fetch !== "function") {
      playIndices = editions.map(function (_, i) { return i; });
      renderRound();
      return;
    }
    var seqStateUrl = "/jogar/seq-state?email=" + encodeURIComponent(email) + "&editions=" + encodeURIComponent(editions.join(","));
    fetch(seqStateUrl).then(function (res) {
      if (!res.ok) throw new Error("seq-state fetch failed");
      return res.json();
    }).then(function (state) {
      var idx = [];
      for (var i = 0; i < editions.length; i++) {
        var entry = state[i];
        if (entry && entry.voted) {
          if (entry.correct === true) preCredited++;
          else if (entry.correct === false) knownWrongIndices.push(i);
        } else {
          idx.push(i);
        }
      }
      playIndices = idx;
      renderRound(); // playIndices vazio (tudo já votado) → renderRound já dispara showFinal
    }).catch(function () {
      playIndices = editions.map(function (_, i) { return i; });
      renderRound();
    });
  }

  startGame();
})();
</script>
${shareButtonScript("#seq-share-slot")}
${inlineSignupScript()}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  h1 { font-family: ${DS_FONTS.serif}; font-size: 1.5rem; margin-bottom: 4px; letter-spacing: -0.01em; }
  p.sub { color: ${DS_COLORS.ink}; font-size: 0.95rem; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  .choices { display: flex; gap: 12px; margin: 20px 0; justify-content: center; flex-wrap: wrap; }
  .choice { flex: 1 1 240px; max-width: 260px; }
  /* #3607: mesma reserva de espaço 16:9 (800x450) do par único acima — a
     sequência troca as <img> a cada rodada via choicesEl.innerHTML
     (renderRound() no script abaixo), então SEM aspect-ratio/width/height o
     box colapsa a cada troca de par (CLS reportado pelo editor). */
  .choice img { width: 100%; height: auto; aspect-ratio: 16 / 9; border-radius: 6px; display: block; background: ${DS_COLORS.paperAlt}; }
  .choice button { margin-top: 8px; width: 100%; padding: 10px 12px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 1rem; font-family: ${DS_FONTS.sans}; }
  .choice button:disabled { opacity: 0.5; cursor: not-allowed; }
  a { color: ${DS_COLORS.ink}; text-decoration: underline; }
  .scroll-hint { display: none; }
  #seq-final[hidden], #jogar-subscribe-cta[hidden], #jogar-signup-form[hidden] { display: none; }
  .result-msg { font-family: ${DS_FONTS.serif}; font-size: 1.3rem; line-height: 1.4; margin: 20px 0; }
  .quiz-round-result button { margin-top: 4px; padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  .share-card { margin: 24px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .share-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .share-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .share-actions button { padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  .subscribe-cta { margin: 20px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .subscribe-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .subscribe-btn { display: inline-block; padding: 10px 20px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
${renderInlineSignupFormStyles()}
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
    .share-card { max-width: 100%; padding: 20px 18px; }
    .share-actions { flex-direction: column; }
    .share-actions button { width: 100%; padding: 14px 16px; font-size: 1.05rem; }
    .subscribe-cta { max-width: 100%; padding: 20px 18px; }
    .subscribe-btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 1.05rem; }
    .signup-form { max-width: 100%; padding: 20px 18px; }
  }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
<h1>Sequência do mês — jogue e entre no leaderboard</h1>
${bodyHtml}

<p class="footer-links"><a href="${htmlEscape(buildBrandSiteUrl(JOGAR_BRAND, "jogar-footer", "eia-jogar-footer"))}">← Voltar para a ${htmlEscape(info.name)}</a> &nbsp;|&nbsp; <a href="${leaderboardLink}">Ver leaderboard</a>${quizFallbackLink}</p>
${renderBrandFooter(JOGAR_BRAND)}
${scriptHtml}
</body>
</html>`;
}

/**
 * Handler `GET /jogar` (#3516, rework #3589). `?edition=AAMMDD` explícito e
 * válido preserva o comportamento CLÁSSICO de par único (ponte clarice→
 * arquivo, #3524/#3578 — ver rationale item 5/6 acima) — não é mais o
 * default. Sem `?edition=` (ou malformado): serve a SEQUÊNCIA do mês
 * anterior (#3589), a experiência principal do web a partir de agora.
 *
 * Prefixo de list `correct:{yy}{mm}` (mês de conteúdo anterior) em vez de
 * escanear TODO o keyspace `correct:*` — mesma economia de I/O que
 * `handleJogarArchivePage` já faz por ano.
 */
export async function handleJogarPage(url: URL, env: Env): Promise<Response> {
  const explicitEdition = url.searchParams.get("edition");
  if (explicitEdition && AAMMDD_RE.test(explicitEdition)) {
    const edition = explicitEdition;
    const correctRaw = await env.POLL.get(`correct:${edition}`);
    return new Response(renderJogarPageHtml({ edition, revealed: correctRaw !== null }), {
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "public, max-age=120",
      },
    });
  }

  const now = new Date();
  const { yy, mm } = resolvePreviousCalendarMonth(now);
  const keys: string[] = [];
  for await (const k of listAllKeys(env, `correct:${yy}${mm}`)) keys.push(k);
  const editions = resolveJogarSequenceEditions(keys, now);
  return new Response(renderJogarSequencePageHtml(editions), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      // #3589: cada rodada grava um voto real — nunca cachear (mesmo
      // racional de Cache-Control: no-store do /jogar/quiz, embora aqui a
      // razão seja side-effect real, não só "sequência sorteada nova").
      "Cache-Control": "no-store",
    },
  });
}

/** Entrada retornada por `GET /jogar/seq-state` — ver `handleJogarSeqState`. */
export interface SeqStateResultEntry {
  edition: string;
  voted: boolean;
  correct: boolean | null;
}

/**
 * Handler `GET /jogar/seq-state?email={pseudo-email}&editions={csv AAMMDD}`
 * (#3595 — skip-and-credit, ver rationale na seção acima). Pra CADA edição
 * pedida, reporta se o TOKEN (pseudo-email anônimo, mesmo formato de
 * `anonEmailForToken`) já votou nela e, SE já votou, se acertou — lendo
 * DIRETO a mesma chave `vote:{edition}:{email}` que `handleVote`/
 * `buildAlreadyVotedResponse` (vote.ts) já escrevem/leem (o `correct`
 * gravado ali no momento do voto original, `{choice, ts, correct}` — ver
 * `env.POLL.put(voteKey, ...)` em handleVote). ZERO esquema novo de
 * persistência.
 *
 * Anti-spoiler: `correct` só é populado (não-null) quando `voted === true` —
 * o cliente só pode saber o gabarito de uma edição em que ESTE token já
 * votou antes (o mesmo dado que `/vote` já devolveu a ele na hora). Edição
 * não votada nunca revela `correct` aqui, mesmo que `correct:{edition}` já
 * exista no KV compartilhado. Mesmo nível de exposição já aceito em
 * `/vote` (que hoje já revela "já votou, escolha: X" pra qualquer email
 * passado nos params, sem exigir sig em merge-tag mode) — este endpoint não
 * introduz uma classe de risco nova, só um caminho read-only equivalente.
 *
 * `env` CRU (não `bEnv`) — mesmo racional do resto de `/jogar*`: a chave
 * `vote:{edition}:{email}` não é prefixada por brand (o pseudo-email já
 * isola o namespace `web` por construção, `@web.eia.diaria.local`).
 */
export async function handleJogarSeqState(url: URL, env: Env): Promise<Response> {
  const emailRaw = url.searchParams.get("email");
  const email = emailRaw ? emailRaw.toLowerCase().trim() : emailRaw;
  if (!email || !isValidVoteEmailFormat(email)) {
    return json({ error: "invalid email" }, 400, env);
  }
  // #3976: este endpoint é EXCLUSIVO do brand `web` — o token client-side
  // (`anonEmailForToken`) deve ser UUID v4 sob o domínio reservado, mesmo
  // guard aplicado em `handleVote` quando brand==="web" (vote.ts). Fecha o
  // mesmo vetor de forja aqui: sem isso, um HTTP client externo podia chamar
  // `/jogar/seq-state?email=verify1840428@web.eia.diaria.local&...` e sondar
  // estado de voto pra um token forjado (mesma classe do achado #3976).
  if (!isValidWebToken(email)) {
    return json({ error: "invalid email" }, 400, env);
  }
  const editions = parseSeqStateEditionsParam(url.searchParams.get("editions"));
  const results: SeqStateResultEntry[] = await Promise.all(
    editions.map(async (edition): Promise<SeqStateResultEntry> => {
      const raw = await env.POLL.get(`vote:${edition}:${email}`);
      if (!raw) return { edition, voted: false, correct: null };
      try {
        const parsed = JSON.parse(raw) as { correct?: boolean | null };
        const correct = typeof parsed.correct === "boolean" ? parsed.correct : null;
        return { edition, voted: true, correct };
      } catch {
        // Registro corrompido — trata como votado mas sem gabarito conhecido
        // (mesma disciplina de safeParseKv em vote.ts: nunca derruba o
        // endpoint por causa de 1 registro malformado).
        return { edition, voted: true, correct: null };
      }
    }),
  );
  return new Response(JSON.stringify(results), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
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
 * Pure (#3524): reforço contextual de assinatura no ÍNDICE do arquivo —
 * distinto de `renderSubscribeCtaBlock` (o CTA PRINCIPAL, revelado só
 * pós-voto/pós-quiz, #3518) por design: aqui o visitante ainda não jogou
 * nada nesta página (é o índice de edições, não um par jogável) — um botão
 * `hidden`-then-revealed não se aplica, e mostrar o CTA cheio de cara
 * duplicaria visualmente o mesmo bloco que aparece segundos depois assim que
 * o visitante clica em qualquer edição (`/jogar?edition=…` → mesmo
 * `renderJogarPageHtml` de sempre). Decisão conservadora: uma frase única,
 * sempre visível (sem JS/hidden), no rodapé do índice — reforço leve, não
 * uma 2ª conversão concorrente. Reusa `buildSubscribeUrl()` (mesmo destino/
 * UTM do CTA principal, #3518) — o funil de atribuição não distingue "veio
 * do índice do arquivo" vs. "veio pós-voto"; ambos são o mesmo `eia-standalone`
 * (decisão aceitável: a issue #3524 só exige o funil distinguir
 * newsletter/share/embed, não sub-origens dentro do próprio `/jogar`).
 */
export function renderArchiveSubscribeReinforcement(): string {
  const url = buildSubscribeUrl();
  return `<p class="sub archive-subscribe-reinforcement">Isso chega pronto na sua caixa de entrada todo dia — <a href="${htmlEscape(url)}" target="_blank" rel="noopener">assine a Diar.ia</a>.</p>`;
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
    brand: JOGAR_BRAND,
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
${renderArchiveSubscribeReinforcement()}
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

// ── #3520: quiz relâmpago — N pares seguidos, score compartilhável ─────────
//
// Sub-issue [S] do EPIC #3514, construída sobre a fundação #3516 (identidade
// anônima, `/jogar?edition=`) + #3519 (arquivo de pares FECHADOS, reusa
// `extractEditionsForYear`'s racional de "só edição com gabarito público e
// não-futura") + #3517 (motor de share, ver `QuizSharePayload` em share.ts).
// Decisões de design (ver PR #3520 para rationale completo):
//
//   1. Rota: `GET /jogar/quiz?n=N` — índice novo, não um query param em
//      `/jogar` (evitaria complicar `resolveJogarEdition`/`renderJogarPageHtml`
//      que já tratam de outra coisa — o par ÚNICO do dia/arquivo). Mesmo
//      padrão de path dedicado já usado por `/jogar/arquivo` (#3519).
//
//   2. Fonte dos pares: MESMAS chaves `correct:{edition}` que alimentam o
//      arquivo (#3519) — só que sem filtro de ANO (o quiz sorteia do universo
//      inteiro de edições fechadas, não de um ano específico) e com exclusão
//      explícita do dia corrente mesmo que já tenha gabarito definido (ver
//      item 5, guard crítico de anti-spoiler em `handleQuizAnswer`).
//
//   3. Placar 100% client-side, NUNCA escrito no KV — ver rationale completo
//      no header de share.ts ("Score do quiz é 100% CLIENT-SIDE"). Cada
//      rodada só LÊ o gabarito público via `GET /jogar/quiz/answer`
//      (sem side-effect); nenhuma chamada a `/vote` acontece. Satisfaz o
//      critério de aceite #3520 ("não contamina o ranking mensal") por
//      construção, sem precisar de nenhum branch condicional em
//      `handleVote`/`vote.ts` (arquivo mais sensível do worker — dedup,
//      Durable Object — zero mudança ali).
//
//   4. Sem sessão/seed servidor pra anti-replay (a issue original sugeria
//      "seed no KV/cookie pra evitar replay-farm"). Decisão CONSERVADORA:
//      omitido deliberadamente — como o placar não entra em NENHUM ranking
//      (item 3), "farmar" o quiz não tem nenhum payoff competitivo, só
//      vaidade sem custo real (mesmo racional já aceito pro `SIG_LENGTH`
//      truncado do card de voto único, ver header de share.ts). Implementar
//      anti-replay real exigiria justamente o "estado servidor pesado" que a
//      issue pede pra evitar — sobre-engenharia pra um risco de blast radius
//      zero. Cada `GET /jogar/quiz` sorteia uma sequência NOVA (sem cache,
//      `Cache-Control: no-store`) — recarregar a página já dá um quiz
//      diferente, suficiente pra não ser um "spoiler permanente" reusável.
//
//   5. Anti-spoiler — o guard mais importante desta issue: `handleQuizAnswer`
//      rejeita qualquer `edition >= hoje` (BRT) INDEPENDENTE de
//      `correct:{edition}` já existir no KV. Sem este guard, um leitor
//      poderia chamar `GET /jogar/quiz/answer?edition={hoje}` DIRETAMENTE
//      (sem passar pela UI) e descobrir o gabarito do par do dia ANTES de
//      votar em `/jogar` — o gabarito pode ser definido no KV antes do
//      e-mail sair (mesmo racional já documentado no header deste arquivo
//      pro `handleJogarPage`). O quiz só pode revelar respostas de edições
//      ESTRITAMENTE passadas, nunca a de hoje, mesmo que já "fechada"
//      administrativamente.
//
//   6. Requer JavaScript (progressive enhancement NÃO preservado aqui, ao
//      contrário de `/jogar`/`/jogar/arquivo`). Decisão conservadora: um
//      fallback sem-JS exigiria ou N page-loads inteiras (uma por rodada,
//      com placar tracked via query string/cookie — reintroduz o "estado
//      servidor pesado" que o item 4 evita) ou uma reimplementação paralela
//      da UI em HTML puro. `<noscript>` linka de volta pro `/jogar` (par do
//      dia, 100% funcional sem JS) — nunca um dead-end.
//
//   7. Pontuação: mesma decisão do #3519 — sem diferenciação de pontos entre
//      par do dia/arquivo/quiz (aliás o quiz nem GRAVA pontos, ver item 3).

/** Tamanho mínimo/máximo/default do quiz — issue sugere "5 ou 10 pares";
 * MIN=3 garante que "quiz" seja mais que 1-2 rodadas, MAX=10 limita o custo
 * de imagens carregadas numa sessão (mesmo teto sugerido na issue). */
export const QUIZ_MIN_N = 3;
export const QUIZ_MAX_N = 10;
export const QUIZ_DEFAULT_N = 5;

/**
 * Pure (#3520): resolve quantas rodadas o quiz pedido deve ter — clamped em
 * [QUIZ_MIN_N, QUIZ_MAX_N]. `?n=` ausente/malformado (não-inteiro, NaN) cai
 * no default, nunca lança (mesma disciplina de `resolveJogarEdition`: página
 * pública de entrada não pode 400/500 por um param mal formado). Note que
 * este é o tamanho PEDIDO — a quantidade REAL de rodadas jogáveis pode ser
 * menor se não houver edições fechadas suficientes (ver `pickQuizEditions`).
 */
export function resolveQuizSize(rawN: string | null): number {
  if (!rawN || !/^-?\d+$/.test(rawN)) return QUIZ_DEFAULT_N;
  const n = parseInt(rawN, 10);
  if (n < QUIZ_MIN_N) return QUIZ_MIN_N;
  if (n > QUIZ_MAX_N) return QUIZ_MAX_N;
  return n;
}

/**
 * Pure (#3520): extrai TODAS as edições com gabarito fechado (qualquer ano),
 * excluindo hoje e futuro — mesmo racional de `extractEditionsForYear`
 * (#3519), sem o filtro de ano (o quiz sorteia do universo inteiro de
 * edições disponíveis, não de um ano específico). Ordem de retorno não
 * importa aqui (`pickQuizEditions` embaralha) — dedup via Set.
 */
export function extractAllClosedEditions(correctKeyNames: string[], now: Date = new Date()): string[] {
  const today = todayAammddBrt(now);
  const set = new Set<string>();
  for (const k of correctKeyNames) {
    const edition = k.startsWith("correct:") ? k.slice("correct:".length) : k;
    if (!AAMMDD_RE.test(edition)) continue;
    if (edition >= today) continue; // hoje/futuro nunca entram no quiz (anti-spoiler)
    set.add(edition);
  }
  return [...set];
}

/**
 * Pure (#3520): sorteia até `n` edições SEM repetição de `available` (Fisher-
 * Yates parcial). `rng` injetável pra determinismo em teste (default
 * `Math.random`). Se `available.length < n`, retorna `available.length`
 * itens (nunca lança/preenche com duplicata) — "edições insuficientes" vira
 * um quiz mais curto, não um erro (critério de aceite #3520).
 */
export function pickQuizEditions(available: string[], n: number, rng: () => number = Math.random): string[] {
  const pool = [...available];
  const count = Math.min(Math.max(n, 0), pool.length);
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

/**
 * Pure render (#3520): página do quiz relâmpago. `editions` já sorteadas
 * pelo caller (`handleJogarQuizPage`) — esta função só embute o array (sem
 * revelar NENHUM gabarito, só os AAMMDD, que não são spoiler — o gabarito só
 * é buscado rodada-a-rodada via `/jogar/quiz/answer`, depois do voto do
 * leitor, mesma disciplina anti-gaming do resto do produto) e monta o
 * shell/JS que conduz as rodadas inteiramente no cliente.
 *
 * `editions.length === 0` → mensagem amigável (sem edições fechadas
 * suficientes ainda) em vez de renderizar um quiz vazio quebrado.
 */
export function renderJogarQuizPageHtml(editions: string[]): string {
  const info = BRAND_INFO[JOGAR_BRAND];
  const total = editions.length;
  const pageTitle = `Quiz relâmpago — É IA? | ${info.name}`;
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: `${total > 0 ? total : "Vários"} pares seguidos, direto do "É IA?" — acerte o máximo possível e compartilhe seu placar.`,
    path: "/jogar/quiz",
    brand: JOGAR_BRAND,
  });

  const emptyStateHtml = `<p class="sub">Ainda não há edições fechadas suficientes pra montar o quiz relâmpago — volte em breve.</p>
<p class="footer-links"><a href="/jogar">Jogar o par de hoje</a> &nbsp;|&nbsp; <a href="/jogar/arquivo">Ver arquivo</a></p>`;

  const quizBodyHtml = total === 0 ? emptyStateHtml : `<p class="sub" id="quiz-progress">Par 1 de ${total} — acertos: 0</p>

<noscript><p class="sub">O quiz relâmpago precisa de JavaScript. <a href="/jogar">Jogue o par de hoje sem JavaScript.</a></p></noscript>

<div id="quiz-play">
  <div class="choices" id="quiz-choices"></div>
  <div id="quiz-round-result" class="quiz-round-result" hidden></div>
</div>

<div id="quiz-final" class="quiz-final" hidden>
  <p class="result-msg quiz-final-score"></p>
  <div id="quiz-share-slot" hidden></div>
</div>

${renderQuizSubscribeCtaBlock()}
${renderInlineSignupFormBlock()}`;

  const scriptHtml = total === 0 ? "" : `<script>
(function () {
  var editions = ${JSON.stringify(editions)};
  var total = editions.length;
  var round = 0;
  var score = 0;
  var answered = false;

  var choicesEl = document.getElementById("quiz-choices");
  var progressEl = document.getElementById("quiz-progress");
  var roundResultEl = document.getElementById("quiz-round-result");
  var playEl = document.getElementById("quiz-play");
  var finalEl = document.getElementById("quiz-final");
  var subscribeCta = document.getElementById("jogar-subscribe-cta");
  var signupForm = document.getElementById("jogar-signup-form"); // #3580

  function imgUrl(edition, side) {
    return "/img/img-" + edition + "-01-eia-" + side + ".jpg";
  }

  function renderRound() {
    answered = false;
    roundResultEl.hidden = true;
    roundResultEl.innerHTML = "";
    var edition = editions[round];
    progressEl.textContent = "Par " + (round + 1) + " de " + total + " — acertos: " + score;
    choicesEl.innerHTML =
      '<div class="choice"><img src="' + imgUrl(edition, "A") + '" alt="Imagem A" loading="lazy"><button type="button" class="quiz-choice-btn" data-choice="A">Essa é a IA (A)</button></div>' +
      '<p class="scroll-hint">↓ Veja também a Imagem B antes de decidir</p>' +
      '<div class="choice"><img src="' + imgUrl(edition, "B") + '" alt="Imagem B" loading="lazy"><button type="button" class="quiz-choice-btn" data-choice="B">Essa é a IA (B)</button></div>';
  }

  function setChoiceButtonsDisabled(disabled) {
    var btns = choicesEl.querySelectorAll(".quiz-choice-btn");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = disabled;
  }

  function advance() {
    round++;
    if (round >= total) {
      showFinal();
      return;
    }
    renderRound();
  }

  function showFinal() {
    if (playEl) playEl.hidden = true;
    finalEl.hidden = false;
    var scoreEl = finalEl.querySelector(".quiz-final-score");
    if (scoreEl) scoreEl.textContent = "Você acertou " + score + " de " + total + "!";
    var slot = document.getElementById("quiz-share-slot");
    fetch("/jogar/quiz/result?score=" + encodeURIComponent(String(score)) + "&total=" + encodeURIComponent(String(total)))
      .then(function (res) { if (!res.ok) throw new Error("result fetch failed"); return res.text(); })
      .then(function (html) {
        if (!slot) return;
        slot.innerHTML = html;
        slot.hidden = false;
      })
      .catch(function () {});
    if (subscribeCta) subscribeCta.hidden = false;
    if (signupForm) signupForm.hidden = false; // #3580: revela o cadastro inline no fim do quiz
  }

  function onChoice(choice) {
    if (answered) return;
    answered = true;
    setChoiceButtonsDisabled(true);
    var edition = editions[round];
    fetch("/jogar/quiz/answer?edition=" + encodeURIComponent(edition))
      .then(function (res) {
        if (!res.ok) throw new Error("answer fetch failed");
        return res.json();
      })
      .then(function (data) {
        var isCorrect = data.correct === choice;
        if (isCorrect) score++;
        roundResultEl.hidden = false;
        roundResultEl.innerHTML =
          '<p class="result-msg">' + (isCorrect ? "Acertou!" : "Essa não — a resposta era " + data.correct + ".") + "</p>" +
          '<button type="button" id="quiz-next-btn">' + (round + 1 < total ? "Próximo par" : "Ver resultado") + "</button>";
        var nextBtn = document.getElementById("quiz-next-btn");
        if (nextBtn) nextBtn.addEventListener("click", advance);
      })
      .catch(function () {
        // Falha de rede não deve travar o quiz — reabilita os botões pra
        // tentar a rodada de novo (não avança/não pontua, evita placar
        // inconsistente com uma rodada que nunca foi confirmada).
        answered = false;
        setChoiceButtonsDisabled(false);
      });
  }

  choicesEl.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".quiz-choice-btn") : null;
    if (!btn) return;
    onChoice(btn.getAttribute("data-choice"));
  });

  renderRound();
})();
</script>
${shareButtonScript("#quiz-share-slot")}
${inlineSignupScript()}`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
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
  .scroll-hint { display: none; }
  #quiz-round-result[hidden], #quiz-final[hidden], #jogar-subscribe-cta[hidden], #jogar-signup-form[hidden] { display: none; }
  .result-msg { font-family: ${DS_FONTS.serif}; font-size: 1.3rem; line-height: 1.4; margin: 20px 0; }
  .quiz-round-result button { margin-top: 4px; padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  .share-card { margin: 24px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .share-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .share-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .share-actions button { padding: 10px 16px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
  .subscribe-cta { margin: 20px auto; padding: 18px 20px; background: ${DS_COLORS.paperAlt}; border-radius: 8px; max-width: 420px; }
  .subscribe-text { font-family: ${DS_FONTS.serif}; font-size: 1.05rem; margin: 0 0 14px 0; line-height: 1.4; }
  .subscribe-btn { display: inline-block; padding: 10px 20px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 0.95rem; font-family: ${DS_FONTS.sans}; }
${renderInlineSignupFormStyles()}
  @media (max-width: 600px) {
    .choice { flex-basis: 100%; max-width: 100%; }
    .scroll-hint { display: block; width: 100%; margin: 2px 0 10px; font-size: 0.85rem; font-weight: 600; color: ${DS_COLORS.brand}; }
    .share-card { max-width: 100%; padding: 20px 18px; }
    .share-actions { flex-direction: column; }
    .share-actions button { width: 100%; padding: 14px 16px; font-size: 1.05rem; }
    .subscribe-cta { max-width: 100%; padding: 20px 18px; }
    .subscribe-btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 1.05rem; }
    .signup-form { max-width: 100%; padding: 20px 18px; }
  }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA? — quiz relâmpago</p>
<hr class="rule">
<h1>Quiz relâmpago</h1>
${quizBodyHtml}

<p class="footer-links"><a href="${htmlEscape(buildBrandSiteUrl(JOGAR_BRAND, "jogar-footer", "eia-jogar-footer"))}">← Voltar para a ${htmlEscape(info.name)}</a> &nbsp;|&nbsp; <a href="/jogar">Jogar o par de hoje</a> &nbsp;|&nbsp; <a href="/jogar/arquivo">Ver arquivo</a> &nbsp;|&nbsp; <a href="${leaderboardHref(JOGAR_BRAND)}">Ver leaderboard</a></p>
${renderBrandFooter(JOGAR_BRAND)}
${scriptHtml}
</body>
</html>`;
}

/**
 * Handler `GET /jogar/quiz` (#3520). `env` CRU — lê `correct:*` compartilhado
 * pra montar o universo de edições jogáveis (mesmo racional de
 * `handleJogarArchivePage`). `Cache-Control: no-store` — cada request sorteia
 * uma sequência NOVA (ver item 4 do rationale acima); cachear serviria o
 * MESMO quiz repetidamente.
 */
export async function handleJogarQuizPage(url: URL, env: Env): Promise<Response> {
  const now = new Date();
  const requestedN = resolveQuizSize(url.searchParams.get("n"));
  const keys: string[] = [];
  for await (const k of listAllKeys(env, "correct:")) keys.push(k);
  const available = extractAllClosedEditions(keys, now);
  const editions = pickQuizEditions(available, requestedN);
  return new Response(renderJogarQuizPageHtml(editions), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Handler `GET /jogar/quiz/answer?edition=AAMMDD` (#3520). Endpoint público
 * SEM side-effect (só leitura do gabarito já público) — nunca escreve no KV,
 * é o que garante que o quiz nunca poluí score/leaderboard (ver rationale no
 * header de share.ts).
 *
 * Guard crítico de anti-spoiler: `edition >= hoje` (BRT) é rejeitado com 403
 * INDEPENDENTE de `correct:{edition}` já existir no KV — o gabarito de hoje
 * pode ser definido antes do e-mail sair (mesmo racional documentado no
 * header do arquivo pra `handleJogarPage`); sem este guard, chamar este
 * endpoint diretamente com `edition=hoje` vazaria a resposta do par do dia
 * ANTES do leitor votar em `/jogar`.
 */
export async function handleQuizAnswer(url: URL, env: Env): Promise<Response> {
  const edition = url.searchParams.get("edition");
  if (!edition || !AAMMDD_RE.test(edition)) {
    return json({ error: "invalid edition" }, 400, env);
  }
  const today = todayAammddBrt(new Date());
  if (edition >= today) {
    return json({ error: "edition not eligible for quiz — reveals only past closed editions" }, 403, env);
  }
  const correct = await env.POLL.get(`correct:${edition}`);
  if (correct !== "A" && correct !== "B") {
    return json({ error: "not found" }, 404, env);
  }
  return json({ edition, correct }, 200, env);
}

/**
 * #3589 (self-review #2038, achado corrigido no mesmo PR — não só
 * comentado, mesmo precedente de #3117/#3120): teto de `total` aceito por
 * `resolveQuizResultParams`/`GET /jogar/quiz/result`. NÃO é mais
 * `QUIZ_MAX_N` (10) — este endpoint agora é reusado LITERALMENTE por
 * `renderJogarSequencePageHtml` (`/jogar` default, a sequência do mês
 * anterior), cujo `total` realista é o número de edições fechadas do mês
 * (até ~23 dias úteis num mês de 31 dias) — bem acima do teto do quiz
 * relâmpago. Usar `QUIZ_MAX_N` aqui rejeitaria `/jogar/quiz/result` com
 * 400 pra QUALQUER sequência mensal real, quebrando o card de
 * compartilhamento final da sequência silenciosamente (o `.catch` no
 * cliente engole o 400 — mesmo risco documentado abaixo pro `QUIZ_MIN_N`).
 * `31` cobre o mês civil mais longo possível — generoso o bastante pra
 * nunca rejeitar um total real de nenhum dos dois callers (quiz ≤10,
 * sequência ≤~23), sem re-abrir a validação pra "qualquer número" (ainda
 * finito e pequeno o bastante pra não servir de vetor de abuso — mesmo
 * racional de "forja só produz vaidade sem efeito no sistema", ver
 * rationale no header de share.ts). `QUIZ_MAX_N` continua intocado — segue
 * bound o TAMANHO PEDIDO de um quiz novo (`resolveQuizSize`), sem relação
 * com este teto.
 */
export const QUIZ_RESULT_MAX_TOTAL = 31;

/**
 * Pure (#3520, teto ajustado #3589): valida `score`/`total` recebidos de
 * `GET /jogar/quiz/result`. `null` pra qualquer forma inválida (não-inteiro,
 * `total` fora de [1, QUIZ_RESULT_MAX_TOTAL], `score` negativo ou > `total`)
 * — nunca lança.
 *
 * Self-review #2038 (achado corrigido, não só comentado — mesmo precedente
 * de #3117): o piso do `total` aqui é `1`, NÃO `QUIZ_MIN_N`. `QUIZ_MIN_N`
 * bound o TAMANHO PEDIDO de um quiz novo (`resolveQuizSize`) — mas
 * `pickQuizEditions` pode legitimamente devolver MENOS rodadas que isso
 * quando o pool de edições fechadas é pequeno (ex: lançamento do produto,
 * só 1-2 edições fechadas ainda). Usar `QUIZ_MIN_N` como piso aqui rejeitaria
 * `/jogar/quiz/result?score=1&total=1` justamente no cenário "edições
 * insuficientes" que é critério de aceite explícito da #3520 — o placar do
 * quiz jogaria normalmente, mas o card de compartilhamento final falharia
 * silenciosamente (o `.catch` no cliente engole o 400).
 *
 * Nota (ver rationale no header de share.ts): não há verificação contra
 * respostas REAIS aqui — `score`/`total` são confiados do cliente. Trade-off
 * deliberado (forja só produz vaidade sem efeito no sistema).
 */
export function resolveQuizResultParams(rawScore: string | null, rawTotal: string | null): QuizSharePayload | null {
  if (!rawScore || !rawTotal) return null;
  if (!/^\d+$/.test(rawScore) || !/^\d+$/.test(rawTotal)) return null;
  const score = parseInt(rawScore, 10);
  const total = parseInt(rawTotal, 10);
  if (total < 1 || total > QUIZ_RESULT_MAX_TOTAL) return null;
  if (score < 0 || score > total) return null;
  return { score, total };
}

/**
 * Handler `GET /jogar/quiz/result?score=X&total=N` (#3520). Assina o
 * `QuizSharePayload` e retorna DIRETO o bloco `renderQuizShareCardBlock`
 * (não uma página inteira) — o cliente injeta a resposta via
 * `slot.innerHTML` sem precisar de DOMParser (ao contrário do fetch de
 * `/vote` em `renderJogarPageHtml`, cuja resposta é uma página completa da
 * qual só um fragmento é extraído).
 */
export async function handleQuizResult(url: URL, env: Env): Promise<Response> {
  const payload = resolveQuizResultParams(url.searchParams.get("score"), url.searchParams.get("total"));
  if (!payload) {
    return json({ error: "invalid score/total" }, 400, env);
  }
  const token = await encodeQuizShareToken(env.POLL_SECRET, payload);
  return new Response(renderQuizShareCardBlock(token, payload), {
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}
