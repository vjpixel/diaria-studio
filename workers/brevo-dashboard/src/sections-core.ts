import type { Env, BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats, BrevoLinksStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementSummary } from "./types.ts";
import { type CouponUsageReport } from "../../../scripts/lib/stripe-coupons.ts";
import { DS, DS_FONTS as DSF, pct, cellClass, isSystemLink, renderLinksSection, aggregateLinksAcrossCampaigns, deriveLinksSectionTitle, renderAggregatedLinksSection, hoursSince, fmtTimeBRT, renderColumnGlossary, brevoReportLink } from "./render-links.ts";
import { shouldShowStalenessNote } from "./staleness.ts";
import {
  renderVolumeSection,
  aggregateByMonth,
  renderMonthlyTotalsSection,
  renderEngagementCohortsSection,
  renderContactsSummarySection,
  renderEiaEngagementSection,
  renderCouponTabPanel,
  renderCohortsTabPanel,
  COHORT_DEVIATION_THRESHOLD_PP,
} from "./sections-kv.ts";
import { billingCycleWindow, isInBillingWindow, type BillingCycleWindow } from "./billing-cycle.ts";
import { renderWeeklyPlanTabPanel, deriveEditionName } from "./weekly-plan.ts";
import { isBounceBreach } from "./thresholds.ts";

/**
 * #3082: rótulo pra 2ª linha (<small>) da célula "Lista" na tabela Envios —
 * identifica qual campanha (edição + célula) corresponde a cada linha. Sem
 * isso, 3 linhas do mesmo dia de teste A/B/C ficam indistinguíveis exceto
 * pelas estatísticas (mesmo ID de lista/nome de lista genérico).
 *
 * Reusa `deriveEditionName` (weekly-plan.ts, já usado na aba Agendamento) pro
 * nome de edição limpo (sem sufixo de célula) e `parseClariceCampaignKey` pro
 * cell isolado — remonta "{edição} — {cell}" (ex: "Clarice News 2606-07 — B")
 * só quando a campanha É de fato uma célula de teste A/B/C. Envio único (sem
 * célula) ou nome que não segue o padrão Clarice News (parsed null) → `null`,
 * sem linha extra — não há célula pra desambiguar, e mostrar o nome de
 * qualquer forma só duplicaria informação já visível (coluna "Enviado").
 */
function deriveCampaignEditionLabel(name: string): string | null {
  const parsed = parseClariceCampaignKey(name);
  if (!parsed || !parsed.cell) return null;
  return `${deriveEditionName(name)} — ${parsed.cell}`;
}

