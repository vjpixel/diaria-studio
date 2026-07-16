/**
 * workers/poll/src/share.ts (#3517)
 *
 * Share card pós-jogo do "É IA?" standalone — o motor de divulgação do EPIC
 * #3514. Construído sobre a fundação do #3516 (brand `web`, página `/jogar`,
 * slot `#jogar-result-slot` reservado explicitamente pra este momento).
 *
 * Fluxo:
 *   1. Voto novo em brand=web (vote.ts:handleVote) monta um `SharePayload`
 *      `{edition, correct}` e assina via `encodeShareToken` (HMAC com
 *      `POLL_SECRET` — mesmo secret já usado em /vote e /set-name, nenhum
 *      secret novo). O token vai embutido no HTML de resultado
 *      (`votePageHtml`, index.ts) como um bloco `#jogar-share-card` com os 2
 *      botões de compartilhamento — visível diretamente pra quem navega até
 *      /vote (progressive enhancement: funciona sem JS).
 *   2. `/jogar` (jogar.ts) intercepta o submit do voto via `fetch` (em vez de
 *      deixar a navegação nativa acontecer) e injeta o MESMO bloco
 *      `#jogar-share-card` — extraído via `DOMParser` do HTML que /vote
 *      retornou — dentro do slot reservado `#jogar-result-slot`, sem sair da
 *      página. Qualquer falha de rede cai pra navegação nativa (nunca perde
 *      o voto do leitor).
 *   3. O link compartilhado é `/share/{token}` — página com meta tags OG/
 *      Twitter (og:image AGORA populado, fechando a lacuna documentada em
 *      #3106: antes não existia NENHUMA imagem buscável via HTTP no worker;
 *      agora `/og/{token}` gera uma imagem SVG determinística a partir do
 *      payload assinado). Token inválido/adulterado NUNCA vira dead-end —
 *      redireciona pro jogo (baixo risco: sem PII, sem ação destrutiva).
 *
 * Decisões de design (ver PR #3517 para rationale completo):
 *
 *   - **OG image é SVG** (`Content-Type: image/svg+xml`), não PNG rasterizado.
 *     `workers/poll` não tem NENHUMA dependência de bundling hoje (só
 *     wrangler/typescript em devDependencies) — rasterizar PNG exigiria uma
 *     lib WASM nova (satori + resvg, ex: `workers-og`, sugerida no esboço da
 *     issue) cujo impacto no bundle size do Workers free tier não dá pra
 *     validar sem um `wrangler deploy` real (fora do escopo desta sessão —
 *     guard explícito de não fazer deploy). SVG puro é: (a) pure function
 *     testável sem infra nova, (b) zero risco de bundle-size, (c) renderiza
 *     perfeito no navegador pra quem abre o link direto. Risco aceito:
 *     Facebook/WhatsApp têm suporte inconsistente pra SVG como og:image
 *     (Twitter/X e Discord aceitam) — se o editor confirmar que o preview não
 *     renderiza no WhatsApp real, migrar pra rasterização é um follow-up
 *     isolado (troca só `renderShareCardSvg` + Content-Type, sem mexer em
 *     payload/rotas/assinatura).
 *   - **Payload = só `{edition, correct}`** — SEM o score total "X de Y"
 *     sugerido como exemplo de copy no esboço da issue. Buscar o score total
 *     exigiria uma leitura adicional de `score:{email}` DEPOIS do
 *     `Promise.all` de `updateScore` em `handleVote` — tecnicamente simples,
 *     mas `handleVote` é um dos arquivos mais sensíveis do worker (dedup,
 *     guard-keys idempotentes, Durable Object). Reduzir o payload ao que já
 *     está 100% em escopo em `handleVote` SEM nenhuma leitura KV extra
 *     minimiza o blast radius nesse arquivo. "Acertei X de Y" fica
 *     documentado como follow-up natural (ex: junto de #3518, que já vai
 *     mexer em stats pós-voto).
 *   - **Sem PII no payload** (mandato da issue): só `edition` (AAMMDD
 *     público) e `correct` (boolean|null) — nenhum email/token do jogador.
 *   - **Assinatura HMAC truncada a 16 hex chars (64 bits)**: o pior caso de
 *     forja é alguém fabricar um card "eu acertei" falso pra si mesmo — sem
 *     NENHUM efeito colateral no sistema (nenhuma escrita KV, nenhum voto,
 *     nenhuma pontuação real alterada). Não é segredo de alto risco, então
 *     trocar um pouco de margem de segurança por uma URL mais compacta (mais
 *     fácil de compartilhar) é aceitável — 64 bits ainda inviabiliza
 *     brute-force casual.
 *   - **Token inválido em `/share/{token}` → 302 pra `/jogar`** (nunca 404
 *     dead-end): um link de baixo risco compartilhado quebrado ainda deve
 *     converter tráfego pro jogo, alinhado ao objetivo do EPIC #3514
 *     ("motor de divulgação").
 */
