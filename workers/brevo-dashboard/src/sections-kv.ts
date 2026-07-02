import type { Env, BrevoCampaign, BrevoGlobalStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementEdition, EiaEngagementSummary, CohortStatsRow } from "./types.ts";
import { type CouponUsageReport, type CouponCodeReport, commissionCents } from "../../../scripts/lib/stripe-coupons.ts";
import { cohortLabel } from "../../../scripts/lib/clarice-segment.ts";
// #2857 fase B: cohortSendRank ordena as sub-linhas do breakdown de 1º envio
// (sucessor do antigo tierRank — o fallback de render pro payload legado
// by_tier foi removido na fase C, ver firstSendBreakdownRows abaixo).
// cohorts.ts é dependency-free/Workers-safe (mesmo padrão de
// clarice-segment.ts) — importar direto daqui não introduz node:sqlite.
import { cohortSendRank } from "../../../scripts/lib/cohorts.ts";
import { DS, pct, fmtTimeBRT } from "./render-links.ts";
import { escHtml, parseClariceCampaignKey, pickStats, monthKeyBRT, CLARICE_PLAN_TOTAL, ENVIOS_TOOLTIP } from "./sections-core.ts";

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
    ? `Melhor dia provisório: <strong style="color:${DS.brand}">D${winnerDay}</strong> — aguardar conclusão da S1 para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  const tableRows = rows
    .map((r) => {
      const isWinner = r.dayNum === winnerDay && r.campaignCount > 0;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ LÍDER</strong>` : "";
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
 * Exportado pra teste unitário.
 */
