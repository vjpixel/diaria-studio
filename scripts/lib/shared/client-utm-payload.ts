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

/**
 * #8003: fragmento JS (SEM chave de fechamento) pra colar dentro de um objeto
 * de payload já aberto — captura `document.referrer` + click ID de anúncio
 * pago (`gclid`/`fbclid`/`msclkid`) num par de campos NOVOS e SEPARADOS do
 * triplo UTM canônico acima.
 *
 * Por que separado, nunca substituindo `source`/`medium`/`campaign`/
 * `referring_site`: a issue #8003 mediu que os cadastros nos formulários
 * próprios gravam sempre o FORMULÁRIO usado (triplo fixo por posição de
 * link, resolvido em `resolveSubscribeUtm`), nunca de onde a pessoa
 * realmente veio — isso vale pra 100% dos cadastros, pagos ou orgânicos (não
 * é o mesmo gap que `isAllowedClientUtmSource`/`origemPaga` cobrem, que é
 * escopo intencional e restrito a 4 prefixos de canal pago). O editor
 * confirmou: adicionar `referrer`/`click_id` como sinal ADICIONAL,
 * puramente informativo — nunca consumido por lógica de negócio, nunca
 * usado pra decidir o triplo UTM em si, só gravado como veio do cliente
 * pra permitir auditoria manual depois.
 *
 * Por que `document.referrer` bruto em vez de tentar inferir o canal aqui:
 * essa inferência (mapear um referrer de busca orgânica, rede social, etc.
 * pra uma categoria) é trabalho de quem LÊ o dado depois — o ponto de
 * captura só registra o fato cru, sem julgamento. `click_id` cobre os 3
 * provedores de ads que o projeto já anuncia em (#7981 Google Ads,
 * Microsoft Ads, Meta Ads — ver `docs/google-ads-api-setup.md`,
 * `microsoft-ads-oferta-do-email-e-us-only.md`) prefixado pelo nome do
 * parâmetro (`"gclid:..."`) pra não precisar de um 2º campo só pra dizer
 * qual provedor gerou o clique.
 *
 * Cap de tamanho (300 chars) já aplicado no CLIENTE — o servidor corta de
 * novo em `SUBSCRIBE_CLIENT_ORIGIN_MAX` (defesa em profundidade, mesmo
 * padrão de `SUBSCRIBE_CLIENT_UTM_MAX`): nunca confiar só no corte do
 * cliente, que um requester malicioso pode simplesmente não rodar.
 */
export function clientOriginSignalPayloadFieldsJs(): string {
  return [
    'referrer: (document.referrer || "").slice(0, 300),',
    'click_id: (function () { var p = new URLSearchParams(window.location.search); if (p.get("gclid")) return "gclid:" + p.get("gclid"); if (p.get("fbclid")) return "fbclid:" + p.get("fbclid"); if (p.get("msclkid")) return "msclkid:" + p.get("msclkid"); return ""; })(),',
  ].join("\n          ");
}