import { AAMMDD_RE, htmlEscape, formatEditionDate, renderBrandFooter, renderBrandShellStyles, renderSeoMeta, POLL_BASE_URL } from "./lib";
import { DS_COLORS, DS_FONTS } from "./ds-tokens.generated";
import { hmacSign } from "./index";

/** Payload assinado embutido no token de compartilhamento — sem PII (ver
 * rationale no header do arquivo). */
export interface SharePayload {
  edition: string;
  /** true=acertou, false=errou, null=gabarito ainda não revelado quando votou. */
  correct: boolean | null;
}

/** Comprimento do sig truncado no token — ver rationale no header do arquivo. */
const SIG_LENGTH = 16;

/** Pure: serializa o payload pra um corpo compacto e determinístico (vira a
 * mensagem assinada por `encodeShareToken`). Formato: `{AAMMDD}.{0|1|-}`. */
export function serializeSharePayload(payload: SharePayload): string {
  const correctChar = payload.correct === true ? "1" : payload.correct === false ? "0" : "-";
  return `${payload.edition}.${correctChar}`;
}

/** Pure: inverso de `serializeSharePayload`. Retorna `null` pra qualquer
 * forma fora do padrão — nunca lança (mesma disciplina de
 * `resolveJogarEdition` em jogar.ts: input malformado não pode derrubar uma
 * rota pública). */
export function deserializeSharePayload(body: string): SharePayload | null {
  const match = /^(\d{6})\.([01-])$/.exec(body);
  if (!match) return null;
  const [, edition, correctChar] = match;
  if (!AAMMDD_RE.test(edition)) return null;
  const correct = correctChar === "1" ? true : correctChar === "0" ? false : null;
  return { edition, correct };
}

/** Monta+assina o token compartilhável. HMAC com `POLL_SECRET` — mesmo
 * secret já usado por `/vote`/`/set-name`, nenhum secret novo. */
export async function encodeShareToken(secret: string, payload: SharePayload): Promise<string> {
  const body = serializeSharePayload(payload);
  const sig = (await hmacSign(secret, body)).slice(0, SIG_LENGTH);
  return `${body}.${sig}`;
}

/** Decodifica+verifica um token. Retorna `null` pra token ausente, malformado
 * ou adulterado (sig mismatch) — nunca lança (`/share`/`/og` são rotas
 * públicas). Comparação constant-time (mesmo padrão de `hmacVerify` em
 * index.ts), mas contra o sig TRUNCADO — não dá pra reusar `hmacVerify`
 * direto (ele espera o HMAC completo de 64 hex chars). */
export async function decodeShareToken(secret: string, token: string): Promise<SharePayload | null> {
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === token.length - 1) return null;
  const body = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = (await hmacSign(secret, body)).slice(0, SIG_LENGTH);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  return deserializeSharePayload(body);
}

/** Pure: mensagem de compartilhamento (usada no OG description, no texto do
 * card, e no payload do Web Share API). Curta o bastante pra não estourar o
 * SVG do card (ver `renderShareCardSvg`). */
