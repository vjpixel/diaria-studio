/**
 * scripts/lib/ads-test-run-state.ts (#5845)
 *
 * Tipos + lógica PURA em torno de `data/aquisicao/teste-2608/run-state.json`
 * — o pré-registro único e imutável do D0 do teste de 3 canais pagos
 * (#5524). Ver `scripts/ads-test-d0.ts` (I/O — grava o arquivo) e
 * `scripts/ads-test-watch.ts` (I/O — lê o arquivo todo dia).
 *
 * ## Por que imutável
 *
 * `00-PROTOCOLO.md` §7.1 exige a data de apuração pré-registrada, não
 * escolhida depois — é o que impede uma leitura antecipada favorável (ou
 * desfavorável) a um braço de virar "a" data de apuração com o benefício
 * da retrospectiva. O arquivo grava TODAS as datas derivadas de uma vez,
 * na hora do D0, e nunca deveria mudar depois — regravar exige `--force` +
 * motivo explícito (ver {@link planRunStateWrite}), registrado num
 * histórico, nunca uma sobrescrita silenciosa.
 */

import { deriveAdsTestSchedule, type AdsTestSchedule, type DateOnlyString } from "./ads-test-schedule.ts";

/** Os 3 braços do teste 2608 — nomes de canal EXATOS que já vivem em
 *  `CHANNEL_GROUP_KEYS` (`scripts/lib/cac.ts`) e nas linhas de `spend.csv`
 *  do teste (§8.2 do protocolo). Não é uma constante arbitrária: mudar
 *  esses nomes aqui sem mudar os dois lugares acima quebra a atribuição. */
export const ADS_TEST_2608_BRACOS = [
  "Google Ads (teste 2608)",
  "Microsoft Ads (teste 2608)",
  "Meta Ads (teste 2608)",
] as const;

/** Um intervalo de PAUSA de veiculação (campanha desativada nos 3 braços) —
 *  `desde`/`ate` inclusivos, mesma convenção `YYYY-MM-DD` do resto do
 *  módulo. Formato ANTIGO (pré-#8240), só por DATA — nenhuma pausa real do
 *  teste 2608 usa mais este shape hoje (a pausa 09/09→17/09 foi gravada em
 *  `revisao.pausa`, com hora — ver abaixo), mas segue aceito por
 *  retrocompatibilidade. */
export interface AdsTestPause {
  desde: DateOnlyString;
  ate: DateOnlyString;
}

/** Revisão OPCIONAL do cronograma derivado — registra pausas de veiculação
 *  que `deriveAdsTestSchedule` não sabe (ela só conhece D0, nunca eventos
 *  supervenientes). Ausente = comportamento de sempre (dias corridos,
 *  #8210 Bug 4b: era a única leitura possível antes desta revisão existir).
 *  Presente = `buildTestStateTiles` (`ads-campaign-economics.ts`) desconta
 *  os dias pausados da contagem de "dias de veiculação real", sem alterar
 *  `d0`/`fim_janela`/os demais marcos derivados. */
export interface AdsTestRunStateRevisao {
  /** Formato ANTIGO — ver {@link AdsTestPause}. */
  pausas?: readonly AdsTestPause[];
  /** Formato ATUAL (#8240/#8241/#8262/#8242) — 1 intervalo de pausa (ou
   *  lista, para uma 2ª pausa futura) com timestamp ISO COM hora (não só
   *  data). `unknown` aqui de propósito: quem interpreta a forma exata
   *  (`inicio`/`fim`/`inicio_por_braco`) é `AdsTestPauseField`/
   *  `AdsTestRunStateWithPause` em `ads-test-pause-window.ts` — este
   *  arquivo só valida que, quando presente, tem a forma mínima de um
   *  intervalo (ver {@link assertValidRunState}), sem duplicar aquele
   *  tipo. */
  pausa?: unknown;
  /** Metadados livres de auditoria de uma regravação de revisão — nunca
   *  validados em detalhe aqui (não afetam nenhum cálculo, só leitura
   *  humana/relatório). */
  em?: string;
  motivo?: string;
  valores_anteriores?: Record<string, unknown>;
}

