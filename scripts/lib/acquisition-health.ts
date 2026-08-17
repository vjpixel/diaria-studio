/**
 * scripts/lib/acquisition-health.ts (#5249)
 *
 * Lógica PURA (sem I/O) do alarme semanal de saúde de aquisição por canal.
 * Opera exclusivamente sobre os snapshots semanais já existentes de
 * `data/beehiiv-backup/` (task `Diaria-Beehiiv-Backup`, #5229) — NENHUMA
 * chamada à API Beehiiv ao vivo (guard de publicação do overnight/develop:
 * este módulo só lê estruturas já carregadas em memória pelo caller).
 *
 * Reusa a definição de leitor-v1 (`scripts/lib/leitor.ts`, #5235 — CTR real
 * = cliques únicos ÷ recebidas, NUNCA `stats.click_rate`, ver a armadilha
 * documentada lá) e o agrupamento por canal (`resolveGroupKey`/`normalizeKey`,
 * `scripts/cohort-engagement.ts`, #4464 — `utm_source` normalizado, com
 * fallback pra `referring_site` quando ausente).
 *
 * ## Os 3 sinais (issue #5249)
 *
 * 1. **Sobrevivência** (ativos ÷ cadastros do canal): alarma se cair abaixo
 *    de um piso absoluto (`survivalFloorPct`) OU cair
 *    `survivalDropPtsAlarm` pontos vs a semana anterior do MESMO canal.
 * 2. **CTR agregado** do canal abaixo da BASE — a mediana dos canais
 *    elegíveis NA MESMA semana (nunca um número fixo congelado, guardrail
 *    explícito da issue) — por `ctrWeeksBelowBase` semanas seguidas
 *    (streak persistido em `AcquisitionHealthState.ctrBelowBaseStreak`).
 * 3. **Volume**: canal conhecido que zera cadastros novos na janela
 *    (`canal_parou`), ou canal nunca visto antes nesta monitoria
 *    (`canal_desconhecido`) — o de maior valor imediato: foi assim que o
 *    SparkLoop (#5255) foi descoberto.
 *
 * ## Guardrails de desenho (issue #5249, aplicados aqui)
 *
 * - **Nunca alarmar com `n` insuficiente**: `amostraPequena`/`amostraVazia`
 *   (mesmo vocabulário de `cohort-engagement.ts`) suprimem o sinal de CTR;
 *   o streak zera nesse caso em vez de carregar um valor obsoleto adiante.
 * - **Nunca alarmar sobre coorte recém-criada**: `amostraNova` (cadastros
 *   abaixo de `cohortMinSize`) suprime sobrevivência E CTR — mas NUNCA
 *   `canal_desconhecido`, que é o oposto: a novidade É o sinal.
 * - **Nunca alarmar `canal_parou` sobre uma transição de volume irrelevante**
 *   (guard 4, #5282): `1 → 0` de um canal de cauda longa esporádico é ruído,
 *   não sinal. `canalParouMinNovosAnterior` exige que a semana anterior
 *   tenha tido pelo menos N cadastros novos antes de considerar o zero desta
 *   semana um "canal parou" real — mesmo espírito de `ctrSampleMin`/
 *   `amostraPequena`, mas aplicado ao volume de `novosNaJanela`, não ao
 *   `amostraConsiderada` do CTR (métricas de base diferentes, guard próprio).
 * - **Comparar sempre contra a base do MESMO período**: a base de CTR é
 *   recalculada a cada rodada (mediana da própria semana), nunca lida de
 *   configuração estática.
 * - **Nunca comparar `novosNaJanela` entre janelas de largura muito
 *   diferente (#5494)**: `canal_parou` compara contagem BRUTA de cadastros
 *   entre a janela atual e a anterior — se um snapshot semanal for pulado
 *   (ex.: task não armada ainda), a janela pode virar 2 dias vs 58 dias, e
 *   9-20 cadastros acumulados em 58 dias parecem "canal secou" quando
 *   comparados contra 2 dias sem nenhum. `windowDays` (calculado em
 *   `computeChannelStats` a partir da janela informada pelo caller) entra em
 *   `detectAcquisitionHealthFindings` e SUPRIME `canal_parou` quando a razão
 *   entre as duas larguras excede `canalParouMaxWindowRatio` — a supressão
 *   fica registrada em `suppressedFindings` (nunca silenciada), não vira
 *   `findings` nem entra no fingerprint de idempotência do e-mail. Preferido
 *   a extrapolar taxa (`novos/dia`): extrapolar 2 dias pra 7 inventa
 *   precisão que o dado não tem.
 *
 * ## Assimetria de streak/known: 1ª execução nunca alarma "canal
 * desconhecido"
 *
 * Mesma lição de `cursos-error-alarm.ts` (#4382) — sem `knownChannels`
 * anterior (state vazio, `lastCheckedSnapshotDate === null`), TODO canal do
 * 1º snapshot pareceria "novo". A 1ª execução só ESTABELECE o baseline
 * (`knownChannels`), sem gerar finding nenhum de `canal_desconhecido`.
 */