export function renderDashboardHtml(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
  scheduled: Array<BrevoCampaign & { listName?: string; listSize?: number }> = [], // #2251
  cohorts: EngagementCohorts | null = null, // #2426: pré-computado via KV
  mvStatus: MvStatus | null = null, // #2609: status MV por grupo — #2736: param não-usado no corpo (seção removida da UI), mantido pra não quebrar a assinatura posicional nos call sites/testes; ver readKvTabs
  contactsSummary: ContactsSummary | null = null, // #2653: sumário do store
  couponUsage: CouponUsageReport | null = null, // #2718: tab de cupons Stripe (PII-gated)
  eiaEngagement: EiaEngagementSummary | null = null, // #2738: engajamento do poll "É IA?" por edição
  planCredits: number | null = null, // #2910: créditos/limite do plano Brevo (denominador dinâmico da seção Volume) — fetch ao vivo feito no call site (index.ts), nunca aqui (função continua pura/sync)
  // #3079: ISO de quando `campaigns`/`scheduled` foram DE FATO buscados na Brevo
  // (cron tick pré-computado, ou "agora" em fetch ao vivo — `?fresh=1`/cold-start
  // antes do 1º tick). `null` (default) preserva o comportamento pré-#3079 para
  // callers/testes que não passam este argumento — tratado como "agora" (fetch
  // ao vivo), nunca como pré-computado.
  dataGeneratedAt: string | null = null,
  // #3080: limite de campanhas pedido ao Brevo pra montar `campaigns` (ex:
  // CAMPAIGNS_FETCH_LIMIT=150) — usado só pra decidir se a janela está "cheia"
  // (`campaigns.length >= campaignsWindowLimit`), habilitando os avisos de
  // "janela parcial" em "Totais por mês"/"Volume no ciclo" (defesa em
  // profundidade — o limite real pode subir de novo no futuro e cruzar de
  // novo). `null` (default) = desconhecido/não informado → nenhum aviso.
  campaignsWindowLimit: number | null = null,
): string {
  // #3017: ordena a tabela "Envios" por data de envio, mais recente primeiro.
  // sentDate é a fonte canônica aqui (campanha já enviada); scheduledAt só
  // entra como fallback no caso raro de sentDate ausente (nota: ordem de
  // precedência invertida vs groupMonthlyAbcTests, que prioriza scheduledAt —
  // lá o dado é "intenção de envio" cobrindo teste ainda-não-disparado; aqui
  // é a tabela de campanhas já enviadas).
  // #3057: comparação por TIMESTAMP numérico (Date.parse), não por string ISO
  // bruta — sentDate tipicamente vem sem milissegundos ("...T09:00:00Z") mas
  // scheduledAt pode vir com ms e/ou offset explícito ("...T09:00:00.000Z",
  // "...T09:00:00.000-03:00"); comparação lexicográfica de strings com
  // formatos diferentes pode ordenar errado (ex: "." ordena abaixo de dígitos
  // em code-unit compare). Data ausente/não-parseável (NaN) é tratada como a
  // mais antiga possível (-Infinity) — nunca quebra o sort, só afunda pro fim.
  const toSortableTime = (c: Pick<BrevoCampaign, "sentDate" | "scheduledAt">): number => {
    const raw = c.sentDate ?? c.scheduledAt;
    if (!raw) return -Infinity;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  const sortedCampaigns = [...campaigns].sort((a, b) => toSortableTime(b) - toSortableTime(a));
  const rows = sortedCampaigns
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
        // #3082: mesmo rótulo de edição/célula das rows com stats — uma célula
        // A/B/C sem stats ainda pode aparecer na tabela (ex: envio recentíssimo).
        const editionLabelNoStats = deriveCampaignEditionLabel(c.name ?? "");
        return `<tr><td>${brevoReportLink(c.id)}</td><td>${escHtml(c.listName ?? "?")}${editionLabelNoStats ? `<br><small>${escHtml(editionLabelNoStats)}</small>` : ""}</td><td>${fmtTimeBRT(c.sentDate)}</td><td>—</td><td colspan="6" style="color:${DS.ink};opacity:0.6;font-style:italic;">sem stats</td></tr>
      <tr class="links-row"><td colspan="10" class="links-cell">${linksHtmlNoStats}</td></tr>`;
      }
      const openRate = pct(s.uniqueViews, s.delivered);
      // CTOR (click-to-open rate) = cliques únicos ÷ aberturas únicas (não delivered).
      // Mede engajamento com o CONTEÚDO entre quem abriu, isolando assunto/deliverability.
      // Opens MPP-inclusive (uniqueViews) — mesma base do open rate principal (igual Brevo Web UI).
      const ctor = pct(s.uniqueClicks, s.uniqueViews);
      const bounceRate = pct(s.hardBounces + s.softBounces, s.sent);
      // Per circuit breakers doc 2026-05-12: unsub e spam sobre `sent`
      // (não `delivered`). Pequena diferença na prática (sent ≈ delivered +
      // bounces), mas mantém consistência com a doc operacional.
      const unsubRate = pct(s.unsubscriptions, s.sent);
      // #3081: 3 casas (não 1) — o circuit breaker de spam dispara em ≥0.1%;
      // com 1 casa, 0.049% arredondaria pra "0.0%" e mascararia o cruzamento
      // do limiar. Mesma precisão aplicada em "Totais por mês" (sections-kv.ts).
      const spamRate = pct(s.complaints, s.sent, 3);

      // Numeric versions pra comparar contra thresholds dos circuit breakers
      // (CLAUDE.md: doc operacional 2026-05-12). Alerta visual quando crossado.
      const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
      const hardBounceRateNum = s.sent > 0 ? (s.hardBounces / s.sent) * 100 : 0;
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
      // #3078: alerta quando hard bounce SOZINHO já estoura (≥2%) OU quando o
      // total hard+soft estoura (≥5%) — mesma regra "OR" da aba Rampa (thresholds.ts),
      // não mais um único threshold combinado de 3% (que mascarava o caso
      // hard-alto/total-baixo, ex: hard 2.5%/total 2.8%).
      const bounceAlert = isBounceBreach(hardBounceRateNum, bounceRateNum);
      const unsubAlert = unsubRateNum >= 3;
      const spamAlert = spamRateNum >= 0.1;
      const mppOpens = gsIsReal ? (gs?.appleMppOpens ?? 0) : 0;
      const opensNoMpp = s.uniqueViews - mppOpens;
      const openRateNoMpp = pct(opensNoMpp, s.delivered);

      // #2086 B2 / #3040: trackableViewsRate = trackableViews / delivered.
      // Indica emails com rastreamento real (exclui MPP/bots que não carregam pixel).
      // `!= null` (não `??`) porque o campo pode estar AUSENTE no shape real da
      // Brevo (latente em campaignStats) — precisamos distinguir "sem dado" de
      // "0 aberturas trackable reais": #3040 só anexa esse dado ao parêntese de
      // Opens quando ele de fato existe.
      const hasTrackable = s.trackableViews != null;
      const trackableRate = pct(s.trackableViews ?? 0, s.delivered);

      // Opens cell tem layout duplo quando há MPP (#1153): top mostra
      // "taxa-com-MPP (taxa-sem-MPP)" e bottom mostra "count-total (count-sem-MPP)".
      // #3040: coluna Trackable 📍 standalone foi removida — quando há MPP E
      // trackable, o parêntese de Opens ganha um segundo membro ("sem MPP" +
      // "trackable"); quando há MPP mas trackable está ausente, mantém o
      // formato antigo (só "sem MPP").
      // #3056 (regressão do #3040): quando NÃO há MPP mas HÁ trackable, o dado
      // trackable não pode simplesmente desaparecer — antes do #3040 ele tinha
      // sua própria coluna sempre renderizada. Mostramos o trackable sozinho
      // no parêntese (sem o membro "sem MPP", que não existe nesse caso —
      // mppOpens=0 já significa openRate === openRateNoMpp).
      // #3084: o membro "· Z% trackable" vai num <span class="trackable-clause">
      // pra poder ser escondido em mobile (media query acima) sem perder o
      // "X% (Y% sem MPP)" — que sozinho já cabe numa linha.
      const opensTopLine = mppOpens > 0
        ? hasTrackable
          ? `${openRate} <span class="rate-inline">(${openRateNoMpp} sem MPP<span class="trackable-clause"> · ${trackableRate} trackable</span>)</span>`
          : `${openRate} <span class="rate-inline">(${openRateNoMpp})</span>`
        : hasTrackable
          ? `${openRate} <span class="rate-inline">(${trackableRate} trackable)</span>`
          : openRate;
      const opensBottomLine = mppOpens > 0
        ? hasTrackable
          ? `${s.uniqueViews} (${opensNoMpp} · ${s.trackableViews})`
          : `${s.uniqueViews} (${opensNoMpp})`
        : hasTrackable
          ? `${s.uniqueViews} (${s.trackableViews} trackable)`
          : `${s.uniqueViews}`;

      // #1132/dashboard: strip parênteses do nome da lista pra display
      // (Brevo nomes têm "(150 contatos)" hardcoded). O size real vem do
      // `totalSubscribers` da API, mais fiel + atualizado.
      const cleanListName = (c.listName ?? "?").replace(/\s*\([^)]*\)\s*/g, "").trim();
      // #3082: 2ª linha <small> na célula Lista com edição + célula (A/B/C) —
      // desambigua rows do mesmo dia de teste A/B/C, que hoje só diferem pelas
      // métricas. `null` (envio único, sem célula) → sem linha extra.
      const editionLabel = deriveCampaignEditionLabel(c.name ?? "");
      // #2177: links section colapsável por campanha
      const linksHtml = renderLinksSection(
        c.id,
        linksStats,
        s.uniqueClicks,
      );
      return `<tr>
        <td>${brevoReportLink(c.id)}</td>
        <td><strong>${escHtml(cleanListName)}</strong>${editionLabel ? `<br><small>${escHtml(editionLabel)}</small>` : ""}</td>
        <td>${fmtTimeBRT(c.sentDate)}<br><small>${hoursSince(c.sentDate)} atrás</small></td>
        <td>${s.sent}</td>
        <td>${pct(s.delivered, s.sent)}<br><small>${s.delivered}</small></td>
        <td${cellClass("metric", openAlert && "alert")}>${opensTopLine}<br><small>${opensBottomLine}</small></td>
        <td${cellClass("metric")}>${ctor}<br><small>${s.uniqueClicks}</small></td>
        <td${cellClass(bounceAlert && "alert")}>${bounceRate}<br><small>${s.hardBounces + s.softBounces}</small></td>
        <td${cellClass(unsubAlert && "alert")}>${unsubRate}<br><small>${s.unsubscriptions}</small></td>
        <td${cellClass(spamAlert && "alert")}>${spamRate}<br><small>${s.complaints}</small></td>
      </tr>
      <tr class="links-row"><td colspan="10" class="links-cell">${linksHtml}</td></tr>`;
    })
    .join("\n");

  // #3011: `nowDate` é o mesmo instante do cabeçalho ("Dados em tempo real —
  // carregado às ${now} BRT") — passado às seções com dado pré-computado (KV)
  // pra decidir (via shouldShowStalenessNote) se a nota de "atualizado em X"
  // deve aparecer (dado diverge do cabeçalho) ou ficar oculta (dado coincide).
  const nowDate = new Date();
  const now = nowDate.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // #3079: o header antigo ("Dados em tempo real — carregado às {now} BRT")
  // sempre usava `new Date()` — mentiroso para o payload PRÉ-COMPUTADO pelo
  // Cron Trigger (dash:lastgood:campaigns, até ~10min velho). Reusa o mesmo
  // helper de staleness do #3011 (shouldShowStalenessNote) que já decide,
  // pras outras seções KV, se `sectionIso` diverge o bastante de `nowDate`
  // pra merecer nota — aqui a "seção" é o payload de campanhas em si.
  // `dataGeneratedAt == null` (callers/testes pré-#3079) nunca mostra a nota
  // pré-computada — degrada pro texto/formato antigo, idêntico ao pré-#3079.
  const dataIsPrecomputed = dataGeneratedAt != null && shouldShowStalenessNote(dataGeneratedAt, nowDate);
  const dataFreshnessTimeLabel = dataGeneratedAt != null ? fmtTimeBRT(dataGeneratedAt) : now;
  const dataFreshnessLine = dataIsPrecomputed
    ? `Dados pré-computados a cada ~10min (Cron Trigger) — atualizado às ${dataFreshnessTimeLabel} BRT.`
    : `Dados em tempo real — carregado às ${dataFreshnessTimeLabel} BRT.`;

  // #2086 Fase 2: seções adicionais
  // #2910: "Volume enviado no ciclo" usa o ciclo de COBRANÇA Brevo (dia 4,
  // 15:45 BRT — billing-cycle.ts), NÃO o `activeCycle` de naming de campanha
  // (que segue servindo só o Resumo A/B/C logo abaixo — conceitos
  // deliberadamente separados, ver billing-cycle.ts). Soma TODAS as
  // campanhas Clarice (diária + mensal + ABC) com `sentDate` na janela —
  // nunca fica congelado numa rampa antiga sem novo envio.
  const billingWindow = billingCycleWindow();
  const cumSentBilling = calcCumulativeSentInBillingWindow(campaigns, billingWindow);
  // #3080: a janela de campanhas buscadas está "cheia" (potencialmente truncada)
  // quando o número de campanhas retornadas bate o limite pedido — nesse caso não
  // sabemos se há envios mais antigos (fora da janela) que deveriam entrar nas
  // agregações abaixo. `campaignsWindowLimit == null` (desconhecido) nunca aciona
  // o aviso — fail-quiet, não fail-alarming.
  const isCampaignsWindowFull =
    campaignsWindowLimit != null && campaigns.length >= campaignsWindowLimit;
  // Campanha mais antiga (por sentDate) dentro da janela buscada — usada só pro
  // aviso de subcontagem de "Volume no ciclo" abaixo (comparação com o início do
  // ciclo de cobrança, não com nenhum filtro de audiência Clarice).
  const oldestSentMs = campaigns.reduce<number | null>((min, c) => {
    if (!c.sentDate) return min;
    const t = Date.parse(c.sentDate);
    if (!Number.isFinite(t)) return min;
    return min === null || t < min ? t : min;
  }, null);
  // #3080: janela cheia E a campanha mais antiga nela é POSTERIOR ao início do
  // ciclo de cobrança → há um "buraco" entre o início do ciclo e o começo da
  // janela buscada — `cumSentBilling` pode estar subcontando envios do ciclo.
  const volumeMayUndercount =
    isCampaignsWindowFull && oldestSentMs != null && oldestSentMs > billingWindow.start.getTime();
  const volumeSection = renderVolumeSection(cumSentBilling, billingWindow, planCredits, volumeMayUndercount);
  // #3081: nota diagnóstica de campanhas com naming não reconhecido por
  // NENHUM classificador Clarice — sinaliza sem quebrar o render.
  const unclassifiedNote = renderUnclassifiedCampaignsNote(findUnclassifiedCampaignNames(campaigns));
  // `activeCycle` segue servindo só o Resumo A/B/C abaixo (naming de campanha,
  // ex: "2605") — `calcCumulativeSent`/`CLARICE_PLAN_TOTAL` (cycle-naming)
  // pararam de alimentar a seção Volume (agora billing-window-based acima),
  // mas seguem exportados/testados como utilitário independente.
  const activeCycle = detectActiveCycle(campaigns);
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
  // #2889: Resumo A/B/C dos testes MENSAIS — UMA seção por (ciclo + dia de
  // envio), separadas do diário e entre si (dois testes do mesmo ciclo com o
  // mesmo naming, ex: engajado sexta + cold domingo, viram seções distintas
  // pela data). Sem reset placeholder (o #2871 é do diário); sem teste mensal
  // → nada. Mais recente primeiro.
  const monthlyAbcGroups = groupMonthlyAbcTests(campaigns);
  const monthlyAbcSection = monthlyAbcGroups
    .map((g) =>
      renderAbcSection(aggregateAbcSummary(g.campaigns, g.cycle), false, {
        title: `Resumo A/B/C — Mensal (${g.cycle} · ${g.dateLabel})`,
        // id inclui ciclo+data (a chave real do grupo) — só a data poderia
        // colidir se 2 ciclos testassem no mesmo dia (review #2905).
        id: `abc-summary-monthly-${g.cycle}-${g.dateKey}`,
      }),
    )
    .join("\n");
  // #2976: Resumo A/B/C por AUDIÊNCIA (Agregada/Fria/Quente) — aditivo, um bloco
  // por ciclo mensal distinto (agrupa TODAS as datas de teste do ciclo, ao
  // contrário de `monthlyAbcSection` acima que separa por data). Vem ANTES do
  // detalhe cronológico por data — é a leitura primária pra decidir o teste.
  const monthlyAbcCycles = [...new Set(monthlyAbcGroups.map((g) => g.cycle))];
  const abcAudienceSection = monthlyAbcCycles
    .map((cycle) => renderAbcAudienceSection(cycle, aggregateAbcByAudience(campaigns, cycle)))
    .join("\n");
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
  // #3081: campaignCount = tamanho da janela agregada (campaigns.length) — o
  // título reflete a janela real, não implica que os dados são de 1 edição só.
  const aggregatedLinksSection = renderAggregatedLinksSection(aggregatedLinks, edicaoLabel, campaigns.length);
  // #2251/#3010: seção de campanhas agendadas (status queued) — só sobre
  // `scheduled`, nunca polui os agregadores de enviadas (A/B/C, volume,
  // weekday). Movida pra aba Agendamento (renderWeeklyPlanTabPanel abaixo) —
  // não é mais injetada no panel-visaogeral aqui (#3010).
  // #2369: tabela de totais por mês — à parte da lista detalhada de campanhas.
  const monthlyTotalsRows = aggregateByMonth(campaigns);
  // #3080: só passa o limite (habilitando o aviso "(parcial — janela de N campanhas)"
  // no mês mais antigo) quando a janela buscada estava de fato cheia.
  const monthlyTotalsSection = renderMonthlyTotalsSection(
    monthlyTotalsRows,
    isCampaignsWindowFull ? campaignsWindowLimit : null,
  );
  // #2426: coortes de engajamento por contato (pré-computadas via KV, lidas na rota).
  const cohortsSection = renderEngagementCohortsSection(cohorts, nowDate);
  // #2736: "Status MillionVerifier por grupo" removida da aba Engajamento
  // (ruído, decisão do editor). renderMvStatusSection permanece exportada e
  // testada (reuso futuro); a leitura do KV mv:status em readKvTabs também
  // fica (custo desprezível, já paralela às outras — reverter é maior cirurgia
  // do que o pedido pede; ver corpo do PR).
  // #2653: sumário do store único de contatos (pré-computado via KV).
  const contactsSummarySection = renderContactsSummarySection(contactsSummary, nowDate);
  // #2864: aba Cohorts — comparativo de envio/engajamento por cohort. Deriva
  // de contactsSummary (mesmo payload KV de Contatos, campo cohort_stats
  // opcional) — sem parâmetro novo na assinatura desta função.
  // #2909: passa cycle_start (top-level do summary) pra tabela decidir entre
  // exibir "recebeu neste ciclo"/"falta enviar" (número) ou "—" (sem ciclo).
  const cohortsTabSection = renderCohortsTabPanel(
    contactsSummary?.cohort_stats,
    contactsSummary?.cycle_start ?? null,
  );
  // #2738: engajamento do poll "É IA?" por edição (pré-computado via KV).
  const eiaEngagementSection = renderEiaEngagementSection(eiaEngagement, nowDate);
  // #2718: tab de cupons Stripe (apenas quando couponUsage não é null — PII-gated).
  const couponTabHtml = couponUsage ? renderCouponTabPanel(couponUsage, nowDate) : "";
  // #2974: aba "Rampa"/Agendamento — plano de envio semanal (maturação >48h →
  // agregado → semáforo → 3 volumes) + #3010: campanhas agendadas (`scheduled`)
  // logo abaixo da recomendação dos próximos 3 envios.
  const weeklyPlanSection = renderWeeklyPlanTabPanel(campaigns, nowDate, scheduled);

  // #2991: paleta visual da dashboard usa os tokens CANÔNICOS do DS (decisão
  // do editor — dashboard não tem paleta própria, segue design-tokens.ts como
  // qualquer outra superfície). --card usa DS.paperEmail (branco puro, já
  // canônico pra "card sobre fundo cream" — mesmo par usado nos e-mails).
  // Sem --ink-soft: o DS não tem tier de cinza (consolidado em ink único);
  // texto secundário usa opacity sobre --ink (ver .sub abaixo).
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
    --card: ${DS.paperEmail};
    --rule: ${DS.rule};
    --hair: ${DS.rule};
    --alert: ${DS.alert};
  }
  body { font-family: ${DSF.sans}; max-width: 1200px; margin: 30px auto; padding: 0 20px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; color: var(--ink); }
  /* #3089: opacity 0.6 mede ~4.7-4.8:1 sobre --paper/--card (passa AA, mas sem
     folga — cai a ~4.4:1 sobre --paper-alt). 0.65 dá margem (~5.6-5.7:1). */
  .sub { color: var(--ink); opacity: 0.65; font-size: 0.9rem; margin: 0 0 24px 0; }
  /* #2991: "cards" — table-wrap já envolve toda tabela/lista de cada seção em
     todas as abas (estrutura preexistente, ver #2086) — vira o container de
     card sem mexer em markup/dados. */
  .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--hair); border-radius: 8px; padding: 4px; }
  table { background: var(--card); }
  td.metric, td.spark, .spark-bar, td .rate-inline, .volume-note strong, td strong {
    font-family: ui-monospace, 'Geist Mono', 'JetBrains Mono', monospace;
    font-variant-numeric: tabular-nums;
  }
  /* #2908: duas tabelas estreitas (Inelegíveis por razão + MillionVerifier bucket)
     lado a lado num flex — economiza a metade direita da tela. Quebra pra
     empilhado em telas estreitas (flex-wrap). min-width:0 deixa o filho encolher
     (senão o conteúdo trava a largura e o wrap não dispara). */
  .side-by-side { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
  .side-by-side > * { flex: 1 1 240px; min-width: 0; }
  /* #2908: <details> dos cohorts nunca-enviados — recolhido abaixo das ativas. */
  details.never-sent { margin-top: 12px; }
  details.never-sent > summary { cursor: pointer; font-size: 0.85rem; color: var(--ink); opacity: 0.75; padding: 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; z-index: 2; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  /* #3085: 1ª coluna (rótulo da linha) fica sticky ao rolar horizontalmente
     tabelas largas (Envios, Totais por mês, Cohorts) dentro de .table-wrap —
     mesmo mecanismo do sticky de header (eixo Y) acima. z-index em camadas
     pra o canto superior-esquerdo (th:first-child, sticky NOS DOIS eixos ao
     mesmo tempo — herda top:0 do seletor th genérico acima e ganha left:0
     aqui) ficar por cima tanto das linhas do corpo quanto do restante do
     header ao rolar nas duas direções simultaneamente. */
  .table-wrap td:first-child { position: sticky; left: 0; z-index: 1; background: var(--card); }
  .table-wrap th:first-child { position: sticky; left: 0; z-index: 3; background: var(--paper-alt); }
  /* #2104: borda do th era --rule (#EBE5D0) sobre fundo --paper-alt (#EBE5D0) → invisível.
     Substituída por ink (#171411) com 18% opacity — visível no DS claro sem ser pesada. */
  /* #3088: valores numéricos de destaque (td.metric) voltam a --ink — teal
     (--brand, #00A0A0) mede ~3.2:1 sobre --card, abaixo do mínimo AA (4.5:1)
     pra texto normal nesse tamanho (14.4px/600, não é "large text"). O
     negrito + mono/tabular-nums (ver regra acima) já diferencia visualmente
     do texto comum sem depender de cor. Teal fica reservado a elementos
     GRÁFICOS (links, barra de progresso, estado ativo de abas — 3:1 é
     aceitável pra esses por SC 1.4.11, não pra texto). */
  td.metric { font-weight: 600; color: var(--ink); }
  td.alert { font-weight: 600; color: var(--alert); }
  td.alert small, td.alert .rate-inline { color: var(--alert); opacity: 1; }
  .alert-label { font-weight: 600; color: var(--alert); }
  /* #2880: linha Total das tabelas do store — destacada, borda superior. */
  tr.total-row td { font-weight: 700; border-top: 2px solid var(--rule); }
  /* #3084: célula Opens quebrava em até 4 linhas em mobile (ex: "27.4%
     (20.6% sem MPP · 17.1% trackable)") esticando as linhas da tabela Envios.
     nowrap mantém o parêntese inteiro numa linha; em telas estreitas o
     .trackable-clause (membro "· Z% trackable") é escondido — ver media query
     abaixo — deixando só "X% (Y% sem MPP)". */
  td .rate-inline { font-weight: normal; color: var(--ink); white-space: nowrap; }
  /* #3089: mesmo ajuste de folga de contraste do .sub acima (0.6 → 0.65). */
  td small { color: var(--ink); opacity: 0.65; font-weight: normal; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 24px; text-align: center; }
  .footer code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.95em; }
  /* #2086: seções de fase 2 */
  .phase2-section { margin: 32px 0 8px 0; }
  /* #3092: separação visual mais forte entre seções CONSECUTIVAS da mesma aba
     (ex: aba Engajamento — S1 diário, Agregada/Fria/Quente, Mensal — 5 tabelas
     seguidas sem nenhuma quebra visual além da margem padrão). Só entre
     IRMÃS consecutivas (adjacent sibling) — a 1ª seção de cada aba, logo após
     a tab-bar, não ganha a régua extra (não há "seção anterior" ali pra
     separar). */
  .phase2-section + .phase2-section { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--rule); }
  .section-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px 0; color: var(--ink); border-bottom: 2px solid var(--rule); padding-bottom: 6px; }
  .section-note { font-size: 0.85rem; color: var(--ink); opacity: 0.75; margin: 0 0 12px 0; }
  /* #3092: rebaixa os h4 internos (Agregada/Fria/Quente dentro de "Resumo
     A/B/C por Audiência") pra ficarem visualmente subordinados ao h2 da
     seção — tratamento tipo <th> (uppercase, opacity, letter-spacing), sem
     introduzir cor nova. Antes era só um style inline de margin, do mesmo
     tamanho/peso do texto normal — nada sinalizava que eram 3 subdivisões
     de UMA tabela-mãe, não 3 seções novas. */
  .subsection-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); opacity: 0.75; margin: 20px 0 6px 0; }
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
  /* #3089: mesmo fix de contraste do .links-note (0.5 → 0.7 opacity, ~3.5:1 → ~5.6+:1). */
  .links-empty { padding: 4px 12px 6px; font-size: 0.8rem; color: var(--ink); opacity: 0.7; margin: 0; }
  .links-table-wrap { overflow-x: auto; padding: 0 8px 8px; }
  .links-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .links-table th, .links-table td { padding: 4px 6px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  .links-table th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.4px; background: transparent; color: var(--ink); opacity: 0.7; }
  .links-table td.link-url { max-width: 420px; word-break: break-all; }
  .links-table td.link-url a { color: var(--brand); text-decoration: none; }
  .links-table td.link-url a:hover { text-decoration: underline; }
  /* #3088: contagens de link (13px/600) — mesmo motivo do td.metric acima. */
  .links-table td.link-clicks { font-weight: 600; color: var(--ink); }
  .links-table td.link-pct { opacity: 0.75; }
  /* #3089: opacity 0.5 a 11.5px media ~3.5:1 (abaixo de AA 4.5:1). 0.7 sobe pra
     ~5.6-6.8:1 (WCAG relative luminance, ink #171411 sobre --paper/--card/--paper-alt). */
  .links-note { font-size: 0.72rem; color: var(--ink); opacity: 0.7; padding: 2px 12px 6px; margin: 0; }
  /* #3090: "Glossário das colunas" — reusa .links-ctr/.links-summary (mesmo
     colapsável dos outros usos), conteúdo em <dl> (termo/definição). */
  dl.glossary-list { margin: 0; padding: 0 12px 10px; font-size: 0.82rem; }
  dl.glossary-list dt { font-weight: 700; color: var(--ink); margin-top: 8px; }
  dl.glossary-list dt:first-child { margin-top: 0; }
  dl.glossary-list dd { margin: 2px 0 0; color: var(--ink); opacity: 0.85; }
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
  /* #3083: em mobile (~400-560px) os labels quebravam em 2 linhas dentro do
     flex ("Cupons" cortado) e o overflow do tab-bar esticava o body inteiro
     (scroll horizontal indesejado da página). Fix: o tab-bar vira sua PRÓPRIA
     área de scroll horizontal (overflow-x auto + flex-wrap nowrap), scrollbar
     escondida (scrollbar-width none — Firefox; -ms-overflow-style idem —
     Edge legado) já que o fade nas bordas já sinaliza "tem mais abas". Labels
     ganham white-space:nowrap (nunca quebram) + flex-shrink:0 (nunca encolhem
     a ponto de cortar texto). */
  .tab-bar {
    display: flex; gap: 4px; margin: 16px 0 0 0; border-bottom: 2px solid var(--rule); padding-bottom: 0;
    overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; -ms-overflow-style: none;
    position: relative;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-label {
    display: inline-block; padding: 8px 18px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; border-bottom: 2px solid transparent;
    border-radius: 4px 4px 0 0; color: var(--ink); opacity: 0.65;
    margin-bottom: -2px; user-select: none;
    transition: opacity 0.1s;
    white-space: nowrap; flex-shrink: 0;
  }
  .tab-label:hover { opacity: 1; background: var(--paper-alt); }
  #tab-visaogeral:checked ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:checked ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:checked ~ .tab-bar label[for="tab-links"],
  #tab-contatos:checked ~ .tab-bar label[for="tab-contatos"],
  #tab-rampa:checked ~ .tab-bar label[for="tab-rampa"],
  #tab-cupons:checked ~ .tab-bar label[for="tab-cupons"] {
    background: var(--paper); border-color: var(--rule); opacity: 1;
    color: var(--brand); border-bottom-color: var(--paper);
  }
  /* Foco de teclado: o radio focado projeta um contorno no seu label irmão. */
  #tab-visaogeral:focus-visible ~ .tab-bar label[for="tab-visaogeral"],
  #tab-engajamento:focus-visible ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:focus-visible ~ .tab-bar label[for="tab-links"],
  #tab-contatos:focus-visible ~ .tab-bar label[for="tab-contatos"],
  #tab-rampa:focus-visible ~ .tab-bar label[for="tab-rampa"],
  #tab-cupons:focus-visible ~ .tab-bar label[for="tab-cupons"] {
    outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1;
  }
  .tab-panel { display: none; padding-top: 8px; }
  #tab-visaogeral:checked ~ .tab-panels #panel-visaogeral,
  #tab-engajamento:checked ~ .tab-panels #panel-engajamento,
  #tab-links:checked ~ .tab-panels #panel-links,
  #tab-contatos:checked ~ .tab-panels #panel-contatos,
  #tab-rampa:checked ~ .tab-panels #panel-rampa,
  #tab-cupons:checked ~ .tab-panels #panel-cupons { display: block; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
    .tab-label { padding: 6px 10px; font-size: 0.8rem; }
    /* #3084: esconde o membro "· Z% trackable" da célula Opens em mobile —
       deixa só "X% (Y% sem MPP)" pra caber numa linha. */
    .trackable-clause { display: none; }
  }
