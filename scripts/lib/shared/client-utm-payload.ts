/**
 * scripts/lib/shared/client-utm-payload.ts (#7535, Camada 1 — Passo 2)
 *
 * Fragmento JS compartilhado que lê `utm_source`/`utm_medium`/`utm_campaign`
 * do querystring da página e os acrescenta ao payload do POST de cadastro
 * inline. Antes desta extração, `livros` (via `scripts/build-livros-page.ts`)
 * e `arquivo`/`hub` (via `scripts/lib/shared/curadoria-page.ts`) mandavam só
 * `{ email, optin, website, source }` — o servidor (`resolveSubscribeUtm`,
 * `workers/poll/src/subscribe.ts`) já sabe consultar a allowlist de
 * `isAllowedClientUtmSource` pra QUALQUER `source` (#7535), mas sem o
 * cliente enviar o triplo cru, não há o que consultar: tráfego pago
 * roteado pra essas superfícies perdia a atribuição em silêncio.
 *
 * A apex (`scripts/lib/site-assinar-page.ts`/`scripts/lib/site-home-page.ts`)
 * já fazia essa leitura ANTES de #7535 (é o único `source` que aceita o
 * triplo completo do cliente, #6427) — não usa este helper porque preenche
 * campos `<input>` do form em vez de montar um objeto de payload JS (padrão
 * de submit diferente); o mecanismo de leitura (`URLSearchParams` sobre
 * `window.location.search`) é o mesmo.
 *
 * Terceira cópia evitada de propósito (a #7360 documentou o custo de ter
 * essa leitura sem dono nem teste) — `workers/cursos/src/gate-page.ts` tem
 * seu PRÓPRIO padrão de submit (só `utm_source`, sem `medium`/`campaign` —
 * o gate não tem `SubscribeSource`/triplo dinâmico, só `origem_paga`) e por
 * isso não usa este helper.
 */

/**
 * Retorna o fragmento JS (SEM chave de fechamento) pra colar dentro de um
 * objeto de payload já aberto — 3 propriedades, cada uma lendo o
 * querystring da página no momento do submit (não cacheado — cobre o caso
 * raro de SPA que muda a URL sem reload entre carregar a página e o
 * usuário submeter o form).
 */
export function clientUtmPayloadFieldsJs(): string {
  return [
    'utm_source: new URLSearchParams(window.location.search).get("utm_source") || "",',
    'utm_medium: new URLSearchParams(window.location.search).get("utm_medium") || "",',
    'utm_campaign: new URLSearchParams(window.location.search).get("utm_campaign") || "",',
  ].join("\n          ");
}
