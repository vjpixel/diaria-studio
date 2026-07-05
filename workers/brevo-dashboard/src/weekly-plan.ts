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
import { escHtml, pickStats, ENVIOS_TOOLTIP } from "./sections-core.ts";
import { fmtTimeBRT } from "./render-links.ts";

/** Janela de maturação — envios mais recentes que isso ficam fora do agregado. */
export const MATURATION_MS = 48 * 60 * 60 * 1000;

/**
 * Tamanho da amostra de saúde: os N envios MADUROS (>48h) mais recentes — decisão
 * do editor (por CONTAGEM, não janela de tempo). 10 já é amostra farta pra
 * abertura/bounce/spam/unsub.
 *
 * **Sem diferenciar cold/quente** (decisão do editor): o ISP enxerga a reputação
 * AGREGADA do domínio, não por segmento — quentes abrindo (abertura alta) AJUDAM
 * a entregabilidade, e conforme o universo escala eles viram uma fração pequena
 * que quase não move a média. Todo envio `sent` entra no agregado.
 */
export const HEALTH_SAMPLE_SIZE = 10;

/** Chave de dia-calendário BRT (YYYY-MM-DD) de um sentDate — pra agrupar células A/B/C do mesmo envio. */
function brtDayKey(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA dá YYYY-MM-DD estável; timeZone fixa o dia no fuso de Brasília.
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Passo de escalonamento default (+7%, dentro da faixa +5–10% dos guardrails). */
export const DEFAULT_WEEK_STEP = 0.07;

/** Corte no semáforo vermelho — "poda −30" (guardrail já em uso no ciclo cold). */
export const RED_CUT_FRACTION = 0.3;

export interface HealthThresholds {
  /** Abertura: >= green é 🟢; >= yellow (e < green) é 🟡; abaixo de yellow é 🔴. Maior é melhor. */
  openRate: { green: number; yellow: number };
  /** Bounce/spam/unsub: < green é 🟢; < yellow (e >= green) é 🟡; >= yellow é 🔴. Menor é melhor. */
  bounceRate: { green: number; yellow: number };
  spamRate: { green: number; yellow: number };
  unsubRate: { green: number; yellow: number };
}

/** Thresholds do requisito da issue #2974 (comentário do editor). */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  openRate: { green: 14, yellow: 11 }, // ≥14% / 11-14% / <11%
  bounceRate: { green: 1.5, yellow: 2.5 }, // <1,5% / 1,5-2,5% / >2,5%
  spamRate: { green: 0.05, yellow: 0.1 }, // <0,05% / 0,05-0,1% / >0,1%
  unsubRate: { green: 0.4, yellow: 0.7 }, // <0,4% / 0,4-0,7% / >0,7%
};

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
    bounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    spam += s.complaints ?? 0;
    unsub += s.unsubscriptions ?? 0;
  }

  return {
    openRate: delivered > 0 ? (views / delivered) * 100 : 0,
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
    classifyMetric(health.bounceRate, thresholds.bounceRate, "lower"),
    classifyMetric(health.spamRate, thresholds.spamRate, "lower"),
    classifyMetric(health.unsubRate, thresholds.unsubRate, "lower"),
  ].reduce(worseOf);
}

export interface WeekPlan {
  /** 3 volumes recomendados, na ordem ter/sex/dom. */
  volumes: [number, number, number];
  semaphore: Semaphore;
  /** true no semáforo vermelho — sinaliza que o editor deve revisar antes de prosseguir. */
  flagged: boolean;
}

/**
 * 4. Plano da semana a partir do volume-base (último envio maduro da semana
 * anterior): 🟢 escalona +step (composto, um step por dia: ter/sex/dom);
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

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
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
 * Renderiza a aba "Rampa" do dashboard — semáforo, agregado maduro, quais
 * campanhas entraram vs foram excluídas por imaturidade (<48h, transparência
 * pro editor), e o plano de 3 volumes (ter/sex/dom 06:00).
 *
 * `now` injetado (não `new Date()` interno) pra manter a função testável de
 * ponta a ponta se necessário; o call site (index.ts) passa `new Date()`.
 */