</style>
</head>
<body>
<h1>📧 Clarice News Dashboard</h1>
<p class="sub">Últimas ${campaigns.length} campaigns. ${dataFreshnessLine}</p>

<!-- #2542: tab state inputs (hidden, CSS-only — sem JS externo) -->
<input type="radio" class="tab-radios" name="dash-tab" id="tab-visaogeral" checked>
<input type="radio" class="tab-radios" name="dash-tab" id="tab-rampa">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-engajamento">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-links">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-contatos">
${couponUsage ? '<input type="radio" class="tab-radios" name="dash-tab" id="tab-cupons">' : ''}

<!-- tab bar (labels referencing the radio inputs above; aria-controls liga aba↔painel) -->
<div class="tab-bar" role="tablist">
  <label class="tab-label" id="tablabel-visaogeral" for="tab-visaogeral" role="tab" aria-controls="panel-visaogeral">Visão geral</label>
  <label class="tab-label" id="tablabel-rampa" for="tab-rampa" role="tab" aria-controls="panel-rampa">Agendamento</label>
  <label class="tab-label" id="tablabel-engajamento" for="tab-engajamento" role="tab" aria-controls="panel-engajamento">Engajamento</label>
  <label class="tab-label" id="tablabel-links" for="tab-links" role="tab" aria-controls="panel-links">Links / Cliques</label>
  <label class="tab-label" id="tablabel-contatos" for="tab-contatos" role="tab" aria-controls="panel-contatos">Contatos</label>
  ${couponUsage ? '<label class="tab-label" id="tablabel-cupons" for="tab-cupons" role="tab" aria-controls="panel-cupons">Cupons</label>' : ''}