import { resolveGroupKey } from "../cohort-engagement.ts";
import { computeCtrPct, LEITOR_V1_THRESHOLDS } from "./leitor.ts";
import type { BeehiivBackupSubscriber } from "./beehiiv-backup-snapshots.ts";

// ---------------------------------------------------------------------------
// Limiares (documentados, ajustáveis via CLI — ver check-acquisition-health.ts)
// ---------------------------------------------------------------------------

export interface AcquisitionHealthThresholds {
  /** Mínimo de cadastros no canal pra suas métricas (sobrevivência/CTR)
   *  serem avaliadas — abaixo disso é "coorte recém-criada" (guard 2).
   *  Mesmo piso numérico do `leitor-v1.receivedMin` (#5235) por consistência
   *  de vocabulário, mas semântica DISTINTA: aqui é contagem de PESSOAS no
   *  canal, não de edições recebidas por pessoa. */
  cohortMinSize: number;
  /** Piso absoluto de sobrevivência (ativos/cadastros, escala 0-100) —
   *  abaixo disso alarma mesmo sem histórico de queda pra comparar. Valor
   *  inicial não-medido (sem dado real disponível nesta sessão) — reavaliar
   *  contra a distribuição real assim que a 1ª rodada rodar. */
  survivalFloorPct: number;
  /** Queda mínima (pontos percentuais) vs a semana anterior do MESMO canal
   *  que já alarma, mesmo com sobrevivência ainda acima do piso. */
  survivalDropPtsAlarm: number;
  /** Piso de `total_received` por assinante pra entrar no denominador do
   *  CTR agregado do canal — mesmo piso de `leitor-v1.receivedMin`. */
  ctrReceivedMin: number;
  /** Amostra mínima de PESSOAS elegíveis (`amostraConsiderada`) pro CTR do
   *  canal ser confiável — abaixo disso é `amostraPequena` (guard 1). Mesmo
   *  piso de `amostra_pequena` em `cohort-engagement.ts` (#4761). */
  ctrSampleMin: number;
  /** Quantas semanas SEGUIDAS abaixo da base disparam o alarme de CTR. */
  ctrWeeksBelowBase: number;
  /** Amostra mínima de cadastros novos na janela ANTERIOR pra uma transição
   *  `N → 0` de `novosNaJanela` contar como `canal_parou` (guard 4, #5282).
   *  Abaixo disso é ruído de canal de cauda longa esporádico (ex.: `1 → 0`),
   *  não um sinal real de canal que parou de entregar. */
  canalParouMinNovosAnterior: number;
  /** Razão máxima ENTRE `windowDays` (largura em dias) da janela atual e da
   *  anterior pra `canal_parou` ainda ser considerado comparável (#5494).
   *  Acima disso (ex.: 2 dias vs 58 dias = razão 29×) o finding é SUPRIMIDO
   *  — a comparação de contagem bruta não é honesta entre janelas de
   *  largura tão diferente. `null`/janela ausente em qualquer um dos dois
   *  lados NUNCA suprime (mantém o comportamento pré-#5494 quando o caller
   *  não informa largura). */
  canalParouMaxWindowRatio: number;
}

