/**
 * scripts/lib/metrics/apoiador-link.ts (#7916, fatia 5/N)
 *
 * Liga assinante↔apoiador POR IDENTIDADE (e-mail) e agrega o resultado na
 * MESMA grade de coorte (dia de cadastro BRT × classe de aquisição ×
 * `utm_source`) que `acquisition-cohort.ts` já usa — completa o critério de
 * aceite restante da issue "receita confirmada por coorte, tempo até
 * primeiro apoio".
 *
 * ## Módulo PURO, sem I/O
 *
 * Mesmo padrão de `acquisition-cohort.ts`/`ativacao-coorte.ts`: nenhuma
 * função aqui abre `db` nem lê `contacts.jsonl`/cache da apoia.se — o
 * chamador (`scripts/studio-ui/studio-subscribers.ts`) resolve os dois
 * lados (subscribers via `diaria-subscribers-db.ts`, apoiadores via
 * `loadContacts`/`readMonthCache`/`readPastMonthSnapshots` de
 * `apoio-contacts-store.ts`/`apoia-se.ts`/`studio-apoios.ts`) e injeta aqui
 * já resolvido.
 *
 * ## Vínculo é por E-MAIL, com limitações documentadas — nunca fabricadas
 *
 * A apoia.se não tem endpoint de listagem nem ID cruzável com o resto da
 * base (só `GET /backers/charges/{email}`, ver docstring de `apoia-se.ts`)
 * — o único jeito de saber "este assinante é este apoiador" é casar e-mail
 * normalizado (trim + lowercase). Duas lacunas reais, ambas documentadas em
 * vez de escondidas:
 *
 * 1. **Um apoiador pode ter cadastrado o apoio com um e-mail diferente do
 *    que usa pra assinar a newsletter.** Sem outro identificador cruzável,
 *    essa pessoa aparece como "não-apoiador" na coorte — subestimativa
 *    conhecida, não um bug deste módulo.
 * 2. **`firstConfirmedAt` é uma APROXIMAÇÃO** (ver `LinkableApoiador` abaixo)
 *    — a apoia.se não expõe a data real do 1º pagamento, só o status do MÊS
 *    CORRENTE (`checkBacker`) e snapshots mensais passados. O proxy mais
 *    fiel disponível hoje é `ApoioContact.createdAt` (quando o CRM local
 *    registrou a pessoa como apoiador confirmado, via drain do Gmail —
 *    tipicamente minutos/horas depois do pagamento real, nunca antes).
 *
 * ## `currentMonthlyValue` — nunca `0` fabricado quando não-observável
 *
 * Um apoiador vinculado que NÃO está pagando este mês (parou, ou nunca teve
 * o mês corrente checado) tem `currentMonthlyValue: null` — não `0`. Zero
 * afirmaria "confirmado que não paga nada agora", que é uma medição mais
 * forte do que "não temos confirmação de pagamento este mês" quando o dado
 * simplesmente não foi consultado ainda. A soma agregada por coorte
 * (`confirmedMonthlyRevenue`) trata `null` como excluído da soma (nunca como
 * zero contribuindo) — ver `buildApoiadorCohortTable`.
 *
 * ## Dias até o 1º apoio: negativo é um caso real, não erro
 *
 * Se `firstConfirmedAt` for ANTERIOR a `enteredAt` (a pessoa já apoiava a
 * campanha antes de assinar a newsletter — perfeitamente possível, apoio via
 * apoia.se e assinatura da newsletter são jornadas independentes), o diff é
 * negativo. `buildApoiadorCohortTable` EXCLUI esses casos da média (que
 * responde "quanto tempo um LEITOR leva até apoiar", não faz sentido
 * incluir quem já apoiava antes de ler) mas os CONTA separadamente em
 * `apoiadoresComApoioAnteriorAoCadastro` — nunca descartados em silêncio.
 */

import { classifyAcquisition, type AcquisitionClass, type AcquisitionClassInput } from "./acquisition-class.ts";
import { isoToBrtDay } from "./acquisition-cohort.ts";

// ---------------------------------------------------------------------------
// Vínculo por e-mail
// ---------------------------------------------------------------------------