</div>

<!-- tab panels -->
<div class="tab-panels">

  <!-- Aba 1: Visão geral — totais mensais + volume + envios (#3010: agendados moveu pra aba Agendamento) -->
  <div class="tab-panel" id="panel-visaogeral" role="tabpanel" aria-labelledby="tablabel-visaogeral">
${monthlyTotalsSection}
${volumeSection}
${unclassifiedNote}
<section class="phase2-section" id="campaigns-table">
  <h2 class="section-title">Envios</h2>
${renderColumnGlossary("envios", ENVIOS_COLUMNS)}
<div class="table-wrap">
<table id="envios-table">
<thead>
<tr>
${ENVIOS_COLUMNS.map((c) => `<th scope="col" title="${escHtml(c.tooltip)}">${c.label}</th>`).join("\n")}
</tr>
</thead>
<tbody id="envios-tbody">
${rows || `<tr><td colspan="10" style="text-align:center;color:${DS.ink};opacity:0.6;padding:24px;">Nenhuma campaign encontrada.</td></tr>`}
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

  <!-- Aba Agendamento: plano de envio semanal cold (#2974) -->
  <div class="tab-panel" id="panel-rampa" role="tabpanel" aria-labelledby="tablabel-rampa">
${weeklyPlanSection}
  </div><!-- /panel-rampa -->

  <!-- Aba 2: Engajamento — weekday + resumo A/B/C + coortes + É IA? (#2773) -->
  <div class="tab-panel" id="panel-engajamento" role="tabpanel" aria-labelledby="tablabel-engajamento">
${weekdaySection}
${abcSection}
${abcAudienceSection}
${monthlyAbcSection}
${cohortsSection}
${eiaEngagementSection}
  </div><!-- /panel-engajamento -->

  <!-- Aba 3: Links / Cliques — distribuição de cliques por link no período (não é taxa; Brevo v3 não dá opens/unique-clicks por link) -->
  <div class="tab-panel" id="panel-links" role="tabpanel" aria-labelledby="tablabel-links">
${aggregatedLinksSection}
  </div><!-- /panel-links -->

  <!-- Aba 4: Contatos — sumário do store único (#2653) -->
  <div class="tab-panel" id="panel-contatos" role="tabpanel" aria-labelledby="tablabel-contatos">
${contactsSummarySection}
${cohortsTabSection}
  </div><!-- /panel-contatos -->

${couponUsage ? `  <!-- Aba 5: Cupons — uso de cupons Stripe (#2718, PII-gated) -->
  <div class="tab-panel" id="panel-cupons" role="tabpanel" aria-labelledby="tablabel-cupons">
${couponTabHtml}
  </div><!-- /panel-cupons -->` : ''}

</div><!-- /tab-panels -->

<p class="footer">Dados com cache de até 5 min — <a href="?fresh=1" style="color:var(--brand)">?fresh=1</a> força atualização imediata.<br>
Open rate calculado sobre <em>delivered</em>; CTOR = cliques únicos ÷ <em>aberturas</em> (opens); bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses (quando há dado de MPP), a taxa sem Apple MPP (ainda pode incluir outros bots) e, quando disponível, a taxa trackable — aberturas com pixel real (trackableViews ÷ delivered), sinal mais limpo de engajamento real por excluir MPP e outros bots que não disparam pixel. Dados brutos em <code>/api/campaigns</code>.<br>
Cells em <span class="alert-label">vermelho</span> indicam que a métrica cruzou o threshold de circuit breaker (open <15%, bounce hard ≥2% ou total ≥5%, unsub ≥3%, spam ≥0.1%). <strong>Vermelho sempre significa "ruim"</strong> em toda a página — inclusive na aba Contatos, tabela Cohorts, onde o critério é desvio desfavorável de mais de ${COHORT_DEVIATION_THRESHOLD_PP}pp da média da coluna em vez de circuit breaker (#3091; ver nota da própria tabela).</p>
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
 * Volume do bloco S1 (d01–d07 A/B/C) do ciclo 2605-06 conforme
 * clarice-build-edition-sends.ts — usado só como referência histórica da
 * rampa de migração (aggregateAbcSummary/A-B-C section). Exportado pra teste
 * unitário.
 *
 * `CLARICE_PLAN_TOTAL` (40.000 hardcoded, era o denominador fixo da seção
 * "Volume enviado no ciclo") foi REMOVIDO em #2910 — a seção agora usa o
 * ciclo de COBRANÇA Brevo com denominador dinâmico (`planCredits`, ver
 * `renderVolumeSection`/`billing-cycle.ts`), nunca mais um total fixo da
 * migração de junho.
 */
export const CLARICE_PLAN_S1 = 5_600;

/**
 * Tooltip compartilhado para a coluna "Envios (eventos)" — usado na tabela
 * por-campanha, na tabela mensal e na seção Volume. DRY: alterar aqui propaga
 * para todos os pontos de uso. (#2429 self-review)
 */
export const ENVIOS_TOOLTIP =
  "Eventos de envio acumulados; uma pessoa em N campanhas conta N vezes; inclui bounces.";

/**
 * #3090: definição CANÔNICA das colunas da tabela "Envios" (label + tooltip) —
 * fonte única usada tanto no `title=` de cada `<th>` (hover, desktop) QUANTO no
 * `<details>` "Glossário das colunas" (sempre visível, funciona em touch/mobile
 * — o fluxo real do editor é celular). Antes a semântica das métricas vivia
 * só no `title=`, inacessível sem hover. Exportado pra teste unitário.
 */
export const ENVIOS_COLUMNS: Array<{ label: string; tooltip: string }> = [
  // #3081: tooltip atualizado — ID agora é link (brevoReportLink) pro
  // relatório da campanha na UI da Brevo, não mais texto puro.
  { label: "ID", tooltip: "ID do envio no Brevo — link direto pro relatório da campanha na UI da Brevo." },
  { label: "Lista", tooltip: "Lista de destinatários no Brevo." },
  { label: "Enviado", tooltip: "Data e hora do envio (horário de Brasília)." },
  { label: "E-mails (eventos)", tooltip: ENVIOS_TOOLTIP },
  { label: "Delivered", tooltip: "Emails entregues nas caixas dos leitores." },
  {
    label: "Opens 👁️",
    tooltip:
      "Aberturas únicas. Inclui Apple MPP e bots/proxies. Bench: 15-25% B2C, 30-45% engajadas. Entre parênteses (quando há dado de MPP): taxa sem Apple MPP e, quando disponível, taxa trackable — trackableViews ÷ delivered, aperturas com pixel rastreável que exclui MPP/bots que não disparam pixel (sinal mais limpo de engajamento real).",
  },
  {
    label: "CTOR 🖱️",
    tooltip:
      "CTOR (click-to-open rate) = cliques únicos ÷ aberturas únicas. Engajamento com o conteúdo entre quem abriu. Taxa em cima, count de cliques embaixo. Bench: ~10-15% típico (denominador é opens, não delivered).",
  },
  {
    label: "Bounces",
    tooltip:
      "Hard bounces (inválido) + soft bounces (caixa cheia). Bench: <2% saudável. Pausa o ramp quando hard ≥2% OU total ≥5%.",
  },
  { label: "Unsub", tooltip: "Descadastros. Esperado em baixo volume. Bench: <0.5%. ≥3% pausa o ramp." },
  { label: "Spam", tooltip: "Marcações de spam. Prejudica reputação do domínio. Bench: <0.1%. ≥0.1% pausa o ramp." },
];

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
  monthly: boolean;
} | null {
  const m = campaignName.match(/Clarice News (\d{4}) d(\d{2})(?:-([ABC]))?(?=\s|$)/i);
  if (m) {
    const cell = m[3] ? (m[3].toUpperCase() as "A" | "B" | "C") : null;
    return { cycle: m[1], dayNum: parseInt(m[2], 10), cell, monthly: false };
  }
  // #2889: naming do digest MENSAL — "Clarice News AAMM-MM — X: subject" (ciclo
  // conteúdo-envio, célula A/B/C, sem dayNum). O teste ABC mensal é 1 campanha
  // por célula (não S1/dias), então não tem dNN. `monthly: true` faz
  // aggregateAbcSummary pular o corte de dia e detectActiveCycle ignorar (o
  // diário e o mensal são testes distintos, cada um com seu Resumo A/B/C).
  const mm = campaignName.match(/Clarice News (\d{4}-\d{2})\s*[—–-]\s*([ABC])\b/i);
  if (mm) {
    return { cycle: mm[1], dayNum: 0, cell: mm[2].toUpperCase() as "A" | "B" | "C", monthly: true };
  }
  return null;
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
 *
 * #3081 (review): `parseClariceCampaignKey` é tentado primeiro — preserva
 * 100% do comportamento anterior pro caso warm (diário E mensal, idêntico ao
 * código antigo). SÓ quando ele não reconhece o nome, cai pro fallback
 * `parseAbcAudienceCampaign` restrito a `audience === "cold"` — cobre o teste
 * mensal COLD (naming "cold AAMM-MM — X"), tratado como `monthly:true` (sem
 * corte de dia, mesmo tratamento que o mensal warm já recebia). Sem este
 * fallback, `groupMonthlyAbcTests` (que já reconhece cold) formava o grupo
 * mas esta função zerava todas as células dele — a seção "Resumo A/B/C —
 * Mensal" de um ciclo só-cold renderizava vazia (`renderAbcSection` retorna
 * "" quando `every(r => r.campaignCount === 0)`), o mesmo sintoma que o fix
 * do `groupMonthlyAbcTests` deveria ter resolvido (achado no self-review).
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
    const warm = parseClariceCampaignKey(c.name);
    const cold = warm ? null : parseAbcAudienceCampaign(c.name);
    const parsed =
      warm ??
      (cold && cold.audience === "cold"
        ? { cycle: cold.cycle, dayNum: 0, cell: cold.cell as "A" | "B" | "C" | null, monthly: true }
        : null);
    if (!parsed || parsed.cycle !== cycle) continue;
    // #2360: cell=null = envio único (sem sufixo A/B/C) — não participa do A/B/C.
    if (parsed.cell === null) continue;
    // S1 = d01–d07 (só no diário; o mensal é 1 campanha por célula, sem dias — #2889).
    if (!parsed.monthly && parsed.dayNum > 7) continue;

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
 * #2910: volume enviado cumulativo dentro da JANELA do ciclo de COBRANÇA
 * Brevo (`billingCycleWindow`) — soma "sent" de TODAS as campanhas Clarice
 * (diária + mensal + ABC + cold, `classifyClariceAudience` não-null) cujo
 * `sentDate` cai na janela. Filtra por DATA de envio, não por naming de
 * ciclo — diferente de `calcCumulativeSent` (que soma por `cycle` de
 * naming, ex: "2605", usado só pelo Resumo A/B/C). Sem isso, o envio de um
 * mês sem novo naming de ciclo diário (ex: digest mensal/ABC) ficava fora
 * da contagem e a seção Volume travava na última rampa.
 *
 * #3076: `classifyClariceAudience` (não `parseClariceCampaignKey`) é o
 * classificador certo aqui — este Brevo account só serve Clarice News
 * (premissa documentada em `weekly-plan.ts`), então toda campanha `sent`
 * é candidata, e isso inclui o naming `cold AAMM-MM — X` (oficial desde
 * #2976, com envios reais). `parseClariceCampaignKey` só reconhece o
 * naming "Clarice News ..." e por isso subcontava os cold, o que também
 * distorcia o denominador `planTotal` (planCredits + cumulativeSent, ver
 * `sections-kv.ts`) e divergia de `aggregateByMonth` (que soma sem filtro
 * de naming, só por `sentDate` — mesmo dado, duas histórias diferentes).
 * Exportado pra teste unitário.
 */
export function calcCumulativeSentInBillingWindow(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  window: BillingCycleWindow,
): number {
  let total = 0;
  for (const c of campaigns) {
    if (!classifyClariceAudience(c.name)) continue; // só campanhas Clarice (warm ou cold)
    if (!isInBillingWindow(c.sentDate, window)) continue;
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
    if (!parsed || parsed.monthly) continue; // #2889: só ciclos DIÁRIOS
    if (!latest || parsed.cycle > latest) latest = parsed.cycle;
  }
  return latest;
}

/**
 * #2889: agrupa as campanhas de teste ABC MENSAL em TESTES distintos, por
 * (ciclo + DATA de envio BRT). Dois testes do MESMO ciclo com o MESMO naming
 * (ex: engajado na sexta + cold no domingo — mesmos 3 subjects) são separados
 * pela data de envio, pra nunca misturar públicos diferentes numa comparação
 * única. Cada grupo vira uma seção A/B/C própria; ordenados do mais recente
 * pro mais antigo. Exportado pra teste unitário.
 *
 * #3081: deriva de `parseAbcAudienceCampaign` (não `parseClariceCampaignKey`)
 * — o parser antigo só reconhece o naming warm "Clarice News AAMM-MM — X",
 * então um ciclo SÓ-COLD (naming "cold AAMM-MM — X") nunca gerava grupo aqui,
 * mesmo a seção "Resumo A/B/C por Audiência" logo abaixo já suportando cold.
 * `parseAbcAudienceCampaign` cobre warm E cold; o filtro `/^\d{4}-\d{2}$/`
 * no `cycle` mantém só ciclos MENSAIS (formato "AAMM-MM", com hífen) — testes
 * A/B/C DIÁRIOS ("Clarice News AAMM dNN-X", cycle sem hífen) continuam fora
 * (cobertos por `aggregateAbcSummary`/`abcSection` acima, não aqui).
 */
export function groupMonthlyAbcTests(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
): Array<{
  cycle: string;
  dateKey: string; // YYYY-MM-DD (BRT) — chave de ordenação
  dateLabel: string; // DD/MM/YYYY
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>;
}> {
  const groups = new Map<
    string,
    { cycle: string; dateKey: string; campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }> }
  >();
  for (const c of campaigns) {
    const parsed = parseAbcAudienceCampaign(c.name);
    if (!parsed || !/^\d{4}-\d{2}$/.test(parsed.cycle)) continue;
    // Data do envio: scheduledAt (intenção) com fallback sentDate. As 3
    // campanhas de um teste são disparadas JUNTAS no mesmo horário (Clarice
    // News sai ~06:00 BRT, nunca perto da meia-noite), então mesmo que uma
    // caia no fallback sentDate elas compartilham a mesma data BRT — não há
    // split do teste pela fronteira de dia (review #2905).
    const when = c.scheduledAt ?? c.sentDate;
    if (!when) continue;
    const ms = Date.parse(when);
    if (!Number.isFinite(ms)) continue;
    // data no fuso BRT (en-CA → YYYY-MM-DD)
    const dateKey = new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const key = `${parsed.cycle}|${dateKey}`;
    if (!groups.has(key)) groups.set(key, { cycle: parsed.cycle, dateKey, campaigns: [] });
    groups.get(key)!.campaigns.push(c);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, dateLabel: g.dateKey.split("-").reverse().join("/") }))
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0));
}