export function buildShareText(payload: SharePayload): string {
  const dateLabel = formatEditionDate(payload.edition);
  const question = "Você consegue diferenciar uma foto real de uma gerada por IA?";
  if (payload.correct === true) {
    return `Acertei o "É IA?" de hoje (${dateLabel})! ${question} diar.ia.br/jogar`;
  }
  if (payload.correct === false) {
    return `Não foi dessa vez no "É IA?" de hoje (${dateLabel}). ${question} diar.ia.br/jogar`;
  }
  return `Já votei no "É IA?" de hoje (${dateLabel}) — resultado sai em breve. ${question} diar.ia.br/jogar`;
}

/**
 * Pure: JS de wiring dos botões de compartilhamento (Web Share API + fallback
 * copiar-link), delegado a partir de `containerSelector` — funciona tanto pro
 * bloco renderizado direto em `votePageHtml` (container = `#jogar-share-card`,
 * presente no load) quanto pro bloco injetado dinamicamente em `/jogar`
 * (container = `#jogar-result-slot`, presente no load MESMO antes do conteúdo
 * ser injetado — delegação de evento cobre filhos futuros). Retorna a tag
 * `<script>` completa, pronta pra interpolar.
 */
export function shareButtonScript(containerSelector: string): string {
  return `<script>
(function () {
  var container = document.querySelector(${JSON.stringify(containerSelector)});
  if (!container) return;
  container.addEventListener("click", function (ev) {
    var target = ev.target && ev.target.closest ? ev.target.closest("[data-share-action]") : null;
    if (!target || !container.contains(target)) return;
    var shareUrl = target.getAttribute("data-share-url");
    var shareText = target.getAttribute("data-share-text");
    if (target.getAttribute("data-share-action") === "native" && navigator.share) {
      navigator.share({ text: shareText, url: shareUrl }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(function () {
        var original = target.textContent;
        target.textContent = "Link copiado!";
        setTimeout(function () { target.textContent = original; }, 2000);
      }).catch(function () { window.prompt("Copie o link:", shareUrl); });
    } else {
      window.prompt("Copie o link:", shareUrl);
    }
  });
})();
</script>`;
}

/**
 * Pure: bloco HTML do card de compartilhamento — mesma estrutura reusada em
 * `votePageHtml` (index.ts, visível direto) e extraída via `DOMParser` por
 * `/jogar` (jogar.ts, injetada no slot). `id="jogar-share-card"` é o
 * contrato entre as duas pontas — não renomear sem atualizar jogar.ts.
 */
export function renderShareCardBlock(token: string, payload: SharePayload): string {
  const text = buildShareText(payload);
  const shareUrlNative = `${POLL_BASE_URL}/share/${encodeURIComponent(token)}?utm_medium=social`;
  const shareUrlCopy = `${POLL_BASE_URL}/share/${encodeURIComponent(token)}?utm_medium=copy`;
  return `<div id="jogar-share-card" class="share-card">
  <p class="share-text">${htmlEscape(text)}</p>
  <div class="share-actions">
    <button type="button" data-share-action="native" data-share-url="${htmlEscape(shareUrlNative)}" data-share-text="${htmlEscape(text)}">Compartilhar</button>
    <button type="button" data-share-action="copy" data-share-url="${htmlEscape(shareUrlCopy)}" data-share-text="${htmlEscape(text)}">Copiar link</button>
  </div>
</div>`;
}

/**
 * Pure: card visual 1200×630 (proporção OG padrão) servido por `/og/{token}`.
 * SVG puro — ver rationale de design no header do arquivo sobre por que não é
 * PNG rasterizado. Textos mantidos curtos deliberadamente (SVG `<text>` não
 * faz wrap automático) — polish de wrapping dinâmico fica de follow-up.
 */