export interface AdsTestRunState extends AdsTestSchedule {
  bracos: readonly string[];
  /** Timestamp ISO de quando o arquivo foi gravado (não confundir com
   *  `d0` — este é "quando registramos", aquele é "quando acende"). */
  registrado_em: string;
  /** Ver {@link AdsTestRunStateRevisao} — `undefined` no caso comum (teste
   *  sem pausa registrada ainda). */
  revisao?: AdsTestRunStateRevisao;
}

/** Uma entrada do histórico de regravações (`run-state-history.jsonl`) —
 *  o estado ANTERIOR à sobrescrita, mais o motivo e quando foi regravado.
 *  Nunca apagado; o arquivo cresce só por append. */
export interface AdsTestRunStateHistoryEntry {
  previous_state: AdsTestRunState;
  overwritten_at: string;
  reason: string;
}

/**
 * Constrói o `AdsTestRunState` completo a partir do D0 e (opcionalmente) um
 * clock injetável — nunca `Date.now()` direto, pra manter isto puro e
 * testável com tempo controlado.
 *
 * @pure
 */
export function buildAdsTestRunState(
  d0: DateOnlyString,
  nowIso: string,
  bracos: readonly string[] = ADS_TEST_2608_BRACOS,
): AdsTestRunState {
  const schedule = deriveAdsTestSchedule(d0);
  return { ...schedule, bracos, registrado_em: nowIso };
}

/** Resultado de {@link planRunStateWrite} — o script (I/O) decide o que
 *  fazer com base nisto, nunca reimplementa a decisão. */
export type RunStateWritePlan =
  | { action: "write"; state: AdsTestRunState }
  | { action: "refuse-exists-no-force"; existing: AdsTestRunState }
  | { action: "write-with-history"; state: AdsTestRunState; historyEntry: AdsTestRunStateHistoryEntry }
  | { action: "refuse-force-without-reason"; existing: AdsTestRunState };

/**
 * Decide o que fazer ao tentar gravar `run-state.json`:
 *
 * - Arquivo ainda não existe → grava direto (`"write"`).
 * - Arquivo já existe, sem `--force` → recusa (`"refuse-exists-no-force"`) —
 *   é o que torna o arquivo imutável por padrão.
 * - Arquivo já existe, `--force` mas sem `reason` → recusa
 *   (`"refuse-force-without-reason"`) — regravar sem motivo registrado não
 *   é permitido; o motivo é o que preserva a auditabilidade da §7.1.
 * - Arquivo já existe, `--force` COM `reason` → grava, mas primeiro produz
 *   a entrada de histórico com o estado anterior completo
 *   (`"write-with-history"`) — o caller (I/O) faz o append antes do
 *   overwrite, nunca depois (senão uma falha entre os dois passos perderia
 *   o histórico).
 *
 * @pure
 */
export function planRunStateWrite(
  existing: AdsTestRunState | null,
  next: AdsTestRunState,
  opts: { force: boolean; reason: string | null; nowIso: string },
): RunStateWritePlan {
  if (existing == null) {
    return { action: "write", state: next };
  }
  if (!opts.force) {
    return { action: "refuse-exists-no-force", existing };
  }
  if (!opts.reason || opts.reason.trim() === "") {
    return { action: "refuse-force-without-reason", existing };
  }
  return {
    action: "write-with-history",
    state: next,
    historyEntry: { previous_state: existing, overwritten_at: opts.nowIso, reason: opts.reason.trim() },
  };
}

/** Valida a forma mínima de um JSON lido do disco como `AdsTestRunState` —
 *  usado pelo I/O layer antes de confiar no conteúdo (arquivo pode ter sido
 *  editado à mão / corrompido pelo sync do OneDrive). Lança com mensagem
 *  explicativa em vez de deixar um `undefined` se propagar silenciosamente
 *  pros cálculos de fase. */
