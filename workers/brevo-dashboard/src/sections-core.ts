import type { Env, BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats, BrevoLinksStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementSummary } from "./types.ts";
import { type CouponUsageReport } from "../../../scripts/lib/stripe-coupons.ts";
import { DS, DS_FONTS as DSF, pct, cellClass, isSystemLink, renderLinksSection, aggregateLinksAcrossCampaigns, deriveLinksSectionTitle, renderAggregatedLinksSection, hoursSince, fmtTimeBRT } from "./render-links.ts";
import {
  renderVolumeSection,
  renderScheduledSection,
  aggregateByMonth,
  renderMonthlyTotalsSection,
  renderEngagementCohortsSection,
  renderContactsSummarySection,
  renderEiaEngagementSection,
  renderCouponTabPanel,
} from "./sections-kv.ts";

export function renderDashboardHtml(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }> = [], // #2251
  cohorts: EngagementCohorts | null = null, // #2426: pré-computado via KV
  mvStatus: MvStatus | null = null, // #2609: status MV por grupo — #2736: param não-usado no corpo (seção removida da UI), mantido pra não quebrar a assinatura posicional nos call sites/testes; ver readKvTabs
  contactsSummary: ContactsSummary | null = null, // #2653: sumário do store
  couponUsage: CouponUsageReport | null = null, // #2718: tab de cupons Stripe (PII-gated)
  eiaEngagement: EiaEngagementSummary | null = null, // #2738: engajamento do poll "É IA?" por edição
): string {
  const rows = campaigns
    .map((c) => {
      // #1141: prioriza globalStats (com Apple MPP, bate com Brevo Web UI).
      // Fallback pra campaignStats[0] se globalStats fetch falhou OU veio
      // zeroed (o listing retorna globalStats com todos os campos = 0 —
      // verificado 2026-05-12. fetchRecentCampaigns filtra esse caso, mas
      // o render é defensive-in-depth: trata sent=0 como "stats indisponível").
      const gs = c.statistics?.globalStats;
      const cs = c.statistics?.campaignStats?.[0];
      const gsIsReal = gs && gs.sent > 0;
      const s = gsIsReal ? gs : cs;
      // #2199.5: hoist canonical linksStats to single variable (one source of truth).
      // c.statistics?.linksStats is canonical (set by fetchRecentCampaigns #2199.3).
      // c.linksStats fallback preserved for backward compat (tests/mocks that pass top-level).
      const linksStats = c.statistics?.linksStats ?? c.linksStats;
      if (!s) {
        // #2198 Bug 1: passa linksStats real mesmo quando stats ausente, evitando
        // "dados não disponíveis" para campanha que tem linksStats mas não globalStats/campaignStats.
        const linksHtmlNoStats = renderLinksSection(c.id, linksStats);
        return `<tr><td>${c.id}</td><td>${escHtml(c.listName ?? "?")}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="7" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtmlNoStats}</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      const ctr = pct(s.uniqueClicks, s.delivered);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // Per circuit breakers doc 2026-05-12: unsub e spam sobre `sent`
      // (não `delivered`). Pequena diferença na prática (sent ≈ delivered +
      // bounces), mas mantém consistência com a doc operacional.
      const unsubRate = pct(s.unsubscriptions, s.sent);
      const spamRate = pct(s.complaints, s.sent);

      // Numeric versions pra comparar contra thresholds dos circuit breakers
      // (CLAUDE.md: doc operacional 2026-05-12). Alerta visual quando crossado.
      const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
      const bounceRateNum = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;
      const unsubRateNum = s.sent > 0 ? (s.unsubscriptions / s.sent) * 100 : 0;
      const spamRateNum = s.sent > 0 ? (s.complaints / s.sent) * 100 : 0;
      // Thresholds dos circuit breakers.
      // openAlert exige `openRateNum > 0` pra não acionar quando o dado ainda
      // tá propagando (campanha recém-enviada, opens ainda chegando — Brevo
      // tipicamente registra MPP nos primeiros minutos). Trade-off: campanha
      // genuinamente com 0% engajamento permanente NÃO alerta. Em prática raro
      // (Brevo sempre tem MPP). Se virar problema, condicionar a `delivered >= 50`.
      const openAlert = openRateNum > 0 && openRateNum < 15;
      const bounceAlert = bounceRateNum >= 3;
      const unsubAlert = unsubRateNum >= 3;
      const spamAlert = spamRateNum >= 0.1;
      const mppOpens = gsIsReal ? (gs?.appleMppOpens ?? 0) : 0;
      const opensNoMpp = s.uniqueViews - mppOpens;
      const openRateNoMpp = pct(opensNoMpp, s.delivered);

      // Opens cell tem layout duplo quando há MPP (#1153): top mostra
      // "taxa-com-MPP (taxa-sem-MPP)" e bottom mostra "count-total (count-sem-MPP)".
      // Sem MPP: layout simples (taxa única + count único).
      const opensTopLine = mppOpens > 0
        ? `${openRate} <span class="rate-inline">(${openRateNoMpp})</span>`
        : openRate;
      const opensBottomLine = mppOpens > 0
        ? `${s.uniqueViews} (${opensNoMpp})`
        : `${s.uniqueViews}`;

      // #2086 B2: trackableViewsRate = trackableViews / delivered
      // Indica emails com rastreamento real (exclui MPP/bots que não carregam pixel).
      // ?? 0 defensivo: campo pode estar ausente no shape real da Brevo (latente em campaignStats).
      const trackableRate = pct(s.trackableViews ?? 0, s.delivered);

      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      // #2177: links section colapsável por campanha
      const linksHtml = renderLinksSection(
        c.id,
        linksStats,
        s.uniqueClicks,
      );
      return `<tr>
        <td>${c.id}</td>
        <td><strong>${escHtml(cleanListName)}</strong></td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${pct(s.delivered, s.sent)}<br><small>${s.delivered}</small></td>
        <td${cellClass("metric", openAlert && "alert")}>${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td class="metric trackable">${trackableRate}<br><small>${s.trackableViews ?? 0}</small></td>
        <td${cellClass("metric")}>${ctr}<br><small>${s.uniqueClicks}</small></td>
        <td${cellClass(bounceAlert && "alert")}>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td${cellClass(unsubAlert && "alert")}>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td${cellClass(spamAlert && "alert")}>${spamRate}<br><small>${s.complaints}</small></td>
      </tr>
      <tr class="links-row"><td colspan="11" class="links-cell">${linksHtml}</td></tr>`;
    })
    .join("\n");

  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // #2086 Fase 2: seções adicionais
  const activeCycle = detectActiveCycle(campaigns);
  const cumSent = activeCycle ? calcCumulativeSent(campaigns, activeCycle) : 0;
  const volumeSection = activeCycle ? renderVolumeSection(cumSent) : "";
  // #2600: restaura Resumo A/B/C como seção principal (revertendo #2492 que havia substituído).
  // D1–D5 mantido como seção SEPARADA logo após.
  // Reset A/B/C (#2871): o filtro fica AQUI no call site — aggregateAbcSummary
  // permanece pura (review #2870: embutir o cutoff nela quebrava a cobertura
  // das regressões #2199/#2600 e armava um trap pra callers futuros). O
  // placeholder só aparece quando o CORTE causou o zero (havia células
  // pré-reset); ciclo sem A/B/C planejado segue renderizando nada (neutro).
  const abcRowsAll = activeCycle ? aggregateAbcSummary(campaigns, activeCycle) : [];
  const abcRows = activeCycle
    ? aggregateAbcSummary(campaigns.filter(isPostAbcReset), activeCycle)
    : [];
  const abcResetNote =
    abcRowsAll.some((r) => r.campaignCount > 0) && abcRows.every((r) => r.campaignCount === 0);
  const abcSection = activeCycle ? renderAbcSection(abcRows, abcResetNote) : "";
  // #2736: "Resumo D1–D5 — S1" removida da aba Engajamento (ruído, decisão do
  // editor). renderDaySummarySection/aggregateDaySummary permanecem exportadas
  // e testadas (reuso futuro), só não são mais chamadas aqui.
  // #2134: tabela de open rate por dia da semana (ciclo ativo).
  // Escopo: ciclo ativo quando detectado; fallback "todas as campanhas" quando
  // não há campanha Clarice News (activeCycle=null). Linha all-time separada
  // não implementada — custo de render zero pois os dados já estão em memória,
  // mas optamos por manter UI simples: 1 tabela por view. Revisitar se editor
  // pedir comparação cross-ciclo explícita.
  const weekdayScopeLabel = "todos os envios"; // #2134 follow-up: editor pediu histórico completo, não só o ciclo ativo
  const weekdayNow = new Date(); // #2611: injetável nos testes via parâmetro; produção usa Date atual
  const { rows: weekdayRows, excluded: weekdayExcluded } = aggregateByWeekday(campaigns, null, weekdayNow);
  const weekdaySection = weekdayRows.length > 0 || weekdayExcluded.length > 0
    ? renderWeekdaySection(weekdayRows, weekdayScopeLabel, weekdayExcluded)
    : "";
  // #2212: seção de links agregados do período
  // #2421: título inclui label da edição (cycle-sendMonth) quando detectável.
  const aggregatedLinks = aggregateLinksAcrossCampaigns(campaigns);
  const edicaoLabel = deriveLinksSectionTitle(campaigns);
  const aggregatedLinksSection = renderAggregatedLinksSection(aggregatedLinks, edicaoLabel);
  // #2251: seção de campanhas agendadas (status queued) — só sobre `scheduled`,
  // nunca polui os agregadores de enviadas (A/B/C, volume, weekday).
  const scheduledSection = renderScheduledSection(scheduled);
  // #2369: tabela de totais por mês — à parte da lista detalhada de campanhas.
  const monthlyTotalsRows = aggregateByMonth(campaigns);
  const monthlyTotalsSection = renderMonthlyTotalsSection(monthlyTotalsRows);
  // #2426: coortes de engajamento por contato (pré-computadas via KV, lidas na rota).
  const cohortsSection = renderEngagementCohortsSection(cohorts);
  // #2736: "Status MillionVerifier por grupo" removida da aba Engajamento
  // (ruído, decisão do editor). renderMvStatusSection permanece exportada e
  // testada (reuso futuro); a leitura do KV mv:status em readKvTabs também
  // fica (custo desprezível, já paralela às outras — reverter é maior cirurgia
  // do que o pedido pede; ver corpo do PR).
  // #2653: sumário do store único de contatos (pré-computado via KV).
  const contactsSummarySection = renderContactsSummarySection(contactsSummary);
  // #2738: engajamento do poll "É IA?" por edição (pré-computado via KV).
  const eiaEngagementSection = renderEiaEngagementSection(eiaEngagement);
  // #2718: tab de cupons Stripe (apenas quando couponUsage não é null — PII-gated).
  const couponTabHtml = couponUsage ? renderCouponTabPanel(couponUsage) : "";

  // #2084: CSS usa tokens do DS (DS.*/DSF.*). Vars --muted e --rule-header
  // são derivadas do DS: --muted = ink com opacity 55% (ferramenta interna,
  // sem token canônico de cinza — DS só tem ink; usamos inline hex aproximado
  // #666 → substituído por DS.ink para uniformidade, com opacity via class).
  // --rule-header = DS.rule (bege #EBE5D0); --rule de linhas = DS.rule.
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clarice News Dashboard</title>
<style>
  :root {
    --brand: ${DS.brand};
    --ink: ${DS.ink};
    --paper: ${DS.paper};
    --paper-alt: ${DS.paperAlt};
    --rule: ${DS.rule};
    --alert: ${DS.alert};
  }
  body { font-family: ${DSF.sans}; max-width: 1200px; margin: 30px auto; padding: 0 20px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; color: var(--ink); }
  .sub { color: var(--ink); opacity: 0.6; font-size: 0.9rem; margin: 0 0 24px 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  /* #2104: borda do th era --rule (#EBE5D0) sobre fundo --paper-alt (#EBE5D0) → invisível.
     Substituída por ink (#171411) com 18% opacity — visível no DS claro sem ser pesada. */
  td.metric { font-weight: 600; color: var(--brand); }
  td.trackable { font-size: 0.85em; opacity: 0.85; }
  td.alert { font-weight: 600; color: var(--alert); }
  td.alert small, td.alert .rate-inline { color: var(--alert); opacity: 1; }
  .alert-label { font-weight: 600; color: var(--alert); }
  td .rate-inline { font-weight: normal; color: var(--ink); }
  td small { color: var(--ink); opacity: 0.6; font-weight: normal; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 24px; text-align: center; }
  .footer code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
  /* #2086: seções de fase 2 */
  .phase2-section { margin: 32px 0 8px 0; }
  .section-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px 0; color: var(--ink); border-bottom: 2px solid var(--rule); padding-bottom: 6px; }
  .section-note { font-size: 0.85rem; color: var(--ink); opacity: 0.75; margin: 0 0 12px 0; }
  .volume-note { font-size: 0.95rem; margin-top: 10px; } /* número no font do DS; só a spark-bar é monospace */
  .spark-bar { display: block; font-family: monospace; font-size: 0.8rem; line-height: 1.2; letter-spacing: -1px; color: var(--brand); margin-top: 4px; overflow: hidden; white-space: nowrap; }
  td.spark { font-family: monospace; letter-spacing: -1px; color: var(--brand); font-size: 0.8rem; white-space: nowrap; }
  /* #2177: CTR por link */
  tr.links-row td.links-cell { padding: 0; border-bottom: 2px solid var(--rule); background: var(--paper); }
  details.links-ctr { margin: 0; }
  summary.links-summary { padding: 5px 8px; font-size: 0.8rem; cursor: pointer; color: var(--ink); opacity: 0.75; user-select: none; list-style: none; }
  summary.links-summary::-webkit-details-marker { display: none; }
  summary.links-summary::before { content: "▶ "; font-size: 0.65rem; }
  details[open] > summary.links-summary::before { content: "▼ "; }
  .links-count-badge { background: var(--paper-alt); border-radius: 8px; padding: 1px 6px; font-size: 0.75rem; margin-left: 4px; }
  .links-empty { padding: 4px 12px 6px; font-size: 0.8rem; color: var(--ink); opacity: 0.5; margin: 0; }
  .links-table-wrap { overflow-x: auto; padding: 0 8px 8px; }
  .links-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .links-table th, .links-table td { padding: 4px 6px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  .links-table th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.4px; background: transparent; color: var(--ink); opacity: 0.7; }
  .links-table td.link-url { max-width: 420px; word-break: break-all; }
  .links-table td.link-url a { color: var(--brand); text-decoration: none; }
  .links-table td.link-url a:hover { text-decoration: underline; }
  .links-table td.link-clicks { font-weight: 600; color: var(--brand); }
  .links-table td.link-pct { opacity: 0.75; }
  .links-note { font-size: 0.72rem; color: var(--ink); opacity: 0.5; padding: 2px 12px 6px; margin: 0; }
  /* #2758: lista de pagamentos individuais na célula "Pagamentos" (detalhe por assinatura) */
  .payments-list { margin: 4px 0 6px; padding-left: 20px; font-size: 0.8rem; }
  .payments-list li { padding: 1px 0; }
  /* #2758: .links-ctr dentro de uma <td> normal (não numa <tr>/<td> full-bleed
     como o "Links clicados") — a <td> já tem padding próprio, então zeramos o
     do summary pra não dobrar o espaçamento. */
  details.payments-cell summary.links-summary { padding: 0; }
  /* #2758: separador entre os blocos de mês empilhados (sem tabela ao redor
     pra dar borda, diferente do "Resumo por cupom" removido). */
  details.coupon-month { border-bottom: 1px solid var(--rule); }
  details.coupon-month summary.links-summary { padding: 8px; }
  /* #2542: tab navigation — CSS-only via radio+label+:checked (sem JS externo) */
  /* Radios visualmente ocultos mas FOCÁVEIS via teclado (não display:none, que os
     removeria da ordem de tabulação — Tab/setas precisam alcançar as abas). */
  .tab-radios { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .tab-bar { display: flex; gap: 4px; margin: 16px 0 0 0; border-bottom: 2px solid var(--rule); padding-bottom: 0; }
  .tab-label {
    display: inline-block; padding: 8px 18px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; border-bottom: 2px solid transparent;
    border-radius: 4px 4px 0 0; color: var(--ink); opacity: 0.65;
    margin-bottom: -2px; user-select: none;
    transition: opacity 0.1s;
  }
  .tab-label:hover { opacity: 1; background: var(--paper-alt); }
  #tab-visaogeral:checked ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:checked ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:checked ~ .tab-bar label[for="tab-links"],
  #tab-contatos:checked ~ .tab-bar label[for="tab-contatos"],
  #tab-cupons:checked ~ .tab-bar label[for="tab-cupons"] {
    background: var(--paper); border-color: var(--rule); opacity: 1;
    color: var(--brand); border-bottom-color: var(--paper);
  }
  /* Foco de teclado: o radio focado projeta um contorno no seu label irmão. */
  #tab-visaogeral:focus-visible ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:focus-visible ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:focus-visible ~ .tab-bar label[for="tab-links"],
  #tab-contatos:focus-visible ~ .tab-bar label[for="tab-contatos"],
  #tab-cupons:focus-visible ~ .tab-bar label[for="tab-cupons"] {
    outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1;
  }
  .tab-panel { display: none; padding-top: 8px; }
  #tab-visaogeral:checked ~ .tab-panels #panel-visaogeral,
  #tab-engajamento:checked ~ .tab-panels #panel-engajamento,
  #tab-links:checked ~ .tab-panels #panel-links,
  #tab-contatos:checked ~ .tab-panels #panel-contatos,
  #tab-cupons:checked ~ .tab-panels #panel-cupons { display: block; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
    .tab-label { padding: 6px 10px; font-size: 0.8rem; }
  }
</style>
</head>
<body>
<h1>📧 Clarice News Dashboard</h1>
<p class="sub">Últimas ${campaigns.length} campaigns. Dados em tempo real — carregado às ${now} BRT.</p>

<!-- #2542: tab state inputs (hidden, CSS-only — sem JS externo) -->
<input type="radio" class="tab-radios" name="dash-tab" id="tab-visaogeral" checked>
<input type="radio" class="tab-radios" name="dash-tab" id="tab-engajamento">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-links">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-contatos">
${couponUsage ? '<input type="radio" class="tab-radios" name="dash-tab" id="tab-cupons">' : ''}

<!-- tab bar (labels referencing the radio inputs above; aria-controls liga aba↔painel) -->
<div class="tab-bar" role="tablist">
  <label class="tab-label" id="tablabel-visaogeral" for="tab-visaogeral" role="tab" aria-controls="panel-visaogeral">Visão geral</label>
  <label class="tab-label" id="tablabel-engajamento" for="tab-engajamento" role="tab" aria-controls="panel-engajamento">Engajamento</label>
  <label class="tab-label" id="tablabel-links" for="tab-links" role="tab" aria-controls="panel-links">Links / CTR</label>
  <label class="tab-label" id="tablabel-contatos" for="tab-contatos" role="tab" aria-controls="panel-contatos">Contatos</label>
  ${couponUsage ? '<label class="tab-label" id="tablabel-cupons" for="tab-cupons" role="tab" aria-controls="panel-cupons">Cupons</label>' : ''}
</div>

<!-- tab panels -->
<div class="tab-panels">

  <!-- Aba 1: Visão geral — totais mensais + volume + agendados + envios -->
  <div class="tab-panel" id="panel-visaogeral" role="tabpanel" aria-labelledby="tablabel-visaogeral">
${monthlyTotalsSection}
${volumeSection}
${scheduledSection}
<section class="phase2-section" id="campaigns-table">
  <h2 class="section-title">Envios</h2>
<div class="table-wrap">
<table id="envios-table">
<thead>
<tr>
<th title="ID do envio no Brevo.">ID</th>
<th title="Lista de destinatários no Brevo.">Lista</th>
<th title="Data e hora do envio (horário de Brasília).">Enviado</th>
<th title="${escHtml(ENVIOS_TOOLTIP)}">E-mails (eventos)</th>
<th title="Emails entregues nas caixas dos leitores.">Delivered</th>
<th title="Aberturas únicas. Inclui Apple MPP e bots/proxies. Bench: 15-25% B2C, 30-45% engajadas.">Opens 👁️</th>
<th title="trackableViews ÷ delivered: aperturas com pixel rastreável (exclui MPP/bots que não disparam pixel). Sinal mais limpo de engajamento real.">Trackable 📍</th>
<th title="Cliques únicos. Bench: 1.5-3% B2C.">Clicks 🖱️</th>
<th title="Hard bounces (inválido) + soft bounces (caixa cheia). Bench: <2% saudável. ≥3% pausa o ramp.">Bounces</th>
<th title="Descadastros. Esperado em baixo volume. Bench: <0.5%. ≥3% pausa o ramp.">Unsub</th>
<th title="Marcações de spam. Prejudica reputação do domínio. Bench: <0.1%. ≥0.1% pausa o ramp.">Spam</th>
</tr>
</thead>
<tbody id="envios-tbody">
${rows || `<tr><td colspan="11" style="text-align:center;color:${DS.ink};opacity:0.6;padding:24px;">Nenhuma campaign encontrada.</td></tr>`}
</tbody>
</table>
</div>
<div id="envios-pagination" style="display:none;margin-top:12px;align-items:center;gap:12px;font-size:0.85rem;color:var(--ink);">
  <button id="envios-prev" aria-label="Página anterior" disabled
    style="padding:4px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--paper-alt);color:var(--ink);cursor:pointer;">‹ Anterior</button>
  <span id="envios-page-info" style="opacity:0.75;"></span>
  <button id="envios-next" aria-label="Próxima página"
    style="padding:4px 12px;border:1px solid var(--rule);border-radius:4px;background:var(--paper-alt);color:var(--ink);cursor:pointer;">Próxima ›</button>
</div>
<script>
(function() {
  var PER_PAGE = 10;
  var tbody = document.getElementById('envios-tbody');
  var pagination = document.getElementById('envios-pagination');
  var prevBtn = document.getElementById('envios-prev');
  var nextBtn = document.getElementById('envios-next');
  var pageInfo = document.getElementById('envios-page-info');
  if (!tbody || !pagination || !prevBtn || !nextBtn || !pageInfo) return;

  // Collect data rows only (exclude .links-row accordion TRs — each data row is
  // paired with an immediately-following .links-row sibling that must travel with it).
  var allRows = Array.prototype.filter.call(tbody.children, function(el) {
    return el.tagName === 'TR' && !el.classList.contains('links-row');
  });
  var totalRows = allRows.length;
  var totalPages = Math.max(1, Math.ceil(totalRows / PER_PAGE));

  if (totalRows <= PER_PAGE) {
    pagination.style.display = 'none';
    return; // hide controls — ≤ PER_PAGE campaigns
  }

  pagination.style.display = 'flex';
  var currentPage = 1;

  function showPage(page) {
    currentPage = page;
    var start = (page - 1) * PER_PAGE;
    var end = start + PER_PAGE;
    for (var i = 0; i < allRows.length; i++) {
      var visible = (i >= start && i < end);
      allRows[i].style.display = visible ? '' : 'none';
      // Also show/hide the paired .links-row sibling that follows each data row.
      var next = allRows[i].nextElementSibling;
      if (next && next.classList.contains('links-row')) {
        next.style.display = visible ? '' : 'none';
      }
    }
    pageInfo.textContent = 'Página ' + page + ' de ' + totalPages;
    prevBtn.disabled = page <= 1;
    prevBtn.setAttribute('aria-disabled', page <= 1 ? 'true' : 'false');
    nextBtn.disabled = page >= totalPages;
    nextBtn.setAttribute('aria-disabled', page >= totalPages ? 'true' : 'false');
  }

  prevBtn.addEventListener('click', function() { if (currentPage > 1) showPage(currentPage - 1); });
  nextBtn.addEventListener('click', function() { if (currentPage < totalPages) showPage(currentPage + 1); });

  showPage(1);
})();
</script>
</section>
  </div><!-- /panel-visaogeral -->

  <!-- Aba 2: Engajamento — weekday + resumo A/B/C + coortes + É IA? (#2773) -->
  <div class="tab-panel" id="panel-engajamento" role="tabpanel" aria-labelledby="tablabel-engajamento">
${weekdaySection}
${abcSection}
${cohortsSection}
${eiaEngagementSection}
  </div><!-- /panel-engajamento -->

  <!-- Aba 3: Links / CTR — links agregados do período -->
  <div class="tab-panel" id="panel-links" role="tabpanel" aria-labelledby="tablabel-links">
${aggregatedLinksSection}
  </div><!-- /panel-links -->

  <!-- Aba 4: Contatos — sumário do store único (#2653) -->
  <div class="tab-panel" id="panel-contatos" role="tabpanel" aria-labelledby="tablabel-contatos">
${contactsSummarySection}
  </div><!-- /panel-contatos -->

${couponUsage ? `  <!-- Aba 5: Cupons — uso de cupons Stripe (#2718, PII-gated) -->
  <div class="tab-panel" id="panel-cupons" role="tabpanel" aria-labelledby="tablabel-cupons">
${couponTabHtml}
  </div><!-- /panel-cupons -->` : ''}

</div><!-- /tab-panels -->

<p class="footer">Dados com cache de até 5 min — <a href="?fresh=1" style="color:var(--brand)">?fresh=1</a> força atualização imediata.<br>
Open rate e CTR calculados sobre <em>delivered</em>; bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses, a taxa sem Apple MPP (ainda pode incluir outros bots). Coluna Trackable 📍 mostra aberturas com pixel real (trackableViews ÷ delivered). Dados brutos em <code>/api/campaigns</code>.<br>
Cells em <span class="alert-label">vermelho</span> indicam que a métrica cruzou o threshold de circuit breaker (open <15%, bounce ≥3%, unsub ≥3%, spam ≥0.1%).</p>
<script>
/* #2622: progressive enhancement — deep-link (hash<->aba) + aria-selected. Sem JS, o CSS-only puro segue funcionando. */
(function () {
  var radios = Array.prototype.slice.call(document.querySelectorAll('.tab-radios'));
  if (!radios.length) return;
  var labels = Array.prototype.slice.call(document.querySelectorAll('.tab-label'));
  function panelOf(radio) {
    var lbl = document.querySelector('.tab-label[for="' + radio.id + '"]');
    return lbl ? lbl.getAttribute('aria-controls') : null;
  }
  function syncAria() {
    labels.forEach(function (lbl) {
      var r = document.getElementById(lbl.getAttribute('for'));
      lbl.setAttribute('aria-selected', r && r.checked ? 'true' : 'false');
    });
  }
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var matched = radios.filter(function (r) { return r.id === h || panelOf(r) === h; })[0];
    if (matched) matched.checked = true;
  }
  radios.forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      var pid = panelOf(r);
      if (pid && history.replaceState) history.replaceState(null, '', '#' + pid);
      syncAria();
    });
  });
  window.addEventListener('hashchange', function () { applyHash(); syncAria(); });
  applyHash();
  syncAria();
})();
</script>
</body>
</html>`;
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── #2086 Fase 2: helpers de agregação ──────────────────────────────────────

/**
 * Volume total do plano S1/ciclo 2605-06 conforme clarice-build-edition-sends.ts.
 * S1 = d01–d07 A/B/C = 5.600. Total S1+S2+S3 = 40.000.
 * Exportado pra teste unitário.
 */
export const CLARICE_PLAN_TOTAL = 40_000;
export const CLARICE_PLAN_S1 = 5_600;

/**
 * Tooltip compartilhado para a coluna "Envios (eventos)" — usado na tabela
 * por-campanha, na tabela mensal e na seção Volume. DRY: alterar aqui propaga
 * para todos os pontos de uso. (#2429 self-review)
 */
export const ENVIOS_TOOLTIP =
  "Eventos de envio acumulados; uma pessoa em N campanhas conta N vezes; inclui bounces.";

/**
 * Extrai o ciclo e o número do dia de uma campanha Clarice News.
 * ex: "Clarice News 2605 d02-C (qui)" → { cycle: "2605", dayNum: 2, cell: "C" }
 * ex: "Clarice News 2605 d08 (qua)"  → { cycle: "2605", dayNum: 8, cell: null }
 * Retorna null para campanhas que não seguem o padrão.
 *
 * #2360: sufixo de célula (-A/-B/-C) é OPCIONAL. Envios únicos (sem A/B/C) têm
 * cell: null e são incluídos em calcCumulativeSent / detectActiveCycle. Não
 * participam do resumo A/B/C (aggregateAbcSummary filtra cell === null).
 */
export function parseClariceCampaignKey(campaignName: string): {
  cycle: string;
  dayNum: number;
  cell: "A" | "B" | "C" | null;
} | null {
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})(?:-([ABC]))?(?=\s|$)/i);
  if (!m) return null;
  const cell = m[3] ? (m[3].toUpperCase() as "A" | "B" | "C") : null;
  return { cycle: m[1], dayNum: parseInt(m[2], 10), cell };
}

/**
 * #2254: fonte única da escolha de stats reais de uma campanha — globalStats
 * (primário, bate com a UI da Brevo) quando `sent > 0`, senão campaignStats[0].
 * Centraliza o padrão `gsIsReal ? gs : cs` que estava duplicado em vários lugares
 * (renderDashboardHtml, aggregateByWeekday, calcCumulativeSent, aggregateAbcSummary). Retorna `null` quando não há stats reais (sent>0).
 * `!(... .sent > 0)` cobre sent=0, undefined e null sem NaN.
 *
 * #2258 (semântica de MPP, verificada empiricamente 2026-06-14 contra a API
 * Brevo): TANTO `globalStats.uniqueViews` QUANTO `campaignStats.uniqueViews`
 * INCLUEM Apple MPP opens (cs.uv ≈ gs.uv, ~levemente menor por lag de snapshot;
 * NÃO é gs.uv − appleMppOpens). Logo `uniqueViews` é uma base homogênea
 * (MPP-inclusiva) entre as duas fontes — usar direto é consistente. O orgânico
 * (sem MPP) só é computável de globalStats, que expõe `appleMppOpens`; por isso
 * `isGlobal` é retornado: quem quiser orgânico subtrai SÓ quando isGlobal.
 */
export function pickStats(
  c: BrevoCampaign,
): { stats: BrevoGlobalStats | BrevoCampaignStats; isGlobal: boolean } | null {
  const gs = c.statistics?.globalStats;
  if (gs && gs.sent > 0) return { stats: gs, isGlobal: true };
  const cs = c.statistics?.campaignStats?.[0];
  if (cs && cs.sent > 0) return { stats: cs, isGlobal: false };
  return null;
}

export interface CellSummary {
  cell: "A" | "B" | "C";
  /** Soma de uniqueViews (MPP-inclusivo) das campanhas da célula */
  totalViews: number;
  /** Soma de delivered das campanhas da célula */
  totalDelivered: number;
  /** Open rate agregado MPP-inclusivo (totalViews / totalDelivered) — base do LÍDER */
  openRate: number;
  /** Número de campanhas contabilizadas (dias enviados) */
  campaignCount: number;
  /**
   * #2257: open rate ORGÂNICO (sem Apple MPP), secundário. `null` quando algum
   * dia da célula caiu no fallback campaignStats (sem `appleMppOpens` → orgânico
   * não computável e não-comparável). Só preenchido quando TODOS os dias têm
   * globalStats (mesma base entre as células).
   */
  organicOpenRate: number | null;
}

/**
 * Reset do teste A/B/C (#2871, pedido do editor 260702): o teste do ciclo 2605
 * foi ENCERRADO e documentado (B venceu — consolidada em d06); um teste novo
 * será rodado em breve. Campanhas agendadas ANTES deste corte ficam fora do
 * Resumo A/B/C — o filtro (isPostAbcReset) é aplicado no CALL SITE
 * (renderDashboardHtml), nunca dentro de aggregateAbcSummary (review #2870).
 * Lifecycle do cutoff (próximo reset, opção KV sem deploy): ver #2871.
 */
export const ABC_RESET_AT = "2026-07-03T00:00:00.000-03:00";

/**
 * true se a campanha foi agendada NO cutoff ou depois — participa do Resumo
 * A/B/C pós-reset (#2871). `scheduledAt` ausente/não-parseável → false
 * (conservador). Verificação empírica 260702: o listing `status=sent` da
 * Brevo devolve `scheduledAt` populado (28/28 campanhas de junho conferidas
 * via API) — campanhas do teste novo passam normalmente.
 */
export function isPostAbcReset(c: Pick<BrevoCampaign, "scheduledAt">): boolean {
  const ms = c.scheduledAt ? Date.parse(c.scheduledAt) : NaN;
  return Number.isFinite(ms) && ms >= Date.parse(ABC_RESET_AT);
}

/**
 * Agrega resumo A/B/C das campanhas S1 (d01–d07) de um ciclo Clarice.
 * Usa apenas campanhas com status "sent" e stats reais (gs.sent > 0).
 * Exportado pra teste unitário.
 */
export function aggregateAbcSummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): CellSummary[] {
  const cells: Record<
    "A" | "B" | "C",
    { views: number; delivered: number; count: number; organicViews: number; organicDays: number }
  > = {
    A: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
    B: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
    C: { views: 0, delivered: 0, count: 0, organicViews: 0, organicDays: 0 },
  };

  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    // #2360: cell=null = envio único (sem sufixo A/B/C) — não participa do A/B/C.
    if (parsed.cell === null) continue;
    // S1 = d01–d07
    if (parsed.dayNum > 7) continue;

    // #2254: escolha de fonte centralizada. #2252: fallback p/ campaignStats
    // quando globalStats 429/zerado — sem ele a seção A/B/C INTEIRA sumia.
    const picked = pickStats(c);
    if (!picked) continue;
    const { stats: s, isGlobal } = picked;

    // #2258: base canônica = uniqueViews (MPP-INCLUSIVO). campaignStats.uniqueViews
    // TAMBÉM inclui MPP (verificado 2026-06-14) → usar direto é homogêneo entre as
    // fontes e bate com a UI da Brevo (#2257). O bug do #2253 era subtrair MPP só
    // do globalStats e não do campaignStats (que não expõe appleMppOpens) → no
    // fallback gerava número "orgânico" que na verdade era MPP-incl → impossível.
    cells[parsed.cell].views += s.uniqueViews ?? 0;
    cells[parsed.cell].delivered += s.delivered ?? 0;
    cells[parsed.cell].count += 1;

    // #2257: orgânico (sem MPP) só de globalStats (tem appleMppOpens). Contamos
    // organicDays p/ saber se TODOS os dias da célula têm orgânico — só então é
    // comparável entre as células (mesma base); senão organicOpenRate = null.
    if (isGlobal) {
      const gs = s as BrevoGlobalStats;
      cells[parsed.cell].organicViews += Math.max(0, (gs.uniqueViews ?? 0) - (gs.appleMppOpens ?? 0));
      cells[parsed.cell].organicDays += 1;
    }
  }

  return (["A", "B", "C"] as const).map((cell) => {
    const d = cells[cell];
    // organicOpenRate só quando TODOS os dias contados têm orgânico (base homogênea).
    const organicComplete = d.count > 0 && d.organicDays === d.count;
    return {
      cell,
      totalViews: d.views,
      totalDelivered: d.delivered,
      openRate: d.delivered > 0 ? (d.views / d.delivered) * 100 : 0,
      campaignCount: d.count,
      organicOpenRate: organicComplete && d.delivered > 0 ? (d.organicViews / d.delivered) * 100 : null,
    };
  });
}

/**
 * Calcula volume enviado cumulativo de campanhas Clarice News de um ciclo.
 * Soma "sent" de todas as campanhas do ciclo (todos os dias, todas as células).
 * Usa globalStats como primário (com Apple MPP, bate com Brevo UI); cai pra
 * campaignStats[0].sent se globalStats fetch falhou — evita subcontagem quando
 * o fetch individual de stats não funcionou pra alguma campanha.
 * Exportado pra teste unitário.
 */
export function calcCumulativeSent(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): number {
  let total = 0;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    const picked = pickStats(c); // #2254: fonte única (globalStats → campaignStats)
    if (!picked) continue;
    total += picked.stats.sent ?? 0;
  }
  return total;
}