/**
 * #3081: nomes de campanha que NÃO batem com nenhum naming Clarice conhecido
 * — nem warm (`Clarice News ...`, com ou sem célula) nem cold (`cold ...`,
 * com ou sem célula). Uma campanha nesta lista não é reconhecida por
 * NENHUMA agregação do dashboard — a nota diagnóstica na Visão Geral
 * sinaliza isso em vez de deixar a lacuna passar silenciosamente. Exportado
 * pra teste unitário.
 *
 * #3081 (review): usa `classifyClariceAudience` (não `parseAbcAudienceCampaign`
 * diretamente) — este último exige célula A/B/C explícita pra reconhecer
 * cold, então um envio cold LEGÍTIMO sem célula (ex: envio único pós-teste,
 * mesmo padrão que envios warm sem célula já recebem) caía aqui como falso
 * positivo. `classifyClariceAudience` é estritamente mais permissivo (aceita
 * qualquer prefixo `cold` OU naming `parseClariceCampaignKey`), sem perder
 * nenhum caso que `parseAbcAudienceCampaign` reconheceria.
 */
export function findUnclassifiedCampaignNames(
  campaigns: Array<Pick<BrevoCampaign, "name">>,
): string[] {
  const names: string[] = [];
  for (const c of campaigns) {
    if (classifyClariceAudience(c.name)) continue;
    names.push(c.name);
  }
  return names;
}

