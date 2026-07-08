import type { Env, BrevoCampaign, BrevoGlobalStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementEdition, EiaEngagementSummary, CohortStatsRow } from "./types.ts";
import { type CouponUsageReport, type CouponCodeReport, commissionCents } from "../../../scripts/lib/stripe-coupons.ts";
import { cohortLabel } from "../../../scripts/lib/clarice-segment.ts";
// #2857 fase B: cohortSendRank ordena as sub-linhas do breakdown de 1º envio
// (sucessor do antigo tierRank — o fallback de render pro payload legado
// by_tier foi removido na fase C, ver firstSendBreakdownRows abaixo).
// cohorts.ts é dependency-free/Workers-safe (mesmo padrão de
// clarice-segment.ts) — importar direto daqui não introduz node:sqlite.
import { cohortSendRank } from "../../../scripts/lib/cohorts.ts";
import { DS, pct, fmtTimeBRT, cellClass, renderColumnGlossary, renderMethodologyNote } from "./render-links.ts";
import { escHtml, parseClariceCampaignKey, pickStats, monthKeyBRT, ENVIOS_TOOLTIP, renderMixedAudienceNote } from "./sections-core.ts";
import { isBounceBreach } from "./thresholds.ts";
// #3011: gate das notas "atualizado às ..." — só aparecem quando o dado
// pré-computado (KV) diverge do timestamp do cabeçalho da dashboard.
import { shouldShowStalenessNote } from "./staleness.ts";
import {
  formatBillingWindowLabel,
  BILLING_CYCLE_DAY,
  BILLING_CYCLE_HOUR,
  BILLING_CYCLE_MINUTE,
  type BillingCycleWindow,
} from "./billing-cycle.ts";

// #2875: formatter pt-BR de contagem inteira — estava duplicado em
// renderContactsSummarySection e renderCohortsTabPanel (mesmo corpo, 2
// definições locais). `v` é sempre um number definido nos call sites (não
// `number | null`); o `?? 0` antigo era defesa morta (item #2875-8).
function fmtCount(v: number): string {
  return v.toLocaleString("pt-BR");
}

// #2875: formatters NaN-safe extraídos pra módulo (estavam definidos só
// dentro de renderCohortsTabPanel, e reinventados inline em
// renderEiaEngagementSection) — payload KV parcial/antigo pode ter numerador
// ausente/não-finito; sem o guard, vaza "NaN%"/"undefined" no render.
function numOrDash(v: number | null, suffix = ""): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}${suffix}`;
}
function pctOrDash(v: number | null): string {
  return numOrDash(v, "%");
}
// Mesmo guard, sem decimais — pra contagens/totais (não taxas).
function countOrDash(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : fmtCount(v);
}

export interface DaySummary {
  /** Número do dia (1–5, correspondente a d01–d05 da S1) */
  dayNum: number;
  /** Rótulo legível (ex: "D1") */
  label: string;
  /** Soma de uniqueViews (MPP-inclusivo) das campanhas do dia */
  totalViews: number;
  /** Soma de delivered das campanhas do dia */
  totalDelivered: number;
  /** Open rate agregado MPP-inclusivo (totalViews / totalDelivered) */
  openRate: number;
  /** Número de campanhas contabilizadas (células enviadas neste dia) */
  campaignCount: number;
  /**
   * Open rate ORGÂNICO (sem Apple MPP), secundário. `null` quando alguma
   * campanha do dia caiu no fallback campaignStats (sem `appleMppOpens`).
   * Só preenchido quando TODAS as campanhas do dia têm globalStats.
   */
  organicOpenRate: number | null;
}

/**
 * #2492: agrega resumo D1–D5 das campanhas S1 (d01–d05) de um ciclo Clarice.
 * Cada row representa UM DIA, somando todas as células (A/B/C) daquele dia.
 * Usa apenas campanhas com stats reais (gs.sent > 0 ou cs.sent > 0).
 * Exportado pra teste unitário.
 */
export function aggregateDaySummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): DaySummary[] {
  // D1–D5 = dias 1 a 5 da S1
  const MAX_DAY = 5;
  const days: Record<
    number,
    { views: number; delivered: number; count: number; organicViews: number; organicDays: number }
  > = {};
  for (let d = 1; d <= MAX_DAY; d++) {
    days[d] = { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 };
  }

  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    if (parsed.dayNum < 1 || parsed.dayNum > MAX_DAY) continue;

    const picked = pickStats(c);
    if (!picked) continue;
    const { stats: s, isGlobal } = picked;

    const d = days[parsed.dayNum];
    d.views += s.uniqueViews ?? 0;
    d.delivered += s.delivered ?? 0;
    d.count += 1;

    if (isGlobal) {
      const gs = s as BrevoGlobalStats;
      d.organicViews += Math.max(0, (gs.uniqueViews ?? 0) - (gs.appleMppOpens ?? 0));
      d.organicDays += 1;
    }
  }

  return Array.from({ length: MAX_DAY }, (_, i) => {
    const dayNum = i + 1;
    const d = days[dayNum];
    const organicComplete = d.count > 0 && d.organicDays === d.count;
    return {
      dayNum,
      label: `D${dayNum}`,
      totalViews: d.views,
      totalDelivered: d.delivered,
      openRate: d.delivered > 0 ? (d.views / d.delivered) * 100 : 0,
      campaignCount: d.count,
      organicOpenRate:
        organicComplete && d.delivered > 0 ? (d.organicViews / d.delivered) * 100 : null,
    };
  });
}

/**
 * #2492: renderiza a seção de breakdown D1–D5 (um row por dia de envio da S1,
 * somando todas as células A/B/C). Oculta ("") quando nenhum dia tem dados.
 * Exportado pra teste unitário.
 */
export function renderDaySummarySection(rows: DaySummary[]): string {
  if (rows.every((r) => r.campaignCount === 0)) return "";

  // Melhor dia = maior open rate entre os que têm dados
  const sampledRows = rows.filter((r) => r.campaignCount > 0);
  const maxRate = sampledRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = sampledRows.filter((r) => r.openRate === maxRate).length;
  const isTied = sampledRows.length >= 2 && tiedCount > 1;
  const winnerDay = !isTied && sampledRows.length >= 2
    ? sampledRows.find((r) => r.openRate === maxRate)?.dayNum ?? null
    : null;

  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre dias com ${maxRate.toFixed(1)}% — aguardar mais dias de envio.`
    : sampledRows.length >= 2 && winnerDay
    ? `Melhor dia provisório: <strong style="color:${DS.ink}">D${winnerDay}</strong> — aguardar conclusão da S1 para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  const tableRows = rows
    .map((r) => {
      const isWinner = r.dayNum === winnerDay && r.campaignCount > 0;
      // #3088: teal falha AA em texto pequeno — tag volta a --ink.
      const winnerTag = isWinner ? ` <strong style="color:${DS.ink}">▲ LÍDER</strong>` : "";
      const organicInline =
        r.campaignCount > 0 && r.organicOpenRate != null
          ? ` <span class="rate-inline">(${r.organicOpenRate.toFixed(1)}% s/ MPP)</span>`
          : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      return `<tr>
        <td><strong>${r.label}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${organicInline}${winnerTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="day-summary">
  <h2 class="section-title">Resumo D1–D5 — S1</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo) — base do vencedor. Entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os envios do dia têm esse dado. Cada linha agrega todas as células (A/B/C) enviadas naquele dia.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Dia da S1 (D1 = d01, D2 = d02, … D5 = d05)">Dia</th>
        <th title="Soma de entregues de todas as células enviadas no dia">Delivered (total)</th>
        <th title="Soma de aberturas únicas (com Apple MPP) de todas as células do dia">Opens (total)</th>
        <th title="Open rate agregado com Apple MPP — entre parênteses, taxa sem MPP quando disponível">Open rate agr.</th>
        <th title="Número de campanhas (células) enviadas neste dia">Campanhas</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2251: renderiza a seção "Campanhas agendadas" (status queued), ordenada por
 * horário (próximo envio primeiro). Mostra dia/célula (quando Clarice News),
 * horário BRT, lista e tamanho esperado do envio (snapshot). Oculta (`""`)
 * quando não há agendadas — mesmo contrato graceful das demais seções.
 * Exportado pra teste unitário.
 */
