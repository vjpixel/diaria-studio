/**
 * scripts/lib/mensal/monthly-apoiadores-kit-render.ts (#7633)
 *
 * Variante KIT do envio extra pra apoiadores Mantenedor/Patrono — sucessora
 * de `monthly-apoiadores-brevo-render.ts` (#4593), que por sua vez sucedeu o
 * módulo Beehiiv do #4482. É o TERCEIRO canal da mesma audiência e do mesmo
 * conteúdo. O Beehiiv nunca saiu do papel (bloqueio de plano, #4572); o Brevo
 * enviou 1 edição (ciclo 2607-08, 04/08/2026, 10 entregues — #7655).
 *
 * ## Por que trocar de novo — e por que não é "mais um pivot"
 *
 * A troca anterior foi forçada por bloqueio de plataforma. Esta é
 * consolidação: `publishing.newsletter.backend` virou `"kit"` (#7388), a base
 * inteira migrou da Beehiiv (#7386, 317 → 0 ativos) e a anual já nasceu no
 * Kit (#7569). Manter a Brevo viva só pro envio de apoiadores significaria um
 * 2º ESP, um 2º sync de audiência e um 2º formato de merge tag pra manter —
 * sem nenhum envio real do outro lado pra justificar.
 *
 * ## O que muda em relação ao perfil Brevo (e é TUDO que muda)
 *
 * 1. **Merge tag do voto do "É IA?"** — o Kit usa Liquid próprio,
 *    `{{ subscriber.email_address }}` (confirmado ao vivo no #464, ver
 *    `scripts/lib/kit-broadcasts.ts`), não o `{{ contact.EMAIL }}` da Brevo.
 *    Errar isso é reproduzir o bug do #4510 (100% dos votos daquele canal
 *    chegando com a string literal, rejeitada por `isValidVoteEmailFormat`) —
 *    por isso `MonthlyUtmProfile.pollMergeTag` é uma union fechada, e o campo
 *    é a razão principal deste módulo existir em vez de reusar o perfil Brevo.
 * 2. **`utm_source`** — `mensal-apoiadores-kit`, próprio (ver
 *    `MENSAL_APOIADORES_KIT_UTM_SOURCE` em `shared/utm-registry.ts`).
 * 3. **`pollBrand`** — `mensal-apoiadores-kit`, registrado em `BRAND_INFO`
 *    (`workers/poll/src/lib.ts`) com `leaderboardPeriod: "year"`. Esse
 *    `"year"` NÃO é cosmético: o worker rejeita (400) edição em formato de
 *    ciclo pra brand com leaderboard mensal, então um brand novo mal
 *    configurado quebraria todo voto deste envio — mesma armadilha que o
 *    #4510 documentou pro `mensal-beehiiv`.
 *
 * O resto — filtro de seções Clarice-only, imagens, relink pra edição diária
 * — é idêntico e reusado sem modificação (`filterDraftForApoiadores`,
 * `draftToEmail`), pelo mesmo racional do #4593: são funções sobre CONTEÚDO,
 * sem nada de ESP na forma.
 */
import { draftToEmail, type MonthlyUtmProfile } from "./monthly-render.ts";
import { filterDraftForApoiadores } from "./monthly-draft-filter.ts";
import {
  MENSAL_APOIADORES_KIT_UTM_SOURCE,
  MENSAL_APOIADORES_KIT_UTM_MEDIUM,
  buildMensalApoiadoresKitCampaign,
} from "../shared/utm-registry.ts";

/**
 * Perfil de UTM da variante Kit do envio apoiadores (#7633) — ver docstring
 * do módulo pros 3 campos que diferem do perfil Brevo e por que cada um
 * importa.
 */
export const APOIADORES_KIT_UTM_PROFILE: MonthlyUtmProfile = {
  source: MENSAL_APOIADORES_KIT_UTM_SOURCE,
  medium: MENSAL_APOIADORES_KIT_UTM_MEDIUM,
  buildCampaign: buildMensalApoiadoresKitCampaign,
  // Kit, não Brevo — Liquid próprio (#464). Trocar isto por
  // "{{ contact.EMAIL }}" quebra 100% dos votos deste canal (#4510).
  pollMergeTag: "{{ subscriber.email_address }}",
  pollBrand: "mensal-apoiadores-kit",
};

/**
 * Render completo da variante Kit apoiadores (#7633): filtra o draft
 * (`filterDraftForApoiadores`, reusado sem modificação) e chama o MESMO
 * `draftToEmail` do envio Clarice, só trocando o `utmProfile`. Assinatura
 * idêntica à de `draftToEmailApoiadoresBrevo` de propósito — os dois consomem
 * as MESMAS URLs de imagem já publicadas pelo pipeline Clarice do ciclo (sem
 * upload duplicado).
 */
export function draftToEmailApoiadoresKit(
  draft: string,
  chosenSubject: string | null,
  yymm: string,
  eiaImageUrlA?: string,
  eiaImageUrlB?: string,
  eiaCredit?: string,
  destaqueImageUrls?: Record<number, string>,
  destaqueImageCaption?: string,
  livrosImageUrl?: string,
  eiaPrevResultLine?: string | null,
): { subject: string; previewText: string; html: string } {
  const filtered = filterDraftForApoiadores(draft);
  return draftToEmail(
    filtered,
    chosenSubject,
    yymm,
    eiaImageUrlA,
    eiaImageUrlB,
    eiaCredit,
    destaqueImageUrls,
    destaqueImageCaption,
    livrosImageUrl,
    eiaPrevResultLine,
    APOIADORES_KIT_UTM_PROFILE,
  );
}
