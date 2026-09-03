/**
 * scripts/lib/metrics/ativacao-coorte.ts (#7183, fatia 11 do épico #7172)
 *
 * Ativação de latência curta por coorte de cadastro (safra semanal, BRT):
 * `abertura-1a-edicao` (abriu a 1ª edição recebida) e `primeiro-clique-14d`
 * (clicou em até 14 dias do cadastro). `leitor-v1` (`scripts/lib/leitor.ts`)
 * já responde "quem é leitor", mas com latência de ~28 dias (mín. 20
 * recebidas, cadência seg-sex) — 4x a janela desta métrica. Ver corpo da
 * issue #7183 para a medição completa.
 *
 * ## Módulo PURO, sem I/O
 *
 * Nenhuma função aqui lê disco, SQLite ou rede — mesmo par canônico de
 * `scripts/lib/metrics/acquisition-class.ts` (#7173) e
 * `scripts/lib/metrics/registry.ts` (#7175/#7176): o CHAMADOR (rota do
 * Studio, script CLI) resolve o insumo (store do #6464, backup Beehiiv) e
 * injeta via `AtivacaoCoorteSubscriberInput[]`.
 *
 * ## Não reimplementar "abriu"/"clicou"
 *
 * `deriveBeehiivEventTypes` (`scripts/lib/beehiiv-subscribers-ingest.ts`,
 * #7104) já é a derivação canônica: `status ∈ {opened, clicked}` OU
 * `total_opened > 0` para abertura; `status === "clicked"` OU
 * `total_clicked > 0` para clique — nunca só `status` (51 de 66 linhas
 * `status: "unsubscribed"` do backup têm `total_opened > 0`).
 * `derivarAberturaEClique` abaixo é um wrapper fino, não uma 2ª
 * implementação.
 *
 * ## Denominador único (decisão da issue)
 *
 * As duas métricas compartilham o MESMO denominador: safra de D que
 * **recebeu ≥1 edição** (`recebeuAoMenosUma`). Quem nunca recebeu nada (DOI
 * não confirmado, bounce) não é leitor que deixou de clicar — é entrega que
 * não aconteceu. Sem isso as duas ficam incomparáveis entre si por
 * construção.
 *
 * ## `qualidade` — nunca uma taxa parcial que sobe sozinha
 *
 * - Coorte cujo denominador é 0 (nenhum cadastro recebeu edição ainda) →
 *   `indeterminado`.
 * - Coorte cujo 1º post enviado é 100% stub (#7181 F9 — sem engajamento
 *   confiável) para TODOS os membros → `indeterminado`, nunca `0`.
 * - `primeiro-clique-14d` com QUALQUER membro ainda a menos de 14 dias do
 *   cadastro → `indeterminado` (a coorte inteira, nunca uma taxa parcial).
 * - Resto resolvido mas alguns membros com dado indisponível (post
 *   parcialmente stub) → `piso` (a taxa real só pode ser maior).
 * - `piso` por incerteza de casamento cross-plataforma do store (#6464) usa
 *   `CROSS_PLATFORM_FLOOR_NOTE` (`scripts/lib/diaria-subscribers-identity-resolve.ts`)
 *   como `motivo` — nunca um aviso novo escrito à mão.
 *
 * ## Fronteira de dia/semana em BRT
 *
 * `resolveCohortDayBrt`/`resolveCohortWeekBrt` reusam `unixSecondsToBrtDate`
 * (`scripts/lib/beehiiv-publish-date.ts`) — nunca `toISOString().slice(0,10)`
 * (que vazaria pro dia UTC errado num cadastro às 23h BRT). Semana rotulada
 * pela segunda-feira.
 */

import {
  classifyAcquisition,
  type AcquisitionClass,
  type AcquisitionClassInput,
} from "./acquisition-class.ts";
import { filterInternalAndTestSubscribers } from "../cac.ts";
import { normalizeKey } from "../shared/attribution-keys.ts";
import { unixSecondsToBrtDate } from "../beehiiv-publish-date.ts";
import { CROSS_PLATFORM_FLOOR_NOTE } from "../diaria-subscribers-identity-resolve.ts";
import {
  deriveBeehiivEventTypes,
  type BeehiivEngagementRecord,
} from "../beehiiv-subscribers-ingest.ts";