/**
 * Detecta o ciclo ativo (mais recente) entre campanhas Clarice News.
 * Retorna o cycle string (ex: "2605") ou null se nenhuma encontrada.
 * Exportado pra teste unitário.
 */
export function detectActiveCycle(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): string | null {
  let latest: string | null = null;
  for (const c of campaigns) {
    const parsed = parseClariceCampaignKey(c.name);
    if (!parsed) continue;
    if (!latest || parsed.cycle > latest) latest = parsed.cycle;
  }
  return latest;
}

// ─── #2134: tabela de open rate por dia da semana ────────────────────────────

/**
 * Ordem canônica seg→dom (índice 0=seg, 6=dom).
 * Corresponde a `new Date().getDay()` mapeado pra ordem BRT-friendly:
 * JS getDay(): 0=dom, 1=seg, ..., 6=sab.
 * Aqui usamos nossa própria chave 0–6 (seg–dom) — ver weekdayKey().
 */
export const WEEKDAY_LABELS: Record<number, string> = {
  0: "Seg",
  1: "Ter",
  2: "Qua",
  3: "Qui",
  4: "Sex",
  5: "Sáb",
  6: "Dom",
};

export interface WeekdaySummary {
  /** 0=Seg, 1=Ter, 2=Qua, 3=Qui, 4=Sex, 5=Sáb, 6=Dom */
  weekday: number;
  label: string;
  /** Número de campanhas enviadas neste dia */
  count: number;
  delivered: number;
  opens: number;
  /** open rate agregado = opens / delivered (0 quando delivered=0) */
  openRate: number;
  /** true quando count < 2 — amostra insuficiente para conclusão */
  smallSample: boolean;
}

