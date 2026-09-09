/**
 * workers/meta-leads/src/utm.ts (#7769)
 *
 * Atribuição fixa aplicada a TODO lead criado por este worker.
 *
 * `source`/`medium`/`campaign` são o MESMO triplo já registrado em
 * `scripts/lib/shared/utm-registry.ts` (entrada `ads-meta-2608`, teste de 3
 * canais pagos #5845/#5838) — reusado aqui de propósito, não coincidência,
 * porque o lead do formulário instantâneo é o MESMO investimento em Meta
 * Ads que aquele UTM já mede no lado do clique-pro-site. `referringSite` é
 * PRÓPRIO deste worker (`"meta-instant-form"`) — é o campo que separa, na
 * atribuição, quem entrou pelo formulário instantâneo (fica dentro do Meta,
 * nunca visita o site) de quem clicou e converteu no site (medido pelo
 * `referring_site` que o clique carrega).
 *
 * Não importado direto de `scripts/lib/shared/utm-registry.ts` (que
 * declara os 3 campos junto de metadados de painel/descrição, não o
 * shape simples que este worker precisa) — os 3 valores são cópia literal,
 * sincronia garantida por `test/index.test.ts`, que compara este arquivo
 * contra a entrada `ads-meta-2608` do registry (mesmo padrão de
 * `test/utm-registry-mirror.test.ts` para `workers/poll/src/utm-registry.ts`).
 */

/** @see scripts/lib/shared/utm-registry.ts — entrada "ads-meta-2608" */
export const META_LEADS_UTM = {
  source: "meta-ads",
  medium: "paid_social",
  campaign: "ads-meta-2608",
  referringSite: "meta-instant-form",
} as const;