// ---------------------------------------------------------------------------
// Fronteira de dia/semana BRT
// ---------------------------------------------------------------------------

/** `created` (epoch seconds UTC) → `YYYY-MM-DD` BRT. Reusa
 *  `unixSecondsToBrtDate`, nunca `toISOString().slice(0,10)`. @pure */
export function resolveCohortDayBrt(createdEpochSeconds: number): string {
  return unixSecondsToBrtDate(createdEpochSeconds);
}

/** `created` (epoch seconds UTC) → segunda-feira `YYYY-MM-DD` (BRT) da
 *  semana que contém o cadastro — rótulo da safra semanal. @pure */
export function resolveCohortWeekBrt(createdEpochSeconds: number): string {
  const day = resolveCohortDayBrt(createdEpochSeconds);
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=domingo..6=sábado
  const deltaToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + deltaToMonday);
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// "abriu"/"clicou" — wrapper fino sobre deriveBeehiivEventTypes (não reimplementar)
// ---------------------------------------------------------------------------

/** `abriu`/`clicou` de 1 registro de engajamento Beehiiv, via a derivação
 *  canônica de #7104 — nunca reimplementada aqui. @pure */
export function derivarAberturaEClique(record: BeehiivEngagementRecord): {
  abriu: boolean;
  clicou: boolean;
} {
  const types = deriveBeehiivEventTypes(record);
  return { abriu: types.includes("open"), clicou: types.includes("click") };
}

// ---------------------------------------------------------------------------
// created mais antigo entre snapshots (reativação reseta `created`)
// ---------------------------------------------------------------------------

/** O `created` mais ANTIGO visto para o mesmo e-mail entre snapshots — a
 *  reativação Beehiiv (DELETE+CREATE) troca `id` e `created`, então ler só o
 *  snapshot mais recente fabrica cadastro novo em quem só foi reativado.
 *  @pure */
export function resolveEarliestCreated(candidatesEpochSeconds: readonly number[]): number {
  if (candidatesEpochSeconds.length === 0) {
    throw new Error("resolveEarliestCreated: nenhum candidato — chamador não deveria ter chamado sem snapshot");
  }
  return Math.min(...candidatesEpochSeconds);
}

// ---------------------------------------------------------------------------
// Exclusão de import em massa — critério é utm_channel, nunca data hardcoded
// ---------------------------------------------------------------------------

/** `true` quando o registro é import em massa (`utm_channel === "import"`)
 *  — mesmo critério do Kit em #7176, nunca uma data hardcoded. O caso
 *  conhecido do lado Beehiiv (2025-09-02, 34/36 registros `import` do
 *  snapshot) é evidência de que o critério casa, não um filtro à parte.
 *  @pure */