/**
 * Renderiza a nota diagnóstica de campanhas não classificadas (vazia quando
 * a lista está vazia — nenhuma seção extra quando tudo está OK). Exportado
 * pra teste unitário.
 */
export function renderUnclassifiedCampaignsNote(names: string[]): string {
  if (names.length === 0) return "";
  const plural = names.length === 1 ? "" : "s";
  return `<p class="section-note"><small>⚠️ ${names.length} campanha${plural} não classificada${plural} (naming fora do padrão Clarice News/cold): ${names.map((n) => escHtml(n)).join(", ")}.</small></p>`;
}

// ─── #2976: Resumo A/B/C por AUDIÊNCIA (Agregada / Fria / Quente) ────────────

export type ClariceAudience = "cold" | "warm";

/**
 * Classifica o naming de uma campanha Clarice em fria (cold, nunca recebeu a
 * newsletter) ou quente (já engajada) — sinal usado pra separar o Resumo A/B/C
 * em 3 tabelas (#2976). Convenção de naming do editor: campanhas frias começam
 * com "cold " (ex: "cold 2606-07 — A: subject"); campanhas quentes seguem o
 * padrão "Clarice News ..." já reconhecido por `parseClariceCampaignKey`.
 * Retorna `null` quando o naming não bate com nenhum dos dois padrões.
 */
export function classifyClariceAudience(campaignName: string): ClariceAudience | null {
  if (/^cold\b/i.test(campaignName.trim())) return "cold";
  if (parseClariceCampaignKey(campaignName)) return "warm";
  return null;
}

/**
 * Parseia uma campanha de teste A/B/C (fria OU quente) do naming pra extrair
 * ciclo + célula, independente de audiência. Reusa `parseClariceCampaignKey`
 * pro caso quente (mensal, "Clarice News AAMM-MM — X"); implementa um parser
 * paralelo pro caso frio ("cold AAMM-MM — X" ou "cold AAMM-MM X"). Só campanhas
 * com célula A/B/C explícita participam do Resumo por Audiência — envios
 * únicos (sem A/B/C) são ignorados aqui (mesma convenção do #2360).
 * Exportado pra teste unitário.
 */
export function parseAbcAudienceCampaign(
  campaignName: string,
): { cycle: string; cell: "A" | "B" | "C"; audience: ClariceAudience } | null {
  const warm = parseClariceCampaignKey(campaignName);
  if (warm && warm.cell) {
    return { cycle: warm.cycle, cell: warm.cell, audience: "warm" };
  }
  const cold = campaignName.match(/^cold\s+(\d{4}-\d{2})(?:\s*[—–-]\s*|\s+)([ABC])\b/i);
  if (cold) {
    return { cycle: cold[1], cell: cold[2].toUpperCase() as "A" | "B" | "C", audience: "cold" };
  }
  return null;
}

/** Métricas por célula do Resumo A/B/C por Audiência (#2976) — superset de `CellSummary`. */
export interface CellSummaryV2 {
  cell: "A" | "B" | "C";
  campaignCount: number;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscriptions: number;
  /** opens / delivered */
  openRate: number;
  /** clicks / opens — qualidade da abertura */
  ctor: number;
  /** clicks / delivered — o "fundo do poço" do engajamento (#2976) */
  clickRate: number;
  /** unsub / sent */
  unsubRate: number;
  /** (hard+soft bounce) / sent */
  bounceRate: number;
  /** spam complaints / sent */
  spamRate: number;
}

/** Resultado do teste de proporção (z-test) entre 2 células — usado para o flag de significância. */
export interface ZTestResult {
  z: number;
  pValue: number;
}

/**
 * Aproximação de Abramowitz-Stegun pra função erro — sem dependência externa
 * (princípio "zero custo recorrente"/sem lib nova, CLAUDE.md). Erro máximo
 * ~1.5e-7, mais que suficiente pro flag de significância (p < 0.05).
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Teste de duas proporções (z-test) — compara a taxa de clique de 2 células
 * (x1/n1 vs x2/n2). Retorna o z-score e o p-value bicaudal. Sem dependência
 * externa (implementação from-scratch, ver `erf`). `n1`/`n2` = 0 → z=0/p=1
 * (indeterminado, tratado como não-significativo). Exportado pra teste
 * unitário. #2976.
 */