export function renderVolumeSection(cumulativeSent: number): string {
  const pctBar = Math.min(100, (cumulativeSent / CLARICE_PLAN_TOTAL) * 100);
  const pctLabel = pctBar.toFixed(1);
  const barFill = Math.round(pctBar * 0.3); // 30 chars = 100%
  const bar = "█".repeat(barFill) + "░".repeat(30 - barFill);
  // #2429: rótulo "E-mails (eventos)" (#2491: renomeado de "Envios (eventos)") deixa explícito
  // que este número conta eventos de envio (uma pessoa em 2 campanhas conta 2 vezes; inclui
  // bounces), não pessoas únicas.
  // Tooltip compartilhado via ENVIOS_TOOLTIP — mesma cópia usada na tabela por-campanha e mensal.
  return `
<section class="phase2-section" id="volume-ciclo">
  <h2 class="section-title">Volume enviado no ciclo</h2>
  <p class="section-note volume-note">
    <strong title="${escHtml(ENVIOS_TOOLTIP)}">${cumulativeSent.toLocaleString("pt-BR")} envios (eventos)</strong> de ${CLARICE_PLAN_TOTAL.toLocaleString("pt-BR")} (${pctLabel}%)<br>
    <span class="spark-bar" title="${pctLabel}% do plano total">${bar}</span>
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
  /** CTR agregado = totalClicks / totalDelivered (0 quando delivered=0) */
  ctr: number;
  /** #2442: Soma de hard+soft bounces no mês */
  totalBounces: number;
  /** #2442: Bounce rate agregado = totalBounces / totalSent (0 quando sent=0) */
  bounceRate: number;
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
        totalBounces: 0, totalUnsub: 0, totalSpam: 0,
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
        ctr: d.totalDelivered > 0 ? (d.totalClicks / d.totalDelivered) * 100 : 0,
        // #2442
        totalBounces: d.totalBounces,
        bounceRate: d.totalSent > 0 ? (d.totalBounces / d.totalSent) * 100 : 0,
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
export function renderMonthlyTotalsSection(rows: MonthlyTotalRow[]): string {
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

  const tableRows = rows.map((r) => {
    const openRateFmt = r.totalDelivered > 0 ? r.openRate.toFixed(1) + "%" : "—";
    const ctrFmt = r.totalDelivered > 0 ? r.ctr.toFixed(1) + "%" : "—";
    const bounceRateFmt = r.totalSent > 0 ? r.bounceRate.toFixed(1) + "%" : "—";
    const unsubRateFmt = r.totalSent > 0 ? r.unsubRate.toFixed(1) + "%" : "—";
    const spamRateFmt = r.totalSent > 0 ? r.spamRate.toFixed(1) + "%" : "—";
    // Circuit breaker alerts (mesmos thresholds da tabela Envios)
    const bounceAlert = r.totalSent > 0 && r.bounceRate >= 3;
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
      <td><strong>${escHtml(r.label)}</strong></td>
      <td>${r.campaignCount}</td>
      <td>${sentRange}</td>
      <td>${r.totalSent.toLocaleString("pt-BR")}</td>
      <td>${pct(r.totalDelivered, r.totalSent)}<br><small>${r.totalDelivered.toLocaleString("pt-BR")}</small></td>
      ${metricCell(openRateFmt, r.totalViews)}
      ${metricCell(ctrFmt, r.totalClicks)}
      ${metricCell(bounceRateFmt, r.totalBounces, bounceAlert)}
      ${metricCell(unsubRateFmt, r.totalUnsub, unsubAlert)}
      ${metricCell(spamRateFmt, r.totalSpam, spamAlert)}
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="monthly-totals">
  <h2 class="section-title">Totais por mês</h2>
  <p class="section-note">1 linha por mês — agrega todos os envios realizados naquele mês. Valores são <strong>eventos por envio</strong> (um contato que recebeu 3 campanhas conta 3×). Opens usa <code>uniqueViews</code> (MPP-inclusivo, igual à UI da Brevo) — não comparar diretamente com as Coortes de engajamento (que contam <strong>pessoas únicas</strong> com aberturas reais/trackable, EXCLUI MPP). Veja a lista detalhada na seção Envios abaixo.</p>
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
        <th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
        <th title="Hard bounces + soft bounces. Bench: &lt;2% saudável. ≥3% pausa o ramp.">Bounces</th>
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
export function renderEngagementCohortsSection(cohorts: EngagementCohorts | null): string {
  if (!cohorts) {
    return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-engagement-cohorts.ts</code> para popular (faz os GETs per-contato e grava no KV).</p>
</section>`;
  }

  const u = cohorts.universe;
  const genBRT = fmtTimeBRT(cohorts.generatedAt);
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
  const tfootRow = `<tr style="font-weight:700;border-top:2px solid var(--rule);">
      <td>Total${sumMismatch ? ` <span style="color:var(--alert)" title="${sumMismatchTitle}">⚠️</span>` : ""}</td>
      <td class="metric">${u.toLocaleString("pt-BR")}</td>
      <td>100%</td>
    </tr>`;

  return `
<section class="phase2-section" id="engagement-cohorts">
  <h2 class="section-title">Coortes de engajamento</h2>
  <p class="section-note"><span title="Contatos únicos dedupados que receberam ao menos um envio (todas as campanhas).">${u.toLocaleString("pt-BR")} pessoas únicas alcançadas</span> (recebeu ≥1 e-mail ou saiu). Cada contato conta em <strong>exatamente uma</strong> coorte — quem deu bounce ou descadastrou entra só em "Saídas", independente de ter aberto. "Abriu" = aberturas reais (trackable) per-contato — <strong>EXCLUI MPP</strong> (a Brevo não atribui MPP a contatos individuais; <code>appleMppOpens</code> é só agregado de campanha). Por isso os números aqui diferem de "Totais por mês" (que usa <code>uniqueViews</code>, MPP-inclusivo) — não comparar 1:1. Escopo: toda a base Clarice (todas as edições). Pré-computado às ${genBRT} BRT.</p>
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
  const eng = s.engagement ?? { with_opens: 0, with_clicks: 0 };

  const n = (v: number): string => (v ?? 0).toLocaleString("pt-BR");
  const genBRT = escHtml(fmtTimeBRT(s.generated_at));

  // tabelinha {rótulo → contagem}, ordenada por contagem desc.
  // #2812 item 2: `relabel` (3º parâmetro opcional) foi removido — era morto
  // desde o #2805 (o único caller com relabel, a tabela "Por tier", foi
  // removido nesse PR). Verificado de novo agora (pós-#2817): a tabela "Por
  // safra" nova NÃO usa kvTable — tem seu próprio render (cohortSection, com
  // ordenação cronológica em vez de por-contagem) — então o parâmetro segue
  // sem nenhum caller real. `tierLabel`/`cohortLabel` continuam vivos, usados
  // diretamente por `tierBreakdownRows`/`cohortSection`, fora de kvTable.
  const kvTable = (
    title: string,
    map: Record<string, number> | undefined,
  ): string => {
    const rows = Object.entries(map ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, v]) =>
          `<tr><td>${escHtml(k)}</td><td style="text-align:right">${n(v)}</td></tr>`,
      )
      .join("\n");
    return `<div class="table-wrap"><table>
      <thead><tr><th>${escHtml(title)}</th><th style="text-align:right">contatos</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };

  // #2805 → 3ª iteração (pedido do editor, 260702): o breakdown de 1º envio são
  // SUB-LINHAS reais da tabela — 1 <tr> por cohort, com a contagem na coluna
  // "contatos" — em vez de lista <br> espremida na célula da linha 0.
  // ATENÇÃO (#2807 review): o universo do by_cohort_first_send (firstSend:
  // send_eligible=1 + sends_count=0, #2732) NÃO é idêntico à linha 0 do
  // histograma — optin nunca-enviado tem +40 pts (fica na linha 40) e
  // re-envio decaído/inelegível nunca-enviado pode ter 0 exato (conta na
  // linha 0 mas está fora do firstSend). Por isso cada sub-linha carrega o
  // rótulo "1º envio": descreve o universo próprio dele, não uma partição da
  // linha 0.
  // Ordem: cohortSendRank ASC (fila real de 1º envio, assinante-ativo
  // primeiro — mesma regra de prioridade de envio que `segmentFromStore`
  // usa), "sem cohort" por último. Rótulo pt-BR via `cohortLabel` (mesma
  // função da tabela "Por safra", `cohortSection` abaixo).
  // `byCohortFirstSendVerified === undefined` ⇒ tabela SEM a coluna verified
  // (o caller passa o campo só quando a coluna global está ativa — review
  // #2815: os dois campos verified sempre nascem juntos no summary; payload
  // parcial mostra 0, trade-off aceito e documentado). A mesma ressalva de
  // universos vale pra coluna verified: o verified da linha 0 é do bucket
  // inteiro (sem internos), o das sub-linhas é do firstSend — as somas não
  // conciliam por design.
  //
  // #2857 fase C (cutover): o fallback pro payload legado `by_tier`
  // (pré-fase-B) foi REMOVIDO — clarice-db-summary.ts nunca mais emite esse
  // campo, e qualquer KV vivo em produção já é pós-fase-B/B.1 (refresh
  // periódico). Sem nenhum dos dois campos (payload cru pré-#2731 sem
  // priority_points_histogram) → sem breakdown, ver renderPriorityPointsFallback.
  // #2865: 3º parâmetro opcional `byCohortFirstSendBrevo` — mesma semântica
  // esparsa da coluna verified (ausente = 0), coluna extra só quando o KV traz
  // o campo (payload antigo degrada sem a coluna, mesmo gate do verified).
  const firstSendBreakdownRows = (
    byCohortFirstSend: Record<string, number> | undefined,
    byCohortFirstSendVerified: Record<string, number> | undefined,
    byCohortFirstSendBrevo: Record<string, number> | undefined,
  ): string => {
    const entries = Object.entries(byCohortFirstSend ?? {});
    if (entries.length === 0) return "";
    const withVerifiedCol = byCohortFirstSendVerified !== undefined;
    const withBrevoCol = byCohortFirstSendBrevo !== undefined;
    const rank = (k: string): number => cohortSendRank(k === "null" ? null : k);
    return entries
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([k, v]) =>
        `\n<tr><td style="opacity:0.65;padding-left:18px">· 1º envio — ${escHtml(cohortLabel(k === "null" ? null : k))}</td><td style="text-align:right;opacity:0.65">${n(v)}</td>${withVerifiedCol ? `<td style="text-align:right;opacity:0.65">${n(byCohortFirstSendVerified?.[k] ?? 0)}</td>` : ""}${withBrevoCol ? `<td style="text-align:right;opacity:0.65">${n(byCohortFirstSendBrevo?.[k] ?? 0)}</td>` : ""}</tr>`)
      .join("");
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
    // 260702: coluna "verified" (mv_bucket='verified') — só quando o KV já
    // traz o campo novo; payload antigo renderiza a tabela de 2 colunas.
    const vHist = s.priority_points_histogram_verified;
    const withVerified = vHist !== undefined;
    // #2865: coluna "Brevo" (brevo_list_ids IS NOT NULL) — mesmo gate opcional.
    const bHist = s.priority_points_histogram_brevo;
    const withBrevo = bHist !== undefined;
    // #2805: logo após a linha 0 entram as sub-linhas do breakdown de 1º envio
    // (rotuladas "1º envio" — universo firstSend, que se CONCENTRA na linha 0
    // mas não coincide com ela; ver comentário do firstSendBreakdownRows).
    const rows = sorted.map(([k, v]) =>
      `<tr><td>${escHtml(k === "null" ? "sem pontuação" : k)}</td><td style="text-align:right">${n(v)}</td>${withVerified ? `<td style="text-align:right">${n(vHist?.[k] ?? 0)}</td>` : ""}${withBrevo ? `<td style="text-align:right">${n(bHist?.[k] ?? 0)}</td>` : ""}</tr>${
        k === "0"
          ? firstSendBreakdownRows(
              s.by_cohort_first_send,
              withVerified ? (s.by_cohort_first_send_verified ?? {}) : undefined,
              withBrevo ? (s.by_cohort_first_send_brevo ?? {}) : undefined,
            )
          : ""
      }`,
    ).join("\n");
    return `<div class="table-wrap"><table>
      <thead><tr><th>priority_points (valor exato)</th><th style="text-align:right">contatos</th>${withVerified ? '<th style="text-align:right">verified</th>' : ""}${withBrevo ? '<th style="text-align:right">Brevo</th>' : ""}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  // #2812 item 6: fallback pré-#2731 (sem priority_points_histogram) não
  // mostrava NENHUM breakdown — a tabela "Por tier"/cohort só existe hoje
  // dentro de renderPriorityPointsHistogram (linha 0 do histograma novo).
  // Paridade mínima com o caminho novo: anexa o MESMO firstSendBreakdownRows
  // à faixa "zero (sem histórico)" — onde o universo firstSend se CONCENTRA
  // (mesma ressalva de universos do comentário acima). Sem coluna "verified"
  // aqui: o payload que dispara este fallback é sempre o mais antigo dos dois
  // formatos (pré-#2731), então nunca teria priority_points_histogram_verified/
  // by_cohort_first_send_verified também.
  const renderPriorityPointsFallback = (
    map: Record<string, number>,
    byCohortFirstSend: Record<string, number> | undefined,
  ): string => {
    const rows = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => {
        const row = `<tr><td>${escHtml(k)}</td><td style="text-align:right">${n(v)}</td></tr>`;
        return k === "zero (sem histórico)"
          ? row + firstSendBreakdownRows(byCohortFirstSend, undefined, undefined)
          : row;
      })
      .join("\n");
    return `<div class="table-wrap"><table>
      <thead><tr><th>priority_points (re-envio, por faixa — aguardando refresh #2731)</th><th style="text-align:right">contatos</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  // KV pré-#2731 não tem o histograma — degrada pras faixas antigas (com o
  // breakdown de 1º envio anexado à faixa "zero", #2812 item 6).
  const priorityPointsSection = s.priority_points_histogram
    ? renderPriorityPointsHistogram(s.priority_points_histogram)
    : renderPriorityPointsFallback(ppMap, s.by_cohort_first_send);
  const brevoBadge = brevo.has_signal
    ? `<span style="color:${DS.brand}">${n(brevo.synced_rows)} sincronizados</span>`
    : `<span style="color:var(--alert)">sem sinal Brevo ainda — rode clarice-sync-brevo.ts</span>`;

  // #2817: "Por safra (cohort)" — mesmo padrão visual do kvTable, com a coluna
  // "verified" (como as demais tabelas com par total+verified). Campo OPCIONAL
  // (KV antigo sem by_cohort) → tabela inteira omitida, não renderizada vazia.
  // Ordenação CRONOLÓGICA (não por contagem, ao contrário do kvTable padrão) —
  // "safra" é uma dimensão de tempo, então maio→junho→julho faz mais sentido
  // que ordenar por volume; "sem safra" (null) sempre por último. A forma
  // canônica 'YYYY-MM' ordena lexicograficamente = cronologicamente.
  const cohortSection = s.by_cohort
    ? (() => {
        const byCohortVerified = s.by_cohort_verified;
        const withVerifiedCol = byCohortVerified !== undefined;
        const rows = Object.entries(s.by_cohort!)
          .sort(([a], [b]) => {
            if (a === "null") return 1;
            if (b === "null") return -1;
            return a < b ? -1 : a > b ? 1 : 0;
          })
          .map(
            ([k, v]) =>
              `<tr><td>${escHtml(cohortLabel(k === "null" ? null : k))}</td><td style="text-align:right">${n(v)}</td>${withVerifiedCol ? `<td style="text-align:right">${n(byCohortVerified?.[k] ?? 0)}</td>` : ""}</tr>`,
          )
          .join("\n");
        return `<div class="table-wrap"><table>
      <thead><tr><th>Por safra (cohort)</th><th style="text-align:right">contatos</th>${withVerifiedCol ? '<th style="text-align:right">verified</th>' : ""}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
      })()
    : "";

  return `
<section class="phase2-section" id="contacts-summary">
  <h2 class="section-title">Banco de contatos (store)</h2>
  <p class="section-note">Sumário agregado do store único (#2647). Total: <strong>${n(s.total)}</strong> · elegíveis: <strong>${n(elig.eligible)}</strong> · inelegíveis: <strong>${n(elig.ineligible)}</strong> · optin: <strong>${n(pp.optin)}</strong> · Brevo: ${brevoBadge}. Gerado às ${genBRT} BRT.</p>
  ${cohortSection}
  ${priorityPointsSection}
  ${kvTable("Inelegíveis por razão", elig.by_reason)}
  ${kvTable("MillionVerifier (bucket)", s.mv)}
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

export function renderCohortsTabPanel(
  cohortStats: Record<string, CohortStatsRow> | undefined,
): string {
  // #2660 (review #2872): payload AUSENTE (KV antigo, script nunca rodou) ≠
  // payload VAZIO (script rodou, store sem cohorts) — mensagens distintas.
  if (!cohortStats) {
    return `
<section class="phase2-section" id="cohorts-tab">
  <h2 class="section-title">Cohorts</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/clarice-db-summary.ts</code> para popular.</p>
</section>`;
  }
  if (Object.keys(cohortStats).length === 0) {
    return `
<section class="phase2-section" id="cohorts-tab">
  <h2 class="section-title">Cohorts</h2>
  <p class="section-note">Nenhum cohort no store (sumário gerado com base vazia).</p>
</section>`;
  }

  const n = (v: number): string => (v ?? 0).toLocaleString("pt-BR");
  // NaN-safe (review #2872): payload KV parcial/antigo pode ter numerador
  // ausente → divisão vira NaN; sem o guard, vaza "NaN%" e envenena colAvg.
  const pctOrDash = (v: number | null): string =>
    v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;

  type Row = {
    cohort: string;
    contacts: number;
    eligible: number;
    received: number;
    sendsSum: number;
    openRate: number | null;
    clickRate: number | null;
    unsubBounceRate: number | null;
    mvVerifiedRate: number | null;
    ppAvg: number | null;
  };

  const rank = (k: string): number => cohortSendRank(k === "null" ? null : k);
  const rows: Row[] = Object.entries(cohortStats)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, c]) => ({
      cohort: k,
      contacts: c.contacts,
      eligible: c.eligible,
      received: c.received,
      sendsSum: c.sends_sum,
      openRate: c.received > 0 ? (c.opened / c.received) * 100 : null,
      clickRate: c.received > 0 ? (c.clicked / c.received) * 100 : null,
      unsubBounceRate: c.received > 0 ? (c.unsub_bounce / c.received) * 100 : null,
      mvVerifiedRate: c.contacts > 0 ? (c.mv_verified / c.contacts) * 100 : null,
      // typeof-guard (review #2872): KV antigo pode ter priority_points_sum
      // null (SUM SQL de tudo-NULL, pré-COALESCE) — null/received = 0 em JS e
      // renderia "0.0" como se medido; null → "—".
      ppAvg:
        c.received > 0 && typeof c.priority_points_sum === "number"
          ? c.priority_points_sum / c.received
          : null,
    }));

  // Média simples da coluna (só sobre linhas com denominador > 0 — null não
  // entra; NaN de payload parcial também não, review #2872).
  const colAvg = (vals: Array<number | null>): number | null => {
    const present = vals.filter((v): v is number => v != null && Number.isFinite(v));
    if (present.length === 0) return null;
    return present.reduce((a, b) => a + b, 0) / present.length;
  };
  const avgOpen = colAvg(rows.map((r) => r.openRate));
  const avgClick = colAvg(rows.map((r) => r.clickRate));
  const avgUnsubBounce = colAvg(rows.map((r) => r.unsubBounceRate));
  const avgMv = colAvg(rows.map((r) => r.mvVerifiedRate));

  const cellAttr = (v: number | null, avg: number | null): string =>
    v != null && avg != null && Math.abs(v - avg) > COHORT_DEVIATION_THRESHOLD_PP
      ? ' class="alert"'
      : "";

  const tableRows = rows
    .map((r) => {
      return `<tr>
      <td>${escHtml(cohortLabel(r.cohort === "null" ? null : r.cohort))}</td>
      <td>${n(r.contacts)}</td>
      <td>${n(r.eligible)}</td>
      <td>${n(r.received)}</td>
      <td>${n(r.sendsSum)}</td>
      <td${cellAttr(r.openRate, avgOpen)}>${pctOrDash(r.openRate)}</td>
      <td${cellAttr(r.clickRate, avgClick)}>${pctOrDash(r.clickRate)}</td>
      <td${cellAttr(r.unsubBounceRate, avgUnsubBounce)}>${pctOrDash(r.unsubBounceRate)}</td>
      <td${cellAttr(r.mvVerifiedRate, avgMv)}>${pctOrDash(r.mvVerifiedRate)}</td>
      <td>${r.ppAvg == null ? "—" : r.ppAvg.toFixed(1)}</td>
    </tr>`;
    })
    .join("\n");

  return `
<section class="phase2-section" id="cohorts-tab">
  <h2 class="section-title">Cohorts</h2>
  <p class="section-note">Comparativo de envio/engajamento por cohort (#2864) — ordenado pela fila real de 1º envio (mais morno → mais frio). Abertura/Clique/Unsub+Bounce são sobre quem <strong>recebeu ≥1 envio</strong>; MV verified é sobre o total de contatos do cohort. Exclui e-mails internos (mesmo filtro de <code>priority_points</code>, #2809). Células em <span class="alert-label">vermelho</span> desviam mais de ${COHORT_DEVIATION_THRESHOLD_PP} pontos percentuais da média da coluna.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Cohort (taxonomia #2857)">Cohort</th>
        <th title="Total de contatos no cohort (exclui internos)">Contatos</th>
        <th title="Contatos elegíveis para envio (send_eligible=1)">Elegíveis</th>
        <th title="Contatos que já receberam ao menos 1 envio (sends_count>0)">Recebeu ≥1</th>
        <th title="Soma de envios (eventos) do cohort">Envios (Σ)</th>
        <th title="% de quem recebeu que abriu ao menos 1 envio">Abertura</th>
        <th title="% de quem recebeu que clicou ao menos 1 envio">Clique</th>
        <th title="% de quem recebeu que descadastrou ou deu bounce">Unsub+Bounce</th>
        <th title="% do cohort verificado no MillionVerifier (mv_bucket=verified)">MV verified</th>
        <th title="priority_points médio de quem recebeu — engajamento composto">Pts médio</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * #2609: renderiza seção de status MillionVerifier por grupo.
 * Stub gracioso quando `mvStatus` é null (KV não populado ainda).
 * Exportado pra teste unitário.
 */
export function renderMvStatusSection(mvStatus: MvStatus | null): string {
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

  const tableRows = mvStatus.groups.map((g) => {
    let badge: string;
    if (g.status === "t01") {
      badge = `<span style="color:${DS.ink};opacity:0.6">N/A — validado por pagamento Stripe</span>`;
    } else if (g.status === "verified" && g.verifiedAt) {
      const dateFmt = new Date(g.verifiedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
      badge = `<span style="color:${DS.brand}">✓ MV ${dateFmt} — ${g.verified.toLocaleString("pt-BR")} ok / ${g.rejected.toLocaleString("pt-BR")} excluídos / ${g.unknown.toLocaleString("pt-BR")} inconclusivos</span>`;
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
  <p class="section-note">Verificação de e-mails (MillionVerifier) por grupo/tier. T01 pula verificação — pagamento Stripe valida implicitamente. Gerado às ${genBRT} BRT.</p>
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

/** 1 linha agregada por mês-calendário (AAMM) pra tabela de Engajamento — É IA?. */
export interface EiaEngagementMonthRow {
  /** AAMM (ex: "2604") — chave de ordenação, não exibida diretamente. */
  month: string;
  /** Rótulo legível (ex: "Abr/2026"). */
  label: string;
  /** Soma de votos de TODAS as edições do mês (inclui as sem correct_choice configurado). */
  total_votes: number;
  /** % de acerto agregado exato (Σ correct_count / Σ total_votes), só sobre
   *  edições com pct_correct != null. null se nenhuma edição do mês qualifica. */
  pct_correct: number | null;
}

/**
 * Agrupa `editions` (1 linha por edição AAMMDD) em 1 linha por mês-calendário
 * (#2773). Mês extraído direto do AAMMDD (`edition.slice(0,4)`) — não precisa
 * de fuso/timestamp (diferente do agrupamento de campanhas por sentDate), já
 * que a edição em si não carrega hora.
 *
 * Agregação do "% acerto": exata via Σ correct_count / Σ total_votes — NÃO
 * média de pct_correct (que já vem arredondado na origem, acumularia erro).
 * Edições com `pct_correct === null` (abaixo do threshold do poll worker, ou
 * resposta correta não configurada) são excluídas do numerador E denominador
 * dessa razão — mas seus votos ainda contam pro total_votes do mês (métrica
 * de volume, independente de haver gabarito).
 *
 * Exportado pra teste unitário.
 */
export function aggregateEiaEngagementByMonth(editions: EiaEngagementEdition[]): EiaEngagementMonthRow[] {
  const MONTH_NAMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  type Acc = { totalVotes: number; correctCountSum: number; votesWithCorrect: number };
  const acc = new Map<string, Acc>();

  for (const e of editions) {
    // Guard: edition malformado (KV corrompido/escrita parcial) — pula em vez
    // de produzir um bucket/label "NaN" na tabela. AAMMDD só, 6 dígitos.
    if (!/^\d{6}$/.test(e.edition)) continue;
    const month = e.edition.slice(0, 4); // AAMM
    if (!acc.has(month)) acc.set(month, { totalVotes: 0, correctCountSum: 0, votesWithCorrect: 0 });
    const a = acc.get(month)!;
    a.totalVotes += e.total_votes;
    // Guard: KV pré-#2773 não tem correct_count (campo novo) — se pct_correct
    // existe mas correct_count não é um number válido, trata como "sem gabarito
    // confiável" (exclui do numerador/denominador) em vez de somar `undefined`
    // e produzir NaN% silencioso na tabela até o próximo --push atualizar o KV.
    if (e.pct_correct != null && typeof e.correct_count === "number" && Number.isFinite(e.correct_count)) {
      a.correctCountSum += e.correct_count;
      a.votesWithCorrect += e.total_votes;
    }
  }

  return Array.from(acc.entries())
    .sort(([a], [b]) => b.localeCompare(a)) // mais recente primeiro
    .map(([month, d]) => {
      const yy = month.slice(0, 2);
      const mm = parseInt(month.slice(2, 4), 10);
      const label = `${MONTH_NAMES[mm - 1] ?? mm}/20${yy}`;
      return {
        month,
        label,
        total_votes: d.totalVotes,
        pct_correct: d.votesWithCorrect > 0 ? (d.correctCountSum / d.votesWithCorrect) * 100 : null,
      };
    });
}

// #2860: teto de linhas exibidas na tabela por edição — a lista pode crescer
// indefinidamente (1 edição/dia), então cap explícito com nota, em vez de
// paginação nova (decisão simples que a issue delegou pro PR).
export const EIA_ENGAGEMENT_MAX_EDITIONS = 30;

/**
 * #2860 (pedido do editor 260702): renderiza a tabela de engajamento do poll
 * "É IA?" — voltou a ser 1 linha por EDIÇÃO (AAMMDD, header "Edição"), mais
 * recente primeiro. Reverte a agregação mensal do #2773 (mantida disponível
 * via `aggregateEiaEngagementByMonth`, ainda exportada/testada — só não é
 * mais chamada aqui) — o dado por edição já está no payload KV
 * (`eiaEngagement.editions`), então a mudança é só de render, sem pipeline
 * nova. Lista limitada às `EIA_ENGAGEMENT_MAX_EDITIONS` mais recentes, com
 * nota "mostrando as N mais recentes de M" quando o corte se aplica.
 *
 * Stub gracioso quando `eiaEngagement` é null (KV não populado ainda) ou sem
 * edições. Dado gravado por `scripts/build-poll-eia-data.ts --push`.
 * Exportado pra teste unitário.
 */
export function renderEiaEngagementSection(eiaEngagement: EiaEngagementSummary | null): string {
  if (!eiaEngagement || eiaEngagement.editions.length === 0) {
    return `
<section class="phase2-section" id="eia-engagement">
  <h2 class="section-title">Engajamento — É IA?</h2>
  <p class="section-note">Dados ainda não gerados. Rode <code>npx tsx scripts/build-poll-eia-data.ts --push</code> para popular.</p>
</section>`;
  }

  const genBRT = eiaEngagement.updated_at ? fmtTimeBRT(eiaEngagement.updated_at) : null;

  // Guard: edition malformado (KV corrompido/escrita parcial) — mesmo filtro
  // do agregador mensal (aggregateEiaEngagementByMonth), pra nunca renderizar
  // uma linha "NaN"/vazia.
  const validEditions = eiaEngagement.editions.filter((e) => /^\d{6}$/.test(e.edition));
  // Mais recente primeiro — AAMMDD ordena lexicograficamente = cronologicamente.
  const sorted = [...validEditions].sort((a, b) => b.edition.localeCompare(a.edition));
  const totalCount = sorted.length;
  const shown = sorted.slice(0, EIA_ENGAGEMENT_MAX_EDITIONS);
  const capNote = totalCount > EIA_ENGAGEMENT_MAX_EDITIONS
    ? ` Mostrando as ${EIA_ENGAGEMENT_MAX_EDITIONS} mais recentes de ${totalCount}.`
    : "";

  const tableRows = shown.map((e) => {
    // Degrade por campo (review #2872): entrada de KV parcial sem total_votes
    // não pode derrubar o render inteiro (TypeError → 502) — vira "—", mesmo
    // espírito do caminho mensal substituído no #2860.
    const total = typeof e.total_votes === "number" ? e.total_votes.toLocaleString("pt-BR") : "—";
    const pctFmt = typeof e.pct_correct === "number" ? `${e.pct_correct.toFixed(1)}%` : "—";
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
        <th title="Edição (AAMMDD)">Edição</th>
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

export function renderCouponTabPanel(usage: CouponUsageReport): string {
  const fmtBRL = (cents: number): string => {
    const abs = Math.abs(cents);
    return `R$${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  };

  const codes = Object.keys(usage).sort();
  const allRows = codes.flatMap((code) => (usage[code] as CouponCodeReport).redemptions);

  // #2766: momento em que o report foi montado — mesmo valor em todos os
  // códigos (carimbado por fetchCouponUsage). Ausente em KV pré-#2766.
  const generatedAt = codes.map((code) => (usage[code] as CouponCodeReport).generatedAt).find((g) => g != null);
  const generatedAtNote = generatedAt
    ? `<p class="coupon-generated-at" style="opacity:0.6;font-size:13px;margin:0 0 12px 0;">Atualizado ${escHtml(fmtTimeBRT(generatedAt))} BRT.</p>`
    : `<p class="coupon-generated-at" style="opacity:0.6;font-size:13px;margin:0 0 12px 0;">Data de atualização indisponível (KV antigo — aguarde o próximo refresh, #2750).</p>`;

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
  const hasForecast = allRows.some((r) => (!r.payments || r.payments.length === 0) && r.first_payment_is_forecast);
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
    ? `<p class="coupon-monthly-legacy-note" style="opacity:0.6;font-size:13px;margin-top:6px;">Há ${escHtml(fmtBRL(legacyPaidCents))} em pagamentos registrados no formato antigo (sem quebra por mês ainda) — some após o próximo refresh (#2750). Ver "Detalhe por assinatura" abaixo pro total real.</p>`
    : "";

  const monthlySectionBody = monthKeysDesc.length === 0
    ? `<p class="coupon-monthly-empty" style="opacity:0.6;font-size:14px;">Nenhum pagamento registrado ainda (assinaturas em trial, ou KV aguardando refresh — ver #2750).</p>`
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
