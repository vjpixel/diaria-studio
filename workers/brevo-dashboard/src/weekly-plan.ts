/**
 * Aba "Rampa" (#2974) — planejador semanal de volume de envio cold.
 *
 * Decisão de arquitetura (comentário do editor na issue): o worker NÃO alcança
 * o store local (OneDrive/SQLite) — por isso a feature é dividida em 2 partes:
 *   1. Este arquivo (worker): lógica PURA de decisão (maturação → agregado →
 *      semáforo → plano de 3 volumes) + render da aba. Roda sobre as campanhas
 *      Brevo já buscadas por `fetchRecentCampaigns` (mesma fonte usada pelas
 *      outras abas — este Brevo account só serve Clarice News, então toda
 *      campanha `sent` aqui é candidata a "envio cold").
 *   2. `scripts/weekly-send-plan-audience.ts` (local): recebe os volumes
 *      decididos aqui como input e executa a seleção de audiência no store.
 *
 * Requisito de maturação >48h (comentário do editor, #2974): métricas de
 * envio maturam ao longo de ~48h (abertura sobe forte nas primeiras 24-48h;
 * bounce/spam/unsub idem). Um envio de <48h SUBESTIMA a abertura — nunca
 * decidir o semáforo sobre dado verde-imaturo.
 *
 * Import circular com sections-core.ts (mesmo padrão documentado em
 * render-links.ts #2832): `pickStats`/`escHtml` são usados aqui mas definidos
 * lá, e `renderWeeklyPlanTabPanel` é importado por sections-core.ts. Seguro —
 * todo uso é dentro de corpos de função chamados em request-time, nunca em
 * top-level do módulo.
 */
import type { BrevoCampaign } from "./types.ts";
import { escHtml, pickStats, ENVIOS_TOOLTIP, parseClariceCampaignKey, aggregateByWeekday, pickTopWeekdays, WEEKDAY_LABELS, renderMixedAudienceNote } from "./sections-core.ts";
import { fmtTimeBRT, STATUS_COLOR } from "./render-links.ts";
// #3010: renderScheduledSection foi movida da aba Visão Geral pra Agendamento —
// import circular com sections-kv.ts é seguro pelo mesmo motivo documentado
// acima (uso só dentro de corpo de função, em request-time).
import { renderScheduledSection } from "./sections-kv.ts";
// #3078: thresholds extraídos pra módulo compartilhado (sections-core.ts e
// sections-kv.ts também consomem) — reexportados aqui pra não quebrar
// consumidores existentes que importam de weekly-plan.ts/index.ts.
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "./thresholds.ts";
export { DEFAULT_HEALTH_THRESHOLDS };
export type { HealthThresholds };

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