export const DEFAULT_ACQUISITION_HEALTH_THRESHOLDS: AcquisitionHealthThresholds = {
  cohortMinSize: 20,
  survivalFloorPct: 30,
  survivalDropPtsAlarm: 10,
  ctrReceivedMin: LEITOR_V1_THRESHOLDS.receivedMin,
  ctrSampleMin: 5,
  ctrWeeksBelowBase: 2,
  canalParouMinNovosAnterior: 3,
  canalParouMaxWindowRatio: 1.5,
};

// ---------------------------------------------------------------------------
// Estatísticas por canal
// ---------------------------------------------------------------------------

export interface ChannelStats {
  channel: string;
  cadastros: number;
  ativos: number;
  /** `null` quando `cadastros === 0` (canal sem nenhum registro nesta lista —
   *  não deveria acontecer na prática, já que o canal só existe se algum
   *  subscriber o referenciou, mas mantém o tipo honesto). */
  sobrevivenciaPct: number | null;
  /** Ativos com `total_received >= ctrReceivedMin` — denominador de pessoas
   *  elegíveis pro CTR agregado. */
  amostraConsiderada: number;
  /** `cadastros < cohortMinSize` — coorte recém-criada, guard 2. */
  amostraNova: boolean;
  /** `0 < amostraConsiderada < ctrSampleMin` — guard 1. */
  amostraPequena: boolean;
  /** `amostraConsiderada === 0` — guard 1 (mutuamente exclusivo com
   *  `amostraPequena`, mesmo padrão de `cohort-engagement.ts`). */
  amostraVazia: boolean;
  /** CTR agregado do canal = Σ cliques únicos ÷ Σ recebidas, sobre os
   *  elegíveis (`amostraConsiderada`). `null` quando `amostraVazia`. */
  ctrAgregadoPct: number | null;
  /** Cadastros com `created` dentro de `(windowSinceEpochExclusive,
   *  windowUntilEpochInclusive]` — `0` quando a janela não foi informada
   *  (ver `computeChannelStats`). */
  novosNaJanela: number;
  /** Largura (em dias, pode ser fracionária) da janela usada pra calcular
   *  `novosNaJanela` — `null` quando `hasWindow` é falso (caller não
   *  informou janela). Constante entre todos os canais de uma mesma chamada
   *  de `computeChannelStats` (#5494 — usado por `detectAcquisitionHealthFindings`
   *  pra suprimir `canal_parou` quando a janela atual e a anterior têm
   *  larguras muito diferentes). */
  windowDays: number | null;
}

/** Pure: agrupa `subscribers` por canal e computa as métricas de saúde.
 *  `windowSinceEpochExclusive`/`windowUntilEpochInclusive` são epoch em
 *  SEGUNDOS (mesma unidade de `BeehiivBackupSubscriber.created`) — `null`
 *  em qualquer um dos dois desliga o cálculo de `novosNaJanela` (fica 0 pra
 *  todo canal), usado quando o caller não tem uma 3ª data de snapshot pra
 *  formar a janela anterior (ver docstring de `check-acquisition-health.ts`
 *  sobre `canal_parou` precisar de 3 snapshots). */