/**
 * Retorna a chave do dia da semana em BRT (0=Seg, 1=Ter, ..., 6=Dom).
 * Converte o ISO string pra BRT antes de extrair o weekday — evita erro
 * de "envio às 21h BRT = dia UTC seguinte" (ex: 22:00 BRT = 01:00 UTC+1dia).
 *
 * Estratégia: usa Intl.DateTimeFormat com timeZone BRT pra extrair o dia
 * numérico (JS weekday: 0=dom..6=sab → mapeado pra nossa escala 0=seg..6=dom).
 */
export function weekdayKeyBRT(iso: string): number | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;

  // Extrai partes de data em BRT via formatToParts
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).formatToParts(d);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";

  // Mapeia abreviação pt-BR → índice 0=Seg..6=Dom
  // Browsers/Node retornam "seg.", "ter.", "qua.", "qui.", "sex.", "sáb.", "dom."
  // Fazemos lowercase + strip ponto pra normalizar.
  const normalized = weekdayShort.toLowerCase().replace(/\./g, "").trim();
  const map: Record<string, number> = {
    seg: 0, ter: 1, qua: 2, qui: 3, sex: 4, sáb: 5, sab: 5, dom: 6,
  };
  return map[normalized] ?? null;
}

/**
 * Retorna a chave "YYYY-MM" do sentDate em BRT (America/Sao_Paulo).
 * Exportado pra teste unitário.
 *
 * Necessário porque `sentDate.slice(0,7)` usa UTC — campanha enviada
 * 2026-07-01T00:00:00Z (= 30/jun 21:00 BRT) produziria "2026-07" via slice,
 * mas deve ser "2026-06" para ser consistente com fmtTimeBRT / weekdayKeyBRT.
 * (#2402)
 */