export function twoProportionZTest(x1: number, n1: number, x2: number, n2: number): ZTestResult {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normCdf(Math.abs(z)));
  return { z, pValue };
}

/** Limiar de significância padrão (p < 0.05) usado no flag `significantClick`. #2976 */
export const SIGNIFICANCE_ALPHA = 0.05;

export interface AbcAudienceTable {
  cells: CellSummaryV2[];
  /** Célula com maior open rate entre as amostradas (empate → null). */
  leaderOpenRate: "A" | "B" | "C" | null;
  /** Célula com maior click rate entre as amostradas (empate → null) — o "fundo do poço" que decide o teste (#2976). */
  leaderClickRate: "A" | "B" | "C" | null;
  /** true se a diferença de click rate entre a líder e a 2ª colocada é estatisticamente significativa (p < 0.05). */
  significantClick: boolean;
  /** p-value do z-test líder vs 2ª colocada (null quando não há 2 células amostradas). */
  pValue: number | null;
}

function emptyCellV2(cell: "A" | "B" | "C"): CellSummaryV2 {
  return {
    cell,
    campaignCount: 0,
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    unsubscriptions: 0,
    openRate: 0,
    ctor: 0,
    clickRate: 0,
    unsubRate: 0,
    bounceRate: 0,
    spamRate: 0,
  };
}