export function computeChannelStats(
  subscribers: BeehiivBackupSubscriber[],
  windowSinceEpochExclusive: number | null,
  windowUntilEpochInclusive: number | null,
  thresholds: AcquisitionHealthThresholds = DEFAULT_ACQUISITION_HEALTH_THRESHOLDS,
): ChannelStats[] {
  const groups = new Map<string, BeehiivBackupSubscriber[]>();
  for (const sub of subscribers) {
    const key = resolveGroupKey(sub);
    const list = groups.get(key);
    if (list) list.push(sub);
    else groups.set(key, [sub]);
  }

  const hasWindow = windowSinceEpochExclusive != null && windowUntilEpochInclusive != null;
  const windowDays = hasWindow
    ? ((windowUntilEpochInclusive as number) - (windowSinceEpochExclusive as number)) / 86400
    : null;

  const out: ChannelStats[] = [];
  for (const [channel, subs] of groups) {
    const cadastros = subs.length;
    const ativos = subs.filter((s) => s.status === "active").length;
    const sobrevivenciaPct = cadastros > 0 ? (ativos / cadastros) * 100 : null;

    const eligible = subs.filter(
      (s) => s.status === "active" && (s.stats?.total_received ?? 0) >= thresholds.ctrReceivedMin,
    );
    const amostraConsiderada = eligible.length;
    let totalReceived = 0;
    let totalClicked = 0;
    for (const s of eligible) {
      totalReceived += s.stats?.total_received ?? 0;
      totalClicked += s.stats?.total_unique_clicked ?? 0;
    }
    const ctrAgregadoPct = amostraConsiderada > 0 ? computeCtrPct(totalClicked, totalReceived) : null;

    let novosNaJanela = 0;
    if (hasWindow) {
      novosNaJanela = subs.filter(
        (s) =>
          Number.isFinite(s.created) &&
          s.created > (windowSinceEpochExclusive as number) &&
          s.created <= (windowUntilEpochInclusive as number),
      ).length;
    }

    out.push({
      channel,
      cadastros,
      ativos,
      sobrevivenciaPct,
      amostraConsiderada,
      amostraNova: cadastros < thresholds.cohortMinSize,
      amostraPequena: amostraConsiderada > 0 && amostraConsiderada < thresholds.ctrSampleMin,
      amostraVazia: amostraConsiderada === 0,
      ctrAgregadoPct,
      novosNaJanela,
      windowDays,
    });
  }

  return out.sort((a, b) => b.cadastros - a.cadastros);
}

/** Converte `AAAA-MM-DD` (nome de diretório de snapshot, ver
 *  `beehiiv-backup-snapshots.ts`) no epoch em SEGUNDOS do início daquele
 *  dia, UTC. Lança em formato inválido. */
export function snapshotDateToEpochSeconds(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) {
    throw new Error(`data de snapshot inválida: "${date}" (esperado AAAA-MM-DD)`);
  }
  const [, y, mo, d] = m;
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0) / 1000);
}

/** Pure (#5494): `true` quando as duas larguras de janela divergem além de
 *  `maxRatio` (razão entre a maior e a menor). `null` em qualquer um dos
 *  lados, ou largura `<= 0` em qualquer um dos lados (dado degenerado, não
 *  dá pra formar razão), NUNCA diverge — mantém o comportamento anterior a
 *  #5494 quando o caller não informou largura de janela. */
export function windowsDivergeBeyondTolerance(
  windowDaysCurrent: number | null,
  windowDaysPrevious: number | null,
  maxRatio: number,
): boolean {
  if (windowDaysCurrent == null || windowDaysPrevious == null) return false;
  if (windowDaysCurrent <= 0 || windowDaysPrevious <= 0) return false;
  const ratio = Math.max(windowDaysCurrent, windowDaysPrevious) / Math.min(windowDaysCurrent, windowDaysPrevious);
  return ratio > maxRatio;
}

function fmtWindowDays(days: number | null): string {
  return days == null ? "largura desconhecida" : `${Math.round(days * 10) / 10}d`;
}

