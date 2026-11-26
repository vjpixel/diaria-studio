/**
 * Núcleo PURO da rampa semanal de envio Clarice (#2974): maturação → agregado
 * de saúde → semáforo → plano de 3 volumes, mais o volume-base e a detecção de
 * colapso da base (#10096).
 *
 * #13994: separado de `workers/brevo-dashboard/src/weekly-plan.ts`, que fica só
 * com o render da aba e reexporta tudo daqui (`export *`). O pipeline
 * (`clarice-schedule-ramp.ts`, `clarice-wave-plan.ts`, alarmes de envio,
 * `postmaster-spam-sync.ts`) importa este módulo, não o Worker: mesma decisão
 * nos dois lados, sem `scripts/` importar código de Worker. Sem I/O e
 * Workers-safe. Entra no bundle do Worker: listado no `paths:` de
 * `.github/workflows/deploy-brevo-dashboard.yml`.
 *
 * Requisito de maturação >48h (comentário do editor, #2974): métricas de
 * envio maturam ao longo de ~48h (abertura sobe forte nas primeiras 24-48h;
 * bounce/spam/unsub idem). Um envio de <48h SUBESTIMA a abertura — nunca
 * decidir o semáforo sobre dado verde-imaturo.
 */
import type { BrevoCampaign } from "./brevo-dashboard-types.ts";
import { parseClariceCampaignKey, pickStats } from "./brevo-campaign-stats.ts";
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds, type SpamSignal } from "./brevo-health-thresholds.ts";

/** Janela de maturação — envios mais recentes que isso ficam fora do agregado. */
export const MATURATION_MS = 48 * 60 * 60 * 1000;

/**
 * Tamanho da amostra de saúde: os N DIAS-CALENDÁRIO BRT (não campanhas) MADUROS
 * (>48h) mais recentes com envio — decisão do editor. Um dia de teste A/B/C
 * (3 campanhas simultâneas) conta como 1 dia; todas as campanhas desses N dias
 * entram no agregado. 10 já é amostra farta pra abertura/bounce/spam/unsub.
 *
 * **Sem diferenciar cold/quente** (decisão do editor): o ISP enxerga a reputação
 * AGREGADA do domínio, não por segmento — quentes abrindo (abertura alta) AJUDAM
 * a entregabilidade, e conforme o universo escala eles viram uma fração pequena
 * que quase não move a média. Todo envio `sent` entra no agregado.
 */
export const HEALTH_SAMPLE_DAYS = 10;

