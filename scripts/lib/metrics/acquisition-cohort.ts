/**
 * scripts/lib/metrics/acquisition-cohort.ts (#7916, fatia 2/N)
 *
 * Tabela de coorte de aquisição — agrupa CADASTROS (não eventos de
 * engajamento) por dia BRT × classe de aquisição × `utm_source`, sobre o
 * store unificado de `scripts/lib/diaria-subscribers-db.ts` (épico #6464).
 * Completa o critério de aceite da issue "Há relatório na UI do Studio por
 * origem/coorte com denominadores, período BRT e idade da coorte
 * explícitos" — sem fechar a issue inteira (ver corpo da PR pra o que fica
 * pra fatia 3: ligação assinante↔apoiador por identidade e a receita
 * confirmada por coorte).
 *
 * ## Módulo PURO, sem I/O
 *
 * Mesmo padrão de `acquisition-class.ts`/`ativacao-coorte.ts`: nenhuma
 * função aqui abre `db` — o chamador (`scripts/studio-ui/studio-subscribers.ts`)
 * resolve o insumo a partir do store e injeta via `CohortSubscriberInput[]`.
 *
 * ## Reusa `classifyAcquisition`, não reimplementa
 *
 * A classe de aquisição (`pago`/`reativacao`/`iniciativa`/`organico`/
 * `indeterminado`) vem de `acquisition-class.ts` (#7173) — mesma tabela que
 * já resolve a ambiguidade `utm_source=linkedin*`/boost/reativação
 * documentada lá. Este módulo só agrupa por (dia, classe, utm_source), não
 * decide classe.
 *
 * ## "Confirmado" só existe onde a plataforma expõe o dado — nunca fabricado
 *
 * Double opt-in (DOI) só é uma distinção real e observável hoje no Kit:
 * `subscription.status` do Kit é o estado nativo `active`/`inactive` da API
 * (`kit-subscribers.ts` — `inactive` é literalmente "aguardando confirmação
 * de e-mail", não um estado de saída). Beehiiv e Brevo NÃO expõem essa
 * distinção — `status` ali reflete saída do roster (unsubscribed/invalid),
 * não confirmação de assinatura pendente (ver docstring de
 * `beehiiv-subscribers-ingest.ts`/`brevo-subscribers-ingest.ts`). Por isso
 * `confirmedKit`/`unconfirmedKit` abaixo são `null` — nunca `0` — quando
 * NENHUM membro do grupo tem `subscription` no Kit: `0` afirmaria "zero
 * confirmados", que é uma medição; `null` diz "esta pergunta não se aplica
 * aqui", que é a verdade. A issue #7916 pede exatamente este tratamento:
 * "se o dado de confirmação não estiver disponível, documente a lacuna em
 * vez de simular".
 *
 * ## Denominador: 1 linha por SUBSCRIBER (identidade resolvida), não por
 * `subscription`
 *
 * Um assinante presente em 2-3 plataformas (Beehiiv + Kit, por exemplo)
 * conta 1 vez neste relatório — o chamador já entrega 1
 * `CohortSubscriberInput` por `subscriber_id` resolvido (usando a data de
 * entrada mais antiga entre as `subscription` da pessoa e a atribuição
 * cross-plataforma de `resolveSubscriberAttribution`), nunca 1 linha por
 * `subscription`. Contar por `subscription` infla o cadastro de quem
 * migrou de plataforma como 2 cadastros novos — mesmo cuidado que
 * `getStoreCounts`/`computeSubscriptionCoverage` já documentam pra
 * cobertura (#7294).
 */

import { classifyAcquisition, type AcquisitionClass, type AcquisitionClassInput } from "./acquisition-class.ts";
import { unixSecondsToBrtDate } from "../beehiiv-publish-date.ts";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Mesmo union de `kit-subscribers.ts` (`state`) — o contrato documentado
 *  da API do Kit pros 5 estados nativos de `subscription`. Um valor fora
 *  deste union (API muda, dado corrompido) nunca quebra
 *  `buildAcquisitionCohortTable`: cai no `else` da checagem `active`/
 *  `inactive` (ver `CohortSubscriberInput.kitStatus`), contando pra `total`
 *  sem contar pra `confirmedKit`/`unconfirmedKit` — o mesmo tratamento que
 *  `"cancelled"`/`"bounced"`/`"complained"` já recebem. Por isso o cast em
 *  `studio-subscribers.ts` (de `SubscriptionRecord.status: string | null`
 *  pra este union) é seguro mesmo sem um narrowing em runtime: o pior caso
 *  de um valor desconhecido é o mesmo dos 3 estados "sem sinal
 *  confirmado/pendente" que já existem por desenho. */