export interface LinkableApoiador {
  /** Todos os e-mails conhecidos deste apoiador (`ApoioContact.emails`) —
   *  QUALQUER um deles casando com QUALQUER alias do subscriber conta como
   *  vínculo. */
  emails: readonly string[];
  /** ISO 8601 — proxy documentado de "1º apoio confirmado" (ver docstring
   *  do módulo). Nunca inventado quando ausente — o caller só inclui
   *  apoiadores com este campo presente. */
  firstConfirmedAt: string;
  /** Valor mensal pago pelo apoiador ESTE MÊS (competência corrente),
   *  `null` quando não há confirmação de pagamento este mês (parou, ou
   *  ainda não checado) — nunca `0` fabricado, ver docstring do módulo. */
  currentMonthlyValue: number | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Índice e-mail normalizado → apoiador, pra lookup O(1) por assinante.
 * Colisão (2 apoiadores distintos declarando o mesmo e-mail — não deveria
 * acontecer, `contacts.jsonl` é deduplicado por e-mail na origem, mas dado
 * externo é dado externo): o PRIMEIRO da lista vence, silenciosamente —
 * mesma disciplina de "não lançar por dado de terceiro malformado" do resto
 * da base. @pure
 */
export function buildApoiadorEmailIndex(
  apoiadores: readonly LinkableApoiador[],
): Map<string, LinkableApoiador> {
  const index = new Map<string, LinkableApoiador>();
  for (const apoiador of apoiadores) {
    for (const rawEmail of apoiador.emails) {
      const email = normalizeEmail(rawEmail);
      if (email && !index.has(email)) index.set(email, apoiador);
    }
  }
  return index;
}

/**
 * Vincula um subscriber (pelos e-mails de TODOS os seus aliases
 * cross-plataforma) a um apoiador, se algum e-mail casar. `null` = não é
 * apoiador conhecido (ou nenhum e-mail bateu — ver limitação 1 na docstring
 * do módulo). @pure
 */
export function linkSubscriberToApoiador(
  subscriberEmails: readonly string[],
  index: ReadonlyMap<string, LinkableApoiador>,
): LinkableApoiador | null {
  for (const rawEmail of subscriberEmails) {
    const email = normalizeEmail(rawEmail);
    const match = email ? index.get(email) : undefined;
    if (match) return match;
  }
  return null;
}

/**
 * Diferença em DIAS inteiros (floor) entre duas datas ISO — `to - from`.
 * Pode ser negativo (ver docstring do módulo, seção "dias até o 1º apoio").
 * `NaN` se qualquer uma das duas datas for inválida — o caller (`buildApoiadorCohortTable`)
 * trata isso como "sem dado" (exclui da média, não conta em nenhum bucket de
 * antecedência), nunca propaga `NaN` pro output. @pure
 */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return NaN;
  return Math.floor((toMs - fromMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Tabela de coorte agregada
// ---------------------------------------------------------------------------

export interface CohortApoiadorInput {
  /** ISO 8601 — data de cadastro (mesmo campo de `CohortSubscriberInput`). */
  enteredAt: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmChannel: string | null;
  referringSite: string | null;
  /** Apoiador vinculado a este subscriber (via `linkSubscriberToApoiador`),
   *  ou `null` se nenhum e-mail do subscriber bate com nenhum apoiador
   *  conhecido. */
  apoiador: LinkableApoiador | null;
}

export interface ApoiadorCohortRow {
  /** `YYYY-MM-DD`, BRT — mesma chave de `CohortRow`. */
  day: string;
  utmSource: string | null;
  acquisitionClass: AcquisitionClass;
  /** Cadastros (subscribers resolvidos) neste grupo — o denominador. */
  totalSubscribers: number;
  /** Quantos deles são apoiadores conhecidos (vínculo por e-mail). */
  apoiadores: number;
  /** Dentre os `apoiadores`, quantos apoiavam a campanha ANTES de assinar
   *  a newsletter (`daysToFirstSupport < 0`) — excluídos da média abaixo,
   *  mas contados aqui em vez de descartados (ver docstring do módulo). */
  apoiadoresComApoioAnteriorAoCadastro: number;
  /** Média de dias entre cadastro e 1º apoio confirmado, só sobre
   *  apoiadores com diferença ≥0 — `null` quando não há nenhum caso válido
   *  pra media (nunca `0` fabricado). */
  avgDaysToFirstSupport: number | null;
  /** Soma do valor mensal ATUAL (mês corrente) dos apoiadores vinculados
   *  deste grupo que têm `currentMonthlyValue` conhecido — apoiadores com
   *  valor `null` (não confirmados este mês) são EXCLUÍDOS da soma, nunca
   *  contam como 0. `0` aqui é uma medição real (grupo tem apoiadores
   *  vinculados, mas nenhum paga confirmadamente este mês, ou o grupo não
   *  tem apoiador nenhum) — nunca uma lacuna disfarçada. */
  confirmedMonthlyRevenue: number;
  /** Dentre os `apoiadores`, quantos NÃO têm `currentMonthlyValue`
   *  observável este mês (parou de pagar, ou o mês corrente nunca foi
   *  checado pra este e-mail) — reportado explicitamente pra
   *  `confirmedMonthlyRevenue` acima nunca ser lido como "receita TOTAL dos
   *  apoiadores desta coorte" sem essa ressalva ao lado. */
  apoiadoresSemValorMensalConhecido: number;
}

/**
 * Agrupa `subscribers` por (dia de cadastro BRT, classe de aquisição,
 * `utm_source`) — MESMA chave de `buildAcquisitionCohortTable` — e agrega
 * o vínculo com apoiadores por bucket. Ordenado igual: dia ascendente,
 * depois `totalSubscribers` descendente dentro do dia.
 *
 * `enteredAt` inválido (`isoToBrtDay` devolve `null`) exclui o subscriber
 * do resultado — nunca lança — e conta em `.subscribersWithInvalidEnteredAt`
 * (mesmo padrão de `buildAcquisitionCohortTable`). @pure
 */
export function buildApoiadorCohortTable(
  subscribers: readonly CohortApoiadorInput[],
): ApoiadorCohortRow[] & { subscribersWithInvalidEnteredAt: number } {
  interface Bucket {
    day: string;
    utmSource: string | null;
    acquisitionClass: AcquisitionClass;
    totalSubscribers: number;
    apoiadores: number;
    apoiadoresComApoioAnteriorAoCadastro: number;
    /** Soma bruta + contagem válida — a média sai só no map final. */
    daysToFirstSupportSum: number;
    daysToFirstSupportCount: number;
    confirmedMonthlyRevenue: number;
    apoiadoresSemValorMensalConhecido: number;
  }

  const buckets = new Map<string, Bucket>();
  let subscribersWithInvalidEnteredAt = 0;

  for (const sub of subscribers) {
    const day = isoToBrtDay(sub.enteredAt);
    if (day == null) {
      subscribersWithInvalidEnteredAt++;
      continue;
    }
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
        totalSubscribers: 0,
        apoiadores: 0,
        apoiadoresComApoioAnteriorAoCadastro: 0,
        daysToFirstSupportSum: 0,
        daysToFirstSupportCount: 0,
        confirmedMonthlyRevenue: 0,
        apoiadoresSemValorMensalConhecido: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.totalSubscribers++;

    if (sub.apoiador) {
      bucket.apoiadores++;
      // `daysBetweenIso(enteredAt, firstConfirmedAt)` = "apoio - cadastro"
      // (dias ATÉ o apoio; positivo = apoiou depois de assinar), semântica
      // documentada de `avgDaysToFirstSupport` acima.
      const diffDays = daysBetweenIso(sub.enteredAt, sub.apoiador.firstConfirmedAt);
      if (!Number.isNaN(diffDays)) {
        if (diffDays < 0) {
          bucket.apoiadoresComApoioAnteriorAoCadastro++;
        } else {
          bucket.daysToFirstSupportSum += diffDays;
          bucket.daysToFirstSupportCount++;
        }
      }

      if (sub.apoiador.currentMonthlyValue != null) {
        bucket.confirmedMonthlyRevenue += sub.apoiador.currentMonthlyValue;
      } else {
        bucket.apoiadoresSemValorMensalConhecido++;
      }
    }
  }

  const rows = [...buckets.values()]
    .sort((a, b) => (a.day === b.day ? b.totalSubscribers - a.totalSubscribers : a.day < b.day ? -1 : 1))
    .map(({ daysToFirstSupportSum, daysToFirstSupportCount, ...rest }) => ({
      ...rest,
      avgDaysToFirstSupport:
        daysToFirstSupportCount > 0 ? daysToFirstSupportSum / daysToFirstSupportCount : null,
    })) as ApoiadorCohortRow[] & { subscribersWithInvalidEnteredAt: number };
  rows.subscribersWithInvalidEnteredAt = subscribersWithInvalidEnteredAt;
  return rows;
}