/** Chave de dia-calendário BRT (YYYY-MM-DD) de um sentDate — pra agrupar células A/B/C do mesmo envio. */
function brtDayKey(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA dá YYYY-MM-DD estável; timeZone fixa o dia no fuso de Brasília.
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/**
 * Agrupa campanhas por dia-calendário BRT (#2992 — extraído de 2 loops
 * duplicados: `selectMatureCampaignsByDay` e `groupByDayForDetails`). Campanhas
 * sem `sentDate` válido são ignoradas (não entram em nenhum grupo). Exportada
 * pra ser testada isoladamente.
 */
export function groupByBrtDay(campaigns: BrevoCampaign[]): Map<string, BrevoCampaign[]> {
  const byDay = new Map<string, BrevoCampaign[]>();
  for (const c of campaigns) {
    const day = brtDayKey(c.sentDate);
    if (!day) continue;
    const arr = byDay.get(day);
    if (arr) arr.push(c);
    else byDay.set(day, [c]);
  }
  return byDay;
}

/**
 * Deriva um nome "limpo" de edição a partir do nome de campanha — remove o
 * sufixo de célula/variante do teste A/B/C (ex: "Clarice News 2606-07 — A ·
 * dom" → "Clarice News 2606-07"). Sem esse separador, usa o nome truncado.
 *
 * Exportada (#3082) pra reuso na tabela "Envios" (sections-core.ts), que
 * precisa do mesmo nome de edição pra identificar qual campanha é cada linha
 * quando há teste A/B/C do mesmo dia.
 */
export function deriveEditionName(name: string): string {
  // Reusa parseClariceCampaignKey (parseia diário "Clarice News 2607 d01-A" E
  // mensal "Clarice News 2606-07 — A") pra montar um rótulo de edição SEM o
  // sufixo de célula A/B/C. Split ingênuo por " — " deixava o "-A" do diário
  // vazar pra coluna Edição (bug do review #2983). Fallback: heurística antiga.
  const parsed = parseClariceCampaignKey(name);
  if (parsed) {
    return parsed.monthly
      ? `Clarice News ${parsed.cycle}`
      : `Clarice News ${parsed.cycle} d${String(parsed.dayNum).padStart(2, "0")}`;
  }
  const idx = name.indexOf(" — ");
  if (idx !== -1) return name.slice(0, idx).trim();
  return name.length > 40 ? `${name.slice(0, 40).trim()}…` : name;
}

/** Passo de escalonamento default (+10%, topo da faixa +5–10% dos guardrails). */
export const DEFAULT_WEEK_STEP = 0.10;

/** Corte no semáforo vermelho — "poda −30" (guardrail já em uso no ciclo cold). */
export const RED_CUT_FRACTION = 0.3;

/**
 * 1. Filtra campanhas ENVIADAS há mais de `minAgeMs` (default 48h) — só estas
 * entram no agregado de saúde. `now` é injetado (não `new Date()`) pra
 * determinismo em teste.
 */
export function filterMatureCampaigns<T extends Pick<BrevoCampaign, "sentDate">>(
  campaigns: T[],
  now: Date,
  minAgeMs: number = MATURATION_MS,
): T[] {
  return campaigns.filter((c) => {
    if (!c.sentDate) return false;
    const sentMs = Date.parse(c.sentDate);
    if (!Number.isFinite(sentMs)) return false;
    return now.getTime() - sentMs > minAgeMs;
  });
}

export interface HealthAggregate {
  openRate: number;
  hardBounceRate: number;
  bounceRate: number;
  spamRate: number;
  unsubRate: number;
  delivered: number;
  sent: number;
}

/**
 * 2. Agrega saúde das campanhas cold MADURAS, ponderado por `delivered`
 * (bounce/spam/unsub por `sent`, seguindo a mesma convenção do restante do
 * dashboard — ver ENVIOS_TOOLTIP/circuit breakers em sections-core.ts).
 * Usa `pickStats` (globalStats primário → campaignStats fallback, #2254) —
 * mesma fonte única de stats do resto do dashboard.
 */
export function aggregateHealth(matureColdCampaigns: BrevoCampaign[]): HealthAggregate {
  let delivered = 0;
  let sent = 0;
  let views = 0;
  let hardBounces = 0;
  let bounces = 0;
  let spam = 0;
  let unsub = 0;

  for (const c of matureColdCampaigns) {
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;
    delivered += s.delivered ?? 0;
    sent += s.sent ?? 0;
    views += s.uniqueViews ?? 0;
    hardBounces += s.hardBounces ?? 0;
    bounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    spam += s.complaints ?? 0;
    unsub += s.unsubscriptions ?? 0;
  }

  return {
    openRate: delivered > 0 ? (views / delivered) * 100 : 0,
    hardBounceRate: sent > 0 ? (hardBounces / sent) * 100 : 0,
    bounceRate: sent > 0 ? (bounces / sent) * 100 : 0,
    spamRate: sent > 0 ? (spam / sent) * 100 : 0,
    unsubRate: sent > 0 ? (unsub / sent) * 100 : 0,
    delivered,
    sent,
  };
}

export type Semaphore = "green" | "yellow" | "red";

const SEMAPHORE_RANK: Record<Semaphore, number> = { green: 0, yellow: 1, red: 2 };

function worseOf(a: Semaphore, b: Semaphore): Semaphore {
  return SEMAPHORE_RANK[b] > SEMAPHORE_RANK[a] ? b : a;
}

/**
 * 3. Decide o semáforo — a métrica PIOR manda (nunca a média). Cada métrica é
 * avaliada contra seus próprios thresholds (maior é melhor pra abertura; menor
 * é melhor pras demais).
 */
/**
 * Classifica UMA métrica contra seus limiares. `higher` = maior é melhor
 * (abertura); `lower` = menor é melhor (bounce/spam/unsub). Exportada pro render
 * colorir cada valor + mostrar o alvo por métrica (o editor vê QUAL métrica
 * segura o semáforo).
 */
export function classifyMetric(
  value: number,
  t: { green: number; yellow: number },
  dir: "higher" | "lower",
): Semaphore {
  if (dir === "higher") {
    return value >= t.green ? "green" : value >= t.yellow ? "yellow" : "red";
  }
  return value < t.green ? "green" : value < t.yellow ? "yellow" : "red";
}

/**
 * #4063: classifica o sinal de SPAM que governa o semáforo — nunca
 * `health.spamRate` (derivado de `complaints` da Brevo, que subconta ~50×).
 * Sem leitura confiável do Postmaster (`source==="indeterminate"`), o pior
 * que pode acontecer é 🟡 — nunca 🟢 (é exatamente esse falso-verde que o
 * #4063 corrige) e nunca 🔴 automático (a trava fica pra depois, decisão do
 * editor). Com leitura, aplica a mesma classificação de 3 faixas das outras
 * métricas (`classifyMetric`, thresholds.spamRate).
 */
export function classifySpamSignal(
  signal: SpamSignal,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): Semaphore {
  if (signal.source === "indeterminate" || signal.ratePct === null) return "yellow";
  return classifyMetric(signal.ratePct, thresholds.spamRate, "lower");
}

export function decideSemaphore(
  health: HealthAggregate,
  spamSignal: SpamSignal,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): Semaphore {
  return [
    classifyMetric(health.openRate, thresholds.openRate, "higher"),
    classifyMetric(health.hardBounceRate, thresholds.hardBounceRate, "lower"),
    classifyMetric(health.bounceRate, thresholds.bounceRate, "lower"),
    classifySpamSignal(spamSignal, thresholds),
    classifyMetric(health.unsubRate, thresholds.unsubRate, "lower"),
  ].reduce(worseOf);
}

/**
 * #5592: descreve, em texto curto, QUAL(is) métrica(s) romperam o semáforo —
 * `decideSemaphore` (acima) só devolve o veredito PIOR (`Semaphore`), nunca
 * QUAL métrica causou. O dashboard já mostra isso visualmente (tabela de
 * saúde com cada valor colorido, `renderHealthSection`/`renderWeeklyPlanTabPanel`
 * abaixo — "o editor vê QUAL métrica segura o semáforo"), mas essa
 * informação nunca chegava ao TEXTO que sai do guard `clarice-check-
 * semaphore.ts` nem ao e-mail de alarme (#5405 item 1) — os dois diziam só
 * "circuit breaker(s) de entregabilidade rompido(s)", sem nomear o(s)
 * breaker(s). Usado por `deriveRampVolumes` (clarice-schedule-ramp.ts) pra
 * popular `RampVolumePlan.breachedMetrics`, que `decideSemaphoreGuard`
 * (clarice-check-semaphore.ts) injeta na linha `🔴 semáforo VERMELHO —
 * {reason}` impressa em stderr; `clarice-novos-run.ts` (`step()`) captura as
 * ÚLTIMAS 6 LINHAS de stderr (não só essa) como "detalhe do abort",
 * prefixadas com `❌ {label} falhou (exit N):`, e é essa mensagem inteira
 * (`abort.message`), truncada a 300 chars, que chega ao e-mail de alarme —
 * nunca este texto isolado.
 */
export function describeBreachedMetrics(
  health: HealthAggregate,
  spamSignal: SpamSignal,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): string[] {
  const breaches: string[] = [];
  if (classifyMetric(health.openRate, thresholds.openRate, "higher") === "red") {
    breaches.push(`abertura ${health.openRate.toFixed(1)}% (limiar <${thresholds.openRate.yellow}%)`);
  }
  if (classifyMetric(health.hardBounceRate, thresholds.hardBounceRate, "lower") === "red") {
    breaches.push(`bounce duro ${health.hardBounceRate.toFixed(2)}% (limiar ≥${thresholds.hardBounceRate.yellow}%)`);
  }
  if (classifyMetric(health.bounceRate, thresholds.bounceRate, "lower") === "red") {
    breaches.push(`bounce total ${health.bounceRate.toFixed(2)}% (limiar ≥${thresholds.bounceRate.yellow}%)`);
  }
  if (classifySpamSignal(spamSignal, thresholds) === "red") {
    const pct = spamSignal.ratePct !== null ? `${spamSignal.ratePct.toFixed(2)}%` : "indeterminado";
    breaches.push(`spam ${pct} (limiar ≥${thresholds.spamRate.yellow}%)`);
  }
  if (classifyMetric(health.unsubRate, thresholds.unsubRate, "lower") === "red") {
    breaches.push(`unsub ${health.unsubRate.toFixed(2)}% (limiar ≥${thresholds.unsubRate.yellow}%)`);
  }
  return breaches;
}

export interface WeekPlan {
  /** 3 volumes recomendados para os próximos 3 envios (ordem: próximo, 2º, 3º). */
  volumes: [number, number, number];
  semaphore: Semaphore;
  /** true no semáforo vermelho — sinaliza que o editor deve revisar antes de prosseguir. */
  flagged: boolean;
}

/**
 * 4. Recomendação dos próximos 3 envios a partir do volume-base (último envio):
 * 🟢 escalona +step (composto, um step por envio, sem data fixa);
 * 🟡 repete o mesmo volume (mantém, sem crescer); 🔴 corta (poda -30%, ver
 * RED_CUT_FRACTION) e sinaliza `flagged` pro editor decidir.
 */
export function computeWeekPlan(
  baseVolume: number,
  semaphore: Semaphore,
  step: number = DEFAULT_WEEK_STEP,
): WeekPlan {
  if (semaphore === "green") {
    return {
      volumes: [
        Math.round(baseVolume * (1 + step)),
        Math.round(baseVolume * (1 + step) ** 2),
        Math.round(baseVolume * (1 + step) ** 3),
      ],
      semaphore,
      flagged: false,
    };
  }
  if (semaphore === "yellow") {
    return { volumes: [baseVolume, baseVolume, baseVolume], semaphore, flagged: false };
  }
  const cut = Math.round(baseVolume * (1 - RED_CUT_FRACTION));
  return { volumes: [cut, cut, cut], semaphore, flagged: true };
}

/**
 * #10096 — a campanha conta pro volume-base da rampa?
 *
 * - nome com `grupo:{key}` → só se a key for de onda da rampa (`dN-…`, ex.
 *   `grupo:d7-seg12-A`). `grupo:novos-*` (cadastros novos, fluxo paralelo do
 *   `clarice-novos-run.ts`) e qualquer outro fluxo com naming `grupo:` ficam
 *   FORA — não são a rampa e não podem ditar o volume dela;
 * - nome SEM `grupo:` → entra (naming legado anterior ao `grupo:`, ex.
 *   "Clarice News 2606-07 — A · dom"; era tudo rampa). Hoje toda onda da
 *   rampa sai com `grupo:dN-…`, então isso só pesa em histórico antigo.
 *
 * Mesma regex de extração de `groupKeyFromCampaignName`
 * (`scripts/lib/clarice-wave-plan.ts`) — duplicada aqui porque este núcleo
 * entra no bundle do Worker e `clarice-wave-plan.ts` (que importa este
 * módulo) não entra; unificar puxaria o fecho dele para o Worker (#13994).
 */
export function isRampBaseCampaign(name: string | null | undefined): boolean {
  const m = /grupo:([\w-]+)\s*$/i.exec((name ?? "").trim());
  if (!m) return true;
  return /^d\d+-/i.test(m[1]);
}

/**
 * Volume-base = soma do `sent` de TODAS as campanhas enviadas no MESMO dia (BRT)
 * que o envio mais recente (maduro OU NÃO — volume é conhecido na hora do envio,
 * não precisa maturar; decisão do editor). Somar por dia porque um envio pode ser
 * fatiado em células A/B/C simultâneas — pegar só uma subestimaria o volume real
 * em ~⅓ e a rampa escalaria sobre a base errada. Retorna 0 se o array for vazio.
 *
 * #10096: só campanhas DA RAMPA entram (ver `isRampBaseCampaign`) — antes, um
 * dia que só teve envios do fluxo `clarice-novos` (`grupo:novos-*`, 2x/dia,
 * dezenas de contatos) virava o "último dia com envio" e a rampa escalava
 * sobre essa base residual (ciclo 2609-10: 40.180 → 31 → 101).
 */
export function baseVolumeFromLastSendDay(allCampaigns: BrevoCampaign[]): number {
  const campaigns = allCampaigns.filter((c) => isRampBaseCampaign(c.name));
  let latestMs = -Infinity;
  let latestDay: string | null = null;
  for (const c of campaigns) {
    const ms = c.sentDate ? Date.parse(c.sentDate) : NaN;
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestDay = brtDayKey(c.sentDate);
    }
  }
  if (latestDay === null) return 0;
  let total = 0;
  for (const c of campaigns) {
    if (brtDayKey(c.sentDate) !== latestDay) continue;
    total += pickStats(c)?.stats.sent ?? 0;
  }
  return total;
}