export function assertValidRunState(raw: unknown): asserts raw is AdsTestRunState {
  if (raw == null || typeof raw !== "object") {
    throw new Error("ads-test-run-state: run-state.json não é um objeto JSON válido.");
  }
  const r = raw as Record<string, unknown>;
  const requiredDateFields = ["d0", "fim_janela", "religar_brevo", "coorte_madura", "apuracao_snapshot"] as const;
  for (const field of requiredDateFields) {
    if (typeof r[field] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r[field] as string)) {
      throw new Error(`ads-test-run-state: campo "${field}" ausente ou não é uma data YYYY-MM-DD válida.`);
    }
  }
  if (!Array.isArray(r.bracos) || r.bracos.length === 0 || !r.bracos.every((b) => typeof b === "string")) {
    throw new Error('ads-test-run-state: campo "bracos" ausente ou não é uma lista de strings não-vazia.');
  }
  if (typeof r.registrado_em !== "string" || r.registrado_em.trim() === "") {
    throw new Error('ads-test-run-state: campo "registrado_em" ausente ou vazio.');
  }
  if (r.revisao !== undefined) {
    if (typeof r.revisao !== "object" || r.revisao === null) {
      throw new Error('ads-test-run-state: campo "revisao" presente mas não é um objeto.');
    }
    const revisao = r.revisao as Record<string, unknown>;
    // Formato ANTIGO (`pausas`, plural, só por data) — OPCIONAL desde
    // #8242: nenhuma pausa real do teste 2608 usa mais este shape, e
    // exigi-lo incondicionalmente rejeitava o `run-state.json` real (que
    // só tem `pausa`, formato atual, abaixo). Quando presente, a forma
    // continua validada.
    if (revisao.pausas !== undefined) {
      if (!Array.isArray(revisao.pausas)) {
        throw new Error('ads-test-run-state: campo "revisao.pausas" presente mas não é uma lista.');
      }
      for (const pausa of revisao.pausas) {
        if (
          typeof pausa !== "object" ||
          pausa === null ||
          typeof (pausa as Record<string, unknown>).desde !== "string" ||
          typeof (pausa as Record<string, unknown>).ate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test((pausa as Record<string, unknown>).desde as string) ||
          !/^\d{4}-\d{2}-\d{2}$/.test((pausa as Record<string, unknown>).ate as string)
        ) {
          throw new Error('ads-test-run-state: item de "revisao.pausas" precisa de "desde"/"ate" YYYY-MM-DD.');
        }
      }
    }
    // Formato ATUAL (`pausa`, singular ou lista, com hora — #8240/#8241/
    // #8262/#8242) — só a forma mínima é validada aqui (`inicio`
    // obrigatório, ISO string; `fim` ausente/`null`/string; `inicio_por_braco`
    // opcional, mapa de string->string). A interpretação fica em
    // `ads-test-pause-window.ts`, que é quem de fato lê este campo.
    if (revisao.pausa !== undefined && revisao.pausa !== null) {
      const items = Array.isArray(revisao.pausa) ? revisao.pausa : [revisao.pausa];
      for (const item of items) {
        if (typeof item !== "object" || item === null) {
          throw new Error('ads-test-run-state: item de "revisao.pausa" precisa ser um objeto.');
        }
        const iv = item as Record<string, unknown>;
        if (typeof iv.inicio !== "string" || iv.inicio.trim() === "") {
          throw new Error('ads-test-run-state: item de "revisao.pausa" precisa de "inicio" (ISO string).');
        }
        if (iv.fim !== undefined && iv.fim !== null && typeof iv.fim !== "string") {
          throw new Error('ads-test-run-state: "revisao.pausa.fim", quando presente, precisa ser string ou null.');
        }
        if (iv.inicio_por_braco !== undefined) {
          if (typeof iv.inicio_por_braco !== "object" || iv.inicio_por_braco === null || Array.isArray(iv.inicio_por_braco)) {
            throw new Error('ads-test-run-state: "revisao.pausa.inicio_por_braco", quando presente, precisa ser um objeto braço->ISO string.');
          }
          for (const [braco, ts] of Object.entries(iv.inicio_por_braco as Record<string, unknown>)) {
            if (typeof ts !== "string" || ts.trim() === "") {
              throw new Error(`ads-test-run-state: "revisao.pausa.inicio_por_braco.${braco}" precisa ser uma ISO string.`);
            }
          }
        }
      }
    }
  }
}