/** Mediana pura de uma lista de números. `null` se vazia. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Estado persistido (idempotência + baseline de canais conhecidos)
// ---------------------------------------------------------------------------

export interface AcquisitionHealthState {
  /** Canais já vistos em qualquer rodada anterior — ordenado, sem
   *  duplicata. Vazio + `lastCheckedSnapshotDate === null` = nunca rodou
   *  (1ª execução). */
  knownChannels: string[];
  /** Streak de semanas SEGUIDAS abaixo da base de CTR, por canal. Canal
   *  ausente da chave = streak 0 (nunca esteve abaixo, ou zerou na última
   *  rodada). */
  ctrBelowBaseStreak: Record<string, number>;
  lastCheckedAt: string | null;
  /** Data (`AAAA-MM-DD`) do snapshot usado como "atual" na última rodada —
   *  evita reavaliar o MESMO snapshot 2× se a task rodar de novo na mesma
   *  semana antes do próximo backup. */
  lastCheckedSnapshotDate: string | null;
  /** Fingerprint dos findings da última rodada que de fato alarmou — mesmo
   *  padrão de idempotência de `apoios-diff-alarm.ts`. */
  lastAlarmedFingerprint: string | null;
}

export function emptyAcquisitionHealthState(): AcquisitionHealthState {
  return {
    knownChannels: [],
    ctrBelowBaseStreak: {},
    lastCheckedAt: null,
    lastCheckedSnapshotDate: null,
    lastAlarmedFingerprint: null,
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type AcquisitionHealthFindingType =
  | "sobrevivencia_baixa"
  | "sobrevivencia_queda"
  | "ctr_abaixo_base"
  | "canal_parou"
  | "canal_desconhecido";

export interface AcquisitionHealthFinding {
  type: AcquisitionHealthFindingType;
  channel: string;
  detail: string;
}

export interface DetectAcquisitionHealthResult {
  findings: AcquisitionHealthFinding[];
  /** Findings que TERIAM disparado mas foram suprimidos por divergência de
   *  largura de janela (#5494 — `canalParouMaxWindowRatio`). Nunca entram em
   *  `findings`, nunca contam pro fingerprint de idempotência do e-mail —
   *  mas ficam aqui pra o caller logar/expor, nunca silenciar. */
  suppressedFindings: AcquisitionHealthFinding[];
  /** Streak atualizado (não inclui `knownChannels`/`lastChecked*` — o
   *  caller monta o `AcquisitionHealthState` completo, já que só ele sabe
   *  a data do snapshot e o "agora"). */
  nextCtrBelowBaseStreak: Record<string, number>;
}

function pct1(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/** Pure: compara `current` contra `previous` (semana anterior, mesmo
 *  formato — `null` se não houver snapshot anterior disponível) + o
 *  `state` persistido, e devolve os findings desta rodada + o streak de CTR
 *  atualizado. NÃO muta `state`. */
export function detectAcquisitionHealthFindings(
  current: ChannelStats[],
  previous: ChannelStats[] | null,
  state: AcquisitionHealthState,
  thresholds: AcquisitionHealthThresholds = DEFAULT_ACQUISITION_HEALTH_THRESHOLDS,
): DetectAcquisitionHealthResult {
  const isFirstRun = state.lastCheckedSnapshotDate === null;
  const knownSet = new Set(state.knownChannels);
  const previousByChannel = new Map((previous ?? []).map((c) => [c.channel, c]));

  // Base de CTR: mediana dos canais elegíveis NA MESMA semana (guard 3 —
  // nunca um número fixo congelado). "Elegível" = não amostraNova, não
  // amostraPequena, não amostraVazia (senão o próprio ruído de amostra
  // pequena distorce a mediana que serve de vara pra medir os outros).
  const ctrPool = current
    .filter((c) => !c.amostraNova && !c.amostraPequena && !c.amostraVazia && c.ctrAgregadoPct != null)
    .map((c) => c.ctrAgregadoPct as number);
  const ctrBase = median(ctrPool);

  const findings: AcquisitionHealthFinding[] = [];
  const suppressedFindings: AcquisitionHealthFinding[] = [];
  const nextCtrBelowBaseStreak: Record<string, number> = {};

  for (const stat of current) {
    const prev = previousByChannel.get(stat.channel);

    // ── Sinal 1: sobrevivência ────────────────────────────────────────────
    if (!stat.amostraNova && stat.sobrevivenciaPct != null) {
      if (stat.sobrevivenciaPct < thresholds.survivalFloorPct) {
        findings.push({
          type: "sobrevivencia_baixa",
          channel: stat.channel,
          detail:
            `sobrevivência ${pct1(stat.sobrevivenciaPct)} (${stat.ativos}/${stat.cadastros}) abaixo do piso ` +
            `${thresholds.survivalFloorPct}%.`,
        });
      } else if (prev && !prev.amostraNova && prev.sobrevivenciaPct != null) {
        const drop = prev.sobrevivenciaPct - stat.sobrevivenciaPct;
        if (drop >= thresholds.survivalDropPtsAlarm) {
          findings.push({
            type: "sobrevivencia_queda",
            channel: stat.channel,
            detail:
              `sobrevivência caiu ${pct1(drop)} vs a semana anterior (${pct1(prev.sobrevivenciaPct)} → ` +
              `${pct1(stat.sobrevivenciaPct)}).`,
          });
        }
      }
    }

    // ── Sinal 2: CTR abaixo da base por N semanas seguidas ─────────────────
    if (!stat.amostraNova && !stat.amostraPequena && !stat.amostraVazia && stat.ctrAgregadoPct != null && ctrBase != null) {
      const belowBase = stat.ctrAgregadoPct < ctrBase;
      const prevStreak = state.ctrBelowBaseStreak[stat.channel] ?? 0;
      const streak = belowBase ? prevStreak + 1 : 0;
      if (streak > 0) nextCtrBelowBaseStreak[stat.channel] = streak;
      if (streak >= thresholds.ctrWeeksBelowBase) {
        findings.push({
          type: "ctr_abaixo_base",
          channel: stat.channel,
          detail:
            `CTR agregado ${pct1(stat.ctrAgregadoPct)} abaixo da base da semana (mediana ${pct1(ctrBase)}) por ` +
            `${streak} semana(s) seguida(s).`,
        });
      }
      // amostra insuficiente esta semana: streak zera (não carrega um valor
      // obsoleto adiante — guard 1 também se aplica ao STREAK, não só ao
      // finding pontual).
    }

    // ── Sinal 3a: canal parou de entregar cadastros novos ──────────────────
    // Guard 4 (#5282): exige `prev.novosNaJanela >= canalParouMinNovosAnterior`
    // — sem isso, uma transição `1 → 0` de canal de cauda longa esporádico
    // (que nunca teve volume de verdade) alarmava tão alto quanto um canal
    // que de fato secou depois de entregar dezenas.
    if (prev && prev.novosNaJanela >= thresholds.canalParouMinNovosAnterior && stat.novosNaJanela === 0) {
      const detail = `${prev.novosNaJanela} cadastro(s) novo(s) na semana anterior, 0 nesta semana.`;
      if (windowsDivergeBeyondTolerance(stat.windowDays, prev.windowDays, thresholds.canalParouMaxWindowRatio)) {
        // Guard 5 (#5494): janelas de largura muito diferente (ex.: domingo
        // pulado — 2 dias vs 58 dias) tornam a comparação bruta desonesta.
        // Suprime SEM silenciar: fica em `suppressedFindings`, fora do
        // fingerprint de idempotência (não dispara e-mail sozinho).
        suppressedFindings.push({
          type: "canal_parou",
          channel: stat.channel,
          detail:
            `${detail} SUPRIMIDO (#5494): janela atual ${fmtWindowDays(stat.windowDays)} vs anterior ` +
            `${fmtWindowDays(prev.windowDays)} — larguras divergem além da tolerância ` +
            `(razão > ${thresholds.canalParouMaxWindowRatio}×), comparação não é honesta.`,
        });
      } else {
        findings.push({ type: "canal_parou", channel: stat.channel, detail });
      }
    }

    // ── Sinal 3b: canal nunca visto antes ───────────────────────────────────
    // NUNCA suprimido por amostraNova/amostraPequena/amostraVazia — a
    // novidade É o sinal (guard 2 é sobre coorte recém-criada distorcer
    // sobrevivência/CTR, não sobre esconder que ela existe).
    if (!isFirstRun && !knownSet.has(stat.channel)) {
      findings.push({
        type: "canal_desconhecido",
        channel: stat.channel,
        detail: `canal nunca visto em nenhum snapshot anterior (${stat.cadastros} cadastro(s) já presentes).`,
      });
    }
  }

  return { findings, suppressedFindings, nextCtrBelowBaseStreak };
}

/** Fingerprint estável dos findings (tipo+canal, ordenado) — idempotência:
 *  a mesma combinação de findings não gera um novo e-mail se a task rodar
 *  2× sobre o mesmo snapshot (mesmo padrão de `apoios-diff-alarm.ts`). O
 *  `detail` (que carrega números específicos) fica FORA do fingerprint de
 *  propósito — senão uma variação de 1 casa decimal no CTR reenviaria o
 *  alarme todo dia sem nada de novo ter de fato acontecido. */
export function computeFindingsFingerprint(findings: AcquisitionHealthFinding[]): string {
  return findings
    .map((f) => `${f.type}:${f.channel}`)
    .sort()
    .join("|");
}

export function buildNextKnownChannels(state: AcquisitionHealthState, current: ChannelStats[]): string[] {
  const set = new Set(state.knownChannels);
  for (const c of current) set.add(c.channel);
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

const FINDING_TYPE_LABEL: Record<AcquisitionHealthFindingType, string> = {
  sobrevivencia_baixa: "Sobrevivência abaixo do piso",
  sobrevivencia_queda: "Queda de sobrevivência",
  ctr_abaixo_base: "CTR abaixo da base",
  canal_parou: "Canal parou de entregar cadastros",
  canal_desconhecido: "Canal desconhecido",
};

export function buildAcquisitionHealthEmail(
  findings: AcquisitionHealthFinding[],
  snapshotDate: string,
  /** #5494 — findings suprimidos por divergência de largura de janela nesta
   *  rodada. `[]` (default) preserva o corpo pré-#5494. Nunca influencia o
   *  subject (a contagem principal é só de `findings` de verdade). */
  suppressedFindings: AcquisitionHealthFinding[] = [],
): { subject: string; body: string } {
  const subject = `[diar.ia.br] Alarme de saúde de aquisição — ${findings.length} achado(s) (${snapshotDate})`;
  const lines: string[] = [
    `Snapshot avaliado: ${snapshotDate} (data/beehiiv-backup/).`,
    "",
    `${findings.length} achado(s) nesta rodada:`,
    "",
  ];
  for (const f of findings) {
    lines.push(`- [${FINDING_TYPE_LABEL[f.type]}] ${f.channel}: ${f.detail}`);
  }
  if (suppressedFindings.length > 0) {
    lines.push(
      "",
      `${suppressedFindings.length} achado(s) SUPRIMIDO(S) por divergência de largura de janela (#5494) — ` +
        `não contam pro fingerprint nem disparam e-mail sozinhos:`,
      "",
    );
    for (const f of suppressedFindings) {
      lines.push(`- [SUPRIMIDO] [${FINDING_TYPE_LABEL[f.type]}] ${f.channel}: ${f.detail}`);
    }
  }
  lines.push("", "Detalhes/limiares: scripts/lib/acquisition-health.ts, docs/acquisition-health-alarm-setup.md.");
  return { subject, body: lines.join("\n") };
}