/**
 * #10114 — fração mínima do pico recente da rampa abaixo da qual o volume-base
 * é tratado como COLAPSADO (resíduo de uma onda parcial, não um nível real da
 * rampa). 0,25 porque o único jeito legítimo da rampa encolher sozinha é o
 * corte do vermelho (−30%/onda, `RED_CUT_FRACTION`): 3 vermelhos seguidos
 * ainda dão 0,343 do pico; o incidente do ciclo 2609-10 deu 101/40.180 =
 * 0,0025. 4 vermelhos seguidos (0,24) também param, e isso merece o editor.
 * O OUTRO encolhimento legítimo, o corte por crédito Brevo (`cappedBy:
 * "credit"`, #5042 — pode agendar 15% do pico de propósito), não passa por
 * esta fração: entra via `creditCaps` em `detectRampBaseCollapse` (#10209).
 */
export const RAMP_BASE_COLLAPSE_MIN_FRACTION = 0.25;

/** #10114 — quantos dias de envio da rampa ANTERIORES ao último entram no pico. */
export const RAMP_BASE_COLLAPSE_LOOKBACK_DAYS = 7;

export type RampBaseCollapse =
  | { collapsed: false }
  | {
      collapsed: true;
      baseVolume: number;
      baseDay: string;
      peakVolume: number;
      peakDay: string;
      /** baseVolume / peakVolume. */
      fraction: number;
    };