/** Agrega uma lista de campanhas JÁ FILTRADA (por audiência/ciclo) em CellSummaryV2[A,B,C]. */
function aggregateCellsV2(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
  audienceFilter: ClariceAudience | "any",
): CellSummaryV2[] {
  const acc: Record<"A" | "B" | "C", { sent: number; delivered: number; opens: number; clicks: number; unsub: number; bounces: number; spam: number; count: number }> = {
    A: { sent: 0, delivered: 0, opens: 0, clicks: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
    B: { sent: 0, delivered: 0, opens: 0, clicks: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
    C: { sent: 0, delivered: 0, opens: 0, clicks: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
  };
  for (const c of campaigns) {
    const parsed = parseAbcAudienceCampaign(c.name);
    if (!parsed || parsed.cycle !== cycle) continue;
    if (audienceFilter !== "any" && parsed.audience !== audienceFilter) continue;
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;
    const a = acc[parsed.cell];
    a.sent += s.sent ?? 0;
    a.delivered += s.delivered ?? 0;
    a.opens += s.uniqueViews ?? 0;
    a.clicks += s.uniqueClicks ?? 0;
    a.unsub += s.unsubscriptions ?? 0;
    a.bounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    a.spam += s.complaints ?? 0;
    a.count += 1;
  }
  return (["A", "B", "C"] as const).map((cell) => {
    const d = acc[cell];
    if (d.count === 0) return emptyCellV2(cell);
    return {
      cell,
      campaignCount: d.count,
      sent: d.sent,
      delivered: d.delivered,
      opens: d.opens,
      clicks: d.clicks,
      unsubscriptions: d.unsub,
      openRate: d.delivered > 0 ? (d.opens / d.delivered) * 100 : 0,
      ctor: d.opens > 0 ? (d.clicks / d.opens) * 100 : 0,
      clickRate: d.delivered > 0 ? (d.clicks / d.delivered) * 100 : 0,
      unsubRate: d.sent > 0 ? (d.unsub / d.sent) * 100 : 0,
      bounceRate: d.sent > 0 ? (d.bounces / d.sent) * 100 : 0,
      spamRate: d.sent > 0 ? (d.spam / d.sent) * 100 : 0,
    };
  });
}

function buildAbcAudienceTable(cells: CellSummaryV2[]): AbcAudienceTable {
  const sampled = cells.filter((c) => c.campaignCount > 0);

  function pickLeader(metric: (c: CellSummaryV2) => number): "A" | "B" | "C" | null {
    if (sampled.length < 2) return null;
    const max = sampled.reduce((m, c) => Math.max(m, metric(c)), -Infinity);
    const tied = sampled.filter((c) => metric(c) === max);
    return tied.length === 1 ? tied[0].cell : null;
  }

  const leaderOpenRate = pickLeader((c) => c.openRate);
  const leaderClickRate = pickLeader((c) => c.clickRate);

  let significantClick = false;
  let pValue: number | null = null;
  if (leaderClickRate && sampled.length >= 2) {
    const leader = sampled.find((c) => c.cell === leaderClickRate)!;
    // 2ª colocada por click rate (a que mais ameaça a liderança).
    const runnerUp = [...sampled]
      .filter((c) => c.cell !== leaderClickRate)
      .sort((a, b) => b.clickRate - a.clickRate)[0];
    if (runnerUp) {
      const test = twoProportionZTest(leader.clicks, leader.delivered, runnerUp.clicks, runnerUp.delivered);
      pValue = test.pValue;
      significantClick = test.pValue < SIGNIFICANCE_ALPHA;
    }
  }

  return { cells, leaderOpenRate, leaderClickRate, significantClick, pValue };
}

/**
 * Agrega o Resumo A/B/C de um ciclo em 3 tabelas (#2976): Agregada (fria +
 * quente), Fria (só campanhas classificadas `cold`) e Quente (`warm`). Cada
 * tabela tem seu próprio LÍDER (abertura E clique) + flag de significância
 * estatística do clique (o critério que decidiu o vencedor real no ciclo
 * 2606-07 — abertura dava A, clique dava B). Exportado pra teste unitário.
 */
export function aggregateAbcByAudience(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): { aggregate: AbcAudienceTable; cold: AbcAudienceTable; warm: AbcAudienceTable } {
  return {
    aggregate: buildAbcAudienceTable(aggregateCellsV2(campaigns, cycle, "any")),
    cold: buildAbcAudienceTable(aggregateCellsV2(campaigns, cycle, "cold")),
    warm: buildAbcAudienceTable(aggregateCellsV2(campaigns, cycle, "warm")),
  };
}

/** Renderiza 1 tabela (Agregada/Fria/Quente) do Resumo A/B/C por Audiência. */
function renderAbcAudienceTable(title: string, table: AbcAudienceTable): string {
  const { cells, leaderOpenRate, leaderClickRate, significantClick, pValue } = table;
  if (cells.every((c) => c.campaignCount === 0)) {
    return `
  <h4 class="subsection-title">${escHtml(title)}</h4>
  <p class="section-note"><small>Sem dados desta audiência neste ciclo.</small></p>`;
  }
  const orderedRows = [...cells].sort((a, b) => {
    if (a.campaignCount === 0 && b.campaignCount === 0) return 0;
    if (a.campaignCount === 0) return 1;
    if (b.campaignCount === 0) return -1;
    return b.clickRate - a.clickRate;
  });
  const rows = orderedRows
    .map((c) => {
      if (c.campaignCount === 0) {
        return `<tr><td><strong>Célula ${c.cell}</strong></td><td colspan="8" style="opacity:0.5;">— sem envios —</td></tr>`;
      }
      // #3088: teal (--brand) falha AA em texto pequeno — tags de destaque
      // voltam a --ink (negrito + ▲ já diferenciam visualmente).
      const openTag = c.cell === leaderOpenRate ? ` <strong style="color:${DS.ink}">▲ ABERTURA</strong>` : "";
      const clickTag = c.cell === leaderClickRate ? ` <strong style="color:${DS.ink}">▲ CLIQUE</strong>` : "";
      return `<tr>
        <td><strong>Célula ${c.cell}</strong></td>
        <td>${c.campaignCount}</td>
        <td>${c.delivered.toLocaleString("pt-BR")}</td>
        <td class="metric">${c.openRate.toFixed(1)}%${openTag}</td>
        <td class="metric">${c.ctor.toFixed(1)}%</td>
        <td class="metric">${c.clickRate.toFixed(2)}%${clickTag}</td>
        <td>${c.clicks.toLocaleString("pt-BR")}</td>
        <td>${c.unsubRate.toFixed(2)}%</td>
        <td>${c.bounceRate.toFixed(2)}% / ${c.spamRate.toFixed(3)}%</td>
      </tr>`;
    })
    .join("\n");

  const sampled = cells.filter((c) => c.campaignCount > 0);
  const conclusionNote =
    sampled.length < 2
      ? "Dados insuficientes para comparação."
      : !leaderClickRate
      ? "Empate no clique — aguardar mais dados."
      : significantClick
      ? `Vencedor por CLIQUE: <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — diferença estatisticamente significativa (p ${pValue !== null ? pValue.toFixed(4) : "?"} &lt; ${SIGNIFICANCE_ALPHA}). Já dá pra concluir.`
      : `Vencedor provisório por clique: <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — diferença <strong>NÃO</strong> significativa ainda (p ${pValue !== null ? pValue.toFixed(4) : "?"} ≥ ${SIGNIFICANCE_ALPHA}). Precisa de mais dados antes de concluir.`;

  return `
  <h4 class="subsection-title">${escHtml(title)}</h4>
  <p class="section-note">${conclusionNote}</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th scope="col" title="Célula do teste A/B/C">Célula</th>
        <th scope="col" title="Dias/envios contabilizados">Envios</th>
        <th scope="col" title="Total entregue">Delivered</th>
        <th scope="col" title="Aberturas únicas ÷ delivered">Open rate</th>
        <th scope="col" title="CTOR = cliques únicos ÷ aberturas — qualidade da abertura">CTOR</th>
        <th scope="col" title="Cliques únicos ÷ delivered — o &quot;fundo do poço&quot; do engajamento, decide o vencedor real">Click rate</th>
        <th scope="col" title="Total de cliques únicos">Cliques</th>
        <th scope="col" title="Descadastros ÷ sent">Unsub</th>
        <th scope="col" title="Bounce (hard+soft) ÷ sent / Spam ÷ sent">Bounce / Spam</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>`;
}

/**
 * Renderiza o Resumo A/B/C por Audiência (#2976) — 3 tabelas: Agregada, Fria,
 * Quente. Substitui o agrupamento por DATA de envio (que dispersa o sinal
 * quando fria/quente se comportam muito diferente) pelo agrupamento por TIPO
 * de audiência, que é o que de fato decide o teste. Aditivo — as seções por
 * data (`groupMonthlyAbcTests`/`renderAbcSection`) continuam servindo como
 * detalhe cronológico logo abaixo. Exportado pra teste unitário.
 */
export function renderAbcAudienceSection(
  cycle: string,
  result: { aggregate: AbcAudienceTable; cold: AbcAudienceTable; warm: AbcAudienceTable },
): string {
  const allEmpty =
    result.aggregate.cells.every((c) => c.campaignCount === 0) &&
    result.cold.cells.every((c) => c.campaignCount === 0) &&
    result.warm.cells.every((c) => c.campaignCount === 0);
  if (allEmpty) return "";
  return `
<section class="phase2-section" id="abc-audience-${escHtml(cycle)}">
  <h2 class="section-title">Resumo A/B/C por Audiência (${escHtml(cycle)})</h2>
  <p class="section-note"><small>Agrupado por TIPO de audiência (fria = nunca recebeu; quente = base engajada), não por data de envio — o comportamento entre elas diverge o suficiente (abertura ~15% vs ~60%) pra dispersar o sinal se agrupado por data. Vencedor decidido pelo CLIQUE (click rate), não só pela abertura.</small></p>
  ${renderAbcAudienceTable("Agregada (Fria + Quente)", result.aggregate)}
  ${renderAbcAudienceTable("Fria (nunca recebeu)", result.cold)}
  ${renderAbcAudienceTable("Quente (já engajada)", result.warm)}
</section>`;
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
 * #2989: seleciona os N (default 3) melhores dias da semana por open rate
 * agregado, entre os dias com dados (count > 0). Empates na fronteira do corte
 * podem incluir mais de N itens (nunca corta um empate no meio — evita sugerir
 * um dia arbitrariamente sobre outro com a mesma taxa). Pura, testável com
 * fixtures — reusa `WeekdaySummary` já produzida por `aggregateByWeekday`
 * (não recomputa nada). Exportado pra teste unitário.
 */
export function pickTopWeekdays(rows: WeekdaySummary[], n = 3): WeekdaySummary[] {
  const sampled = rows.filter((r) => r.count > 0);
  if (sampled.length === 0) return [];
  const sorted = [...sampled].sort((a, b) => b.openRate - a.openRate);
  if (sorted.length <= n) return sorted;
  const cutoffRate = sorted[n - 1].openRate;
  // Inclui tudo que empata com a taxa do último item dentro do corte (nunca
  // quebra um empate arbitrariamente no meio).
  return sorted.filter((r) => r.openRate >= cutoffRate);
}

/**
 * #3081: a agregação de open rate por dia da semana mistura audiência FRIA
 * (cold, nunca recebeu) e QUENTE (já engajada) — o comportamento entre elas
 * diverge o suficiente (abertura ~15% fria vs ~60% quente, ver
 * `renderAbcAudienceSection`) pra dispersar o sinal se lido sem essa ressalva.
 * Decisão do editor (#3081): nota explícita é suficiente aqui — segmentar a
 * agregação por audiência seria decisão de produto fora de escopo do cleanup.
 * Reusada tanto em `renderWeekdaySection` (aba Engajamento) quanto em
 * `renderTopWeekdaysSection` (aba Rampa, weekly-plan.ts).
 */
export const WEEKDAY_MIXED_AUDIENCE_NOTE =
  "Agrega audiência fria e quente juntas — a abertura diverge bastante entre elas (~15% fria vs ~60% quente); leia como sinal agregado, não segmentado por audiência.";

/**
 * #3081 (self-review): fábrica do `<p>` da nota acima — usada em 4 lugares
 * (`renderWeekdaySection` ×2, `renderTopWeekdaysSection`, `renderMonthlyTotalsSection`)
 * que antes repetiam a mesma marcação `<p class="section-note"><small>...</small></p>`
 * copiada à mão. Centraliza o wrapper — mudar o markup agora é 1 edição, não N.
 */
export function renderMixedAudienceNote(): string {
  return `<p class="section-note"><small>${WEEKDAY_MIXED_AUDIENCE_NOTE}</small></p>`;
}

/**
 * #3081/#3090: definição CANÔNICA das colunas da tabela "Open rate por dia da
 * semana" (label + tooltip) — mesmo padrão de `ENVIOS_COLUMNS`/
 * `AGGREGATED_LINKS_COLUMNS`: fonte única usada tanto no `title=` de cada
 * `<th>` (hover, desktop) quanto no `<details>` "Glossário das colunas"
 * (via `renderColumnGlossary`, reusado — mesmo componente/rótulo das outras
 * 2 tabelas — sempre visível, funciona em touch/mobile). Textos idênticos
 * aos `title=` que já existiam nos headers desta tabela — sem duplicar
 * conteúdo, só torná-lo acessível fora de hover. Exportado pra teste unitário.
 */
export const WEEKDAY_COLUMNS: Array<{ label: string; tooltip: string }> = [
  { label: "Dia", tooltip: "Dia da semana do envio (horário de Brasília)" },
  { label: "Envios", tooltip: "Número de envios realizados neste dia" },
  { label: "Delivered", tooltip: "Total entregue" },
  { label: "Opens", tooltip: "Soma de aberturas únicas (uniqueViews) das campanhas enviadas neste dia." },
  { label: "Open rate agr.", tooltip: "Open rate agregado: opens ÷ delivered. Dias com < 2 campanhas = amostra pequena." },
];

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
  ${renderMixedAudienceNote()}
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
      // #3088: teal falha AA em texto pequeno — tag volta a --ink.
      const winnerTag = isWinner ? ` <strong style="color:${DS.ink}">▲ MELHOR DIA</strong>` : "";
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
    ? `Melhor dia provisório: <strong style="color:${DS.ink}">${WEEKDAY_LABELS[winnerWk]}</strong> — aguardar mais dados para conclusão.`
    : `Dados insuficientes para comparação.`;

  const excludedNote =
    excluded.length > 0
      ? `\n  <p class="section-note"><small>Envios ainda não computados (open rate &lt; ${WEEKDAY_MIN_AGE_HOURS}h, estabilizando): ${excluded.map((e) => escHtml(e.name)).join(", ")}.</small></p>`
      : "";

  return `
<section class="phase2-section" id="weekday-openrate">
  <h2 class="section-title">Open rate por dia da semana — ${escHtml(scopeLabel)}</h2>
  ${renderMixedAudienceNote()}
  ${renderColumnGlossary("weekday-openrate", WEEKDAY_COLUMNS)}
  <p class="section-note">${statusNote}</p>${excludedNote}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        ${WEEKDAY_COLUMNS.map((c) => `<th scope="col" title="${escHtml(c.tooltip)}">${c.label}</th>`).join("\n")}
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
export function renderAbcSection(
  abcRows: CellSummary[],
  resetNote = false,
  opts: { title?: string; id?: string } = {},
): string {
  // #2889: título/id parametrizáveis pra reusar no Resumo A/B/C MENSAL (default = diário S1).
  const secTitle = opts.title ?? "Resumo A/B/C — S1 (d01–d07)";
  const secId = opts.id ?? "abc-summary";
  if (abcRows.every((r) => r.campaignCount === 0)) {
    // Sem resetNote (ciclo sem A/B/C planejado, ex: S2/S3 puro): oculta, como
    // sempre. Com resetNote (#2871 — o corte do reset removeu células reais):
    // placeholder explicativo — sumir seria indistinguível de bug de dado.
    if (!resetNote) return "";
    const resetDate = new Date(ABC_RESET_AT).toLocaleDateString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    return `
<section class="phase2-section" id="${secId}">
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
      // #3088: teal falha AA em texto pequeno — tag volta a --ink.
      const winnerTag = isWinner ? ` <strong style="color:${DS.ink}">▲ LÍDER</strong>` : "";
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
    ? `Vencedor provisório: <strong style="color:${DS.ink}">Célula ${winnerCell}</strong> — aguardar checkpoint de análise para decisão final.`
    : `Dados insuficientes para comparação — aguardar mais dias de envio.`;

  return `
<section class="phase2-section" id="${secId}">
  <h2 class="section-title">${secTitle}</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo) — base do vencedor. Entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os dias da célula têm esse dado.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th scope="col" title="Célula do teste A/B/C">Célula</th>
        <th scope="col" title="Soma de entregues dos dias enviados">Delivered (total)</th>
        <th scope="col" title="Soma de aberturas únicas (com Apple MPP, como na UI da Brevo) dos dias enviados">Opens (total)</th>
        <th scope="col" title="Open rate agregado com Apple MPP (opens ÷ delivered) — base do vencedor; entre parênteses, a taxa sem MPP quando disponível">Open rate agr.</th>
        <th scope="col" title="Dias enviados contabilizados">Dias</th>
      </tr>
    </thead>
    <tbody>${cellRows}</tbody>
  </table>
  </div>
</section>`;
}