export function renderShareCardSvg(payload: SharePayload): string {
  const dateLabel = htmlEscape(formatEditionDate(payload.edition));
  const resultLabel = payload.correct === true ? "Acertou!" : payload.correct === false ? "Quase!" : "Já votou!";
  const sub = payload.correct === true
    ? "Diferencia IA de foto real?"
    : payload.correct === false
    ? "Foi por pouco — e você?"
    : "Resultado sai em breve.";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${DS_COLORS.paper}"/>
  <rect x="0" y="0" width="1200" height="14" fill="${DS_COLORS.brand}"/>
  <text x="80" y="150" font-family="${DS_FONTS.sans}" font-size="30" font-weight="700" letter-spacing="4" fill="${DS_COLORS.ink}">É IA?</text>
  <text x="80" y="280" font-family="${DS_FONTS.serif}" font-size="96" font-weight="700" fill="${DS_COLORS.ink}">${htmlEscape(resultLabel)}</text>
  <text x="80" y="350" font-family="${DS_FONTS.sans}" font-size="36" fill="${DS_COLORS.ink}">${sub}</text>
  <text x="80" y="410" font-family="${DS_FONTS.sans}" font-size="26" fill="${DS_COLORS.ink}">Edição de ${dateLabel}</text>
  <text x="80" y="570" font-family="${DS_FONTS.sans}" font-size="32" font-weight="700" fill="${DS_COLORS.brand}">diar.ia.br/jogar</text>
</svg>`;
}

export interface SharePageOptions {
  token: string;
  payload: SharePayload;
  /** `?utm_medium=` lido da própria URL de `/share/{token}` (default "link")
   * — repassado pro CTA `/jogar?utm_source=share&utm_medium=...` (mensurável
   * no funil, item de aceite da issue). */
  utmMedium: string;
}

/**
 * Pure: página `GET /share/{token}` — o destino que os unfurlers (WhatsApp/
 * LinkedIn/etc.) buscam ao expandir o link compartilhado. `renderSeoMeta`
 * (lib.ts) agora recebe `imageUrl` (#3517) — antes desta issue nenhuma
 * página do worker populava og:image/twitter:image (ver rationale #3106 em
 * lib.ts).
 */
export function renderSharePageHtml(opts: SharePageOptions): string {
  const { token, payload, utmMedium } = opts;
  const text = buildShareText(payload);
  const ogImageUrl = `${POLL_BASE_URL}/og/${encodeURIComponent(token)}`;
  const jogarHref = `/jogar?utm_source=share&utm_medium=${encodeURIComponent(utmMedium || "link")}`;
  const pageTitle = "É IA? — resultado compartilhado | Diar.ia";
  const seoMeta = renderSeoMeta({
    title: pageTitle,
    description: text,
    path: `/share/${encodeURIComponent(token)}`,
    imageUrl: ogImageUrl,
  });

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
${seoMeta}
<style>
  body { font-family: ${DS_FONTS.sans}; font-size: 17px; max-width: 560px; margin: 40px auto; padding: 0 20px; text-align: center; color: ${DS_COLORS.ink}; background: ${DS_COLORS.paper}; }
  .kicker { font-family: ${DS_FONTS.sans}; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: ${DS_COLORS.ink}; margin: 0 0 12px 0; }
  img.share-card-img { width: 100%; height: auto; border-radius: 8px; display: block; margin: 20px 0; background: ${DS_COLORS.paperAlt}; }
  p.share-text { font-family: ${DS_FONTS.serif}; font-size: 1.25rem; line-height: 1.4; }
  a.cta { display: inline-block; margin-top: 20px; padding: 12px 24px; background: ${DS_COLORS.ink}; color: ${DS_COLORS.paper}; border-radius: 6px; text-decoration: none; font-weight: 600; }
${renderBrandShellStyles()}
</style>
</head>
<body>
<p class="kicker">É IA?</p>
<hr class="rule">
<img class="share-card-img" src="${htmlEscape(ogImageUrl)}" alt="Card de resultado do jogo É IA?">
<p class="share-text">${htmlEscape(text)}</p>
<a class="cta" href="${htmlEscape(jogarHref)}">Jogar agora</a>
${renderBrandFooter("web")}
</body>
</html>`;
}