/**
 * #10114 — o volume-base (último dia com onda da rampa, ver
 * `baseVolumeFromLastSendDay`) está muito abaixo do pico dos dias de rampa
 * anteriores? Fecha o buraco que o #10096 deixou: as ondas residuais de uma
 * parada (`d7-seg12` = 31, `d8-ter13` = 101) já saem com nome de rampa, então
 * o filtro `grupo:dN-` as conta como base, e a rampa recomeçaria de ~101 sem
 * ninguém decidir isso.
 *
 * Pico = maior total diário entre os `lookbackDays` dias de rampa ANTERIORES
 * ao último. `ignoreBeforeMs` (aceite do editor, `--accept-base` em
 * `scripts/lib/clarice-envio-halt.ts`) tira do pico os dias enviados ANTES do
 * aceite: o editor olhou a base baixa e decidiu que ela vale; o histórico
 * anterior à decisão deixa de travar a rampa. O último dia (a base) nunca é
 * filtrado pelo aceite — ele é o que está sendo julgado. Puro.
 */
export function detectRampBaseCollapse(
  allCampaigns: BrevoCampaign[],
  opts: {
    ignoreBeforeMs?: number | null;
    minFraction?: number;
    lookbackDays?: number;
    /** #10209 — dias (YYYY-MM-DD BRT) em que a rodada agendou volume
     * REDUZIDO por crédito (`cappedBy: "credit"`), com o volume agendado. */
    creditCaps?: ReadonlyArray<{ day: string; volume: number }>;
  } = {},
): RampBaseCollapse {
  const minFraction = opts.minFraction ?? RAMP_BASE_COLLAPSE_MIN_FRACTION;
  const lookbackDays = opts.lookbackDays ?? RAMP_BASE_COLLAPSE_LOOKBACK_DAYS;
  const ramp = allCampaigns.filter((c) => isRampBaseCampaign(c.name));
  const totals = new Map<string, number>();
  const lastMsByDay = new Map<string, number>();
  for (const c of ramp) {
    const day = brtDayKey(c.sentDate);
    if (!day) continue;
    totals.set(day, (totals.get(day) ?? 0) + (pickStats(c)?.stats.sent ?? 0));
    const ms = Date.parse(c.sentDate as string);
    if (Number.isFinite(ms) && ms > (lastMsByDay.get(day) ?? -Infinity)) lastMsByDay.set(day, ms);
  }
  const days = [...totals.keys()].sort(); // YYYY-MM-DD ascendente
  if (days.length < 2) return { collapsed: false };
  const baseDay = days[days.length - 1];
  const baseVolume = totals.get(baseDay) ?? 0;
  const ignoreBefore = opts.ignoreBeforeMs ?? null;
  const ignored = (day: string) => ignoreBefore !== null && (lastMsByDay.get(day) ?? -Infinity) < ignoreBefore;
  // #10209 — o corte por crédito mais recente até a base é um novo patamar
  // DELIBERADO da rampa: dias anteriores a ele saem do pico, e o volume
  // agendado no dia do corte entra como candidato (um resíduo DEPOIS do
  // corte, inclusive no próprio dia, ainda é colapso).
  let latestCap: { day: string; volume: number } | null = null;
  for (const cap of opts.creditCaps ?? []) {
    if (cap.day > baseDay) continue;
    if (!latestCap || cap.day > latestCap.day) latestCap = cap;
  }
  let peakDay: string | null = null;
  let peakVolume = 0;
  for (const day of days.slice(0, -1).slice(-lookbackDays)) {
    if (ignored(day)) continue;
    if (latestCap && day < latestCap.day) continue;
    const v = totals.get(day) ?? 0;
    if (v > peakVolume) {
      peakVolume = v;
      peakDay = day;
    }
  }
  if (latestCap && !ignored(latestCap.day) && latestCap.volume > peakVolume) {
    peakVolume = latestCap.volume;
    peakDay = latestCap.day;
  }
  if (peakDay === null || peakVolume <= 0) return { collapsed: false };
  const fraction = baseVolume / peakVolume;
  if (fraction >= minFraction) return { collapsed: false };
  return { collapsed: true, baseVolume, baseDay, peakVolume, peakDay, fraction };
}