/** YYYY-MM-DD → dd/mm (exibição BRT no dashboard). */
function fmtDayKey(dayKey: string): string {
  const [, m, d] = dayKey.split("-");
  return `${d}/${m}`;
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

export function decideSemaphore(
  health: HealthAggregate,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): Semaphore {
  return [
    classifyMetric(health.openRate, thresholds.openRate, "higher"),
    classifyMetric(health.hardBounceRate, thresholds.hardBounceRate, "lower"),
    classifyMetric(health.bounceRate, thresholds.bounceRate, "lower"),
    classifyMetric(health.spamRate, thresholds.spamRate, "lower"),
    classifyMetric(health.unsubRate, thresholds.unsubRate, "lower"),
  ].reduce(worseOf);
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

const SEMAPHORE_EMOJI: Record<Semaphore, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

// #3081 (self-review): `decimals` opcional (default 2, preserva o comportamento
// das outras 4 métricas) — Spam passa a pedir 3 casas explicitamente abaixo,
// mesma precisão de fmtSpamPct (sections-core.ts/sections-kv.ts) e do Resumo
// A/B/C por Audiência. Sem isso, esta era a 4ª tabela do dashboard mostrando
// spam rate com uma precisão diferente das outras três já unificadas.
function fmtPct(n: number, decimals = 2): string {
  return `${n.toFixed(decimals)}%`;
}

/**
 * Volume-base = soma do `sent` de TODAS as campanhas enviadas no MESMO dia (BRT)
 * que o envio mais recente (maduro OU NÃO — volume é conhecido na hora do envio,
 * não precisa maturar; decisão do editor). Somar por dia porque um envio pode ser
 * fatiado em células A/B/C simultâneas — pegar só uma subestimaria o volume real
 * em ~⅓ e a rampa escalaria sobre a base errada. Retorna 0 se o array for vazio.
 */
export function baseVolumeFromLastSendDay(campaigns: BrevoCampaign[]): number {
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

/**
 * #2989: renderiza a nota "melhores dias da semana" na aba Agendamento —
 * sugestão MENSAL/MANUAL (o editor decide se migra a cadência de propósito),
 * NUNCA troca automática. Reusa `aggregateByWeekday`/`pickTopWeekdays` (já
 * existentes, dado histórico completo) — não recomputa nada. Vazio quando não
 * há dados suficientes (< 2 dias com envio).
 */
export function renderTopWeekdaysSection(campaigns: BrevoCampaign[], now: Date = new Date()): string {
  const { rows } = aggregateByWeekday(campaigns, null, now);
  const top = pickTopWeekdays(rows, 3);
  if (top.length === 0 || rows.filter((r) => r.count > 0).length < 2) return "";
  const topLabels = top.map((r) => WEEKDAY_LABELS[r.weekday]).join(", ");
  const rowsHtml = top
    .map(
      (r) =>
        `<tr><td><strong>${escHtml(r.label)}</strong></td><td>${r.count}</td><td class="metric">${r.openRate.toFixed(1)}%</td></tr>`,
    )
    .join("\n");
  return `
  <h3>Melhores dias da semana (abertura) — sugestão mensal</h3>
  ${renderMixedAudienceNote()}
  <p class="section-note">Melhores dias: <strong style="color:var(--ink)">${escHtml(topLabels)}</strong>. Sugestão apenas — a recomendação de volume acima não muda sozinha; o editor revisa ~1×/mês e migra a cadência de propósito só se a diferença for material e sustentada (não no ruído semana a semana).</p>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Dia</th><th>Envios</th><th title="Open rate agregado (histórico completo)">Open rate agr.</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  </div>`;
}

/**
 * Renderiza a aba "Rampa" do dashboard — semáforo, agregado maduro, quais
 * campanhas entraram vs foram excluídas por imaturidade (<48h, transparência
 * pro editor), e a recomendação de volume dos próximos 3 envios (sem data fixa).
 *
 * `now` injetado (não `new Date()` interno) pra manter a função testável de
 * ponta a ponta se necessário; o call site (index.ts) passa `new Date()`.
 */
export function renderWeeklyPlanTabPanel(
  campaigns: BrevoCampaign[],
  now: Date = new Date(),
  // #3010: campanhas agendadas (status queued) — movida da aba Visão Geral pra
  // cá, logo abaixo da recomendação dos próximos 3 envios. Default [] preserva
  // call sites/testes existentes que ainda não passam esse argumento.
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }> = [],
): string {
  // #3010: renderizada uma única vez e reaproveitada em todos os branches de
  // retorno desta função (mesmo quando não há plano/recomendação ainda).
  const scheduledSection = renderScheduledSection(scheduled);

  // TODOS os envios (sem diferenciar cold/quente — o ISP vê a reputação AGREGADA
  // do domínio, ver HEALTH_SAMPLE_DAYS).
  const allSent = campaigns.filter((c) => c.status === "sent" && !!c.sentDate);

  if (allSent.length === 0) {
    return `
<section class="phase2-section" id="weekly-plan">
  <h2 class="section-title">Agendamento — plano de envio semanal</h2>
  <p class="section-note">Nenhum envio registrado.</p>
</section>
${scheduledSection}`;
  }

  // Saúde = os HEALTH_SAMPLE_DAYS (10) dias-calendário BRT MADUROS (>48h) mais
  // recentes com envio — todas as campanhas desses dias (célula A/B/C = 1 dia).
  // #2992: maturidade é avaliada por DIA (o dia matura quando a célula A/B/C
  // MAIS RECENTE dele passa de 48h) — o dia é atômico, nunca rachado entre
  // "incluído" e "excluído".
  const { mature: matureUnsorted, immature } = selectMatureDayCampaigns(allSent, now);
  const mature = matureUnsorted.sort(
    (a, b) => Date.parse(b.sentDate as string) - Date.parse(a.sentDate as string),
  );

  // Volume-base = total do ÚLTIMO envio registrado (mesmo <48h) — volume é
  // conhecido na hora, não precisa maturar (decisão do editor). Soma as células
  // A/B/C do último dia de envio.
  const baseVolume = baseVolumeFromLastSendDay(allSent);

  // Sem envio maduro ainda → semáforo indefinido (não decidir crescimento sobre
  // dado imaturo). Mostra os que estão maturando + o volume-base já conhecido.
  if (mature.length === 0) {
    const waitRows = immature
      .map((c) => `<tr><td>${escHtml(c.name)}</td><td>${fmtTimeBRT(c.sentDate)}</td></tr>`)
      .join("\n");
    return `
<section class="phase2-section" id="weekly-plan">
  <h2 class="section-title">Agendamento — plano de envio semanal</h2>
  <p class="section-note">Nenhum envio <strong>maduro (&gt;48h)</strong> ainda — as métricas dos mais recentes ainda estão subindo. Semáforo e plano aparecem quando o mais antigo cruzar 48h. ${immature.length} envio(s) aguardando maturar:</p>
  <div class="table-wrap">
  <table><thead><tr><th>Campanha</th><th>Enviado</th></tr></thead><tbody>
${waitRows}
</tbody></table>
  </div>
  <p class="section-note"><small>Volume-base (último envio): ${baseVolume.toLocaleString("pt-BR")}.</small></p>
</section>
${scheduledSection}`;
  }

  const health = aggregateHealth(mature);
  const semaphore = decideSemaphore(health);

  const canPlan = baseVolume > 0;
  const plan = canPlan ? computeWeekPlan(baseVolume, semaphore) : null;

  const semLabel = { green: "Verde", yellow: "Amarelo", red: "Vermelho" }[semaphore];
  const semNote = {
    green: "Saúde dentro da meta — escalona +10% a cada envio.",
    yellow: "Saúde na faixa de atenção — mantém o mesmo volume (sem crescer).",
    red: "Saúde abaixo da meta — corta 30% e sinaliza revisão do editor.",
  }[semaphore];

  /** Agrupa campanhas por dia BRT → 1 linha por dia (Edição | Data | E-mails). */
  function groupByDayForDetails(cs: BrevoCampaign[]): { rows: string; dayCount: number } {
    const grouped = groupByBrtDay(cs);
    const entries = [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const rows = entries
      .map(([day, dayCampaigns]) => {
        const first = [...dayCampaigns].sort(
          (a, b) => Date.parse(a.sentDate as string) - Date.parse(b.sentDate as string),
        )[0];
        const edition = deriveEditionName(first.name);
        const emails = dayCampaigns.reduce((sum, c) => sum + (pickStats(c)?.stats.sent ?? 0), 0);
        return `<tr><td>${escHtml(edition)}</td><td>${fmtDayKey(day)}</td><td>${emails.toLocaleString("pt-BR")}</td></tr>`;
      })
      .join("\n");
    return { rows, dayCount: entries.length };
  }

  const includedDetails = groupByDayForDetails(mature);
  const excludedDetails = groupByDayForDetails(immature);

  const planSection = plan
    ? `
  <h3>Recomendação — próximos 3 envios</h3>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Envio</th><th>Volume recomendado</th></tr></thead>
    <tbody>
      <tr><td>Próximo envio</td><td>${plan.volumes[0].toLocaleString("pt-BR")}</td></tr>
      <tr><td>2º envio</td><td>${plan.volumes[1].toLocaleString("pt-BR")}</td></tr>
      <tr><td>3º envio</td><td>${plan.volumes[2].toLocaleString("pt-BR")}</td></tr>
    </tbody>
    <tfoot>
      <tr style="font-weight:700;border-top:2px solid var(--rule)"><td>Total (3 envios)</td><td>${plan.volumes
        .reduce((a, b) => a + b, 0)
        .toLocaleString("pt-BR")}</td></tr>
    </tfoot>
  </table>
  </div>
  <p class="section-note">Volume-base (último envio): ${baseVolume.toLocaleString("pt-BR")}.${
      plan.flagged
        ? " <strong>⚠️ Semáforo vermelho — revisar antes de rodar scripts/weekly-send-plan-audience.ts.</strong>"
        : ""
    }</p>
  <p class="section-note"><code>npx tsx scripts/weekly-send-plan-audience.ts --volumes ${plan.volumes.join(",")} [--write]</code></p>`
    : `<p class="section-note">Sem envio maduro (&gt;48h) da semana anterior ainda — plano indisponível até maturar.</p>`;

  // Tabela de métricas: valor colorido pelo status + coluna de alvo (limiares) +
  // status por métrica — o editor vê na hora QUAL métrica segura o semáforo.
  const T = DEFAULT_HEALTH_THRESHOLDS;
  // #3087: STATUS_COLOR consolidado em render-links.ts (ao lado de DS.alert) —
  // não mais declarado localmente (evita drift entre o vermelho daqui e o
  // vermelho de alerta usado no resto do dashboard).
  const metricDefs = [
    { label: "Abertura", value: health.openRate, t: T.openRate, dir: "higher" as const },
    { label: "Hard bounce", value: health.hardBounceRate, t: T.hardBounceRate, dir: "lower" as const },
    { label: "Bounce total", value: health.bounceRate, t: T.bounceRate, dir: "lower" as const },
    // #3081: 3 casas (não 2) — mesma precisão de fmtSpamPct/Envios/"Totais por
    // mês"/Resumo A/B/C por Audiência (o breaker dispara em ≥0.1%, 2 casas
    // ainda arredondam 0.049%→"0.05%" perto do limiar).
    { label: "Spam", value: health.spamRate, t: T.spamRate, dir: "lower" as const, decimals: 3 },
    { label: "Unsub", value: health.unsubRate, t: T.unsubRate, dir: "lower" as const },
  ];
  const metricRows = metricDefs
    .map((m) => {
      const s = classifyMetric(m.value, m.t, m.dir);
      const targetGreen = m.dir === "higher" ? `≥${m.t.green}%` : `&lt;${m.t.green}%`;
      const targetYellow = m.dir === "higher" ? `≥${m.t.yellow}%` : `&lt;${m.t.yellow}%`;
      // #3081 (mesma classe do fix de pct() denom-0 → "—" em render-links.ts):
      // Spam cai em 0 (não "—") quando `health.sent === 0` — sem envios com
      // stats válidas ainda, "0.000%" afirma falsamente "spam zero confirmado"
      // em vez de "sem dado". Só Spam aqui porque foi o caso relatado
      // (#3081); as outras 3 métricas sent-based têm o mesmo padrão mas não
      // foram reportadas — fora do escopo deste fix pontual.
      const valueFmt = m.label === "Spam" && health.sent === 0
        ? "—"
        : fmtPct(m.value, "decimals" in m ? m.decimals : undefined);
      return `<tr><td>${m.label}</td><td style="color:${STATUS_COLOR[s]};font-weight:600">${valueFmt}</td><td style="opacity:0.7">${targetGreen}</td><td style="opacity:0.7">${targetYellow}</td></tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="weekly-plan">
  <h2 class="section-title">Agendamento — plano de envio semanal</h2>
  <p class="section-note"><strong>${SEMAPHORE_EMOJI[semaphore]} ${semLabel}</strong> — ${semNote}</p>
  <p class="section-note" style="font-size:12px;opacity:0.75">Agregado dos ${mature.length} envios maduros (&gt;48h) nos últimos ${includedDetails.dayCount} dias de envio (janela: até ${HEALTH_SAMPLE_DAYS}), sem diferenciar cold/quente. <strong>Semáforo = a PIOR métrica.</strong></p>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Métrica</th><th>Valor</th><th>Alvo 🟢</th><th>Alvo 🟡</th></tr></thead>
    <tbody>
${metricRows}
    </tbody>
  </table>
  </div>
  ${planSection}
  ${scheduledSection}
  ${renderTopWeekdaysSection(campaigns, now)}
  <details>
    <summary class="links-summary">Dias de envio incluídos no agregado (${includedDetails.dayCount})</summary>
    <div class="table-wrap"><table><thead><tr><th>Edição</th><th>Data</th><th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th></tr></thead><tbody>
    ${includedDetails.rows || '<tr><td colspan="3">Nenhum.</td></tr>'}
    </tbody></table></div>
  </details>
  <details>
    <summary class="links-summary">Excluídos por imaturidade (&lt;48h) (${excludedDetails.dayCount})</summary>
    <div class="table-wrap"><table><thead><tr><th>Edição</th><th>Data</th><th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th></tr></thead><tbody>
    ${excludedDetails.rows || '<tr><td colspan="3">Nenhum.</td></tr>'}
    </tbody></table></div>
  </details>
</section>`;
}