export function renderWeeklyPlanTabPanel(
  campaigns: BrevoCampaign[],
  now: Date = new Date(),
): string {
  // TODOS os envios (sem diferenciar cold/quente — o ISP vê a reputação AGREGADA
  // do domínio, ver HEALTH_SAMPLE_SIZE).
  const allSent = campaigns.filter((c) => c.status === "sent" && !!c.sentDate);

  if (allSent.length === 0) {
    return `
<section class="phase2-section" id="weekly-plan">
  <h2 class="section-title">Rampa — plano de envio semanal</h2>
  <p class="section-note">Nenhum envio registrado.</p>
</section>`;
  }

  // Saúde = os HEALTH_SAMPLE_SIZE (10) envios MADUROS (>48h) mais recentes.
  const mature = filterMatureCampaigns(allSent, now)
    .sort((a, b) => Date.parse(b.sentDate as string) - Date.parse(a.sentDate as string))
    .slice(0, HEALTH_SAMPLE_SIZE);
  const matureIds = new Set(mature.map((c) => c.id));
  // Imaturos (<48h) — ainda fora do agregado de saúde, mostrados pra transparência.
  const nowMs = now.getTime();
  const immature = allSent.filter(
    (c) => !matureIds.has(c.id) && nowMs - Date.parse(c.sentDate as string) <= MATURATION_MS,
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
  <h2 class="section-title">Rampa — plano de envio semanal</h2>
  <p class="section-note">Nenhum envio <strong>maduro (&gt;48h)</strong> ainda — as métricas dos mais recentes ainda estão subindo. Semáforo e plano aparecem quando o mais antigo cruzar 48h. ${immature.length} envio(s) aguardando maturar:</p>
  <table><thead><tr><th>Campanha</th><th>Enviado</th></tr></thead><tbody>
${waitRows}
</tbody></table>
  <p class="section-note"><small>Volume-base (último envio): ${baseVolume.toLocaleString("pt-BR")}.</small></p>
</section>`;
  }

  const health = aggregateHealth(mature);
  const semaphore = decideSemaphore(health);

  const canPlan = baseVolume > 0;
  const plan = canPlan ? computeWeekPlan(baseVolume, semaphore) : null;

  const semLabel = { green: "Verde", yellow: "Amarelo", red: "Vermelho" }[semaphore];
  const semNote = {
    green: "Saúde dentro da meta — escalona +7% ao dia (ter/sex/dom).",
    yellow: "Saúde na faixa de atenção — mantém o mesmo volume (sem crescer).",
    red: "Saúde abaixo da meta — corta 30% e sinaliza revisão do editor.",
  }[semaphore];

  const includedRows = mature
    .map((c) => {
      const picked = pickStats(c);
      return `<tr><td>${escHtml(c.name)}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>${picked?.stats.sent ?? "—"}</td></tr>`;
    })
    .join("\n");
  const excludedRows = immature
    .map((c) => `<tr><td>${escHtml(c.name)}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>ainda não maturou (&lt;48h)</td></tr>`)
    .join("\n");

  const planSection = plan
    ? `
  <table>
    <thead><tr><th>Dia</th><th>Volume recomendado</th></tr></thead>
    <tbody>
      <tr><td>Terça</td><td>${plan.volumes[0].toLocaleString("pt-BR")}</td></tr>
      <tr><td>Sexta</td><td>${plan.volumes[1].toLocaleString("pt-BR")}</td></tr>
      <tr><td>Domingo</td><td>${plan.volumes[2].toLocaleString("pt-BR")}</td></tr>
    </tbody>
  </table>
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
  const STATUS_COLOR: Record<Semaphore, string> = {
    green: "#158a4a",
    yellow: "#b07a00",
    red: "#c0392b",
  };
  const metricDefs = [
    { label: "Abertura", value: health.openRate, t: T.openRate, dir: "higher" as const },
    { label: "Bounce", value: health.bounceRate, t: T.bounceRate, dir: "lower" as const },
    { label: "Spam", value: health.spamRate, t: T.spamRate, dir: "lower" as const },
    { label: "Unsub", value: health.unsubRate, t: T.unsubRate, dir: "lower" as const },
  ];
  const metricRows = metricDefs
    .map((m) => {
      const s = classifyMetric(m.value, m.t, m.dir);
      const target =
        m.dir === "higher"
          ? `≥${m.t.green}% 🟢 · ≥${m.t.yellow}% 🟡`
          : `&lt;${m.t.green}% 🟢 · &lt;${m.t.yellow}% 🟡`;
      return `<tr><td>${m.label}</td><td style="color:${STATUS_COLOR[s]};font-weight:600">${fmtPct(m.value)}</td><td style="opacity:0.7">${target}</td><td>${SEMAPHORE_EMOJI[s]}</td></tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="weekly-plan">
  <h2 class="section-title">Rampa — plano de envio semanal</h2>
  <p class="section-note"><strong>${SEMAPHORE_EMOJI[semaphore]} ${semLabel}</strong> — ${semNote}</p>
  <p class="section-note" style="font-size:12px;opacity:0.75">Agregado dos ${mature.length} envios maduros (&gt;48h), sem diferenciar cold/quente. <strong>Semáforo = a PIOR métrica.</strong></p>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Métrica</th><th>Valor</th><th>Alvo (🟢 / 🟡)</th><th>Status</th></tr></thead>
    <tbody>
${metricRows}
    </tbody>
  </table>
  </div>
  ${planSection}
  <details>
    <summary>Campanhas incluídas no agregado (${mature.length})</summary>
    <div class="table-wrap"><table><thead><tr><th>Envio</th><th>Enviado</th><th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th></tr></thead><tbody>
    ${includedRows || '<tr><td colspan="3">Nenhuma.</td></tr>'}
    </tbody></table></div>
  </details>
  <details>
    <summary>Excluídas por imaturidade (&lt;48h) (${immature.length})</summary>
    <div class="table-wrap"><table><thead><tr><th>Envio</th><th>Enviado</th><th>Motivo</th></tr></thead><tbody>
    ${excludedRows || '<tr><td colspan="3">Nenhuma.</td></tr>'}
    </tbody></table></div>
  </details>
</section>`;
}
