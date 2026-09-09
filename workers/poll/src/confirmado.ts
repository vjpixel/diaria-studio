/**
 * workers/poll/src/confirmado.ts (#5167 item 7; redirect desde #7737)
 *
 * Destino histórico do link de confirmação do double opt-in da Beehiiv/Kit
 * (`opt_in_redirect_url`) — `eia.diar.ia.br/confirmado`. Confirmado ao vivo
 * via `get_publication_settings`/painel em 16/08/2026 (#5499): o campo
 * gravado é `opt_in_redirect_url: "https://eia.diar.ia.br/confirmado"`, e o
 * form de DOI do Kit (`KIT_DOI_FORM_ID`, ver `workers/poll/wrangler.toml`)
 * também aponta pra cá — o mesmo redirect de confirmação, copy em
 * `docs/kit-doi-confirmation-copy.md`.
 *
 * **#7737 (decisão do editor, comentário `decisao-editor` na issue): a
 * página real de confirmação passa a ser servida no APEX**
 * (`diar.ia.br/confirmado`, Worker `site` — #467), não mais aqui. Esta rota
 * PERMANECE no ar — não pode virar 404 — porque o link já está gravado em
 * `opt_in_redirect_url` da Beehiiv e em e-mails de confirmação JÁ
 * ENTREGUES a assinantes; um 404 aqui quebraria confirmações pendentes
 * retroativamente. O que muda é o corpo da resposta: 301 pro apex, nunca
 * mais a página em si (que agora mora em `scripts/lib/shared/confirmado-page.ts`,
 * consumida pelo Worker `site`).
 *
 * Não repetir aqui o racional completo de por que esta página existe (o
 * survey de interesses, as 4 "portas" de curadoria, GTM/#5499, por que
 * `gclid`/`fbclid`/`msclkid`/`li_fat_id` não se aplicam) — ele vive na
 * docstring de `scripts/lib/shared/confirmado-page.ts` agora, fonte única.
 * Também não repetir por que o link de confirmação em si sobrevive no
 * Worker `poll` (eia.diar.ia.br já é o domínio de marca de `/jogar`,
 * `/vote`, etc. — mesmo Worker que autentica o funil de DOI) — só o
 * DESTINO final da navegação mudou, não o Worker que recebe o clique
 * inicial do e-mail.
 */
import { PAGE_URL as CONFIRMADO_APEX_URL } from "../../../scripts/lib/shared/confirmado-page.ts";

/** URL de destino do redirect — apex, fonte única em `confirmado-page.ts`. */
export const CONFIRMADO_REDIRECT_URL = CONFIRMADO_APEX_URL;

/**
 * 301 permanente pro apex — sem KV, sem env. Testável direto.
 *
 * `new Response(null, {status, headers})`, NÃO `Response.redirect()`: o
 * guard "immutable" de `Response.redirect()`/`Response.error()` quebra
 * `applyFrameDenyHeaders` (index.ts) — que muta `response.headers` in-place
 * em TODA resposta do router (exceto `/embed`) e documenta explicitamente
 * que o único `Response.redirect()` do worker é o de trailing-slash,
 * resolvido ANTES daquele ponto. Mesmo padrão dos demais redirects internos
 * (`/jogar`, `/jogar/quiz`, `/share`, `/quiz-share`, auto-heal de
 * `/leaderboard/{YYYY-MM}`) — ver a docstring de `applyFrameDenyHeaders`.
 */
export function handleConfirmadoRedirect(): Response {
  return new Response(null, { status: 301, headers: { Location: CONFIRMADO_REDIRECT_URL } });
}