export function renderScheduledSection(
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): string {
  const withDate = scheduled.filter((c) => c.scheduledAt);
  if (withDate.length === 0) return "";

  // Date.parse de string malformada → NaN; comparador com NaN dá ordem
  // indeterminada. Tratamos NaN como 0 (vai pro início) — ordem determinística.
  const ts = (s: string | null): number => {
    const t = Date.parse(s ?? "");
    return Number.isNaN(t) ? 0 : t;
  };
  const ordered = [...withDate].sort((a, b) => ts(a.scheduledAt) - ts(b.scheduledAt));

  const rows = ordered
    .map((c) => {
      // #2249 follow-up (editor 2026-06-14): colunas Dia e Lista removidas.
      return `<tr>
        <td>${escHtml(c.name)}</td>
        <td>${fmtTimeBRT(c.scheduledAt)}</td>
        <td>${c.listSize != null ? c.listSize.toLocaleString("pt-BR") : "—"}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="scheduled-campaigns">
  <h2 class="section-title">Envios agendados</h2>
  <p class="section-note">${ordered.length} agendado(s) — próximo envio primeiro. Tamanho = snapshot esperado da lista no envio.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Nome do envio no Brevo">Envio</th>
        <th title="Horário agendado (horário de Brasília)">Agendado (BRT)</th>
        <th title="Tamanho atual da lista (destinatários esperados)">Tamanho</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * Renderiza a seção de Volume enviado no ciclo — primeira informação do dashboard
 * (decisão do editor 2026-06-11: volume vem ANTES do resumo A/B/C).
 *
 * #2910: `window` é o ciclo de COBRANÇA Brevo (dia 4, 15:45 BRT —
 * `billingCycleWindow`), exibido explicitamente no rótulo pra nunca ser
 * confundido com o ciclo de CONTEÚDO/envio do #2909/#2923 (mês corrente,
 * planejamento de reenvio) — os dois são conceitos DIFERENTES por design.
 * `planCredits` é o RESTANTE do ciclo vindo da Brevo (/v3/account) — NÃO o total
 * do plano. O denominador real (volume/allowance do ciclo) é derivado como
 * `planCredits + cumulativeSent` (restante + já enviado). `null` quando o fetch
 * falhou e não há cache: a seção mostra o número absoluto sem percentual/barra.
 * (Correção 260705: o #2910 usava o restante direto como denominador, que encolhia
 * a cada envio — o denominador correto é o total do ciclo, restante + enviado.)
 * Exportado pra teste unitário.
 */
export function renderVolumeSection(
  cumulativeSent: number,
  window: BillingCycleWindow,
  planCredits: number | null,
  // #3080: true quando a janela de campanhas buscadas na Brevo (CAMPAIGNS_FETCH_LIMIT)
  // está "cheia" (truncada) E a campanha mais antiga dentro dela é POSTERIOR ao início
  // do ciclo de cobrança — sinal de que `cumulativeSent` pode estar SUBCONTANDO (há
  // envios anteriores, dentro do ciclo, que ficaram fora da janela buscada). Default
  // `false` preserva o comportamento anterior para callers/testes que não passam o arg.
  mayUndercount = false,
): string {
  const windowLabel = formatBillingWindowLabel(window);
  const undercountNote = mayUndercount
    ? `<br><small class="alert">⚠️ a janela de campanhas buscadas na Brevo não cobre todo o ciclo de cobrança — este total pode estar <strong>subcontado</strong>.</small>`
    : "";
  // #2429: rótulo "E-mails (eventos)" (#2491: renomeado de "Envios (eventos)") deixa explícito
  // que este número conta eventos de envio (uma pessoa em 2 campanhas conta 2 vezes; inclui
  // bounces), não pessoas únicas.
  // Tooltip compartilhado via ENVIOS_TOOLTIP — mesma cópia usada na tabela por-campanha e mensal.
  const sentLabel = `<strong title="${escHtml(ENVIOS_TOOLTIP)}">${cumulativeSent.toLocaleString("pt-BR")} envios (eventos)</strong>`;

  // `planCredits` da Brevo (/v3/account) é o RESTANTE do ciclo, NÃO o total do plano.
  // O volume/allowance do ciclo (denominador) = restante + já enviado neste ciclo.
  // Ex: 34.708 restante + 5.292 enviado = 40.000 (o plano real). O #2910 usava o
  // restante direto como denominador → errado: encolhia a cada envio (bug do editor 260705).
  const planTotal = planCredits === null ? null : planCredits + cumulativeSent;

  if (planTotal === null || planTotal <= 0) {
    return `
<section class="phase2-section" id="volume-ciclo">
  <h2 class="section-title">Volume enviado no ciclo</h2>
  <p class="section-note volume-note">
    ${sentLabel} — créditos do plano Brevo indisponíveis (denominador não mostrado).<br>
    <small>Ciclo de cobrança Brevo: ${windowLabel} (renova dia ${BILLING_CYCLE_DAY} às ${String(BILLING_CYCLE_HOUR).padStart(2, "0")}:${String(BILLING_CYCLE_MINUTE).padStart(2, "0")} BRT)</small>${undercountNote}
  </p>
</section>`;
  }

  const pctBar = Math.min(100, (cumulativeSent / planTotal) * 100);
  const pctLabel = pctBar.toFixed(1);
  const barFill = Math.round(pctBar * 0.3); // 30 chars = 100%
  const bar = "█".repeat(barFill) + "░".repeat(30 - barFill);
  return `
<section class="phase2-section" id="volume-ciclo">
  <h2 class="section-title">Volume enviado no ciclo</h2>
  <p class="section-note volume-note">
    ${sentLabel} de ${planTotal.toLocaleString("pt-BR")} créditos do plano (${pctLabel}%)<br>
    <span class="spark-bar" title="${pctLabel}% do plano do mês">${bar}</span><br>
    <small>Ciclo de cobrança Brevo: ${windowLabel} (renova dia ${BILLING_CYCLE_DAY} às ${String(BILLING_CYCLE_HOUR).padStart(2, "0")}:${String(BILLING_CYCLE_MINUTE).padStart(2, "0")} BRT)</small>${undercountNote}
  </p>
</section>`;
}


// ─── #2369: tabela de totais por mês ─────────────────────────────────────────

/**
 * Linha de totalização mensal de campanhas enviadas.
 * #2442: campos extras para espelhar formato da tabela Envios (Bounces/Unsub/Spam + range de datas).
 */
export interface MonthlyTotalRow {
  /** Mês no formato YYYY-MM (ex: "2026-06") */
  month: string;
  /** Rótulo legível (ex: "Jun/2026") */
  label: string;
  /** Número de campanhas enviadas no mês */
  campaignCount: number;
  /** Soma de enviados (sent) no mês */
  totalSent: number;
  /** Soma de entregues (delivered) no mês */
  totalDelivered: number;
  /** Soma de aberturas únicas (uniqueViews) no mês */
  totalViews: number;
  /** Soma de cliques únicos (uniqueClicks) no mês */
  totalClicks: number;
  /** Open rate agregado = totalViews / totalDelivered (0 quando delivered=0) */
  openRate: number;
  /** CTOR agregado = totalClicks / totalViews (cliques ÷ aberturas; 0 quando views=0) */
  ctor: number;
  /** #2442: Soma de hard+soft bounces no mês */
  totalBounces: number;
  /** #2442: Bounce rate agregado = totalBounces / totalSent (0 quando sent=0) */
  bounceRate: number;
  /** #3078: Soma de hard bounces (subconjunto de totalBounces) — permite avaliar o breaker de hard isoladamente do total. */
  totalHardBounces: number;
  /** #3078: Hard bounce rate agregado = totalHardBounces / totalSent (0 quando sent=0) */
  hardBounceRate: number;
  /** #2442: Soma de descadastros no mês */
  totalUnsub: number;
  /** #2442: Unsub rate = totalUnsub / totalSent (0 quando sent=0) */
  unsubRate: number;
  /** #2442: Soma de spam (complaints) no mês */
  totalSpam: number;
  /** #2442: Spam rate = totalSpam / totalSent (0 quando sent=0) */
  spamRate: number;
  /** #2442: ISO string do sentDate mais antigo do mês (1º envio) */
  firstSentDate: string | null;
  /** #2442: ISO string do sentDate mais recente do mês (último envio) */
  lastSentDate: string | null;
}

/**
 * Agrega campanhas por mês de envio (sentDate). Usa as mesmas stats que o
 * render principal (globalStats primário → campaignStats fallback via pickStats).
 * Só inclui campanhas com stats reais (sent > 0). Ordena do mês mais recente
 * para o mais antigo.
 * Exportado pra teste unitário.
 */
export function aggregateByMonth(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): MonthlyTotalRow[] {
  type Acc = {
    campaignCount: number;
    totalSent: number;
    totalDelivered: number;
    totalViews: number;
    totalClicks: number;
    // #2442: novos campos para espelhar Envios
    totalBounces: number;
    totalUnsub: number;
    totalSpam: number;
    // #3078: hard bounces isolado (subconjunto de totalBounces)
    totalHardBounces: number;
    firstSentDate: string | null;
    lastSentDate: string | null;
  };
  const acc = new Map<string, Acc>();

  for (const c of campaigns) {
    if (!c.sentDate) continue;
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;

    // Extrair YYYY-MM em BRT (America/Sao_Paulo), consistente com fmtTimeBRT e
    // weekdayKeyBRT. Campanha enviada 2026-07-01T00:00:00Z = 30/jun 21:00 BRT
    // deve bucketizar em "2026-06", não "2026-07". (#2402)
    // monthKeyBRT retorna null para sentDate malformado — pular a campanha. (#2407)
    const month = monthKeyBRT(c.sentDate);
    if (month === null) continue;
    if (!acc.has(month)) {
      acc.set(month, {
        campaignCount: 0, totalSent: 0, totalDelivered: 0, totalViews: 0, totalClicks: 0,
        totalBounces: 0, totalUnsub: 0, totalSpam: 0, totalHardBounces: 0,
        firstSentDate: null, lastSentDate: null,
      });
    }
    const row = acc.get(month)!;
    row.campaignCount += 1;
    row.totalSent += s.sent ?? 0;
    row.totalDelivered += s.delivered ?? 0;
    row.totalViews += s.uniqueViews ?? 0;
    row.totalClicks += s.uniqueClicks ?? 0;
    // #2442: bounces, unsub, spam
    row.totalBounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    row.totalUnsub += s.unsubscriptions ?? 0;
    row.totalSpam += s.complaints ?? 0;
    // #3078: hard bounces isolado, pra avaliar o breaker de hard (≥2%) separado do total (≥5%)
    row.totalHardBounces += s.hardBounces ?? 0;
    // #2442: rastrear min/max sentDate do mês (1º e último envio).
    // c.sentDate é garantido truthy pelo `if (!c.sentDate) continue` no topo do loop.
    if (row.firstSentDate === null || c.sentDate < row.firstSentDate) row.firstSentDate = c.sentDate;
    if (row.lastSentDate === null || c.sentDate > row.lastSentDate) row.lastSentDate = c.sentDate;
  }

  if (acc.size === 0) return [];

  return Array.from(acc.entries())
    .sort(([a], [b]) => b.localeCompare(a)) // mais recente primeiro
    .map(([month, d]) => {
      // "2026-06" → "Jun/2026"
      const [year, mon] = month.split("-");
      const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
      const label = `${monthNames[parseInt(mon, 10) - 1] ?? mon}/${year}`;
      return {
        month,
        label,
        campaignCount: d.campaignCount,
        totalSent: d.totalSent,
        totalDelivered: d.totalDelivered,
        totalViews: d.totalViews,
        totalClicks: d.totalClicks,
        openRate: d.totalDelivered > 0 ? (d.totalViews / d.totalDelivered) * 100 : 0,
        ctor: d.totalViews > 0 ? (d.totalClicks / d.totalViews) * 100 : 0,
        // #2442
        totalBounces: d.totalBounces,
        bounceRate: d.totalSent > 0 ? (d.totalBounces / d.totalSent) * 100 : 0,
        // #3078
        totalHardBounces: d.totalHardBounces,
        hardBounceRate: d.totalSent > 0 ? (d.totalHardBounces / d.totalSent) * 100 : 0,
        totalUnsub: d.totalUnsub,
        unsubRate: d.totalSent > 0 ? (d.totalUnsub / d.totalSent) * 100 : 0,
        totalSpam: d.totalSpam,
        spamRate: d.totalSent > 0 ? (d.totalSpam / d.totalSent) * 100 : 0,
        firstSentDate: d.firstSentDate,
        lastSentDate: d.lastSentDate,
      };
    });
}

/**
 * Renderiza a tabela de totais por mês — 1 linha por mês, agregando campanhas
 * enviadas naquele mês. Tabela À PARTE da lista detalhada de campanhas.
 * Oculta ("") quando sem dados.
 * #2442: espelha formato da tabela Envios (taxa+count, Bounces/Unsub/Spam, range de datas).
 * Exportado pra teste unitário.
 */
export function renderMonthlyTotalsSection(
  rows: MonthlyTotalRow[],
  // #3080: quando não-null, a janela de campanhas buscadas na Brevo estava
  // "cheia" (truncada) neste render — o valor é o limite pedido (ex: 150),
  // exibido no aviso. `rows` já vem ORDENADO do mês mais recente pro mais
  // antigo (aggregateByMonth) — o mês mais antigo (última linha) é o único
  // candidato a estar incompleto (um mês truncado no MEIO da janela sempre
  // teria a linha mais recente completa por definição de "mais recente
  // primeiro"). Default `null` preserva o comportamento anterior (sem aviso)
  // para callers/testes que não passam o argumento.
  windowLimitWhenFull: number | null = null,
): string {
  if (rows.length === 0) return "";

  // Formata célula com taxa em cima + contagem absoluta embaixo (igual ao row builder de Envios).
  function metricCell(rate: string, count: number, alertClass?: boolean): string {
    const cls = alertClass ? ' class="alert"' : ' class="metric"';
    return `<td${cls}>${rate}<br><small>${count.toLocaleString("pt-BR")}</small></td>`;
  }

  // #2442: range de datas "1º – último" do mês, formatado em BRT data-apenas.
  function fmtDateBRT(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
    });
  }

  const tableRows = rows.map((r, idx) => {
    // #3080: só a linha do mês MAIS ANTIGO (última do array — ver comentário na
    // assinatura) recebe o aviso de janela parcial.
    const isOldestMonth = idx === rows.length - 1;
    const partialNote =
      isOldestMonth && windowLimitWhenFull != null
        ? ` <span class="alert" title="A janela de campanhas buscadas na Brevo cobre só as últimas ${windowLimitWhenFull} campanhas enviadas — envios deste mês anteriores a essa janela não entram no total.">(parcial — janela de ${windowLimitWhenFull} campanhas)</span>`
        : "";
    const openRateFmt = r.totalDelivered > 0 ? r.openRate.toFixed(1) + "%" : "—";
    const ctorFmt = r.totalViews > 0 ? r.ctor.toFixed(1) + "%" : "—";
    const bounceRateFmt = r.totalSent > 0 ? r.bounceRate.toFixed(1) + "%" : "—";
    const unsubRateFmt = r.totalSent > 0 ? r.unsubRate.toFixed(1) + "%" : "—";
    // #3081: 3 casas (não 1) — mesma precisão da tabela Envios (sections-core.ts)
    // e do fix de `pct()` (denominador 0 → "—"). `r.spamRate` já vem
    // pré-computado por `aggregateByMonth` — reformatar aqui, não recomputar a
    // partir de r.totalSpam/r.totalSent (2ª fonte de verdade).
    const spamRateFmt = r.totalSent > 0 ? r.spamRate.toFixed(3) + "%" : "—";
    // Circuit breaker alerts (mesmos thresholds da tabela Envios, #3078: hard ≥2% OU total ≥5%)
    const bounceAlert = r.totalSent > 0 && isBounceBreach(r.hardBounceRate, r.bounceRate);
    const unsubAlert = r.totalSent > 0 && r.unsubRate >= 3;
    const spamAlert = r.totalSent > 0 && r.spamRate >= 0.1;

    const firstDate = fmtDateBRT(r.firstSentDate);
    const lastDate = fmtDateBRT(r.lastSentDate);
    // Comparar as datas formatadas (não os ISO datetimes raw) para que campanhas
    // no mesmo dia-calendário BRT mas em horários distintos exibam data única.
    const sentRange = firstDate === lastDate || r.campaignCount <= 1
      ? firstDate
      : `${firstDate} – ${lastDate}`;

    return `<tr>
      <td><strong>${escHtml(r.label)}</strong>${partialNote}</td>
      <td>${r.campaignCount}</td>
      <td>${sentRange}</td>
      <td>${r.totalSent.toLocaleString("pt-BR")}</td>
      <td>${pct(r.totalDelivered, r.totalSent)}<br><small>${r.totalDelivered.toLocaleString("pt-BR")}</small></td>
      ${metricCell(openRateFmt, r.totalViews)}
      ${metricCell(ctorFmt, r.totalClicks)}
      ${metricCell(bounceRateFmt, r.totalBounces, bounceAlert)}
      ${metricCell(unsubRateFmt, r.totalUnsub, unsubAlert)}
      ${metricCell(spamRateFmt, r.totalSpam, spamAlert)}
    </tr>`;
  }).join("\n");

  // #3092: takeaway curto sempre visível + metodologia (eventos vs pessoas
  // únicas, comparação com Coortes) num <details> "Como ler esta tabela".
  const totaisTakeaway = `1 linha por mês — agrega todos os envios realizados naquele mês (eventos por envio, não pessoas únicas).`;
  const totaisMethodology = `Um contato que recebeu 3 campanhas conta 3×. Opens usa <code>uniqueViews</code> (MPP-inclusivo, igual à UI da Brevo) — não comparar diretamente com as Coortes de engajamento (que contam <strong>pessoas únicas</strong> com aberturas reais/trackable, EXCLUI MPP). Veja a lista detalhada na seção Envios abaixo.`;

  return `
<section class="phase2-section" id="monthly-totals">
  <h2 class="section-title">Totais por mês</h2>
  ${renderMixedAudienceNote()}
  ${renderMethodologyNote("monthly-totals", totaisTakeaway, totaisMethodology)}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Mês do envio">Mês</th>
        <th title="Número de envios realizados no mês">Envios</th>
        <th title="Intervalo de datas: 1º envio – último envio do mês (horário de Brasília)">Enviado (1º – último)</th>
        <th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th>
        <th title="Emails entregues nas caixas dos leitores.">Delivered</th>
        <th title="Aberturas únicas (MPP-inclusivo). Bench: 15-25% B2C, 30-45% engajadas.">Opens 👁️</th>
        <th title="CTOR (click-to-open rate) = cliques únicos ÷ aberturas únicas. Taxa em cima, count de cliques embaixo. Bench: ~10-15% típico (denominador é opens, não delivered).">CTOR 🖱️</th>
        <th title="Hard bounces + soft bounces. Bench: &lt;2% saudável. Pausa o ramp quando hard ≥2% OU total ≥5%.">Bounces</th>
        <th title="Descadastros. Bench: &lt;0.5%. ≥3% pausa o ramp.">Unsub</th>
        <th title="Marcações de spam. Bench: &lt;0.1%. ≥0.1% pausa o ramp.">Spam</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2426: renderiza a tabela de coortes de engajamento por contato.
 * Cada contato cai em EXATAMENTE uma coorte (partição mutuamente exclusiva);
 * "saídas" (bounce/descadastro) têm precedência sobre engajamento. O dado é
 * pré-computado por scripts/clarice-engagement-cohorts.ts → KV.
 *
 * Graceful: quando `cohorts` é null (KV ainda não populado), renderiza um stub
 * com a instrução de como gerar — seção presente, nunca quebra o render.
 * Exportado pra teste unitário.
 */
export function renderEngagementCohortsSection(
  cohorts: EngagementCohorts | null,
  headerNow: Date = new Date(),
): string {
  if (!cohorts) {
    return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-engagement-cohorts.ts</code> para popular (faz os GETs per-contato e grava no KV).</p>
</section>`;
  }

  const u = cohorts.universe;
  const genBRT = fmtTimeBRT(cohorts.generatedAt);
  // #3011: nota só aparece quando o dado pré-computado diverge do cabeçalho.
  const staleNote = shouldShowStalenessNote(cohorts.generatedAt, headerNow)
    ? ` Pré-computado às ${genBRT} BRT.`
    : "";
  // Rótulo "2+" (#2426 review): os buckets são definidos como ≥2 (abriu ≥2 /
  // recebeu ≥2), então "2+" é sempre exato — não acoplar ao maxReceived, que
  // descreve o máximo recebido e podia rotular errado o bucket de OPENS (open
  // pode exceder received em anomalias de tracking da Brevo).

  const defs: Array<{ label: string; title: string; n: number }> = [
    { label: "Abriu 2+ e-mails", title: "Contatos que abriram 2 ou mais e-mails reais (e não saíram). Conta aberturas trackable per-contato — EXCLUI MPP/proxy Apple (sinal humano mais limpo). A Brevo não atribui MPP a contatos individuais.", n: cohorts.opened2plus },
    { label: "Abriu 1 e-mail", title: "Contatos que abriram exatamente 1 e-mail real (e não saíram). Conta aberturas trackable per-contato — EXCLUI MPP/proxy Apple (sinal humano mais limpo). A Brevo não atribui MPP a contatos individuais.", n: cohorts.opened1 },
    { label: "Recebeu 1, não abriu", title: "Recebeu 1 e-mail e não abriu nenhum (e não saiu).", n: cohorts.received1_opened0 },
    { label: "Recebeu 2+, não abriu", title: "Recebeu 2 ou mais e-mails e não abriu nenhum (e não saiu).", n: cohorts.received2_opened0 },
    {
      label: "Saídas (bounce/descadastro)",
      title: `Contatos com bounce ou descadastro — precedência sobre tudo (não importa se abriram). Bounce: ${cohorts.exitsBreakdown.bounced.toLocaleString("pt-BR")} · descadastro/suprimido: ${cohorts.exitsBreakdown.optedOut.toLocaleString("pt-BR")}.`,
      n: cohorts.exits,
    },
  ];

  const tableRows = defs.map((d) => `<tr>
      <td title="${escHtml(d.title)}"><strong>${escHtml(d.label)}</strong></td>
      <td class="metric">${d.n.toLocaleString("pt-BR")}</td>
      <td>${pct(d.n, u)}</td>
    </tr>`).join("\n");

  // #2441: validar que as 5 coortes somam o universo (partição completa).
  const cohorteSum = cohorts.opened2plus + cohorts.opened1 + cohorts.received1_opened0 + cohorts.received2_opened0 + cohorts.exits;
  const sumMismatch = cohorteSum !== u;
  // Linha de totalização em <tfoot> — soma coluna "Pessoas únicas" = universe.
  const sumMismatchTitle = sumMismatch
    ? escHtml(`Atenção: soma das coortes (${cohorteSum.toLocaleString("pt-BR")}) ≠ universo (${u.toLocaleString("pt-BR")}) — verifique dados`)
    : "";
  const tfootRow = `<tr class="total-row">
      <td>Total${sumMismatch ? ` <span style="color:var(--alert)" title="${sumMismatchTitle}">⚠️</span>` : ""}</td>
      <td class="metric">${u.toLocaleString("pt-BR")}</td>
      <td>100%</td>
    </tr>`;

  // #3092: takeaway curto sempre visível + metodologia (partição exclusiva,
  // exclusão de MPP, escopo) num <details> "Como ler esta tabela".
  const coortesTakeaway = `<span title="Contatos únicos dedupados que receberam ao menos um envio (todas as campanhas).">${u.toLocaleString("pt-BR")} pessoas únicas alcançadas</span> (recebeu ≥1 e-mail ou saiu), divididas em coortes mutuamente exclusivas.${staleNote}`;
  const coortesMethodology = `Cada contato conta em <strong>exatamente uma</strong> coorte — quem deu bounce ou descadastrou entra só em "Saídas", independente de ter aberto. "Abriu" = aberturas reais (trackable) per-contato — <strong>EXCLUI MPP</strong> (a Brevo não atribui MPP a contatos individuais; <code>appleMppOpens</code> é só agregado de campanha). Por isso os números aqui diferem de "Totais por mês" (que usa <code>uniqueViews</code>, MPP-inclusivo) — não comparar 1:1. Escopo: toda a base Clarice (todas as edições).`;

  return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  ${renderMethodologyNote("engagement-cohorts", coortesTakeaway, coortesMethodology)}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Coorte de engajamento (mutuamente exclusivas).">Coorte</th>
        <th title="Número de pessoas únicas nesta coorte.">Pessoas únicas</th>
        <th title="Participação no universo de pessoas únicas alcançadas.">% do universo</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    <tfoot>${tfootRow}</tfoot>
  </table>
  </div>
</section>`;
}

/**
 * #2653: renderiza o sumário do store único de contatos (#2647).
 * Stub gracioso quando `contactsSummary` é null (KV não populado ainda).
 * Exportado pra teste unitário.
 */
export function renderContactsSummarySection(
  s: ContactsSummary | null,
  headerNow: Date = new Date(),
): string {
  // Stub quando a chave KV não existe (null) OU o payload está malformado (total
  // não-numérico). NÃO usa `!s.total`: um store legitimamente vazio (total=0) é
  // dado válido, não ausência de dado.
  if (!s || typeof s.total !== "number") {
    return `
<section class="phase2-section" id="contacts-summary">
  <h2 class="section-title">Banco de contatos (store)</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-db-summary.ts</code> para popular.</p>
</section>`;
  }

  // Defaults defensivos: o handler casta o JSON do KV sem validar shape; um
  // payload de uma versão antiga do script (sem algum subobjeto) NÃO pode lançar
  // e derrubar o render do dashboard inteiro.
  const brevo = s.brevo ?? { synced_rows: 0, has_signal: false };
  const elig = s.eligibility ?? { eligible: 0, ineligible: 0, by_reason: {} };
  const pp = s.priority_points ?? { lt0: 0, eq0: 0, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 };
  // #3081: dado já computado pelo script (#2809) mas nunca exposto na dashboard —
  // "—" (não 0) quando o KV é anterior a este campo (undefined), distinguindo
  // "0 excluídos" de "dado ausente". `fmtCount` direto (não o alias `n`,
  // declarado mais abaixo nesta função).
  const internalExcludedFmt = pp.internal_excluded != null ? fmtCount(pp.internal_excluded) : "—";
  const eng = s.engagement ?? { with_opens: 0, with_clicks: 0 };

  const n = fmtCount; // #2875: dedup — ver fmtCount module-level
  const genBRT = escHtml(fmtTimeBRT(s.generated_at));
  // #3011: nota só aparece quando o dado pré-computado diverge do cabeçalho.
  const staleNote = shouldShowStalenessNote(s.generated_at, headerNow)
    ? ` Gerado às ${genBRT} BRT.`
    : "";

  // tabelinha {rótulo → contagem}, ordenada por contagem desc. #2880 E: com
  // linha "Total" ao fim (só quando há ≥1 linha). Usada por "Inelegíveis por
  // razão" e "MillionVerifier (bucket)".
  // #3092: `emptyKeyLabel` — a query de origem do mapa `mv` (COALESCE em
  // mv_bucket) só normaliza NULL, não string vazia (mv_bucket='' é um estado
  // válido e distinto, ver scripts/lib/clarice-db.ts MV_NEVER_VERIFIED_SQL).
  // Sem isso, a chave "" renderizava uma linha com rótulo em branco — dado
  // real, mas ilegível pro editor. Default undefined preserva o comportamento
  // anterior para chamadas (ex: "Inelegíveis por razão") sem chave vazia.
  const kvTable = (
    title: string,
    map: Record<string, number> | undefined,
    emptyKeyLabel?: string,
  ): string => {
    const entries = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]);
    const rows = entries
      .map(
        ([k, v]) =>
          `<tr><td>${escHtml(k === "" && emptyKeyLabel ? emptyKeyLabel : k)}</td><td style="text-align:right">${n(v)}</td></tr>`,
      )
      .join("\n");
    // #2880 E: linha Total (soma das contagens). Só quando há ≥1 linha — tabela
    // vazia não ganha um "Total 0" sem sentido.
    const total = entries.reduce((a, [, v]) => a + v, 0);
    const totalRow = entries.length
      ? `\n<tr class="total-row"><td>Total</td><td style="text-align:right">${n(total)}</td></tr>`
      : "";
    return `<div class="table-wrap"><table>
      <thead><tr><th>${escHtml(title)}</th><th style="text-align:right">contatos</th></tr></thead>
      <tbody>${rows}${totalRow}</tbody></table></div>`;
  };

  const ppMap: Record<string, number> = {
    "negativo (<0)": pp.lt0,
    "zero (sem histórico)": pp.eq0,
    "1–40": pp.p1_40,
    "41–80": pp.p41_80,
    ">80": pp.gt80,
  };
  // #2731: distribuição por VALOR EXATO de priority_points, ordenada
  // NUMERICAMENTE DESC pelo valor (não pela contagem, ao contrário de
  // `kvTable`) — reflete a ordem real da fila de re-envio (maior pontuação
  // recebe primeiro). "null" (sem pontuação atribuída ainda) vai por último.
  const renderPriorityPointsHistogram = (hist: Record<string, number>): string => {
    // priority_points é coluna INTEGER (schema) — Number(k) nunca deveria dar
    // NaN aqui. Guard defensivo mesmo assim: um NaN não-tratado tornaria o
    // sort implementation-defined (ordem imprevisível), mascarando um
    // problema de qualidade de dado em vez de sinalizá-lo — NaN vai pro fim,
    // igual "sem pontuação".
    const rank = (k: string): number => {
      if (k === "null") return -Infinity;
      const num = Number(k);
      return isNaN(num) ? -Infinity : num;
    };
    const sorted = Object.entries(hist).sort(([a], [b]) => rank(b) - rank(a));
    // #2880: coluna "elegíveis" (send_eligible=1) ENTRE contatos e verified —
    // o histograma cobre a base inteira (menos internos), incluindo inelegíveis;
    // esta coluna isola, por faixa de pontos, o subconjunto de fato enviável.
    // Mesmo gate opcional das demais (KV antigo sem o campo → sem a coluna).
    const eHist = s.priority_points_histogram_eligible;
    const withEligible = eHist !== undefined;
    // 260702: coluna "verified" (mv_bucket='verified') — só quando o KV já
    // traz o campo novo; payload antigo renderiza a tabela de 2 colunas.
    const vHist = s.priority_points_histogram_verified;
    const withVerified = vHist !== undefined;
    // #2865: coluna "Brevo" (brevo_list_ids IS NOT NULL) — mesmo gate opcional.
    const bHist = s.priority_points_histogram_brevo;
    const withBrevo = bHist !== undefined;
    // #2880: as sub-linhas "1º envio — cohort" (que ficavam sob a linha 0)
    // foram removidas — o eixo cohort agora vive só na tabela Cohorts, logo
    // abaixo. O histograma fica PURO (distribuição por valor de pontuação).
    // Ordem das colunas: contatos | elegíveis | verified | Brevo.
    const rows = sorted.map(([k, v]) =>
      `<tr><td>${escHtml(k === "null" ? "sem pontuação" : k)}</td><td style="text-align:right">${n(v)}</td>${withEligible ? `<td style="text-align:right">${n(eHist?.[k] ?? 0)}</td>` : ""}${withVerified ? `<td style="text-align:right">${n(vHist?.[k] ?? 0)}</td>` : ""}${withBrevo ? `<td style="text-align:right">${n(bHist?.[k] ?? 0)}</td>` : ""}</tr>`,
    ).join("\n");
    // #2880 E: linha Total — soma cada coluna sobre todas as faixas (= a base
    // inteira menos internos, universo do histograma).
    const sumMap = (m: Record<string, number> | undefined): number =>
      Object.values(m ?? {}).reduce((a, b) => a + b, 0);
    const totContatos = sorted.reduce((a, [, v]) => a + v, 0);
    const totalRow = `<tr class="total-row"><td>Total</td><td style="text-align:right">${n(totContatos)}</td>${withEligible ? `<td style="text-align:right">${n(sumMap(eHist))}</td>` : ""}${withVerified ? `<td style="text-align:right">${n(sumMap(vHist))}</td>` : ""}${withBrevo ? `<td style="text-align:right">${n(sumMap(bHist))}</td>` : ""}</tr>`;
    return `<div class="table-wrap"><table>
      <thead><tr><th title="Score = priority_points (engajamento): +40 optin, +20 por abertura, −10 por não-abertura. Fila de re-envio: maior Score primeiro.">Score (valor exato)</th><th style="text-align:right">contatos</th>${withEligible ? '<th style="text-align:right">elegíveis</th>' : ""}${withVerified ? '<th style="text-align:right">verified</th>' : ""}${withBrevo ? '<th style="text-align:right">Brevo</th>' : ""}</tr></thead>
      <tbody>${rows}
${totalRow}</tbody></table></div>`;
  };
  // #2812 item 6: fallback pré-#2731 (sem priority_points_histogram) não
  // #2880: fallback pré-#2731 (sem priority_points_histogram) degrada pras
  // faixas antigas — sem sub-linhas de cohort (removidas; ver tabela Cohorts).
  const renderPriorityPointsFallback = (map: Record<string, number>): string => {
    const rows = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${escHtml(k)}</td><td style="text-align:right">${n(v)}</td></tr>`)
      .join("\n");
    return `<div class="table-wrap"><table>
      <thead><tr><th title="Score = priority_points (engajamento)">Score (re-envio, por faixa — aguardando refresh #2731)</th><th style="text-align:right">contatos</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  // KV pré-#2731 não tem o histograma — degrada pras faixas antigas.
  const priorityPointsSection = s.priority_points_histogram
    ? renderPriorityPointsHistogram(s.priority_points_histogram)
    : renderPriorityPointsFallback(ppMap);
  // #3088: teal falha AA em texto pequeno — badge de status volta a --ink
  // (o vermelho de alerta do outro branch é DS.alert, que já passa AA).
  const brevoBadge = brevo.has_signal
    ? `<span style="color:${DS.ink}">${n(brevo.synced_rows)} sincronizados</span>`
    : `<span style="color:var(--alert)">sem sinal Brevo ainda — rode clarice-sync-brevo.ts</span>`;

  // #2880: a tabela "Por safra (cohort)" foi REMOVIDA — o eixo cohort vive
  // agora só na tabela Cohorts (renderCohortsTabPanel), consolidada nesta mesma
  // aba logo abaixo. O histograma abaixo é o eixo PONTUAÇÃO (re-envio), puro.
  return `
<section class="phase2-section" id="contacts-summary">
  <h2 class="section-title">Banco de contatos (store)</h2>
  <p class="section-note">Sumário agregado do store único (#2647). Total: <strong>${n(s.total)}</strong> · elegíveis: <strong>${n(elig.eligible)}</strong> · inelegíveis: <strong>${n(elig.ineligible)}</strong> · optin: <strong>${n(pp.optin)}</strong> · internos excluídos: <strong>${internalExcludedFmt}</strong> · Brevo: ${brevoBadge}.${staleNote}</p>
  ${priorityPointsSection}
  <p class="section-note">Score = <code>priority_points</code> (engajamento), aditivo (sem corte duro): parte de 0 · <strong>+40</strong> optin (pediu prioridade) · <strong>+20</strong> por e-mail aberto · <strong>−10</strong> por e-mail recebido e não aberto. Ex.: optin que ignora 4 e-mails decai pra 0 (40 − 10×4). Fila de re-envio: maior Score primeiro.</p>
  <p class="section-note">A distribuição por cohort (safra/tipo) está na tabela <strong>Cohorts</strong> abaixo — a linha "sem pontuação" concentra o universo de 1º envio, detalhado lá por cohort. "Score" acima = <code>priority_points</code> (engajamento), <strong>não</strong> o "score" legado (desacreditado, já morto no código).</p>
  <div class="side-by-side">
  ${kvTable("Inelegíveis por razão", elig.by_reason)}
  ${kvTable("MillionVerifier (bucket)", s.mv, "não verificado (sem bucket)")}
  </div>
  <p class="section-note">Engajamento Brevo: ${n(eng.with_opens)} com abertura · ${n(eng.with_clicks)} com clique.</p>
</section>`;
}

/**
 * #2864: aba "Cohorts" — comparativo de envio/engajamento por cohort. Pedido
 * do editor 260702: entender se há padrão de comportamento que difere de um
 * cohort pro outro (insumo pra estratégia da rampa/segmentação de conteúdo).
 *
 * Fonte: `ContactsSummary.cohort_stats` (novo bloco opcional do sumário do
 * store, `scripts/clarice-db-summary.ts`) — contagens BRUTAS por cohort; as
 * taxas (abertura/clique/unsub+bounce/MV) são calculadas AQUI, no render, com
 * denominador 0 tratado como "—" (nunca NaN/Infinity).
 *
 * Ordenação: `cohortSendRank` ASC — mesma fila real de 1º envio das demais
 * tabelas de cohort do dashboard (mais morno → mais frio), pra leitura
 * vertical mostrar o gradiente e outliers saltarem à vista (pedido do editor).
 *
 * Destaque visual: célula ganha `class="alert"` quando a taxa da linha desvia
 * mais de `COHORT_DEVIATION_THRESHOLD_PP` pontos percentuais da média SIMPLES
 * da coluna (só sobre cohorts com denominador > 0) — é o "padrão que difere"
 * que o editor busca. Escolha simples e determinística (a issue delegou a
 * decisão do critério exato de destaque).
 *
 * Stub gracioso quando `cohortStats` é undefined/vazio (KV antigo sem o
 * campo, ou store ainda sem contatos) — mesmo contrato das demais seções KV.
 * Exportado pra teste unitário.
 */
export const COHORT_DEVIATION_THRESHOLD_PP = 20;

/**
 * #3090: definição canônica das colunas da tabela Cohorts (label + tooltip) —
 * fonte única usada tanto no `title=` de cada `<th>` quanto no `<details>`
 * "Glossário das colunas" (sempre visível, funciona em touch/mobile). Exportado
 * pra teste unitário.
 */
export const COHORTS_COLUMNS: Array<{ label: string; tooltip: string }> = [
  { label: "Cohort", tooltip: "Cohort (taxonomia #2857)" },
  { label: "Contatos", tooltip: "Total de contatos no cohort (exclui internos)" },
  { label: "Na Brevo", tooltip: "Contatos do cohort sincronizados na Brevo (brevo_list_ids preenchido)" },
  { label: "Elegíveis", tooltip: "Contatos elegíveis para envio (send_eligible=1)" },
  { label: "Recebeu ≥1", tooltip: "Contatos que já receberam ao menos 1 envio (sends_count>0)" },
  {
    label: "Recebeu neste ciclo",
    tooltip: "Contatos do cohort que receberam no ciclo atual (last_sent_at ≥ início do ciclo)",
  },
  {
    label: "Falta enviar",
    tooltip: "Elegíveis que ainda faltam receber neste ciclo (Elegíveis − Recebeu neste ciclo, mínimo 0)",
  },
  { label: "Abertura", tooltip: "% de quem recebeu que abriu ao menos 1 envio" },
  { label: "Clique", tooltip: "% de quem recebeu que clicou ao menos 1 envio" },
  { label: "Unsub", tooltip: "% de quem recebeu que descadastrou" },
  { label: "Bounce", tooltip: "% de quem recebeu que deu hard bounce" },
];

export function renderCohortsTabPanel(
  cohortStats: Record<string, CohortStatsRow> | undefined,
  // #2909: início do ciclo corrente (ISO). Presente → colunas "Recebeu neste
  // ciclo"/"Falta enviar" exibem números; null/undefined → "—" (sem ciclo).
  cycleStart: string | null = null,
): string {
  // #2660 (review #2872): payload AUSENTE (KV antigo, script nunca rodou) ≠
  // payload VAZIO (script rodou, store sem cohorts) — mensagens distintas.
  const stub = (note: string): string => `
<section class="phase2-section" id="cohorts-tab">
  <h2 class="section-title">Cohorts</h2>
  <p class="section-note">${note}</p>
</section>`;
  if (!cohortStats) {
    return stub(
      'Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-db-summary.ts</code> para popular.',
    );
  }
  if (Object.keys(cohortStats).length === 0) {
    return stub("Nenhum cohort no store (sumário gerado com base vazia).");
  }

  const n = fmtCount; // #2875: dedup — ver fmtCount module-level
  // NaN-safe (review #2872): payload KV parcial/antigo pode ter numerador
  // ausente → divisão vira NaN; sem o guard, vaza "NaN%" e envenena colAvg.
  // numOrDash/pctOrDash: extraídos pra módulo (#2875) — ver acima.

  // #2909: sem cycleStart não há ciclo definido → as colunas "recebeu neste
  // ciclo"/"falta enviar" viram "—" (nulas, não 0). "" também conta como sem ciclo.
  const hasCycle = !!cycleStart;
  const cycleDash = "—";

  type Row = {
    cohort: string;
    contacts: number;
    brevo: number;
    eligible: number;
    received: number;
    receivedThisCycle: number; // #2909: last_sent_at >= cycle_start
    // contagens brutas (pro Total agregar taxas corretamente, #2880 E)
    opened: number;
    clicked: number;
    unsub: number;
    hardBounce: number;
    openRate: number | null;
    clickRate: number | null;
    unsubRate: number | null;
    bounceRate: number | null;
  };

  const rank = (k: string): number => cohortSendRank(k === "null" ? null : k);
  const rows: Row[] = Object.entries(cohortStats)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, c]) => ({
      cohort: k,
      contacts: c.contacts,
      // #2880: absorve a coluna Brevo das tabelas removidas. `?? 0`: KV antigo
      // (pré-#2880) tem cohort_stats sem o campo brevo por linha.
      brevo: c.brevo ?? 0,
      eligible: c.eligible,
      received: c.received,
      // #2909: `?? 0` degrada KV pré-#2909; só é EXIBIDO quando hasCycle.
      receivedThisCycle: c.received_this_cycle ?? 0,
      opened: c.opened ?? 0,
      clicked: c.clicked ?? 0,
      // #2880 G: unsub e bounce separados. `?? unsub_bounce ?? 0`: degrada em KV
      // antigo (pré-split) mostrando o par somado na coluna Unsub, 0 em Bounce.
      unsub: c.unsub ?? (c as { unsub_bounce?: number }).unsub_bounce ?? 0,
      hardBounce: c.hard_bounce ?? 0,
      openRate: c.received > 0 ? (c.opened / c.received) * 100 : null,
      clickRate: c.received > 0 ? (c.clicked / c.received) * 100 : null,
      unsubRate:
        c.received > 0
          ? ((c.unsub ?? (c as { unsub_bounce?: number }).unsub_bounce ?? 0) / c.received) * 100
          : null,
      bounceRate: c.received > 0 ? ((c.hard_bounce ?? 0) / c.received) * 100 : null,
    }));

  // #2908: cohort NUNCA-ENVIADO = `received === 0` (nenhum contato com
  // sends_count>0). Vão pra uma 2ª tabela recolhível (<details>) abaixo das
  // ATIVAS (received>0) — os ~9 cohorts pré-2025 (tudo 0/—) não competem com as
  // que têm engajamento real. Ordenação por cohortSendRank preservada em ambas
  // (rows já vem ordenado; filter mantém a ordem).
  const activeRows = rows.filter((r) => r.received > 0);
  const neverSentRows = rows.filter((r) => r.received === 0);

  // Média simples da coluna (só sobre linhas com denominador > 0 — null não
  // entra; NaN de payload parcial também não, review #2872).
  const colAvg = (vals: Array<number | null>): number | null => {
    const present = vals.filter((v): v is number => v != null && Number.isFinite(v));
    if (present.length === 0) return null;
    return present.reduce((a, b) => a + b, 0) / present.length;
  };
  const avgOpen = colAvg(rows.map((r) => r.openRate));
  const avgClick = colAvg(rows.map((r) => r.clickRate));
  const avgUnsub = colAvg(rows.map((r) => r.unsubRate));
  const avgBounce = colAvg(rows.map((r) => r.bounceRate));

  // #3091: antes, QUALQUER desvio >COHORT_DEVIATION_THRESHOLD_PP virava
  // class="alert" (vermelho) — inclusive um desvio POSITIVO em abertura/clique
  // (a MELHOR linha da coluna), colidindo com a convenção do resto do
  // dashboard (vermelho = circuit breaker = "ruim"). Agora a direção do
  // desvio é avaliada por métrica: abertura/clique são "higher-is-better"
  // (desvio ACIMA da média é favorável); unsub/bounce são "lower-is-better"
  // (desvio ABAIXO da média é favorável). Desvio desfavorável → ▼ + vermelho
  // (alert, "ruim", igual ao resto da página); desvio favorável → ▲ + negrito
  // em --ink (destaque neutro, sem alarme — teal não é usado aqui por ser
  // texto pequeno, ver #3088). Dentro do threshold → sem marcação.
  type RateDirection = "higher" | "lower";
  const classifyDeviation = (
    v: number | null,
    avg: number | null,
    dir: RateDirection,
  ): "favorable" | "unfavorable" | "none" => {
    if (v == null || avg == null || !Number.isFinite(v) || !Number.isFinite(avg)) return "none";
    const diff = v - avg;
    if (Math.abs(diff) <= COHORT_DEVIATION_THRESHOLD_PP) return "none";
    const favorable = dir === "higher" ? diff > 0 : diff < 0;
    return favorable ? "favorable" : "unfavorable";
  };
  const renderRateCell = (v: number | null, avg: number | null, dir: RateDirection): string => {
    const status = classifyDeviation(v, avg, dir);
    const text = pctOrDash(v);
    if (status === "unfavorable") return `<td${cellClass("alert")}>▼ ${text}</td>`;
    if (status === "favorable") return `<td><strong>▲ ${text}</strong></td>`;
    return `<td>${text}</td>`;
  };

  // #2909: célula "recebeu neste ciclo"/"falta enviar" — número quando há ciclo,
  // "—" quando não (null-safe). "falta enviar" = elegíveis − recebeu no ciclo.
  const cycleCell = (value: number): string =>
    hasCycle ? n(value) : cycleDash;

  const renderCohortRow = (r: Row): string => `<tr>
      <td>${escHtml(cohortLabel(r.cohort === "null" ? null : r.cohort))}</td>
      <td>${n(r.contacts)}</td>
      <td>${n(r.brevo)}</td>
      <td>${n(r.eligible)}</td>
      <td>${n(r.received)}</td>
      <td>${cycleCell(r.receivedThisCycle)}</td>
      <td>${cycleCell(Math.max(0, r.eligible - r.receivedThisCycle))}</td>
      ${renderRateCell(r.openRate, avgOpen, "higher")}
      ${renderRateCell(r.clickRate, avgClick, "higher")}
      ${renderRateCell(r.unsubRate, avgUnsub, "lower")}
      ${renderRateCell(r.bounceRate, avgBounce, "lower")}
    </tr>`;

  const activeTableRows = activeRows.map(renderCohortRow).join("\n");

  // #2880 E: linha Total (só sobre as ATIVAS, #2908). Contagens somadas; taxas
  // AGREGADAS (Σnum/Σrecebeu, não média de taxas) — a taxa real da base ativa.
  // "Falta enviar" total = Σelegíveis − Σrecebeu_ciclo. Sem destaque de desvio.
  const tot = activeRows.reduce(
    (a, r) => ({
      contacts: a.contacts + r.contacts,
      brevo: a.brevo + r.brevo,
      eligible: a.eligible + r.eligible,
      received: a.received + r.received,
      receivedThisCycle: a.receivedThisCycle + r.receivedThisCycle,
      opened: a.opened + r.opened,
      clicked: a.clicked + r.clicked,
      unsub: a.unsub + r.unsub,
      hardBounce: a.hardBounce + r.hardBounce,
    }),
    { contacts: 0, brevo: 0, eligible: 0, received: 0, receivedThisCycle: 0, opened: 0, clicked: 0, unsub: 0, hardBounce: 0 },
  );
  const totRate = (num: number): number | null => (tot.received > 0 ? (num / tot.received) * 100 : null);
  // Total só quando há ≥1 cohort ativo (senão a tabela principal fica vazia — as
  // linhas foram todas pro <details> de nunca-enviados).
  const totalRow = activeRows.length
    ? `<tr class="total-row">
      <td>Total</td>
      <td>${n(tot.contacts)}</td>
      <td>${n(tot.brevo)}</td>
      <td>${n(tot.eligible)}</td>
      <td>${n(tot.received)}</td>
      <td>${cycleCell(tot.receivedThisCycle)}</td>
      <td>${cycleCell(Math.max(0, tot.eligible - tot.receivedThisCycle))}</td>
      <td>${pctOrDash(totRate(tot.opened))}</td>
      <td>${pctOrDash(totRate(tot.clicked))}</td>
      <td>${pctOrDash(totRate(tot.unsub))}</td>
      <td>${pctOrDash(totRate(tot.hardBounce))}</td>
    </tr>`
    : "";

  // #2908: header compartilhado entre a tabela ativa e o <details> de
  // nunca-enviados (mesmas colunas). 11 colunas (#2909: −Envios(Σ)/−MV verified,
  // +Recebeu neste ciclo/+Falta enviar).
  // #3090: gerado de COHORTS_COLUMNS (mesma fonte do glossário abaixo) — sem
  // duplicar texto entre o title= (hover) e o glossário (sempre visível).
  const headerRow = `<tr>
${COHORTS_COLUMNS.map((c) => `        <th title="${escHtml(c.tooltip)}">${c.label}</th>`).join("\n")}
      </tr>`;

  // #2908: nunca-enviados (received=0) num <details> recolhível abaixo das
  // ativas — HTML válido (o <details> envolve uma TABELA inteira, não <tr>
  // soltos). Mesma ordenação (cohortSendRank) e mesmas colunas; sem linha Total.
  const neverSentBlock = neverSentRows.length
    ? `
  <details class="never-sent">
    <summary>Cohorts sem envio (${neverSentRows.length}) — nunca receberam</summary>
    <div class="table-wrap">
    <table>
      <thead>${headerRow}</thead>
      <tbody>${neverSentRows.map(renderCohortRow).join("\n")}</tbody>
    </table>
    </div>
  </details>`
    : "";

  const cycleNote = hasCycle
    ? `<strong>Recebeu neste ciclo</strong>/<strong>Falta enviar</strong> refletem o ciclo de envio corrente (last_sent_at ≥ início do ciclo, derivado do send-plan); "Falta enviar" = Elegíveis − Recebeu neste ciclo (mínimo 0 — recebeu pode passar de elegíveis quando há descadastro/bounce pós-envio).`
    : `<strong>Recebeu neste ciclo</strong>/<strong>Falta enviar</strong> exibem "—" — nenhum ciclo de envio com send-plan legível.`;

  // #3092: takeaway curto sempre visível + metodologia completa (taxas,
  // marcação de desvio, linha Total) num <details> "Como ler esta tabela" —
  // o parágrafo original tinha 6-10 linhas e citava issues internas (#2864,
  // #2809, #3091, #2908), jargão que não ajuda o editor a ler o dado.
  const cohortsTakeaway = `Comparativo de envio e engajamento por cohort, ordenado pela fila real de 1º envio (mais morno → mais frio).`;
  const cohortsMethodology = `Abertura/Clique/Unsub/Bounce são <strong>taxas</strong> sobre quem <strong>recebeu ≥1 envio</strong>. ${cycleNote} Exclui e-mails internos (mesmo filtro do Score de re-envio). Células que desviam mais de ${COHORT_DEVIATION_THRESHOLD_PP} pontos percentuais da média da coluna ganham <strong>▲</strong> (desvio favorável — abertura/clique acima da média, ou unsub/bounce abaixo dela) ou <span class="alert-label">▼ vermelho</span> (desvio desfavorável — o mesmo "ruim" do resto do dashboard). A linha <strong>Total</strong> usa taxas agregadas (Σ/Σ), não média das linhas, e não recebe essa marcação. Cohorts que nunca receberam envio ficam recolhidos abaixo, numa lista separada.`;

  return `
<section class="phase2-section" id="cohorts-tab">
  <h2 class="section-title">Cohorts</h2>
  ${renderMethodologyNote("cohorts", cohortsTakeaway, cohortsMethodology)}
  ${renderColumnGlossary("cohorts", COHORTS_COLUMNS)}
  <div class="table-wrap">
  <table>
    <thead>
      ${headerRow}
    </thead>
    <tbody>${activeTableRows}
${totalRow}</tbody>
  </table>
  </div>${neverSentBlock}
</section>`;
}

/**
 * #2609: renderiza seção de status MillionVerifier por grupo.
 * Stub gracioso quando `mvStatus` é null (KV não populado ainda).
 * Exportado pra teste unitário.
 */
export function renderMvStatusSection(
  mvStatus: MvStatus | null,
  headerNow: Date = new Date(),
): string {
  // Trata payload vazio (groups:[]) como não-gerado: mesma orientação acionável, em vez
  // de renderizar uma <tbody> vazia sem contexto.
  if (!mvStatus || mvStatus.groups.length === 0) {
    return `
<section class="phase2-section" id="mv-status">
  <h2 class="section-title">Status MillionVerifier por grupo</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-mv-status.ts</code> para popular.</p>
</section>`;
  }

  const genBRT = fmtTimeBRT(mvStatus.generatedAt);
  // #3011: nota só aparece quando o dado pré-computado diverge do cabeçalho.
  const staleNote = shouldShowStalenessNote(mvStatus.generatedAt, headerNow)
    ? ` Gerado às ${genBRT} BRT.`
    : "";

  const tableRows = mvStatus.groups.map((g) => {
    let badge: string;
    if (g.status === "t01") {
      badge = `<span style="color:${DS.ink};opacity:0.6">N/A — validado por pagamento Stripe</span>`;
    } else if (g.status === "verified" && g.verifiedAt) {
      const dateFmt = new Date(g.verifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      badge = `<span style="color:${DS.ink}">✓ MV ${dateFmt} — ${g.verified.toLocaleString("pt-BR")} ok / ${g.rejected.toLocaleString("pt-BR")} excluídos / ${g.unknown.toLocaleString("pt-BR")} inconclusivos</span>`;
    } else {
      badge = `<span style="color:var(--alert)">MV pendente</span>`;
    }
    return `<tr>
      <td><strong>${escHtml(g.group)}</strong></td>
      <td>${escHtml(g.cycle)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="mv-status">
  <h2 class="section-title">Status MillionVerifier por grupo</h2>
  <p class="section-note">Verificação de e-mails (MillionVerifier) por grupo/tier. T01 pula verificação — pagamento Stripe valida implicitamente.${staleNote}</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Grupo de contatos (tier ou cohort)">Grupo</th>
        <th title="Ciclo do disparo (conteúdo-envio)">Ciclo</th>
        <th title="Status da verificação MillionVerifier">Status MV</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

// #2860: teto de linhas exibidas na tabela por edição — a lista pode crescer
// indefinidamente (1 edição/dia), então cap explícito com nota, em vez de
// paginação nova (decisão simples que a issue delegou pro PR).
export const EIA_ENGAGEMENT_MAX_EDITIONS = 30;

/**
 * #3081: normaliza uma string de edição (AAMMDD diário OU AAMM-MM mensal)
 * pra uma chave numérica cronologicamente comparável (~AAMMDD — ano com 2
 * dígitos, mesmo formato do naming; dia=0 quando desconhecido — caso mensal,
 * que só tem granularidade de mês). Sem
 * isso, comparar as duas strings diretamente (`localeCompare`) mistura os
 * formatos incorretamente — tamanhos/alfabetos diferentes ("260702" vs
 * "2606-07") não ordenam cronologicamente por comparação lexicográfica pura.
 *
 * Mensal: o naming é "{conteúdo AAMM}-{envio MM}" (CLAUDE.md — envio é
 * sempre o mês seguinte ao conteúdo). A chave usa o ANO/MÊS de ENVIO (quando
 * a edição de fato circula) — detecta virada de ano quando o mês de envio é
 * NUMERICAMENTE menor que o mês de conteúdo (dezembro → janeiro).
 *
 * Retorna `-Infinity` pra formato inesperado (não deveria ocorrer — os
 * callers já filtram por `/^\d{6}$|^\d{4}-\d{2}$/` antes de chamar isto).
 * Exportado pra teste unitário.
 */
export function editionSortKey(edition: string): number {
  const daily = edition.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (daily) {
    const [, yy, mm, dd] = daily;
    return Number(yy) * 10000 + Number(mm) * 100 + Number(dd);
  }
  const monthly = edition.match(/^(\d{2})(\d{2})-(\d{2})$/);
  if (monthly) {
    const [, yy, contentMM, sendMM] = monthly;
    const sendYear = Number(sendMM) < Number(contentMM) ? Number(yy) + 1 : Number(yy);
    return sendYear * 10000 + Number(sendMM) * 100; // dia desconhecido — só mês
  }
  return -Infinity;
}

/**
 * #2860 (pedido do editor 260702): renderiza a tabela de engajamento do poll
 * "É IA?" — voltou a ser 1 linha por EDIÇÃO (AAMMDD, header "Edição"), mais
 * recente primeiro. Reverte a agregação mensal do #2773 (que era feita por
 * `aggregateEiaEngagementByMonth`, removida como dead code no #2875 por não
 * ter mais consumidor) — o dado por edição já está no payload KV
 * (`eiaEngagement.editions`), então a mudança é só de render, sem pipeline
 * nova. Lista limitada às `EIA_ENGAGEMENT_MAX_EDITIONS` mais recentes, com
 * nota "mostrando as N mais recentes de M" quando o corte se aplica.
 *
 * Stub gracioso quando `eiaEngagement` é null (KV não populado ainda) ou sem
 * edições. Dado gravado por `scripts/build-poll-eia-data.ts --push`.
 * Exportado pra teste unitário.
 */
export function renderEiaEngagementSection(
  eiaEngagement: EiaEngagementSummary | null,
  headerNow: Date = new Date(),
): string {
  if (!eiaEngagement || eiaEngagement.editions.length === 0) {
    return `
<section class="phase2-section" id="eia-engagement">
  <h2 class="section-title">Engajamento — É IA?</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/build-poll-eia-data.ts --push</code> para popular.</p>
</section>`;
  }

  // #3011: antes exibida sempre que `updated_at` existisse — agora gateada
  // por `shouldShowStalenessNote` (divergência real vs. o cabeçalho), não só
  // presença do campo.
  const genBRT =
    eiaEngagement.updated_at && shouldShowStalenessNote(eiaEngagement.updated_at, headerNow)
      ? fmtTimeBRT(eiaEngagement.updated_at)
      : null;

  // Guard: edition malformado (KV corrompido/escrita parcial) — pula em vez de
  // produzir um bucket/label "NaN" na tabela. Aceita AAMMDD (diária, 6 dígitos)
  // OU o ciclo mensal YYMM-MM (#2903 — a dashboard mensal mostra as edições MENSAIS).
  const validEditions = eiaEngagement.editions.filter((e) => /^\d{6}$|^\d{4}-\d{2}$/.test(e.edition));
  // #3081: mais recente primeiro — ordenação por chave cronológica NUMÉRICA
  // (`editionSortKey`), não mais lexicográfica pura. AAMMDD e YYMM-MM têm
  // tamanhos/formatos diferentes ("260702" vs "2606-07") — comparar como
  // string mistura os dois incorretamente (ex: "-" ordena antes de "0" em
  // code-unit compare, então "2606-07" < "260702" mesmo quando a data real
  // aponta o contrário).
  const sorted = [...validEditions].sort((a, b) => editionSortKey(b.edition) - editionSortKey(a.edition));
  const totalCount = sorted.length;
  const shown = sorted.slice(0, EIA_ENGAGEMENT_MAX_EDITIONS);
  const capNote = totalCount > EIA_ENGAGEMENT_MAX_EDITIONS
    ? ` Mostrando as ${EIA_ENGAGEMENT_MAX_EDITIONS} mais recentes de ${totalCount}.`
    : "";

  const tableRows = shown.map((e) => {
    // Degrade por campo (review #2872): entrada de KV parcial sem total_votes
    // não pode derrubar o render inteiro (TypeError → 502) — vira "—", mesmo
    // espírito do caminho mensal substituído no #2860. countOrDash/pctOrDash
    // (#2875): mesmos formatters NaN-safe usados em renderCohortsTabPanel.
    const total = countOrDash(e.total_votes);
    const pctFmt = pctOrDash(e.pct_correct);
    return `<tr>
      <td><strong>${escHtml(e.edition)}</strong></td>
      <td>${total}</td>
      <td>${escHtml(pctFmt)}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="eia-engagement">
  <h2 class="section-title">Engajamento — É IA?</h2>
  <p class="section-note">Votos no poll "É IA?" por edição (${shown.length}), mais recente primeiro.${capNote}${genBRT ? ` Atualizado às ${escHtml(genBRT)} BRT.` : ""}</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Edição da Clarice News: AAMMDD (diária) ou AAMM-MM (ciclo mensal)">Edição</th>
        <th title="Total de votos registrados na edição">Votos</th>
        <th title="Porcentagem de acerto da edição, quando gabarito configurado">% acerto</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2718: renderiza o painel de cupons Stripe (Aba 5).
 * Chamada APENAS quando couponUsage != null (tab habilitada + flag ON + STRIPE_API_KEY presente).
 * Exportada para testes unitários de PII-off.
 */
/** #2758: um pagamento "achatado" com o contexto da assinatura, pra listagem/drill-down. */
interface FlatPayment {
  coupon_code: string;
  customer_email: string;
  interval: string;
  amount_cents: number;
  epoch: number;
}

export function renderCouponTabPanel(usage: CouponUsageReport, headerNow: Date = new Date()): string {
  const fmtBRL = (cents: number): string => {
    const abs = Math.abs(cents);
    return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  };

  const codes = Object.keys(usage).sort();
  const allRows = codes.flatMap((code) => (usage[code] as CouponCodeReport).redemptions);

  // #2766: momento em que o report foi montado — mesmo valor em todos os
  // códigos (carimbado por fetchCouponUsage). Ausente em KV pré-#2766.
  const generatedAt = codes.map((code) => (usage[code] as CouponCodeReport).generatedAt).find((g) => g != null);
  // #3011: nota só aparece quando o dado pré-computado diverge do cabeçalho
  // (ou quando o timestamp está simplesmente ausente — KV antigo, aviso mantido).
  const generatedAtNote = !generatedAt
    ? `<p class="section-note coupon-generated-at">Data de atualização indisponível (KV antigo — aguarde o próximo refresh).</p>`
    : shouldShowStalenessNote(generatedAt, headerNow)
    ? `<p class="section-note coupon-generated-at">Atualizado ${escHtml(fmtTimeBRT(generatedAt))} BRT.</p>`
    : "";

  // #2749: data em BRT (America/Sao_Paulo), consistente com fmtDateBRT do resto
  // do dashboard — sem timeZone o worker (UTC) mostraria o dia-calendário errado
  // perto da meia-noite pro editor no Brasil.
  const fmtDate = (epoch: number): string =>
    new Date(epoch * 1000).toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
    });
  // #2758: chave de mês-calendário em BRT ("AAAA-MM") pra agrupar pagamentos —
  // um pagamento nos últimos dias do mês em UTC pode cair no mês seguinte em BRT.
  const brtMonthKey = (epoch: number): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit",
    }).formatToParts(new Date(epoch * 1000));
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    return `${y}-${m}`;
  };
  const monthKeyToLabel = (key: string): string => {
    const [y, m] = key.split("-");
    return `${m}/${y}`;
  };

  // #2758: coluna "Pagamentos" — lista TODOS os pagamentos na janela (não só o
  // 1º), colapsável. Sem pagamentos ainda (trial) OU KV legado sem a lista →
  // degrada pra data do 1º pagamento/previsão (mesma semântica do #2749).
  const paymentsCell = (r: (typeof allRows)[number]): string => {
    const list = r.payments;
    if (list && list.length > 0) {
      const total = list.reduce((sum, p) => sum + p.amount_cents, 0);
      const items = list.map((p) =>
        `<li>${escHtml(fmtBRL(p.amount_cents))} em ${escHtml(fmtDate(p.epoch))}</li>`,
      ).join("");
      return `<details class="links-ctr payments-cell">
        <summary class="links-summary">${list.length} pagamento${list.length > 1 ? "s" : ""} <span class="links-count-badge">${escHtml(fmtBRL(total))}</span></summary>
        <ul class="payments-list">${items}</ul>
      </details>`;
    }
    // #3053: cancelada ANTES do 1º pagamento (ex.: cancelou ainda em trial) —
    // a previsão de `first_payment_epoch` nunca vai se realizar. Mostrar um
    // indicador neutro em vez da data prevista com "*" (que sugere "isso vai
    // acontecer"). Escopo cirúrgico: só troca o caso que é de fato enganoso
    // (previsão marcada com "*"). Não mexe em:
    //  - status "canceled" COM `payments` reais → já retornou acima (branch
    //    da lista), preservando o histórico de cobrança;
    //  - status "canceled" SEM `first_payment_is_forecast` (KV pré-#2749,
    //    sem sinal de previsão) → mantém o fallback pra `created`, sem "*",
    //    igual ao comportamento de qualquer outro status nessa mesma lacuna
    //    de dado legado (nada de novo sendo prometido, nada enganoso a corrigir).
    if (r.status === "canceled" && r.first_payment_is_forecast) {
      return "—";
    }
    const payEpoch = r.first_payment_epoch ?? r.created;
    const forecastMark = r.first_payment_is_forecast ? "*" : "";
    return escHtml(fmtDate(payEpoch) + forecastMark);
  };

  const detailRows = allRows.map((r) => {
    // #2743: pago (realizado, net, 12m desde o resgate) + comissão de 40%.
    return `<tr>
      <td>${escHtml(r.coupon_code)}</td>
      <td>${escHtml(r.customer_email)}</td>
      <td>${escHtml(r.interval)}</td>
      <td>${escHtml(fmtBRL(r.paid_cents ?? 0))}</td>
      <td><strong>${escHtml(fmtBRL(r.commission_cents ?? 0))}</strong></td>
      <td>${escHtml(r.status)}</td>
      <td>${paymentsCell(r)}</td>
    </tr>`;
  }).join("\n");
  // #2749: legenda do "*" só aparece se há ≥1 pagamento previsto (trial) SEM
  // lista de pagamentos (a lista, quando presente e vazia, já usa a previsão).
  // #3053: exclui `status === "canceled"` — esse caso não renderiza mais o "*"
  // (vira "—" acima), então não deve contar pra decidir se a legenda aparece.
  const hasForecast = allRows.some(
    (r) => (!r.payments || r.payments.length === 0) && r.first_payment_is_forecast && r.status !== "canceled",
  );
  const forecastLegend = hasForecast
    ? `<p class="coupon-forecast-legend" style="margin-top:8px;font-size:13px;opacity:0.7;">* previsão do 1º pagamento (assinatura em trial — ainda não cobrada)</p>`
    : "";

  // #2758: total por mês-calendário (BRT), clicável — substitui o "Resumo por
  // cupom" (agora só existe "Detalhe por assinatura" + esta visão mensal). A
  // agregação roda inteiramente sobre os `payments` já carregados no KV — sem
  // nova chamada à Stripe. Redemptions sem `payments` (KV pré-#2758) não
  // contribuem — degradação graciosa até o próximo refresh (#2750) repopular.
  //
  // Dedup por charge id (`seenChargeIds`): `payments` é filtrado só por
  // cliente+janela (granularidade "por e-mail", #2743) — se o MESMO cliente
  // tem 2 redemptions cujas janelas se sobrepõem (ex.: 2 assinaturas com
  // cupom, ou resgate + reaplicação), o mesmo charge Stripe aparece na lista
  // de payments de AMBAS as rows. Sem dedup, essa agregação cross-redemption
  // contaria o pagamento 2×. O total por-código (`totalPaidCents`) já se
  // protege disso via max-por-cliente; aqui, mais granular (por charge
  // individual), usamos o id do charge — mais preciso que "max por cliente"
  // quando as janelas se sobrepõem só parcialmente.
  const monthly = new Map<string, { totalCents: number; items: FlatPayment[] }>();
  const seenChargeIds = new Set<string>();
  for (const r of allRows) {
    for (const p of r.payments ?? []) {
      if (seenChargeIds.has(p.id)) continue;
      seenChargeIds.add(p.id);
      const key = brtMonthKey(p.epoch);
      if (!monthly.has(key)) monthly.set(key, { totalCents: 0, items: [] });
      const bucket = monthly.get(key)!;
      bucket.totalCents += p.amount_cents;
      bucket.items.push({
        coupon_code: r.coupon_code, customer_email: r.customer_email,
        interval: r.interval, amount_cents: p.amount_cents, epoch: p.epoch,
      });
    }
  }
  const monthKeysDesc = [...monthly.keys()].sort().reverse();

  // #2758: redemptions do KV pré-#2758 têm `paid_cents` real mas NÃO têm a
  // lista `payments` (não sabemos em que mês cada pagamento caiu) — sem este
  // aviso, "Total por mês" pareceria mostrar R$0 de receita quando na verdade
  // há dinheiro real registrado (só sem quebra mensal ainda). Nota some
  // sozinha assim que o refresh diário (#2750) repopular o KV no formato novo.
  const legacyPaidCents = allRows
    .filter((r) => (!r.payments || r.payments.length === 0) && (r.paid_cents ?? 0) > 0)
    .reduce((sum, r) => sum + (r.paid_cents ?? 0), 0);
  const legacyNote = legacyPaidCents > 0
    ? `<p class="section-note coupon-monthly-legacy-note">Há ${escHtml(fmtBRL(legacyPaidCents))} em pagamentos registrados no formato antigo (sem quebra por mês ainda) — some após o próximo refresh. Ver "Detalhe por assinatura" abaixo pro total real.</p>`
    : "";

  const monthlySectionBody = monthKeysDesc.length === 0
    ? `<p class="section-note coupon-monthly-empty">Nenhum pagamento registrado ainda (assinaturas em trial, ou KV aguardando refresh).</p>`
    : monthKeysDesc.map((key) => {
        const bucket = monthly.get(key)!;
        const itemsSorted = [...bucket.items].sort((a, b) => a.epoch - b.epoch);
        const itemRows = itemsSorted.map((it) => `<tr>
          <td>${escHtml(it.coupon_code)}</td>
          <td>${escHtml(it.customer_email)}</td>
          <td>${escHtml(it.interval)}</td>
          <td>${escHtml(fmtBRL(it.amount_cents))}</td>
          <td>${escHtml(fmtBRL(commissionCents(it.amount_cents)))}</td>
          <td>${escHtml(fmtDate(it.epoch))}</td>
        </tr>`).join("\n");
        return `<details class="links-ctr coupon-month" id="coupon-month-${escHtml(key)}">
  <summary class="links-summary">${escHtml(monthKeyToLabel(key))} <span class="links-count-badge">${bucket.items.length}</span> — pago ${escHtml(fmtBRL(bucket.totalCents))} · comissão ${escHtml(fmtBRL(commissionCents(bucket.totalCents)))}</summary>
  <div class="links-table-wrap">
  <table class="links-table">
    <thead><tr><th>Cupom</th><th>Email</th><th>Plano</th><th>Valor</th><th>Comissão (40%)</th><th>Data</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  </div>
</details>`;
      }).join("\n");

  return `
${generatedAtNote}
<section class="phase2-section" id="coupon-monthly">
  <h2 class="section-title">Total por mês</h2>
  ${monthlySectionBody}
  ${legacyNote}
</section>
<section class="phase2-section" id="coupon-detail">
  <h2 class="section-title">Detalhe por assinatura</h2>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Cupom</th>
        <th>Email</th>
        <th>Plano</th>
        <th>Pago (12m)</th>
        <th>Comissão (40%)</th>
        <th>Status</th>
        <th>Pagamentos</th>
      </tr>
    </thead>
    <tbody>${detailRows}</tbody>
  </table>
  </div>
  ${forecastLegend}
</section>`;
}