/**
 * Seleciona as campanhas MADURAS dos `HEALTH_SAMPLE_DAYS` (10) dias-calendário
 * BRT mais recentes com envio — não as N campanhas mais recentes. Um dia de
 * teste A/B/C (3 campanhas simultâneas) conta como 1 dia; TODAS as campanhas
 * desses dias entram no agregado (decisão do editor, #2974 refinamento).
 */
export function selectMatureCampaignsByDay(
  matureCampaigns: BrevoCampaign[],
  days: number = HEALTH_SAMPLE_DAYS,
): BrevoCampaign[] {
  const byDay = groupByBrtDay(matureCampaigns);
  const topDays = [...byDay.keys()]
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, days);
  const topDaysSet = new Set(topDays);
  return matureCampaigns.filter((c) => {
    const day = brtDayKey(c.sentDate);
    return day !== null && topDaysSet.has(day);
  });
}

/**
 * #2992: seleciona os `days` dias-calendário BRT mais recentes que estão
 * ATOMICAMENTE maduros — um dia matura só quando sua célula A/B/C MAIS RECENTE
 * cruza 48h. Sem isso, um dia com células enviadas minutos antes/depois da
 * fronteira de 48h poderia aparecer parcialmente maduro (algumas células no
 * agregado, outras não) — o dia deixa de ser atômico nas 2 tabelas ("incluídos"
 * vs "excluídos"). `allSentCampaigns` deve conter TODOS os envios (maduros e
 * não), pra avaliar a maturidade do dia pela campanha mais recente do dia,
 * não só pelas já filtradas como maduras.
 */