export function monthKeyBRT(iso: string): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`; // "2026-06"
}

// #2611: envios com menos de 48h têm open rate instável — excluí-los evita conclusões prematuras.
export const WEEKDAY_MIN_AGE_HOURS = 48;

/** Metadado de campanha excluída por <48h (para nota no render). */
export interface WeekdayExcluded {
  name: string;
  sentDate: string;
}

/**
 * Agrega open rate por dia da semana (seg–dom, BRT) para as campanhas do
 * ciclo ativo. Inclui apenas campanhas com stats reais (mesmo fallback do
 * render principal: globalStats primário, campaignStats[0] como fallback, ?? 0
 * defensivo para campos ausentes).
 *
 * #2611: exclui campanhas com sentDate < 48h antes de `now` (open rate instável).
 * `now` é injetável para testes; produção passa `new Date()`.
 *
 * Retorna apenas os weekdays que tiveram ao menos 1 campanha, ordenados seg→dom.
 * Weekdays com count < 2 são marcados com smallSample=true.
 *
 * @param campaigns - lista de campanhas (todas, filtradas internamente por ciclo)
 * @param cycle     - filtro por ciclo (ex: "2605"); produção passa SEMPRE null (todos os envios,
 *                    decisão do editor 2026-06-11) — o filtro vive pra testes/uso futuro
 * @param now       - instante de referência (injetável para testes)
 * @returns { rows: WeekdaySummary[], excluded: WeekdayExcluded[] }
 */
export function aggregateByWeekday(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string | null,
  now: Date = new Date(),
): { rows: WeekdaySummary[]; excluded: WeekdayExcluded[] } {
  type Acc = { count: number; delivered: number; opens: number };
  const acc: Record<number, Acc> = {};
  const excluded: WeekdayExcluded[] = [];
  const minAgeMs = WEEKDAY_MIN_AGE_HOURS * 3600 * 1000;

  for (const c of campaigns) {
    // Filtro por ciclo ativo (quando passado)
    if (cycle !== null) {
      const parsed = parseClariceCampaignKey(c.name);
      if (!parsed || parsed.cycle !== cycle) continue;
    }

    if (!c.sentDate) continue;

    // #2611: excluir envios com menos de 48h (open rate ainda estabilizando).
    const sentMs = new Date(c.sentDate).getTime();
    if (isNaN(sentMs)) continue;
    if (now.getTime() - sentMs < minAgeMs) {
      excluded.push({ name: c.name, sentDate: c.sentDate });
      continue;
    }

    // #2254: fonte única (globalStats → campaignStats). #2256: uniqueViews é
    // MPP-inclusivo nas DUAS fontes (verificado 2026-06-14) → não há mistura de
    // base; opens aqui são MPP-inclusivos, consistente com a tabela de campanhas.
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;

    const wk = weekdayKeyBRT(c.sentDate);
    if (wk === null) continue;

    if (!acc[wk]) acc[wk] = { count: 0, delivered: 0, opens: 0 };
    acc[wk].count += 1;
    acc[wk].delivered += s.delivered ?? 0;
    acc[wk].opens += s.uniqueViews ?? 0;
  }

  // Ordenar seg→dom (chave 0..6) e construir WeekdaySummary
  const rows = Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((wk) => {
      const d = acc[wk];
      return {
        weekday: wk,
        label: WEEKDAY_LABELS[wk] ?? `Dia ${wk}`,
        count: d.count,
        delivered: d.delivered,
        opens: d.opens,
        openRate: d.delivered > 0 ? (d.opens / d.delivered) * 100 : 0,
        smallSample: d.count < 2,
      };
    });

  return { rows, excluded };
}

/**
 * Renderiza a seção de open rate por dia da semana.
 * Melhor dia destacado com ▲ MELHOR DIA (mesmo padrão visual do LÍDER A/B/C).
 * Empate → mesmo tratamento do #2118/#2124 (nenhuma linha recebe tag).
 * Semana completa seg→dom; dias sem campanha são omitidos.
 * Exportado pra teste unitário.
 */
export function renderWeekdaySection(
  rows: WeekdaySummary[],
  scopeLabel: string,
  excluded: WeekdayExcluded[] = [],
): string {
  if (rows.length === 0 && excluded.length === 0) return "";
  if (rows.length === 0) {
    const excList = excluded.map((e) => escHtml(e.name)).join(", ");
    return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  <p class="section-note">Envios ainda não computados (open rate &lt; ${WEEKDAY_MIN_AGE_HOURS}h, estabilizando): ${excList}.</p>
</section>`;
  }

  // Calcula melhor dia (max openRate entre rows com count >= 1)
  // Empate: nenhuma linha recebe tag
  const validRows = rows.filter((r) => r.count > 0);
  const maxRate = validRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = validRows.filter((r) => r.openRate === maxRate).length;
  const isTied = validRows.length >= 2 && tiedCount > 1;
  const winnerWk = !isTied && validRows.length >= 2
    ? (validRows.find((r) => r.openRate === maxRate)?.weekday ?? null)
    : null;

  // #2134 follow-up (editor 2026-06-11): exibir do melhor open rate pro pior.
  const orderedRows = [...rows].sort((a, b) => {
    if (a.count === 0 && b.count === 0) return 0;
    if (a.count === 0) return 1;
    if (b.count === 0) return -1;
    return b.openRate - a.openRate;
  });

  const tableRows = orderedRows
    .map((r) => {
      const isWinner = r.weekday === winnerWk;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ MELHOR DIA</strong>` : "";
      const smallSampleNote = r.smallSample
        ? ` <span style="color:${DS.ink};opacity:0.6;font-size:0.8em;">(amostra pequena)</span>`
        : "";
      const openRateFmt = r.openRate.toFixed(1) + "%";
      return `<tr>
        <td><strong>${escHtml(r.label)}</strong></td>
        <td>${r.count}</td>
        <td>${r.delivered.toLocaleString("pt-BR")}</td>
        <td>${r.opens.toLocaleString("pt-BR")}</td>
        <td class="metric">${openRateFmt}${winnerTag}${smallSampleNote}</td>
      </tr>`;
    })
    .join("\n");

  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre dias com ${maxRate.toFixed(1)}% — aguardar mais dados.`
    : validRows.length < 2
    ? `Dados insuficientes — aguardar mais dias de envio.`
    : winnerWk !== null
    ? `Melhor dia provisório: <strong style="color:${DS.brand}">${WEEKDAY_LABELS[winnerWk]}</strong> — aguardar mais dados para conclusão.`
    : `Dados insuficientes para comparação.`;

  const excludedNote =
    excluded.length > 0
      ? `\n  <p class="section-note"><small>Envios ainda não computados (open rate &lt; ${WEEKDAY_MIN_AGE_HOURS}h, estabilizando): ${excluded.map((e) => escHtml(e.name)).join(", ")}.</small></p>`
      : "";

  return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  <p class="section-note">${statusNote}</p>${excludedNote}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Dia da semana do envio (horário de Brasília)">Dia</th>
        <th title="Número de envios realizados neste dia">Envios</th>
        <th title="Total entregue">Delivered</th>
        <th title="Soma de aberturas únicas (uniqueViews) das campanhas enviadas neste dia.">Opens</th>
        <th title="Open rate agregado: opens ÷ delivered. Dias com < 2 campanhas = amostra pequena.">Open rate agr.</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}


/**
 * Renderiza a seção de resumo A/B/C da S1.
 * Exportado pra teste unitário.
 */
export function renderAbcSection(abcRows: CellSummary[], resetNote = false): string {
  if (abcRows.every((r) => r.campaignCount === 0)) {
    // Sem resetNote (ciclo sem A/B/C planejado, ex: S2/S3 puro): oculta, como
    // sempre. Com resetNote (#2871 — o corte do reset removeu células reais):
    // placeholder explicativo — sumir seria indistinguível de bug de dado.
    if (!resetNote) return "";
    const resetDate = new Date(ABC_RESET_AT).toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    return `
<section class="phase2-section" id="abc-summary">
  <h2 class="section-title">Resumo A/B/C — aguardando novo teste</h2>
  <p class="section-note">Zerado a pedido do editor (#2871): resultados do teste do ciclo 2605 estão documentados — <strong>variante B venceu</strong> (consolidada em d06). Campanhas de teste agendadas a partir de <strong>${resetDate}</strong> repopulam esta tabela automaticamente.</p>
</section>`;
  }

  const sampledRows = abcRows.filter((r) => r.campaignCount > 0);
  const allSampled = sampledRows.length >= 2;

  // Winner: célula com maior open rate entre as que têm dados.
  // Em empate (taxa idêntica), nenhuma célula recebe tag LÍDER — exibir "EMPATE".
  const maxRate = sampledRows.reduce((m, r) => Math.max(m, r.openRate), 0);
  const tiedCount = sampledRows.filter((r) => r.openRate === maxRate).length;
  const isTied = allSampled && tiedCount > 1;
  const winnerCell = !isTied && allSampled
    ? sampledRows.find((r) => r.openRate === maxRate)?.cell ?? null
    : null;

  // #2134 follow-up (editor 2026-06-11): ordenar do melhor open rate pro pior;
  // células sem dados (campaignCount 0) vão pro fim.
  const orderedRows = [...abcRows].sort((a, b) => {
    if (a.campaignCount === 0 && b.campaignCount === 0) return 0;
    if (a.campaignCount === 0) return 1;
    if (b.campaignCount === 0) return -1;
    return b.openRate - a.openRate;
  });

  const cellRows = orderedRows
    .map((r) => {
      const isWinner = r.cell === winnerCell && r.campaignCount > 0;
      const winnerTag = isWinner ? ` <strong style="color:${DS.brand}">▲ LÍDER</strong>` : "";
      // #2257: taxa MPP-inclusiva (primária, bate com a Brevo UI) + orgânica em
      // parênteses quando disponível — mesmo padrão da tabela de campanhas (#1153).
      const organicInline =
        r.campaignCount > 0 && r.organicOpenRate != null
          ? ` <span class="rate-inline">(${r.organicOpenRate.toFixed(1)}% s/ MPP)</span>`
          : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      return `<tr>
        <td><strong>Célula ${r.cell}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${organicInline}${winnerTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  // Quando todas as células amostradas têm openRate 0 (primeiras horas pós-envio,
  // antes de qualquer abertura registrada), evitar "Empate...0.0%" — informação enganosa.
  const allZero = isTied && maxRate === 0;
  const statusNote = allZero
    ? `Aguardando dados de abertura — primeiras horas pós-envio.`
    : isTied
    ? `Empate entre células com ${maxRate.toFixed(1)}% — aguardar mais dias de envio.`
    : allSampled && winnerCell
    ? `Vencedor provisório: <strong style="color:${DS.brand}">Célula ${winnerCell}</strong> — aguardar checkpoint de análise para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  return `
<section class="phase2-section" id="abc-summary">
  <h2 class="section-title">Resumo A/B/C — S1 (d01–d07)</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo) — base do vencedor. Entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os dias da célula têm esse dado.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Célula do teste A/B/C">Célula</th>
        <th title="Soma de entregues dos dias enviados">Delivered (total)</th>
        <th title="Soma de aberturas únicas (com Apple MPP, como na UI da Brevo) dos dias enviados">Opens (total)</th>
        <th title="Open rate agregado com Apple MPP (opens ÷ delivered) — base do vencedor; entre parênteses, a taxa sem MPP quando disponível">Open rate agr.</th>
        <th title="Dias enviados contabilizados">Dias</th>
      </tr>
    </thead>
    <tbody>${cellRows}</tbody>
  </table>
  </div>
</section>`;
}

// ─── #2492: breakdown por dia (D1–D5) ────────────────────────────────────────

/**
 * Resumo de um dia de envio do ciclo Clarice (agrega todas as células A/B/C do dia).
 * Substituição do Resumo A/B/C (por célula) por um breakdown por dia.
 * Exportado pra teste unitário.
 */