export function isBulkImport(utmChannel: string | null | undefined): boolean {
  return normalizeKey(utmChannel) === "import";
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const FOURTEEN_DAYS_SECONDS = 14 * 24 * 3600;

export interface AtivacaoCoorteSubscriberInput {
  email: string;
  /** Epoch seconds UTC — o `created` mais ANTIGO visto pra este e-mail entre
   *  snapshots (`resolveEarliestCreated`). */
  created: number;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_channel?: string | null;
  referring_site?: string | null;
  /** Denominador comum às 2 métricas: recebeu ≥1 edição desde o cadastro. */
  recebeuAoMenosUma: boolean;
  /** `false` quando o 1º post enviado depois de `created` é 100% stub
   *  (#7181 F9) — sem dado de engajamento confiável pra este assinante
   *  nesta janela. Quando `false`, `abriuPrimeiraEdicao` e
   *  `diasAtePrimeiroClique` são ignorados (o assinante entra no
   *  denominador mas fica fora do numerador resolvido). */
  primeiraEdicaoDadosDisponiveis: boolean;
  /** Só válido quando `primeiraEdicaoDadosDisponiveis === true`. */
  abriuPrimeiraEdicao: boolean;
  /** Dias corridos entre `created` e o 1º clique; `null` = nunca clicou (ou
   *  ainda não, se a coorte não maturou). Só válido quando
   *  `primeiraEdicaoDadosDisponiveis === true`. */
  diasAtePrimeiroClique: number | null;
}

function applyExclusions(
  records: readonly AtivacaoCoorteSubscriberInput[],
): AtivacaoCoorteSubscriberInput[] {
  const { kept } = filterInternalAndTestSubscribers(records as AtivacaoCoorteSubscriberInput[]);
  return kept.filter((r) => !isBulkImport(r.utm_channel));
}

function toClassInput(r: AtivacaoCoorteSubscriberInput): AcquisitionClassInput {
  return {
    utm_source: r.utm_source,
    utm_medium: r.utm_medium,
    utm_channel: r.utm_channel,
    referring_site: r.referring_site,
    created: r.created,
  };
}

// ---------------------------------------------------------------------------
// Resultado por classe (decomposição, ambas as métricas)
// ---------------------------------------------------------------------------

export interface AtivacaoCoorteClassAggregate {
  denom: number;
  numeradorResolvido: number;
  naoResolvidos: number;
}

export type AtivacaoCoortePorClasse = Record<AcquisitionClass, AtivacaoCoorteClassAggregate>;

function emptyPorClasse(): AtivacaoCoortePorClasse {
  return {
    pago: { denom: 0, numeradorResolvido: 0, naoResolvidos: 0 },
    reativacao: { denom: 0, numeradorResolvido: 0, naoResolvidos: 0 },
    iniciativa: { denom: 0, numeradorResolvido: 0, naoResolvidos: 0 },
    organico: { denom: 0, numeradorResolvido: 0, naoResolvidos: 0 },
    indeterminado: { denom: 0, numeradorResolvido: 0, naoResolvidos: 0 },
  };
}

export type AtivacaoCoorteQualidade = "exato" | "piso" | "indeterminado";

export interface AtivacaoCoorteResult {
  qualidade: AtivacaoCoorteQualidade;
  motivo: string | null;
  /** `null` quando `qualidade === 'indeterminado'`. */
  valor: number | null;
  denom: number;
  porClasse: AtivacaoCoortePorClasse;
}

// ---------------------------------------------------------------------------
// abertura-1a-edicao
// ---------------------------------------------------------------------------

/**
 * `abertura-1a-edicao(coorte)` = abriram a 1ª edição recebida ÷ safra que
 * recebeu ≥1 edição (denominador). Membros com
 * `primeiraEdicaoDadosDisponiveis === false` (post 100% stub) contam no
 * denominador mas ficam fora do numerador resolvido — se TODOS os membros
 * elegíveis forem assim, `indeterminado`; se só ALGUNS, `piso` (a taxa real
 * só pode ser maior).
 *
 * @pure
 */
export function computeAberturaPrimeiraEdicao(
  records: readonly AtivacaoCoorteSubscriberInput[],
): AtivacaoCoorteResult {
  const kept = applyExclusions(records);
  const universe = kept.filter((r) => r.recebeuAoMenosUma);
  const porClasse = emptyPorClasse();
  for (const r of universe) {
    const cls = classifyAcquisition(toClassInput(r));
    porClasse[cls].denom++;
    if (r.primeiraEdicaoDadosDisponiveis) {
      if (r.abriuPrimeiraEdicao) porClasse[cls].numeradorResolvido++;
    } else {
      porClasse[cls].naoResolvidos++;
    }
  }
  if (universe.length === 0) {
    return {
      qualidade: "indeterminado",
      motivo: "nenhum cadastro desta safra recebeu edição ainda",
      valor: null,
      denom: 0,
      porClasse,
    };
  }
  const resolvidos = universe.filter((r) => r.primeiraEdicaoDadosDisponiveis);
  const naoResolvidos = universe.length - resolvidos.length;
  if (resolvidos.length === 0) {
    return {
      qualidade: "indeterminado",
      motivo:
        "1º post enviado desta safra é 100% stub (#7181 F9) — sem dado de abertura confiável pra nenhum membro",
      valor: null,
      denom: universe.length,
      porClasse,
    };
  }
  const abertos = resolvidos.filter((r) => r.abriuPrimeiraEdicao).length;
  const valor = abertos / universe.length;
  if (naoResolvidos > 0) {
    return {
      qualidade: "piso",
      motivo: `${naoResolvidos}/${universe.length} membros com 1º post 100% stub (#7181 F9) — taxa real só pode ser maior`,
      valor,
      denom: universe.length,
      porClasse,
    };
  }
  return { qualidade: "exato", motivo: null, valor, denom: universe.length, porClasse };
}

// ---------------------------------------------------------------------------
// primeiro-clique-14d
// ---------------------------------------------------------------------------

/**
 * `primeiro-clique-14d(coorte)` = ≥1 clique com `ts ≤ created + 14 dias` ÷
 * safra que recebeu ≥1 edição (mesmo denominador de `abertura-1a-edicao`).
 * A coorte inteira devolve `indeterminado` enquanto QUALQUER membro do
 * denominador ainda não tiver completado 14 dias de casa — nunca uma taxa
 * parcial que sobe sozinha com o passar dos dias.
 *
 * @param nowEpochSeconds injetável — "agora" pro cálculo de maturação.
 * @pure
 */
export function computePrimeiroClique14d(
  records: readonly AtivacaoCoorteSubscriberInput[],
  nowEpochSeconds: number,
): AtivacaoCoorteResult {
  const kept = applyExclusions(records);
  const universe = kept.filter((r) => r.recebeuAoMenosUma);
  const porClasse = emptyPorClasse();
  if (universe.length === 0) {
    return {
      qualidade: "indeterminado",
      motivo: "nenhum cadastro desta safra recebeu edição ainda",
      valor: null,
      denom: 0,
      porClasse,
    };
  }
  const imaturo = universe.some((r) => nowEpochSeconds - r.created < FOURTEEN_DAYS_SECONDS);
  if (imaturo) {
    return {
      qualidade: "indeterminado",
      motivo: "coorte com menos de 14 dias de maturação — pelo menos 1 membro ainda dentro da janela",
      valor: null,
      denom: universe.length,
      porClasse,
    };
  }
  for (const r of universe) {
    const cls = classifyAcquisition(toClassInput(r));
    porClasse[cls].denom++;
    if (r.primeiraEdicaoDadosDisponiveis) {
      if (r.diasAtePrimeiroClique !== null && r.diasAtePrimeiroClique <= 14) {
        porClasse[cls].numeradorResolvido++;
      }
    } else {
      porClasse[cls].naoResolvidos++;
    }
  }
  const resolvidos = universe.filter((r) => r.primeiraEdicaoDadosDisponiveis);
  const naoResolvidos = universe.length - resolvidos.length;
  const clicaram = resolvidos.filter(
    (r) => r.diasAtePrimeiroClique !== null && r.diasAtePrimeiroClique <= 14,
  ).length;
  const valor = clicaram / universe.length;
  if (naoResolvidos > 0) {
    return {
      qualidade: "piso",
      motivo: `${naoResolvidos}/${universe.length} membros sem dado de clique confiável (#7181 F9) — taxa real só pode ser maior`,
      valor,
      denom: universe.length,
      porClasse,
    };
  }
  return { qualidade: "exato", motivo: null, valor, denom: universe.length, porClasse };
}

/** Piso por incerteza de casamento cross-plataforma do store (#6464) — reusa
 *  `CROSS_PLATFORM_FLOOR_NOTE`, nunca um aviso novo escrito à mão. Chamador
 *  aplica isto por cima do resultado quando `deps.crossPlatformFloor` (ver
 *  `registry.ts`) for `true`. @pure */
export function applyCrossPlatformFloor(result: AtivacaoCoorteResult): AtivacaoCoorteResult {
  if (result.qualidade === "indeterminado") return result;
  return { ...result, qualidade: "piso", motivo: CROSS_PLATFORM_FLOOR_NOTE };
}

// ---------------------------------------------------------------------------
// Mediana de dias até o 1º clique — complementar, só entre quem clicou
// ---------------------------------------------------------------------------

/** Mediana de `diasAtePrimeiroClique` entre quem clicou dentro dos 14 dias
 *  (após as mesmas exclusões). `null` quando ninguém clicou (não confundir
 *  com 0 dias). @pure */
export function medianDiasAteClique(records: readonly AtivacaoCoorteSubscriberInput[]): number | null {
  const kept = applyExclusions(records);
  const dias = kept
    .filter((r) => r.recebeuAoMenosUma && r.primeiraEdicaoDadosDisponiveis)
    .map((r) => r.diasAtePrimeiroClique)
    .filter((d): d is number => d !== null && d <= 14)
    .sort((a, b) => a - b);
  if (dias.length === 0) return null;
  const mid = Math.floor(dias.length / 2);
  return dias.length % 2 === 0 ? (dias[mid - 1] + dias[mid]) / 2 : dias[mid];
}