export type KitSubscriptionStatus = "active" | "cancelled" | "bounced" | "complained" | "inactive";

export interface CohortSubscriberInput {
  /** ISO 8601 — a data de cadastro (mais antiga entre as `subscription` do
   *  subscriber resolvido). */
  enteredAt: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmChannel: string | null;
  referringSite: string | null;
  /** Estado NATIVO da `subscription` Kit desta pessoa, ou `null` quando esta
   *  pessoa não tem `subscription` no Kit — nesse caso a distinção
   *  confirmado/pendente simplesmente não existe pra ela (ver docstring do
   *  módulo). Só `"active"`/`"inactive"` alimentam
   *  `confirmedKit`/`unconfirmedKit`; `"cancelled"`/`"bounced"`/
   *  `"complained"` contam pra `total` (o sinal Kit existe) mas não pra
   *  nenhum dos dois — um `0` real, nunca `null` fabricado, quando só esses
   *  estados aparecem no grupo. */
  kitStatus: KitSubscriptionStatus | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CohortRow {
  /** `YYYY-MM-DD`, BRT (UTC-3 fixo, `unixSecondsToBrtDate`). */
  day: string;
  utmSource: string | null;
  acquisitionClass: AcquisitionClass;
  /** Cadastros (subscribers resolvidos) neste grupo — o denominador. */
  total: number;
  /** Contagem com `kitStatus === "active"` — `null` quando nenhum membro
   *  do grupo tem `subscription` Kit (distinção não observável aqui, ver
   *  docstring do módulo). Nunca `0` fabricado. */
  confirmedKit: number | null;
  /** Contagem com `kitStatus === "inactive"` (DOI pendente) — mesma regra
   *  de `null` acima. */
  unconfirmedKit: number | null;
}

/** ISO 8601 → dia BRT (`YYYY-MM-DD`), via `unixSecondsToBrtDate` — nunca
 *  `toISOString().slice(0,10)`, que vazaria pro dia UTC errado num cadastro
 *  de madrugada BRT (mesmo cuidado de `resolveCohortDayBrt` em
 *  `ativacao-coorte.ts`, que opera sobre epoch seconds em vez de ISO). @pure */
export function isoToBrtDay(iso: string): string {
  const epochSeconds = Math.floor(new Date(iso).getTime() / 1000);
  return unixSecondsToBrtDate(epochSeconds);
}

/**
 * Agrupa `subscribers` por (dia de cadastro BRT, classe de aquisição,
 * `utm_source`) e conta confirmado/não-confirmado no Kit onde observável.
 * Ordenado por dia ascendente, depois `total` descendente dentro do dia —
 * resposta pronta pra render sem o caller reordenar. @pure
 */
export function buildAcquisitionCohortTable(
  subscribers: readonly CohortSubscriberInput[],
): CohortRow[] {
  interface Bucket {
    day: string;
    utmSource: string | null;
    acquisitionClass: AcquisitionClass;
    total: number;
    confirmedKit: number;
    unconfirmedKit: number;
    /** `true` se QUALQUER membro do bucket tem `kitStatus` não-nulo — só
     *  então `confirmedKit`/`unconfirmedKit` deixam de ser reportados como
     *  `null` na saída. */
    hasKitSignal: boolean;
  }

  const buckets = new Map<string, Bucket>();

  for (const sub of subscribers) {
    const day = isoToBrtDay(sub.enteredAt);
    const epochSeconds = Math.floor(new Date(sub.enteredAt).getTime() / 1000);
    const classInput: AcquisitionClassInput = {
      utm_source: sub.utmSource,
      utm_medium: sub.utmMedium,
      utm_channel: sub.utmChannel,
      referring_site: sub.referringSite,
      created: epochSeconds,
    };
    const acquisitionClass = classifyAcquisition(classInput);
    const key = `${day}|${acquisitionClass}|${sub.utmSource ?? " "}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        day,
        utmSource: sub.utmSource,
        acquisitionClass,
        total: 0,
        confirmedKit: 0,
        unconfirmedKit: 0,
        hasKitSignal: false,
      };
      buckets.set(key, bucket);
    }

    bucket.total++;
    if (sub.kitStatus != null) {
      bucket.hasKitSignal = true;
      if (sub.kitStatus === "active") bucket.confirmedKit++;
      else if (sub.kitStatus === "inactive") bucket.unconfirmedKit++;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => (a.day === b.day ? b.total - a.total : a.day < b.day ? -1 : 1))
    .map(({ hasKitSignal, ...rest }) => ({
      ...rest,
      confirmedKit: hasKitSignal ? rest.confirmedKit : null,
      unconfirmedKit: hasKitSignal ? rest.unconfirmedKit : null,
    }));
}