export function selectMatureDayCampaigns(
  allSentCampaigns: BrevoCampaign[],
  now: Date,
  days: number = HEALTH_SAMPLE_DAYS,
  minAgeMs: number = MATURATION_MS,
): { mature: BrevoCampaign[]; immature: BrevoCampaign[] } {
  const byDay = groupByBrtDay(allSentCampaigns);
  const nowMs = now.getTime();

  const matureDays: string[] = [];
  const immatureDays: string[] = [];
  for (const [day, cs] of byDay) {
    const mostRecentMs = Math.max(...cs.map((c) => Date.parse(c.sentDate as string)));
    if (nowMs - mostRecentMs > minAgeMs) matureDays.push(day);
    else immatureDays.push(day);
  }

  const topMatureDays = matureDays.sort((a, b) => (a < b ? 1 : -1)).slice(0, days);
  const topMatureDaysSet = new Set(topMatureDays);
  const immatureDaysSet = new Set(immatureDays);

  const mature = allSentCampaigns.filter((c) => {
    const day = brtDayKey(c.sentDate);
    return day !== null && topMatureDaysSet.has(day);
  });
  const immature = allSentCampaigns.filter((c) => {
    const day = brtDayKey(c.sentDate);
    return day !== null && immatureDaysSet.has(day);
  });

  return { mature, immature };
}
