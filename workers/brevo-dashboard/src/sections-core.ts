import type { Env, BrevoCampaign, BrevoGlobalStats, BrevoCampaignStats, BrevoLinksStats, EngagementCohorts, MvStatus, ContactsSummary, EiaEngagementSummary, PostmasterSpamEntry } from "./types.ts";
import { type CouponUsageReport } from "../../../scripts/lib/stripe-coupons.ts";
// #4405: desempate de ciclo por conteúdo em resolveCampaignCycle (abaixo) — mesma
// função que render-links.ts já usa pra classificar URL→conteúdo.
import { classifyLinkContent } from "./link-content.ts";
// #3092: PT_MONTHS_ABBR — dependency-free/Workers-safe (mesmo padrão de
// cohortSendRank em sections-kv.ts), reusado por formatCycleEnvioLabel.
import { PT_MONTHS_ABBR } from "../../../scripts/lib/cohorts.ts";
import { DS, DS_FONTS as DSF, pct, cellClass, renderLinksSection, aggregateLinksAcrossCampaigns, deriveLinksSectionTitle, renderAggregatedLinksSection, hoursSince, fmtTimeBRT, renderColumnGlossary, brevoReportLink, mergeLinkSectionMaps, mergeLinkTitleMaps, aggregateClicksBySection, renderSectionClicksSection, selectLatestEditionCampaigns, type LinkSectionMap } from "./render-links.ts"; // #4184: mergeLinkSectionMaps/LinkSectionMap; #4198: mergeLinkTitleMaps; #4405: aggregateClicksBySection/renderSectionClicksSection/selectLatestEditionCampaigns
import {
  renderVolumeSection,
  aggregateByMonth,
  renderMonthlyTotalsSection,
  renderEngagementCohortsSection,
  renderContactsSummarySection,
  renderEiaEngagementSection,
  renderCouponTabPanel,
  renderCohortsTabPanel,
  renderScheduledSection,
  renderKvUnavailableNote, // #4165/#4173
  COHORT_DEVIATION_THRESHOLD_PP,
} from "./sections-kv.ts";
import { billingCycleWindow, isInBillingWindow, type BillingCycleWindow } from "./billing-cycle.ts";
import {
  renderWeeklyPlanTabPanel,
  renderHealthSection,
  renderRecommendationSection,
  renderTopWeekdaysSection,
  deriveEditionName,
} from "./weekly-plan.ts";
import { isBounceBreach } from "./thresholds.ts";
// #3884: painel de avaliação de experimentos A/B (CTA-01) + registro
// "Experimento vigente" — import circular com este módulo (pickStats/escHtml
// usados lá, funções de render importadas aqui), mesmo padrão já documentado
// acima para render-links.ts/weekly-plan.ts (uso só em corpo de função,
// request-time, nunca em top-level do módulo).
import {
  EXPERIMENTS,
  renderExperimentRegistrySection,
  renderExperimentsEvaluationSections,
} from "./experiment-cta.ts";
// #4515: aba brevo_diaria (canal Brevo PRÓPRIO do editor, conta SEPARADA da
// Clarice) — import circular com este módulo (escHtml é usado lá, definido
// aqui), mesmo padrão já documentado acima para render-links.ts/weekly-plan.ts/
// experiment-cta.ts (uso só em corpo de função, request-time).
import { renderBrevoDiariaTabPanel, type BrevoDiariaTabData } from "./brevo-diaria.ts";

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

/**
 * #4165/#4173: opções que mudam o render pra contexto Studio (painel local),
 * mesmo padrão de `RenderDashboardOptions` em
 * `workers/diaria-dashboard/src/index.ts` (#3861) — parâmetro explícito, não
 * detecção de ambiente (o mesmo módulo serve Worker de produção E Studio).
 */
export interface RenderDashboardOptions {
  /**
   * Liga o modo Studio nas seções KV-dependentes (cohorts, cupons,
   * engajamento É IA?):
   *   - Quando o dado vem `null`, o texto passa a ser "indisponível no
   *     painel local — ver dashboard Cloudflare" (com link), em vez da
   *     instrução "rode o script X" (que faz sentido no Worker, mas não
   *     necessariamente aqui — ver #4173) ou, no caso da aba Cupons, sumir
   *     sem nenhuma explicação (o bug original do #4173).
   *   - O botão "Atualizar votos" (form POST pra `/api/eia/refresh`, rota que
   *     só existe no Worker) vira um link pro dashboard Cloudflare real — o
   *     mesmo POST na origem do Studio 405a (#4165), porque o studio-server
   *     não tem essa rota.
   * `false`/ausente (default) preserva o comportamento atual EXATAMENTE — o
   * Worker de produção nunca passa este parâmetro, então nada muda lá.
   */
  studioMode?: boolean;
  /**
   * #4184: mapa de seção editorial (Destaques/Use Melhor/Radar) por CICLO
   * mensal (`"AAMM-MM"`, ex: `"2606-07"`), usado para popular a coluna
   * "Seção" nas tabelas de link (agregada e drill-down por campanha).
   *
   * Fonte por superfície:
   *   - Worker: KV `secao:{ciclo}` (script explícito `push-link-sections-kv.ts`,
   *     nunca escrito pelo caminho de render — decisão do editor #4184).
   *   - Studio: montado em memória a partir de `data/monthly/{ciclo}/prioritized.md`
   *     local (sem KV — ver `scripts/studio-ui/dashboard-clarice.ts`).
   *
   * Ausente/`null` (default) preserva o comportamento anterior — toda linha
   * cai no fallback "—" (seção desconhecida). O drill-down por campanha usa
   * o mapa do ciclo EXATO daquela campanha (`parseClariceCampaignKey`); a
   * tabela agregada usa a união de todos os ciclos presentes na janela
   * (`mergeLinkSectionMaps`) — ver comentário em `link-section.ts`.
   */
  linkSectionsByCycle?: Record<string, LinkSectionMap> | null;
  /**
   * #4198: mapa CONTEÚDO BASE→TÍTULO editorial por CICLO mensal, sibling de
   * `linkSectionsByCycle` acima (mesma fonte por superfície: Worker via KV
   * `titulo:{ciclo}`, Studio via `prioritized.md` local — ver
   * `buildLinkTitlesByCycleLocal` em `scripts/studio-ui/dashboard-clarice.ts`).
   * Usado pra SUBSTITUIR o rótulo opaco derivado da URL na coluna "Conteúdo"
   * das tabelas de link (agregada e drill-down por campanha) — nunca afeta a
   * chave de agrupamento/seção, que continua o conteúdo BASE (ver
   * `render-links.ts::parseLinksStats`). Ausente/`null` (default) preserva o
   * comportamento anterior ao #4198 — rótulo sempre derivado da URL.
   */
  linkTitlesByCycle?: Record<string, Record<string, string>> | null;
  /**
   * #4515: dados pré-buscados da aba brevo_diaria (canal Brevo PRÓPRIO do
   * editor, conta SEPARADA da Clarice — ver `fetchBrevoDiariaTabData` em
   * brevo-diaria.ts, chamado no call site do Worker — index.ts). `null`/
   * ausente (default, preserva TODOS os callers/testes pré-#4515) → aba
   * oculta. Presente → aba aparece (mesmo com `campaigns: []`/erro, que vira
   * um banner explícito em vez de esconder a falha).
   */
  brevoDiaria?: BrevoDiariaTabData | null;
}

/**
 * #4405: converte `YYMM` (mês de CONTEÚDO, 4 dígitos) pro ciclo `AAMM-MM`
 * (chave do KV `secao:{ciclo}`/`titulo:{ciclo}`) — mesma regra de
 * `yymmToCycle` (`scripts/lib/mensal/monthly-paths.ts`: envio = mês
 * IMEDIATAMENTE seguinte ao conteúdo). Replicada aqui (2 linhas) porque o
 * Worker não importa de `scripts/lib/` (fronteira do projeto, ver
 * CLAUDE.md) — `test/brevo-dashboard-link-secao-4405.test.ts` tem um teste
 * de paridade que garante que as duas nunca divergem. Deliberadamente NÃO
 * deriva do `sentDate` da campanha — uma onda que atravessa a virada do mês
 * erraria o mês de envio.
 */
function yymmToCycleLocal(yymm: string): string {
  const contentMonth = Number(yymm.slice(2, 4));
  const sendMonth = (contentMonth % 12) + 1;
  return `${yymm}-${String(sendMonth).padStart(2, "0")}`;
}

/**
 * #4405: candidato de ciclo mensal (`AAMM-MM`) extraído do NOME de uma
 * campanha — reconhece, além do `Clarice News {AAMM-MM} — {cell}` que
 * `parseClariceCampaignKey` já cobria, os outros 2 formatos reais
 * observados na API Brevo (260731): `Diar.ia Mensal {AAMM} — ...` (envio
 * inicial + ondas ramp-warm, `clarice-cta-ab-setup.ts`/`publish-monthly.ts`)
 * e `Clarice {AAMM} grupo:{key}` (ondas de grupo nomeado — engajados, novos
 * etc., `clarice-schedule-group.ts`). Função IRMÃ de `parseClariceCampaignKey`
 * — deliberadamente não estende aquela função, cujo shape de retorno
 * (dayNum/cell) serve o Resumo A/B/C, um propósito diferente; os 2 formatos
 * novos não têm dayNum/cell no mesmo sentido e misturar arriscaria os
 * agregadores que já dependem do shape atual.
 *
 * Só um CANDIDATO, nunca a palavra final — `Clarice {AAMM} grupo:` pode
 * mentir: achado #4405, um envio pro grupo `novos` saiu rotulado com o
 * ciclo CORRENTE carregando o conteúdo do ciclo ANTERIOR (o digest do mês
 * corrente ainda não estava pronto quando o grupo foi disparado).
 * `resolveCampaignCycle` (abaixo) usa este candidato só como ponto de
 * partida, desempatando pelo conteúdo quando há ambiguidade.
 */
export function extractMonthlyCycleCandidate(campaignName: string): string | null {
  const name = campaignName ?? "";
  const newsMatch = name.match(/Clarice News (\d{4}-\d{2})\s*[—–-]\s*[ABC]\b/i);
  if (newsMatch) return newsMatch[1];
  const mensalMatch = name.match(/Diar\.ia Mensal (\d{4})\b/i);
  if (mensalMatch) return yymmToCycleLocal(mensalMatch[1]);
  const grupoMatch = name.match(/Clarice (\d{4}) grupo:/i);
  if (grupoMatch) return yymmToCycleLocal(grupoMatch[1]);
  return null;
}

function countContentCoverage(map: LinkSectionMap, contents: ReadonlySet<string>): number {
  let n = 0;
  for (const content of contents) if (map[content]) n++;
  return n;
}

/**
 * #4405: resolve o ciclo mensal (`AAMM-MM`) de UMA campanha, desambiguando o
 * candidato do nome (`extractMonthlyCycleCandidate`) pelo CONTEÚDO — entre
 * os ciclos já carregados em `sectionMapsByCycle`, escolhe o que cobre mais
 * URLs de clique desta campanha (via `classifyLinkContent`, mesma chave que
 * os mapas usam). Empate — seja contra o candidato, seja entre 2 ciclos
 * NÃO-candidatos — ou zero cobertura em TODOS os ciclos → fica o candidato
 * do nome (nunca inventa um ciclo sem evidência de conteúdo INEQUÍVOCA; o
 * caso de empate entre não-candidatos nunca é decidido pela ordem de
 * iteração de `sectionMapsByCycle`). Sem
 * candidato de nome (campanha diária, ou naming desconhecido) → `null`, sem
 * tentar desambiguar — nunca declara "monthly" uma campanha que não parece
 * monthly pelo nome.
 *
 * Nota sobre `collectMonthlyLinkCycles` (abaixo): a decisão de QUAIS ciclos
 * buscar no KV usa só o candidato do nome — não dá pra desambiguar por
 * conteúdo antes de ter os mapas carregados (contradição de ordem: precisa
 * do mapa pra saber qual mapa buscar). Na prática o ciclo correto quase
 * sempre acaba no conjunto de qualquer forma, contribuído por OUTRAS
 * campanhas bem nomeadas da mesma janela (`Clarice News`) — esta função só
 * refina a classificação POR CAMPANHA depois que os mapas já foram
 * carregados, ela não amplia o conjunto buscado no KV.
 */
export function resolveCampaignCycle(
  campaignName: string,
  linksStats: BrevoLinksStats | null | undefined,
  sectionMapsByCycle: Record<string, LinkSectionMap> | null | undefined,
): string | null {
  const candidate = extractMonthlyCycleCandidate(campaignName);
  if (candidate === null) return null;
  if (!sectionMapsByCycle || !linksStats) return candidate;

  const cycles = Object.keys(sectionMapsByCycle);
  if (cycles.length === 0) return candidate;

  const contents = new Set<string>();
  for (const url of Object.keys(linksStats)) {
    contents.add(classifyLinkContent(url).content);
  }
  if (contents.size === 0) return candidate;

  let bestCycle = candidate;
  let bestCoverage = sectionMapsByCycle[candidate]
    ? countContentCoverage(sectionMapsByCycle[candidate], contents)
    : 0;
  // #4405 (achado do review): `tied` rastreia quando outro ciclo (não o
  // candidato) empata com o MELHOR já visto — sem isso, um empate entre 2
  // ciclos NÃO-candidatos era decidido silenciosamente pela ordem de
  // iteração de `Object.keys`, contradizendo o "empate → fica o candidato"
  // documentado acima. Reinicia a cada vez que um novo melhor estritamente
  // maior aparece (só o TOPO atual importa pro empate).
  let tied = false;
  for (const cycle of cycles) {
    if (cycle === candidate) continue;
    const coverage = countContentCoverage(sectionMapsByCycle[cycle], contents);
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestCycle = cycle;
      tied = false;
    } else if (coverage > 0 && coverage === bestCoverage) {
      tied = true;
    }
  }
  if (bestCoverage === 0 || tied) return candidate;
  return bestCycle;
}

/**
 * #4184: ciclos mensais (`"AAMM-MM"`) distintos presentes numa lista de
 * campanhas — usado pra decidir quais chaves `secao:{ciclo}` buscar no KV
 * (Worker) ou quais `prioritized.md` ler em disco (Studio). #4405: usa
 * `extractMonthlyCycleCandidate` (não mais só `parseClariceCampaignKey`) —
 * reconhece também `Diar.ia Mensal {AAMM}` e `Clarice {AAMM} grupo:`.
 * Campanhas DIÁRIAS ou de naming desconhecido nunca têm `prioritized.md`
 * equivalente — não entram no resultado, e seu conteúdo cai no fallback
 * determinístico da coluna Seção (nunca mais "—", ver `link-section.ts`)
 * sem nenhuma checagem especial (não há chave pra elas em nenhum mapa).
 */
export function collectMonthlyLinkCycles(
  campaigns: ReadonlyArray<Pick<BrevoCampaign, "name">>,
): string[] {
  const cycles = new Set<string>();
  for (const c of campaigns) {
    const candidate = extractMonthlyCycleCandidate(c.name ?? "");
    if (candidate) cycles.add(candidate);
  }
  return [...cycles];
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
  // #3079/#3553: ISO de quando `campaigns`/`scheduled` foram DE FATO buscados
  // na Brevo — sempre "agora" desde que #3553 (parte B) removeu o Cron
  // Trigger (toda leitura é fetch ao vivo em request-time, exceto o fallback
  // de rate-limit, que passa `null` de propósito). `null` (default) preserva
  // o comportamento histórico para callers/testes que não passam este
  // argumento — tratado como "agora" (fetch ao vivo).
  dataGeneratedAt: string | null = null,
  // #3080: limite de campanhas pedido ao Brevo pra montar `campaigns` (ex:
  // CAMPAIGNS_FETCH_LIMIT=150) — usado só pra decidir se a janela está "cheia"
  // (`campaigns.length >= campaignsWindowLimit`), habilitando os avisos de
  // "janela parcial" em "Totais por mês"/"Volume no ciclo" (defesa em
  // profundidade — o limite real pode subir de novo no futuro e cruzar de
  // novo). `null` (default) = desconhecido/não informado → nenhum aviso.
  campaignsWindowLimit: number | null = null,
  // #4063/#4154: leitura do Postmaster (KV `postmaster:spam`, via readKvTabs,
  // auto ou manual) — governa o breaker de spam da Rampa com precedência
  // sobre `complaints` da Brevo. `null` (default) preserva call sites/testes
  // existentes (sinal fica "indeterminate" — nunca reporta 🟢 falso, ver
  // thresholds.ts).
  postmasterSpam: PostmasterSpamEntry | null = null,
  // #4165/#4173: ver RenderDashboardOptions. `{}` (default) preserva o
  // comportamento atual — nenhum call site de produção passa isto.
  opts: RenderDashboardOptions = {},
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
  // #4184: mapa de seção editorial por ciclo mensal (ver RenderDashboardOptions).
  const linkSectionsByCycle = opts.linkSectionsByCycle ?? null;
  // #4198: mapa de título editorial por ciclo mensal (ver RenderDashboardOptions).
  const linkTitlesByCycle = opts.linkTitlesByCycle ?? null;
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
      // #4184/#4405: mapa de seção do ciclo desta campanha, resolvido pelo
      // CONTEÚDO quando o nome é ambíguo (ver resolveCampaignCycle) — não o
      // merge cross-ciclo usado na tabela agregada, mais abaixo. Campanhas
      // diárias (sem candidato de ciclo mensal no nome) nunca têm
      // prioritized.md equivalente, então `campaignCycle` é `null` e a linha
      // cai no fallback determinístico da coluna Seção sem nenhuma checagem
      // especial.
      const campaignCycle = resolveCampaignCycle(c.name ?? "", linksStats, linkSectionsByCycle);
      const campaignSectionMap = campaignCycle
        ? linkSectionsByCycle?.[campaignCycle] ?? null
        : null;
      // #4198: mapa de título do ciclo desta campanha — mesmo espírito
      // de campaignSectionMap acima (drill-down nunca usa o merge cross-ciclo,
      // que é só pra tabela agregada mais abaixo).
      const campaignTitleMap = campaignCycle
        ? linkTitlesByCycle?.[campaignCycle] ?? null
        : null;
      if (!s) {
        // #2198 Bug 1: passa linksStats real mesmo quando stats ausente, evitando
        // "dados não disponíveis" para campanha que tem linksStats mas não globalStats/campaignStats.
        const linksHtmlNoStats = renderLinksSection(c.id, linksStats, undefined, campaignSectionMap, campaignTitleMap);
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
      // #3081: 3 casas (não 1) — com 1 casa, 0.049% arredondaria pra "0.0%" e
      // mascararia diferenças pequenas. Mesma precisão aplicada em "Totais por
      // mês" (sections-kv.ts). #4154: este número (Brevo/complaints) NUNCA é
      // usado como veredito de breach nesta tabela — ver comentário na célula
      // abaixo.
      const spamRate = pct(s.complaints, s.sent, 3);

      // Numeric versions pra comparar contra thresholds dos circuit breakers
      // (CLAUDE.md: doc operacional 2026-05-12). Alerta visual quando crossado.
      const openRateNum = s.delivered > 0 ? (s.uniqueViews / s.delivered) * 100 : 0;
      const hardBounceRateNum = s.sent > 0 ? (s.hardBounces / s.sent) * 100 : 0;
      const bounceRateNum = s.sent > 0 ? ((s.hardBounces + s.softBounces) / s.sent) * 100 : 0;
      const unsubRateNum = s.sent > 0 ? (s.unsubscriptions / s.sent) * 100 : 0;
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

      // #3678: célula Opens simplificada a pedido do editor — só a taxa total
      // e o count total, sem o parêntese "(X% sem MPP · Y% trackable)" que
      // vinha sendo refinado desde #1153/#2086/#3040/#3056/#3084. O dado
      // computado (trackableViews/appleMppOpens) continua disponível via
      // `/api/campaigns` cru — a mudança é só de display, não de coleta.
      const opensTopLine = openRate;
      const opensBottomLine = `${s.uniqueViews}`;

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
        campaignSectionMap, // #4184
        campaignTitleMap, // #4198
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
        <td>${spamRate}<br><small>${s.complaints}</small></td>
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

  // #3553 (parte B): sem Cron Trigger, o header sempre reflete o load ATUAL —
  // não existe mais um payload "pré-computado" com timestamp defasado (o
  // caminho que gerava isso, dash:lastgood:campaigns como fonte PRIMÁRIA de
  // leitura, foi removido; o KV agora é só fallback de rate-limit, ver
  // buildRateLimitFallback em brevo-api.ts, que passa dataGeneratedAt=null de
  // propósito). `dataGeneratedAt` presente é tratado como o instante do fetch
  // desta própria request — nunca mais compara contra `nowDate` pra decidir
  // entre dois textos.
  // #3349: `fmtTimeBRT` já degrada com segurança (retorna a string crua) para
  // um ISO não-parseável — não precisa de guard extra aqui (KV corrompido
  // nunca lança RangeError, ver render-links.ts).
  const dataFreshnessTimeLabel = dataGeneratedAt != null ? fmtTimeBRT(dataGeneratedAt) : now;
  const dataFreshnessLine = `Dados em tempo real — carregado às ${dataFreshnessTimeLabel} BRT.`;

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
  // #4449 item 2: nota diagnóstica IRMÃ, mas pro caso oposto — campanha
  // `--group` já CLASSIFICADA (warm, só pelo nome) cuja célula A/B/C
  // esperada não foi extraível da lista (naming da LISTA divergente, #4447).
  const groupMissingCellNote = renderGroupCampaignsMissingCellNote(findGroupCampaignsMissingCell(campaigns));
  // `activeCycle` segue servindo só o Resumo A/B/C abaixo (naming de campanha,
  // ex: "2605") — `calcCumulativeSent`/`CLARICE_PLAN_TOTAL` (cycle-naming)
  // pararam de alimentar a seção Volume (agora billing-window-based acima),
  // mas seguem exportados/testados como utilitário independente.
  const activeCycle = detectActiveCycle(campaigns);
  // #2600: restaura Resumo A/B/C como seção principal (revertendo #2492 que havia substituído).
  // D1–D5 mantido como seção SEPARADA logo após.
  // Reset A/B/C (#2871): o filtro fica AQUI no call site — aggregateAbcSummary
  // permanece pura (review #2870: embutir o cutoff nela quebrava a cobertura
  // das regressões #2199/#2600 e armava um trap pra callers futuros). Zero
  // células (seja pelo corte, seja por ciclo sem A/B/C planejado) → a seção
  // não renderiza nada (#3675 removeu o placeholder explicativo do reset,
  // vestigial desde que "Resumo A/B/C por Audiência" virou a leitura primária).
  const abcRows = activeCycle
    ? aggregateAbcSummary(campaigns.filter(isPostAbcReset), activeCycle)
    : [];
  const abcSection = activeCycle ? renderAbcSection(abcRows) : "";
  // #2889: Resumo A/B/C dos testes MENSAIS — UMA seção por (ciclo + dia de
  // envio), separadas do diário e entre si (dois testes do mesmo ciclo com o
  // mesmo naming, ex: engajado sexta + cold domingo, viram seções distintas
  // pela data). Sem reset placeholder (o #2871 é do diário); sem teste mensal
  // → nada. Mais recente primeiro.
  const monthlyAbcGroups = groupMonthlyAbcTests(campaigns);
  const monthlyAbcSectionsByDate = monthlyAbcGroups
    .map((g) =>
      renderAbcSection(aggregateAbcSummary(g.campaigns, g.cycle), {
        title: `Resumo A/B/C — Mensal (${g.cycle} · ${g.dateLabel})`,
        // id inclui ciclo+data (a chave real do grupo) — só a data poderia
        // colidir se 2 ciclos testassem no mesmo dia (review #2905).
        id: `abc-summary-monthly-${g.cycle}-${g.dateKey}`,
      }),
    )
    .join("\n");
  // #3129: a quebra por data é ruído pro editor (decisão já tomada via issue —
  // a leitura primária pra decidir o teste é o consolidado por audiência em
  // `abcAudienceSection` logo abaixo, que continua SEMPRE visível, sem
  // mudança nenhuma aqui). Em vez de remover o detalhe por-data (ainda útil
  // pra acompanhar um teste em andamento dia-a-dia), colapsa por padrão num
  // único <details>, reusando .links-ctr/.links-summary/.links-count-badge
  // (mesmo padrão de render-links.ts) em vez de CSS novo. As âncoras
  // `#abc-summary-monthly-{cycle}-{dateKey}` de cada seção ficam DENTRO do
  // <details> (nunca no próprio <details>), então um deep-link pra uma delas
  // segue auto-expandindo via reveal algorithm nativo do HTML (ancestor
  // <details> sem `open` é aberto automaticamente pelo browser quando o
  // :target é um descendente) — sem precisar de JS extra. Sem grupos → ""
  // (mesma convenção de renderAbcSection: nunca um <details> vazio).
  const monthlyAbcSection = monthlyAbcSectionsByDate
    ? `<details class="links-ctr abc-summary-monthly-group" id="abc-summary-monthly-collapsible">
  <summary class="links-summary">Resumo A/B/C — Mensal por data <span class="links-count-badge">${monthlyAbcGroups.length}</span> teste${monthlyAbcGroups.length === 1 ? "" : "s"}</summary>
${monthlyAbcSectionsByDate}
</details>`
    : "";
  // #2976: Resumo A/B/C por AUDIÊNCIA (Agregada/Fria/Quente) — aditivo, um bloco
  // por ciclo mensal distinto (agrupa TODAS as datas de teste do ciclo, ao
  // contrário de `monthlyAbcSection` acima que separa por data). Vem ANTES do
  // detalhe cronológico por data — é a leitura primária pra decidir o teste.
  const monthlyAbcCycles = [...new Set(monthlyAbcGroups.map((g) => g.cycle))];
  // #3408: 1 cômputo por ciclo, reusado pelas 2 renderizações (completa —
  // Engajamento; só-Agregada — Visão Geral) — evita re-agregar as campanhas
  // do ciclo 2x.
  const abcAudienceResultsByCycle = monthlyAbcCycles.map((cycle) => ({
    cycle,
    result: aggregateAbcByAudience(campaigns, cycle),
  }));
  const abcAudienceSection = abcAudienceResultsByCycle
    .map(({ cycle, result }) => renderAbcAudienceSection(cycle, result))
    .join("\n");
  // #3408: só a tabela Agregada, pra Visão Geral (resumo curado) — Fria/Quente
  // continuam só na aba Engajamento via abcAudienceSection acima.
  const abcAudienceAggregateSection = abcAudienceResultsByCycle
    .map(({ cycle, result }) => renderAbcAudienceAggregateSection(cycle, result))
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
  // #4184: mescla os mapas de TODOS os ciclos mensais presentes na janela —
  // a tabela agregada soma cliques cross-ciclo por natureza, então a seção
  // também é resolvida na união (ver limitação documentada em mergeLinkSectionMaps).
  const mergedLinkSectionMap = linkSectionsByCycle
    ? mergeLinkSectionMaps(Object.values(linkSectionsByCycle))
    : null;
  // #4198: mesmo racional — a tabela agregada soma cliques cross-ciclo, então
  // o título editorial também é resolvido na união de todos os ciclos.
  const mergedLinkTitleMap = linkTitlesByCycle
    ? mergeLinkTitleMaps(Object.values(linkTitlesByCycle))
    : null;
  // #4405: seleção de edição content-disambiguated (`resolveCampaignCycle` —
  // resolve o achado do `grupo:novos`, ver Fase 0) calculada UMA vez e
  // reusada em 2 lugares: o label da tabela HISTÓRICA logo abaixo (em vez de
  // duplicar a resolução mais fraca — só-nome — de `deriveLinksSectionTitle`,
  // que existe só como FALLBACK pra quando nenhuma campanha tem ciclo
  // resolvido de jeito nenhum) e a tabela ESCOPADA À EDIÇÃO mais abaixo.
  // Sem isso as 2 tabelas podiam divergir sobre qual é "a edição mais
  // recente" (achado ao vivo: `grupo:novos-260731` tem o `sentDate` mais
  // recente da janela mas o NOME aponta pro ciclo errado — só a
  // desambiguação por conteúdo acerta).
  const latestEdition = selectLatestEditionCampaigns(campaigns, linkSectionsByCycle);
  const edicaoLabel = latestEdition?.cycle ?? deriveLinksSectionTitle(campaigns);
  const aggregatedLinks = aggregateLinksAcrossCampaigns(campaigns, mergedLinkSectionMap, mergedLinkTitleMap);
  // #3081: campaignCount = tamanho da janela agregada (campaigns.length) — o
  // título reflete a janela real, não implica que os dados são de 1 edição só.
  const aggregatedLinksSection = renderAggregatedLinksSection(aggregatedLinks, edicaoLabel, campaigns.length);

  // #4405: tabela ESCOPADA À EDIÇÃO mais recente (ciclo de conteúdo INTEIRO —
  // todas as ondas: ramp-warm, grupos nomeados, células A/B/C — decisão do
  // editor 260731), injetada ANTES da tabela histórica acima. Usa o mapa do
  // ciclo EXATO da edição (nunca o merge cross-ciclo de `mergedLinkSectionMap`
  // — a limitação documentada em `mergeLinkSectionMaps` não se aplica aqui,
  // já que não há mais de um ciclo envolvido). A tabela histórica continua
  // existindo tal como está — o editor pediu as duas, não a substituição de
  // uma pela outra.
  const editionSectionMap = latestEdition ? linkSectionsByCycle?.[latestEdition.cycle] ?? null : null;
  const editionTitleMap = latestEdition ? linkTitlesByCycle?.[latestEdition.cycle] ?? null : null;
  const editionLinks = latestEdition
    ? aggregateLinksAcrossCampaigns(latestEdition.campaigns, editionSectionMap, editionTitleMap)
    : [];
  // Sem edição detectável (nenhuma campanha com ciclo mensal resolvido) →
  // seção OMITIDA (nunca um stub vazio redundante com a tabela histórica
  // logo abaixo, que já cobre esse caso) — só a histórica aparece.
  const editionLinksSection = latestEdition
    ? renderAggregatedLinksSection(
        editionLinks,
        latestEdition.cycle,
        null, // nunca "janela de N campanhas" aqui — este bloco É a edição
        latestEdition.campaigns.length,
        "links-edicao",
      )
    : "";
  // #4405: "Seções mais clicadas" — resumo por seção, MESMO escopo da tabela
  // da edição acima (não da histórica) — pedido do editor: ver a
  // performance por seção da edição mais recente, não diluída por meses de
  // histórico. Mesma omissão sem edição detectável.
  const sectionClicksSection = latestEdition
    ? renderSectionClicksSection(aggregateClicksBySection(editionLinks), latestEdition.cycle)
    : "";
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
  // #4165/#4173: opts.studioMode troca o stub null pro aviso "indisponível localmente".
  const cohortsSection = renderEngagementCohortsSection(cohorts, nowDate, opts);
  // #2736: "Status MillionVerifier por grupo" removida da aba Engajamento
  // (ruído, decisão do editor). renderMvStatusSection permanece exportada e
  // testada (reuso futuro); a leitura do KV mv:status em readKvTabs também
  // fica (custo desprezível, já paralela às outras — reverter é maior cirurgia
  // do que o pedido pede; ver corpo do PR).
  // #2653: sumário do store único de contatos (pré-computado via KV).
  const contactsSummarySection = renderContactsSummarySection(contactsSummary, nowDate);
  // #2864: aba Cohorts — comparativo de envio/engajamento por cohort. Deriva
  // de contactsSummary (mesmo payload KV de Contatos, campo cohort_stats
  // opcional) — sem parâmetro novo na assinatura desta função. #4406: a linha
  // "Jurídico" (cohort virtual) já vem dentro de cohort_stats — sem seção
  // separada.
  const cohortsTabSection = renderCohortsTabPanel(contactsSummary?.cohort_stats);
  // #2738: engajamento do poll "É IA?" por edição (pré-computado via KV).
  // #4165/#4173: opts.studioMode troca o stub null pro aviso + o botão de
  // refresh (que 405a servido pelo Studio) por um link pro dashboard Cloudflare.
  const eiaEngagementSection = renderEiaEngagementSection(eiaEngagement, nowDate, opts);
  // #2718: tab de cupons Stripe (apenas quando couponUsage não é null — PII-gated).
  // #4165/#4173: em opts.studioMode, um couponUsage null NÃO omite mais a aba
  // inteira sem explicação (era o bug do #4173) — mostra o aviso no lugar do
  // conteúdo PII-gated (showCuponsTab decide se a aba existe, ver template abaixo).
  const couponTabHtml = couponUsage
    ? renderCouponTabPanel(couponUsage, nowDate)
    : (opts.studioMode ? renderKvUnavailableNote("panel-cupons") : "");
  const showCuponsTab = couponUsage !== null || opts.studioMode === true;
  // #4515: aba brevo_diaria — canal Brevo PRÓPRIO do editor, conta SEPARADA
  // da Clarice. `opts.brevoDiaria` ausente/`null` (default — nenhum caller
  // pré-#4515 passa isto) → aba oculta, preservando EXATAMENTE o
  // comportamento anterior. Presente (mesmo com `campaigns: []`/erro) → aba
  // aparece com o banner apropriado (ver renderBrevoDiariaTabPanel).
  const showBrevoDiariaTab = opts.brevoDiaria != null;
  const brevoDiariaSection = showBrevoDiariaTab ? renderBrevoDiariaTabPanel(opts.brevoDiaria!) : "";
  // #3415: variante scoped só pra Visão Geral — mesmo painel, header "Total
  // por mês" → "Cupons" (rename que não pode vazar pra aba Cupons, fonte
  // compartilhada — ver renderCouponTabPanel opts.monthlyTitle).
  const couponVisaoGeralHtml = couponUsage ? renderCouponTabPanel(couponUsage, nowDate, { monthlyTitle: "Cupons" }) : "";
  // #2974: aba "Rampa"/Agendamento — plano de envio semanal (maturação >48h →
  // agregado → semáforo → 3 volumes) + #3010: campanhas agendadas (`scheduled`)
  // logo abaixo da recomendação dos próximos 3 envios.
  const weeklyPlanSection = renderWeeklyPlanTabPanel(campaigns, nowDate, scheduled, postmasterSpam);
  // #3884: registro "Experimento vigente" (regras do protocolo, sempre visível
  // — pedido do editor) + painel de avaliação por experimento (pareamento A/B,
  // acumulado por braço, z-test, guardrails, conversões manuais). Seção nova
  // na aba Agendamento/Rampa (issue deixou a critério da implementação "aba
  // nova ou seção na aba Rampa" — seção escolhida por menor blast radius).
  const experimentRegistrySection = renderExperimentRegistrySection(EXPERIMENTS);
  const experimentEvalSections = renderExperimentsEvaluationSections(campaigns, EXPERIMENTS);
  // #3415: peças fatiadas do mesmo cálculo (computeWeeklySendState
  // compartilhado em weekly-plan.ts) pro reorg Passado/Presente/Futuro da
  // Visão Geral — "Saúde" (Passado), "Recomendação" + agendados (Futuro),
  // "Melhores dias" (Presente). Nunca duplicam a lógica de semáforo/plano.
  const healthVisaoGeralSection = renderHealthSection(campaigns, nowDate, { title: "Saúde" }, postmasterSpam);
  const recommendationVisaoGeralSection = renderRecommendationSection(campaigns, nowDate);
  const scheduledVisaoGeralSection = renderScheduledSection(scheduled);
  const weekdaysVisaoGeralInner = renderTopWeekdaysSection(campaigns, nowDate);
  const weekdaysVisaoGeralSection = weekdaysVisaoGeralInner
    ? `<section class="phase2-section" id="weekly-plan-weekdays">${weekdaysVisaoGeralInner}</section>`
    : "";

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
    /* #3323: variante de --brand escurecida SÓ pra este dashboard — não é
       token canônico do DS (não entra em design-tokens.ts). Existe unicamente
       pra td.metric passar AA em texto pequeno sem cair pra --ink puro. Ver
       comentário completo na regra td.metric abaixo. */
    --metric-teal: #007A7A;
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
  /* #3088: valores numéricos de destaque (td.metric) tinham ido pra --ink —
     teal original (--brand, #00A0A0) media ~3.2:1 sobre --card, abaixo do
     mínimo AA (4.5:1) pra texto normal nesse tamanho (14.4px/600, não é
     "large text"). Teal fica reservado a elementos GRÁFICOS (links, barra de
     progresso, estado ativo de abas — 3:1 é aceitável pra esses por SC
     1.4.11, não pra texto).

     #3323 (investigado, resolvido com nova cor — não é revert nem --ink puro):
     editor reportou "números da Visão Geral ficaram pretos" e pediu recuperar
     alguma distinção visual. O --brand original (#00A0A0) segue inviável (ver
     acima). Fix: --metric-teal (#007A7A, definida no :root acima) — variante
     ESCURECIDA de --brand, mede ~5.17:1 sobre --card (branco), passa AA com
     folga confortável. É um token LOCAL deste dashboard, não canônico do DS
     (não entra em design-tokens.ts) — ponderado e descartado ajustar --ink
     globalmente pra abrir uma faixa de teal viável nos 2 extremos claro/escuro
     simultaneamente: exigiria luminância do --ink ≤0.0019 (hoje 0.0072,
     ~4x mais escuro que o #171411 atual, praticamente preto puro) — mudança
     de identidade de marca (--ink é usado em toda newsletter diária/mensal,
     web e e-mail), desproporcional a uma célula de dashboard interno. */
  td.metric { font-weight: 600; color: var(--metric-teal); }
  td.alert { font-weight: 600; color: var(--alert); }
  td.alert small, td.alert .rate-inline { color: var(--alert); opacity: 1; }
  .alert-label { font-weight: 600; color: var(--alert); }
  /* #2880: linha Total das tabelas do store — destacada, borda superior. */
  tr.total-row td { font-weight: 700; border-top: 2px solid var(--rule); }
  /* #4256: subtotais "Score positivo"/"Score negativo" do histograma de
     priority_points — visualmente distintos das linhas de valor exato
     (itálico, sem o peso/borda da linha Total) mas ainda separados por uma
     borda fina, já que ficam entre as faixas e a linha Total. */
  tr.subtotal-row td { font-style: italic; border-top: 1px solid var(--rule); }
  /* #3084: nowrap evita quebra em várias linhas em telas estreitas (usado
     pelo parêntese "sem MPP" da tabela A/B/C por audiência, sections-kv.ts). */
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
  /* #3408: divisor de agrupamento narrativo (Passado/Presente) na Visão Geral
     — acima de .section-title (h2) em hierarquia visual, pra sinalizar que
     as seções seguintes pertencem a um bloco temático diferente. Só existe
     dentro de #panel-visaogeral. */
  .narrative-group-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; color: var(--brand); opacity: 0.9; margin: 40px 0 4px 0; }
  .narrative-group-title:first-child { margin-top: 0; }
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
  /* #4053: reset explícito — sem isso, a regra global .table-wrap th:first-child
     (sticky da 1ª coluna, ver acima) vaza pro <th> "Conteúdo" e deixa só ele
     com fundo --paper-alt, quebrando a cor uniforme do cabeçalho. */
  .links-table th:first-child { position: static; background: transparent; }
  .links-table td.link-url { max-width: 420px; word-break: break-all; }
  .links-table td.link-url a { color: var(--brand); text-decoration: none; }
  .links-table td.link-url a:hover { text-decoration: underline; }
  /* #3088: contagens de link (13px/600) — mesmo motivo do td.metric acima. */
  .links-table td.link-clicks { font-weight: 600; color: var(--ink); }
  .links-table td.link-pct { opacity: 0.75; }
  /* #4184: evita quebra em 2 linhas de rótulos curtos ("Use Melhor"). */
  .links-table td.link-section { white-space: nowrap; }
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
  /* #3129: Resumo A/B/C mensal por data — colapsado por padrão (details.links-ctr
     reusado). Ganha margin-top próprio porque, ao virar filho do <details> em vez
     de sibling direto, o 1º <section class="phase2-section"> lá dentro deixa de
     casar com a regra .phase2-section + .phase2-section (linha acima) — perderia a
     régua/respiro que separa das seções anteriores (abcSection/abcAudienceSection). */
  details.abc-summary-monthly-group { margin-top: 32px; }
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
  #tab-envios:checked ~ .tab-bar label[for="tab-envios"],
  #tab-engajamento:checked ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:checked ~ .tab-bar label[for="tab-links"],
  #tab-contatos:checked ~ .tab-bar label[for="tab-contatos"],
  #tab-rampa:checked ~ .tab-bar label[for="tab-rampa"],
  #tab-brevodiaria:checked ~ .tab-bar label[for="tab-brevodiaria"],
  #tab-cupons:checked ~ .tab-bar label[for="tab-cupons"] {
    background: var(--paper); border-color: var(--rule); opacity: 1;
    color: var(--brand); border-bottom-color: var(--paper);
  }
  /* Foco de teclado: o radio focado projeta um contorno no seu label irmão. */
  #tab-visaogeral:focus-visible ~ .tab-bar label[for="tab-visaogeral"],
  #tab-envios:focus-visible ~ .tab-bar label[for="tab-envios"],
  #tab-engajamento:focus-visible ~ .tab-bar label[for="tab-engajamento"],
  #tab-links:focus-visible ~ .tab-bar label[for="tab-links"],
  #tab-contatos:focus-visible ~ .tab-bar label[for="tab-contatos"],
  #tab-rampa:focus-visible ~ .tab-bar label[for="tab-rampa"],
  #tab-brevodiaria:focus-visible ~ .tab-bar label[for="tab-brevodiaria"],
  #tab-cupons:focus-visible ~ .tab-bar label[for="tab-cupons"] {
    outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1;
  }
  .tab-panel { display: none; padding-top: 8px; }
  #tab-visaogeral:checked ~ .tab-panels #panel-visaogeral,
  #tab-envios:checked ~ .tab-panels #panel-envios,
  #tab-engajamento:checked ~ .tab-panels #panel-engajamento,
  #tab-links:checked ~ .tab-panels #panel-links,
  #tab-contatos:checked ~ .tab-panels #panel-contatos,
  #tab-rampa:checked ~ .tab-panels #panel-rampa,
  #tab-brevodiaria:checked ~ .tab-panels #panel-brevodiaria,
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
<p class="sub">Últimas ${campaigns.length} campaigns. ${dataFreshnessLine}</p>

<!-- #2542: tab state inputs (hidden, CSS-only — sem JS externo) -->
<!-- #3406: "Visão geral" agora é o resumo curado (reunião de parceria); o
     conteúdo antigo (totais + volume + tabela de envios) virou a aba "Envios". -->
<input type="radio" class="tab-radios" name="dash-tab" id="tab-visaogeral" checked>
<input type="radio" class="tab-radios" name="dash-tab" id="tab-envios">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-rampa">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-engajamento">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-links">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-contatos">
${showBrevoDiariaTab ? '<input type="radio" class="tab-radios" name="dash-tab" id="tab-brevodiaria">' : ''}
${showCuponsTab ? '<input type="radio" class="tab-radios" name="dash-tab" id="tab-cupons">' : ''}

<!-- tab bar (labels referencing the radio inputs above; aria-controls liga aba↔painel) -->
<div class="tab-bar" role="tablist">
  <label class="tab-label" id="tablabel-visaogeral" for="tab-visaogeral" role="tab" aria-controls="panel-visaogeral">Visão Geral</label>
  <label class="tab-label" id="tablabel-envios" for="tab-envios" role="tab" aria-controls="panel-envios">Envios</label>
  <label class="tab-label" id="tablabel-rampa" for="tab-rampa" role="tab" aria-controls="panel-rampa">Agendamento</label>
  <label class="tab-label" id="tablabel-engajamento" for="tab-engajamento" role="tab" aria-controls="panel-engajamento">Engajamento</label>
  <label class="tab-label" id="tablabel-links" for="tab-links" role="tab" aria-controls="panel-links">Links / Cliques</label>
  <label class="tab-label" id="tablabel-contatos" for="tab-contatos" role="tab" aria-controls="panel-contatos">Contatos</label>
  ${showBrevoDiariaTab ? '<label class="tab-label" id="tablabel-brevodiaria" for="tab-brevodiaria" role="tab" aria-controls="panel-brevodiaria">brevo_diaria</label>' : ''}
  ${showCuponsTab ? '<label class="tab-label" id="tablabel-cupons" for="tab-cupons" role="tab" aria-controls="panel-cupons">Cupons</label>' : ''}
</div>

<!-- tab panels -->
<div class="tab-panels">

  <!-- Aba 0: Visão Geral — resumo curado pra reunião de parceria (#3406,
       reorganizado em #3408, e novamente em #3415): 3 blocos narrativos,
       passado → presente → futuro. Reaproveita seções já computadas pras
       outras abas (mesmas variáveis, zero fetch extra) — gera IDs de elemento
       duplicados entre abas (ex: "monthly-totals", "volume-ciclo"), aceito
       porque nenhum script do dashboard usa getElementById/querySelector
       nesses ids específicos. #3408: só a tabela Agregada do resumo A/B/C
       aparece aqui (abcAudienceAggregateSection) — Fria/Quente continuam só
       na aba Engajamento (abcAudienceSection, sem mudança). #3415: o bundle
       completo da aba Agendamento (weekly-plan) NÃO é mais reaproveitado
       inteiro aqui — health/recomendação/agendados/melhores-dias são peças
       extraídas (renderHealthSection/renderRecommendationSection/
       renderScheduledSection/renderTopWeekdaysSection), cada uma no bloco
       narrativo certo; os headers "Saúde"/"Cupons" são renames SCOPED só
       desta aba (opts.title/opts.monthlyTitle), a fonte compartilhada
       (aba Agendamento/Cupons) mantém os títulos originais. -->
  <div class="tab-panel" id="panel-visaogeral" role="tabpanel" aria-labelledby="tablabel-visaogeral">
<h3 class="narrative-group-title">Passado — o que foi executado</h3>
${monthlyTotalsSection}
${healthVisaoGeralSection}
<h3 class="narrative-group-title">Presente — estado atual</h3>
${volumeSection}
${couponVisaoGeralHtml}
${abcAudienceAggregateSection}
${weekdaysVisaoGeralSection}
<h3 class="narrative-group-title">Futuro — próximos passos</h3>
${recommendationVisaoGeralSection}
${scheduledVisaoGeralSection}
  </div><!-- /panel-visaogeral -->

  <!-- Aba 1: Envios — totais mensais + volume + tabela de envios (#3406: ex-"Visão geral", renomeada; #3010: agendados moveu pra aba Agendamento) -->
  <div class="tab-panel" id="panel-envios" role="tabpanel" aria-labelledby="tablabel-envios">
${monthlyTotalsSection}
${volumeSection}
${unclassifiedNote}
${groupMissingCellNote}
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
  </div><!-- /panel-envios -->

  <!-- Aba Agendamento: plano de envio semanal cold (#2974) -->
  <div class="tab-panel" id="panel-rampa" role="tabpanel" aria-labelledby="tablabel-rampa">
${weeklyPlanSection}
${experimentRegistrySection}
${experimentEvalSections}
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
${sectionClicksSection}
${editionLinksSection}
${aggregatedLinksSection}
  </div><!-- /panel-links -->

  <!-- Aba 4: Contatos — sumário do store único (#2653) -->
  <div class="tab-panel" id="panel-contatos" role="tabpanel" aria-labelledby="tablabel-contatos">
${contactsSummarySection}
${cohortsTabSection}
  </div><!-- /panel-contatos -->

${showBrevoDiariaTab ? `  <!-- Aba brevo_diaria: canal Brevo PRÓPRIO do editor (#4515), conta SEPARADA da Clarice -->
  <div class="tab-panel" id="panel-brevodiaria" role="tabpanel" aria-labelledby="tablabel-brevodiaria">
${brevoDiariaSection}
  </div><!-- /panel-brevodiaria -->` : ''}

${showCuponsTab ? `  <!-- Aba 5: Cupons — uso de cupons Stripe (#2718, PII-gated; #4165/#4173: aviso em vez de sumir quando null em studioMode) -->
  <div class="tab-panel" id="panel-cupons" role="tabpanel" aria-labelledby="tablabel-cupons">
${couponTabHtml}
  </div><!-- /panel-cupons -->` : ''}

</div><!-- /tab-panels -->

<p class="footer">Dados com cache de até 5 min — <a href="?fresh=1" style="color:var(--brand)">?fresh=1</a> força atualização imediata.<br>
Open rate calculado sobre <em>delivered</em>; CTOR = cliques únicos ÷ <em>aberturas</em> (opens); bounce, unsub e spam sobre <em>sent</em>. Em cada coluna de métrica, a linha de cima é a taxa e a linha de baixo é o count absoluto. Passe o mouse nos headers pra ver detalhes de cada coluna.<br>
Em Opens, a taxa à esquerda é o total (com Apple MPP e bots, como na Brevo Web UI); entre parênteses (quando há dado de MPP), a taxa sem Apple MPP (ainda pode incluir outros bots) e, quando disponível, a taxa trackable — aberturas com pixel real (trackableViews ÷ delivered), sinal mais limpo de engajamento real por excluir MPP e outros bots que não disparam pixel. Dados brutos em <code>/api/campaigns</code>.<br>
Cells em <span class="alert-label">vermelho</span> indicam que a métrica cruzou o threshold de circuit breaker (open <15%, bounce hard ≥2% ou total ≥5%, unsub ≥3%). <strong>Vermelho sempre significa "ruim"</strong> em toda a página — inclusive na aba Contatos, tabela Cohorts, onde o critério é desvio desfavorável de mais de ${COHORT_DEVIATION_THRESHOLD_PP}pp da média da coluna em vez de circuit breaker (ver nota da própria tabela). Spam (nesta tabela) NUNCA é colorida — o número vem da Brevo/complaints, que subconta o spam real em ~50× (#4063); o breaker de spam de verdade é a leitura do Google Postmaster Tools, na aba Rampa.</p>
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
      "Aberturas únicas. Inclui Apple MPP e bots/proxies. Bench: 15-25% B2C, 30-45% engajadas.",
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
  {
    label: "Spam",
    tooltip:
      "Marcações de spam via complaints da Brevo — subconta o spam real em ~50× (#4063), NUNCA colorida aqui. O breaker de verdade é a leitura do Google Postmaster Tools na aba Rampa.",
  },
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
 * #3092: um ciclo mensal "AAMM-MM" (conteúdo-envio, ver CLAUDE.md — os 4
 * primeiros dígitos são ano+mês de CONTEÚDO, os 2 últimos são só o MÊS de
 * ENVIO) é opaco pro editor à primeira vista ("edição 2607-07" não comunica
 * nada de imediato). Formata o sufixo legível do mês/ano de ENVIO — a janela
 * que de fato aparece nas linhas da tabela — ex: "envios de jul/2026". `null`
 * quando `cycle` não bate o formato esperado, OU quando viola o invariante
 * real do ciclo (achado do /code-review max no PR #3171: a versão anterior só
 * validava que cada parte estava em 1-12, sem checar que envio É o mês
 * seguinte ao conteúdo — um "2607-07" (mesmo mês) ou "2612-11" (envio ANTES
 * do conteúdo) produzia um sufixo confiante mas ERRADO em vez de cair pro
 * fallback sem sufixo). `cycle` vem de regex sobre nome de campanha Brevo
 * (`parseAbcAudienceCampaign`), não validado na origem — mesmo invariante de
 * `isValidCycle` em scripts/lib/clarice-paths.ts (`sendMonth === (contentMonth
 * % 12) + 1`), não importável aqui (usa node:fs, não é Workers-safe) —
 * reimplementado inline.
 */
export function formatCycleEnvioLabel(cycle: string): string | null {
  const m = /^(\d{2})(\d{2})-(\d{2})$/.exec(cycle);
  if (!m) return null;
  const contentYY = Number(m[1]);
  const contentMM = Number(m[2]);
  const envioMM = Number(m[3]);
  if (contentMM < 1 || contentMM > 12 || envioMM < 1 || envioMM > 12) return null;
  // Invariante real do ciclo: envio é SEMPRE o mês imediatamente seguinte ao
  // conteúdo (mod 12) — qualquer outra relação é um ciclo malformado.
  if (envioMM !== (contentMM % 12) + 1) return null;
  // Só vira o mês seguinte (dez → jan) quando o conteúdo é dezembro — a
  // igualdade acima já garante que não há outro caso de wrap possível.
  const envioYearOffset = contentMM === 12 ? 1 : 0;
  const envioFullYear = 2000 + contentYY + envioYearOffset;
  return `envios de ${PT_MONTHS_ABBR[envioMM - 1]}/${envioFullYear}`;
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
  /** Open rate agregado MPP-inclusivo (totalViews / totalDelivered) */
  openRate: number;
  /**
   * #3124: soma de uniqueClicks (cliques únicos) das campanhas da célula —
   * base do critério decisório real desde #2976 (clique, não abertura).
   */
  totalClicks: number;
  /**
   * #3124: click rate agregado (totalClicks / totalDelivered) — critério que
   * de fato decide o teste A/B/C (#2976), não mais só open rate. Antes desta
   * revisão, `renderAbcSection` coroava `▲ LÍDER` só por open rate MPP-inclusivo
   * enquanto `renderAbcAudienceSection` (#2976) já decidia por clique —
   * divergência observada em produção no ciclo 2606-07 (abertura dava A, clique
   * dava B).
   */
  clickRate: number;
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
 * Agrega resumo A/B/C das campanhas de um ciclo Clarice.
 * Usa apenas campanhas com status "sent" e stats reais (gs.sent > 0).
 * Exportado pra teste unitário.
 *
 * #3081 (review): `parseClariceCampaignKey` é tentado primeiro — preserva
 * 100% do comportamento anterior pro caso warm (diário E mensal, idêntico ao
 * código antigo). SÓ quando ele não reconhece o nome, cai pro fallback
 * `parseAbcAudienceCampaign`, que cobre o teste mensal COLD (naming
 * "cold AAMM-MM — X") e, desde #4447, o naming do fluxo `--group`
 * (célula só na LISTA de destinatários) — ambos tratados como `monthly:true`
 * (sem corte de dia, mesmo tratamento que o mensal warm já recebia). Sem
 * filtrar por `audience` aqui (restrição removida em #4447): esta função só
 * precisa de cycle+cell pro bucket por dia — a separação cold/warm é feita à
 * parte em `aggregateAbcByAudience`, que já recebe `listName`. Sem o
 * fallback, `groupMonthlyAbcTests` (que já reconhece cold e `--group`)
 * formava o grupo mas esta função zerava todas as células dele — a seção
 * "Resumo A/B/C — Mensal" de um ciclo sem nenhuma campanha "Clarice News..."
 * renderizava vazia (`renderAbcSection` retorna "" quando
 * `every(r => r.campaignCount === 0)`), o mesmo sintoma reaparecendo a cada
 * naming novo (#3081 → #4447).
 *
 * #3123: a janela de dias (só relevante pro teste DIÁRIO — o mensal é 1
 * campanha por célula, sem `dayNum`, #2889) é DERIVADA dos dados em vez de
 * hardcoded d01–d07. O playbook real do editor consolida a célula vencedora
 * no MEIO da janela (ex: ciclo 2605 — A dropada ~d03 via #2182, C absorvida
 * pela B em d06/d07 via `clarice-drop-c-to-b.ts`): um dia só entra na
 * agregação quando ≥2 células distintas têm campanha com stats reais NAQUELE
 * dia — cobre tanto drop de célula (dias após o drop com só 1 célula
 * remanescente ficam de fora) quanto consolidação no vencedor (dias "solo"
 * pós-consolidação, só 1 célula, também ficam de fora — não enviesam o
 * comparativo). Ciclos onde A/B/C rodam a janela inteira sem drop/consolidação
 * mantêm o comportamento anterior (nenhum dia excluído).
 */
export function aggregateAbcSummary(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
): CellSummary[] {
  const cells: Record<
    "A" | "B" | "C",
    {
      views: number;
      delivered: number;
      clicks: number;
      count: number;
      organicViews: number;
      organicDays: number;
    }
  > = {
    A: { views: 0, delivered: 0, clicks: 0, count: 0, organicViews: 0, organicDays: 0 },
    B: { views: 0, delivered: 0, clicks: 0, count: 0, organicViews: 0, organicDays: 0 },
    C: { views: 0, delivered: 0, clicks: 0, count: 0, organicViews: 0, organicDays: 0 },
  };

  interface Entry {
    cell: "A" | "B" | "C";
    dayNum: number;
    monthly: boolean;
    c: BrevoCampaign & { listName?: string; listSize?: number };
  }
  const entries: Entry[] = [];

  for (const c of campaigns) {
    const warm = parseClariceCampaignKey(c.name);
    // #4447: agora QUE passa c.listName — o branch #3128 (cold via listName)
    // continua inalcançável daqui pelo mesmo motivo de antes (`warm` já
    // falsy), mas o novo branch `--group` (célula só na LISTA, ver
    // parseAbcAudienceCampaign) É alcançável e precisa do listName pra
    // resolver. Sem filtrar por audience: esta função só precisa de
    // cycle+cell pro bucket por dia — a separação cold/warm é feita à parte
    // em aggregateAbcByAudience (aggregateCellsV2), que já recebe listName.
    const fallback = warm ? null : parseAbcAudienceCampaign(c.name, c.listName);
    const parsed =
      warm ??
      (fallback
        ? { cycle: fallback.cycle, dayNum: 0, cell: fallback.cell as "A" | "B" | "C" | null, monthly: true }
        : null);
    if (!parsed || parsed.cycle !== cycle) continue;
    // #2360: cell=null = envio único (sem sufixo A/B/C) — não participa do A/B/C.
    if (parsed.cell === null) continue;
    // S1 é uma janela de NEGÓCIO real (7 dias — ver CLARICE_PLAN_S1 acima,
    // "Volume do bloco S1 (d01–d07 A/B/C)"), não um artefato só pra evitar
    // dias solo. Achado do /code-review (angle "wrapper/proxy correctness"):
    // sem este cap, um dNN>7 com ≥2 células ainda ativas seria absorvido
    // silenciosamente na seção "Resumo A/B/C — S1", misturando S2/S3 (fases
    // distintas da rampa, população diferente) com o teste S1. Mantido do
    // código original — só o corte DENTRO da janela (dias solo por drop/
    // consolidação) é que agora é derivado, não o teto da janela em si.
    if (!parsed.monthly && parsed.dayNum > 7) continue;
    entries.push({ cell: parsed.cell, dayNum: parsed.dayNum, monthly: parsed.monthly, c });
  }

  // #3123: dentro da janela S1 (d01–d07), o corte de dias SOLO (drop de
  // célula / consolidação no vencedor) é derivado dos dados. Mapeia dayNum →
  // Set de células com CAMPANHA naquele dia (só entradas DIÁRIAS; mensal não
  // tem corte de dia).
  //
  // Self-review (achado do angle "language-pitfall" no /code-review do PR):
  // este mapa é construído a partir de `entries` ANTES do filtro de
  // `pickStats` — de propósito. Se computássemos a validade do dia só sobre
  // campanhas com stats REAIS, uma falha transiente de fetch de stats de UMA
  // célula (ex: 429 da Brevo) faria aquele dia parecer "solo" e derrubaria
  // também o dado perfeitamente válido da célula IRMÃ no mesmo dia. A
  // presença de uma CAMPANHA (independente de stats terem chegado) já basta
  // pra provar que o dia foi um dia de teste multi-célula de verdade.
  const cellsByDay = new Map<number, Set<"A" | "B" | "C">>();
  for (const e of entries) {
    if (e.monthly) continue;
    if (!cellsByDay.has(e.dayNum)) cellsByDay.set(e.dayNum, new Set());
    cellsByDay.get(e.dayNum)!.add(e.cell);
  }
  // Achado do angle "altitude" no /code-review: gatear em "≥2 letras de
  // célula distintas apareceram EM QUALQUER LUGAR do ciclo" (checagem antiga)
  // é mais fraco do que o que o próprio filtro por dia já mede — um ciclo
  // genuinamente solo (1 célula só, #2360) com UMA campanha isolada mal-
  // rotulada (typo de nome, resend manual) já dispararia o filtro cycle-wide
  // mesmo sem nenhum dia real de co-ocorrência. O gate certo é perguntar
  // exatamente a mesma coisa que o filtro por dia mede: existe ALGUM dia com
  // ≥2 células reais co-ocorrendo? Se não (ciclo solo, OU handoff sequencial
  // tipo célula A só d01 trocada pela B a partir de d02 sem nunca coexistir —
  // diferente do padrão drop/consolidação que este fix mira), zerar tudo via
  // `validDays` vazio seria pior que não filtrar — cai pro fallback de
  // incluir todos os dias.
  const anyDayHasMultipleCells = [...cellsByDay.values()].some((s) => s.size >= 2);
  const validDays = anyDayHasMultipleCells
    ? new Set([...cellsByDay.entries()].filter(([, s]) => s.size >= 2).map(([day]) => day))
    : new Set(cellsByDay.keys());

  for (const e of entries) {
    if (!e.monthly && !validDays.has(e.dayNum)) continue; // dia solo (drop/consolidação) — fora

    // #2254/#2252: só campanhas com stats reais contam pro total (a janela
    // acima já não depende mais disso — ver comentário de cellsByDay).
    const picked = pickStats(e.c);
    if (!picked) continue;
    const { stats: s, isGlobal } = picked;

    // #2258: base canônica = uniqueViews (MPP-INCLUSIVO). campaignStats.uniqueViews
    // TAMBÉM inclui MPP (verificado 2026-06-14) → usar direto é homogêneo entre as
    // fontes e bate com a UI da Brevo (#2257). O bug do #2253 era subtrair MPP só
    // do globalStats e não do campaignStats (que não expõe appleMppOpens) → no
    // fallback gerava número "orgânico" que na verdade era MPP-incl → impossível.
    cells[e.cell].views += s.uniqueViews ?? 0;
    cells[e.cell].delivered += s.delivered ?? 0;
    // #3124: soma de cliques únicos — base do click rate (critério decisório real, #2976).
    // #3398 (revertido 260713): uniqueClicks já vem sem clique de unsubscribe direto
    // da Brevo (confirmado contra a UI oficial, campanha #89 — uniqueClicks e
    // unsubscriptions são campos independentes). Não subtrair nada.
    cells[e.cell].clicks += s.uniqueClicks ?? 0;
    cells[e.cell].count += 1;

    // #2257: orgânico (sem MPP) só de globalStats (tem appleMppOpens). Contamos
    // organicDays p/ saber se TODOS os dias da célula têm orgânico — só então é
    // comparável entre as células (mesma base); senão organicOpenRate = null.
    if (isGlobal) {
      const gs = s as BrevoGlobalStats;
      cells[e.cell].organicViews += Math.max(0, (gs.uniqueViews ?? 0) - (gs.appleMppOpens ?? 0));
      cells[e.cell].organicDays += 1;
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
      totalClicks: d.clicks,
      clickRate: d.delivered > 0 ? (d.clicks / d.delivered) * 100 : 0,
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
    const parsed = parseAbcAudienceCampaign(c.name, c.listName);
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
 * padrão "Clarice News ..." já reconhecido por `parseClariceCampaignKey`, ou
 * (#3376) o naming do Digest Mensal "Diar.ia Mensal {AAMM} — {timestamp}".
 * Retorna `null` quando o naming não bate com nenhum dos três padrões.
 */
export function classifyClariceAudience(campaignName: string): ClariceAudience | null {
  const trimmed = campaignName.trim();
  if (/^cold\b/i.test(trimmed)) return "cold";
  if (parseClariceCampaignKey(trimmed)) return "warm";
  // #3376: Digest Mensal ("Diar.ia Mensal {AAMM} — {timestamp}[ — Teste N]",
  // ver scripts/publish-monthly.ts:570) usa naming próprio, fora do padrão
  // "Clarice News ..." — mas consome créditos do mesmo plano Brevo e deve
  // contar no volume do ciclo. Sem segmentação fria/quente documentada pro
  // Mensal (a lista de destinatários já filtra isso na composição das waves)
  // — trata como "warm". Não passa por parseClariceCampaignKey de propósito:
  // esse naming não tem célula A/B/C nem dayNum, então não deve entrar em
  // aggregateAbcSummary/detectActiveCycle (testes diários) nem em
  // groupMonthlyAbcTests (que usa parseAbcAudienceCampaign, não este).
  if (/^Diar\.ia Mensal \d{4}\s*[—–-]\s*/i.test(trimmed)) return "warm";
  // #4255: fluxo `--group` (scripts/clarice-schedule-group.ts:162,
  // `campaignNameFor` — "Clarice {yymm} grupo:{key}", ex: "Clarice 2606
  // grupo:envio11"). `workers/` não importa de `scripts/` (bundle do
  // Worker não alcança o diretório raiz do repo, mesma restrição já
  // documentada no espelho do worker `poll`), então o padrão fica
  // ESPELHADO aqui — se `campaignNameFor` mudar de shape, o teste que fixa
  // a string exata (`clarice-schedule-group.test.ts`) e o teste deste
  // regex (#4255) devem quebrar juntos, não silenciosamente divergir.
  // Terceira ocorrência da mesma classe de bug (#3076, #4082 item 2): antes
  // desta linha, `calcCumulativeSentInBillingWindow` descartava toda
  // campanha `grupo:` por não bater em nenhum padrão reconhecido —
  // 14.809 envios (8.005 + 6.804) sumiam do Volume do ciclo (e do
  // denominador `planTotal`, que soma `planCredits + cumulativeSent`,
  // ver `renderVolumeSection` em sections-kv.ts) sem nenhum sinal de erro.
  // Sem segmentação fria/quente documentada pro fluxo `--group` (a lista
  // de destinatários já filtra isso na composição do grupo, mesmo
  // racional do Digest Mensal acima) — trata como "warm".
  if (/^Clarice \d{4} grupo:/.test(trimmed)) return "warm";
  return null;
}

/**
 * Parseia uma campanha de teste A/B/C (fria OU quente) do naming pra extrair
 * ciclo + célula, independente de audiência. Reusa `parseClariceCampaignKey`
 * pro caso quente (mensal, "Clarice News AAMM-MM — X"); implementa um parser
 * paralelo pro caso frio ("cold AAMM-MM — X" ou "cold AAMM-MM X"); e (#4447)
 * um 3º fallback pro naming do fluxo `--group`, que deriva ciclo+célula da
 * LISTA de destinatários em vez do nome da campanha — ver bloco de comentário
 * daquele branch abaixo pro racional completo. Só campanhas com célula A/B/C
 * explícita participam do Resumo por Audiência — envios únicos (sem A/B/C)
 * são ignorados aqui (mesma convenção do #2360). Exportado pra teste
 * unitário.
 *
 * #3128: o NOME DA CAMPANHA nem sempre carrega o sinal de audiência — o
 * editor às vezes reagenda um re-envio pra uma lista fria reusando o MESMO
 * padrão de nome da campanha quente original (ex: só troca o sufixo do
 * subject por "· sab"/"· dom"/"· ter"), sem prefixo "cold". Confirmado via
 * API real da Brevo pro ciclo 2606-07 (issue #3128): campanhas
 * "Clarice News 2606-07 — B · dom" e "Clarice News 2606-07 — B · ter" batem
 * o regex WARM de `parseClariceCampaignKey` (então caíam sempre em
 * `audience: "warm"`), mas a LISTA de destinatários de cada uma se chama
 * "cold 2606-07 dom-B" / "2606-07 cold d1" — só o nome da LISTA denuncia que
 * o envio foi pra audiência fria. O nome da lista é portanto o sinal mais
 * confiável quando disponível: se `listName` contém "cold", a campanha é
 * classificada como fria mesmo que o nome da campanha pareça quente.
 * IMPORTANTE (diferente do branch `--group` abaixo): aqui `listName` só
 * resolve AUDIÊNCIA — ciclo+célula sempre vêm do nome da campanha, que já os
 * carrega. Sem `listName` (chamador não tem a info, ou testes legados), o
 * comportamento cai pro naming-only de antes — retrocompatível pros casos
 * quente/frio; o branch `--group` não tem equivalente naming-only (ver nota
 * nele).
 */
export function parseAbcAudienceCampaign(
  campaignName: string,
  listName?: string,
): { cycle: string; cell: "A" | "B" | "C"; audience: ClariceAudience } | null {
  const listIsCold = typeof listName === "string" && /cold/i.test(listName);
  const warm = parseClariceCampaignKey(campaignName);
  if (warm && warm.cell) {
    return { cycle: warm.cycle, cell: warm.cell, audience: listIsCold ? "cold" : "warm" };
  }
  const cold = campaignName.match(/^cold\s+(\d{4}-\d{2})(?:\s*[—–-]\s*|\s+)([ABC])\b/i);
  if (cold) {
    return { cycle: cold[1], cell: cold[2].toUpperCase() as "A" | "B" | "C", audience: "cold" };
  }
  // #4447: fluxo `--group` (`scripts/clarice-schedule-group.ts`) nomeia a
  // CAMPANHA como "Clarice {yymm} grupo:{key}" — sem ciclo mensal "AAMM-MM"
  // nem célula num formato reconhecível (o {key}, ex: "d1-sab01-A", é opaco
  // pra este parser). O sinal completo só existe na LISTA de destinatários:
  // "Clarice {ciclo mensal} {key} — célula {X}" (ex: "Clarice 2607-08
  // d1-sab01-A — célula A"). Confirmado ao vivo pro ciclo 2607-08 (#4447):
  // sem este fallback, groupMonthlyAbcTests/aggregateAbcByAudience nunca
  // reconheciam essas campanhas — o Resumo A/B/C do ciclo sumia inteiro do
  // painel. Diferente do caso cold acima (#3128), aqui `listName` NÃO é
  // auxiliar de audiência — é a ÚNICA fonte de ciclo+célula; sem `listName`
  // não há naming-only equivalente, a campanha retorna null (ver teste
  // "sem listName → null" abaixo).
  //
  // Não há gerador desse formato de nome de lista neste repo (diferente do
  // nome de CAMPANHA, que `scripts/clarice-schedule-group.ts` produz de forma
  // determinística) — foi digitado à mão pra este ciclo. `c[eé]lula` aceita
  // as duas grafias (sem/com acento) de propósito: a #4447 original só
  // testava a forma sem acento e um retype com "célula" (grafia correta em
  // PT-BR, usada em todo o resto deste arquivo) reproduziria o MESMO bug —
  // 3ª ocorrência dessa classe (#3081 → #3128 → #4447), achado no /code-review
  // deste PR antes do merge.
  const groupList = listName?.match(
    /Clarice\s+(\d{4}-\d{2})\s+[\w-]+\s*[—–-]\s*c[eé]lula\s+([ABC])\b/i,
  );
  if (groupList) {
    const listCell = groupList[2].toUpperCase() as "A" | "B" | "C";
    // O `{key}` da campanha ("grupo:d1-sab01-A") já carrega a célula
    // redundantemente no sufixo — cross-checar contra o sinal da LISTA em vez
    // de confiar cegamente nele (achado do /code-review deste PR). Uma lista
    // renomeada errada (cópia/cola, erro de digitação) sem esse guard
    // misturaria as métricas da campanha na célula ERRADA sem nenhum erro
    // visível — corrompe o vencedor do teste em vez de só sumir com o dado.
    // Sufixo ausente ou não-A/B/C (ex: "-interno") → sem sinal pra cruzar,
    // segue confiando só na lista (mesmo comportamento de antes).
    const nameCellSuffix = campaignName.match(/grupo:[\w-]*-([ABC])$/i);
    if (nameCellSuffix && nameCellSuffix[1].toUpperCase() !== listCell) return null;
    return { cycle: groupList[1], cell: listCell, audience: listIsCold ? "cold" : "warm" };
  }
  return null;
}

/**
 * #4449 item 2: campanhas do fluxo `--group` cujo NOME sinaliza claramente
 * que deveriam ter célula A/B/C (o `{key}` de "Clarice {yymm} grupo:{key}"
 * termina em -A/-B/-C, ex: "grupo:d1-sab01-A") mas `parseAbcAudienceCampaign`
 * não conseguiu extrair a célula (naming da LISTA não reconhecido — typo,
 * variação de digitação, ou naming futuro diferente do #4447).
 *
 * `findUnclassifiedCampaignNames`/`classifyClariceAudience` NÃO pegam esse
 * caso: `classifyClariceAudience` classifica QUALQUER `Clarice {yymm}
 * grupo:{key}` como "warm" só pelo nome da CAMPANHA (#4255), sem checar se a
 * célula foi de fato extraível da lista — uma campanha `--group` com célula
 * esperada mas sem célula extraída passa por "classificada" e nunca aparece
 * na nota de "não classificadas", mesmo tendo o MESMO problema estrutural (a
 * mesma classe de bug que já se repetiu em #3081 → #3128 → #4447).
 *
 * Só marca quando o `{key}` termina em -A/-B/-C — sufixo ausente ou diferente
 * (ex: "-interno", "-extra") é um envio `grupo:` LEGITIMAMENTE sem célula, não
 * entra aqui (mesmo critério que `parseAbcAudienceCampaign` já usa pro
 * cross-check `nameCellSuffix`). Exportado pra teste unitário.
 */
export function findGroupCampaignsMissingCell(
  campaigns: Array<Pick<BrevoCampaign, "name"> & { listName?: string }>,
): string[] {
  const names: string[] = [];
  for (const c of campaigns) {
    if (!/^Clarice \d{4} grupo:/i.test(c.name.trim())) continue; // só o fluxo --group
    if (!/grupo:[\w-]*-[ABC]$/i.test(c.name)) continue; // sem sinal de célula esperada — nada a reportar
    if (parseAbcAudienceCampaign(c.name, c.listName)) continue; // célula extraída OK
    names.push(c.name);
  }
  return names;
}

/**
 * Renderiza a nota diagnóstica de campanhas `--group` com célula esperada mas
 * não extraível (#4449 item 2). Mesmo padrão de `renderUnclassifiedCampaignsNote`
 * (string vazia quando não há nada a reportar). Exportado pra teste unitário.
 */
export function renderGroupCampaignsMissingCellNote(names: string[]): string {
  if (names.length === 0) return "";
  const plural = names.length === 1 ? "" : "s";
  return `<p class="section-note"><small>⚠️ ${names.length} campanha${plural} do fluxo --group parece${names.length === 1 ? "" : "m"} ter célula A/B/C no nome mas a célula não foi reconhecida na LISTA de destinatários (confira o naming — ver #4447): ${names.map((n) => escHtml(n)).join(", ")}.</small></p>`;
}

/** Métricas por célula do Resumo A/B/C por Audiência (#2976) — superset de `CellSummary`. */
export interface CellSummaryV2 {
  cell: "A" | "B" | "C";
  campaignCount: number;
  sent: number;
  delivered: number;
  opens: number;
  /**
   * #4559: cliques ATRIBUÍDOS a algum contato da lista de destinatários
   * (`campaignStats[0].uniqueClicks`) — fonte usada pra decidir o vencedor
   * (clickRate/ctor/leaderClickRate/z-test abaixo usam este campo, não
   * `clicksTotal`). Cai pra `clicksTotal` quando a campanha não tem
   * `campaignStats` (resposta antiga da API, ou fixture de teste legado) —
   * nesse caso o valor aqui é NÃO-VERIFICADO (mesmo tráfego potencialmente
   * não-atribuível de `clicksTotal`, só que sem ter sido checado contra a
   * lista) — ver `unattributedCampaignCount` abaixo, que sinaliza
   * exatamente essa situação (achado CRITICAL do review pré-merge do
   * #4559, #4567).
   */
  clicksAttributed: number;
  /**
   * #4567 (achado CRITICAL do review pré-merge do #4559): quantas
   * campanhas somadas nesta célula NÃO tinham `campaignStats` — nesses
   * casos `clicksAttributed` caiu pro valor de `clicksTotal` por FALTA de
   * dado de atribuição, não porque a atribuição foi checada e bateu. Sem
   * este sinal separado, `renderAbcClickAttributionNote` (que só compara
   * `clicksTotal !== clicksAttributed`) não consegue distinguir "verificado,
   * sem divergência" de "não verificável, caiu no valor contaminado por
   * default" — o painel podia declarar vencedor com confiança plena usando
   * dado inteiramente não-atribuído. 0/ausente (default) = toda campanha
   * desta célula tinha `campaignStats` (preserva fixtures de teste
   * existentes que constroem `CellSummaryV2` sem este campo).
   */
  unattributedCampaignCount?: number;
  /**
   * #4559: cliques TOTAIS reportados por `globalStats`/`pickStats` — pode
   * INCLUIR tráfego que a Brevo não conseguiu atribuir a nenhum contato da
   * lista (scanner, preview, encaminhamento, espelho público — HIPÓTESE
   * levantada a partir do achado ao vivo no ciclo 2607-08: uma única
   * campanha fria concentrava K=166 desse tipo de clique, o suficiente pra
   * inverter o vencedor do teste de assunto; diagnóstico causal específico
   * NÃO confirmado por dado de clique real — ver verificação pendente do
   * #4559). Só existe pra exibir a DIVERGÊNCIA quando ela ocorre
   * (`renderAbcClickAttributionNote`) — nunca usado pra decidir o vencedor.
   * Opcional pra não quebrar fixtures de teste que constroem `CellSummaryV2`
   * à mão sem este campo (mesmo padrão de `suspectedDriftDays` em
   * `AbcAudienceTable`) — `renderAbcClickAttributionNote` trata ausente como
   * "sem divergência conhecida" (cai pro valor de `clicksAttributed`).
   */
  clicksTotal?: number;
  unsubscriptions: number;
  /** opens / delivered */
  openRate: number;
  /** clicksAttributed / opens — qualidade da abertura */
  ctor: number;
  /** clicksAttributed / delivered — o "fundo do poço" do engajamento (#2976) */
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

// z-crítico bicaudal pra alpha=0.05 (SIGNIFICANCE_ALPHA) e z pro poder-alvo de
// 80% (convenção padrão da indústria pra cálculo de amostra/MDE) — constantes
// fixas em vez de reimplementar a normal inversa pro único uso abaixo.
const Z_ALPHA_005_TWO_SIDED = 1.9599639845400545;
const Z_BETA_POWER_80 = 0.8416212335729143;

/**
 * #4559: guard de PODER ESTATÍSTICO — calcula o lift relativo MÍNIMO que um
 * teste de duas proporções (x1/n1 vs x2/n2) conseguiria detectar com 80% de
 * poder a alpha=0.05, dado o tamanho de amostra ATUAL dos 2 braços. Mesma
 * assinatura de `twoProportionZTest` (x1,n1,x2,n2) de propósito — os dois
 * são chamados em par no mesmo call site.
 *
 * Racional: com contagem de clicadores ATRIBUÍDOS pequena (ex: 48/50/38 —
 * cenário real do ciclo 2607-08, #4559), um teste pode cruzar p<0.05 por
 * acaso (falso positivo) ou por um efeito real mas MUITO maior do que
 * qualquer lift que interesse editorialmente — sem essa segunda leitura, o
 * painel declarava "já dá pra concluir" só olhando o p-valor, sem informar
 * que a amostra só tinha poder pra detectar uma diferença enorme (~60%
 * relativo no exemplo da issue). Fórmula padrão de cálculo de amostra pra
 * teste de 2 proporções (variância pooled, mesma usada em `twoProportionZTest`),
 * resolvida pro delta mínimo: `delta_min = (z_alpha/2 + z_beta) * se`, onde
 * `se` é o MESMO erro padrão pooled do z-test. Retorna `Infinity` quando a
 * amostra é degenerada (n<=0 ou taxa pooled <=0/>=1) — MDE indeterminado.
 */
export function minDetectableRelativeLift(x1: number, n1: number, x2: number, n2: number): number {
  if (!(n1 > 0) || !(n2 > 0)) return Infinity;
  const pooled = (x1 + x2) / (n1 + n2);
  if (!(pooled > 0) || pooled >= 1) return Infinity;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const deltaMin = (Z_ALPHA_005_TWO_SIDED + Z_BETA_POWER_80) * se;
  return deltaMin / pooled;
}

/**
 * #4559: patamar acima do qual um resultado "significativo" (p<0.05) ainda
 * recebe a ressalva de poder baixo, em vez do "já dá pra concluir" sem
 * qualificação. Reusa o valor NUMÉRICO 30% do protocolo pré-registrado do
 * CTA-01 (`ExperimentDefinition.liftThreshold` em experiment-cta.ts) como
 * âncora prática — o menor lift que o editor já registrou como
 * editorialmente relevante. Nota (#4567, achado cheap do review pré-merge):
 * as duas normalizações NÃO são estritamente equivalentes — o CTA-01 define
 * lift relativo ao braço CONTROLE (`liftRelative` em
 * `evaluateExperimentDecision`, experiment-cta.ts), enquanto aqui não há
 * controle natural (teste A/B/C de 3 braços) e `minDetectableRelativeLift`
 * mede relativo à taxa POOLED dos 2 braços comparados — só a ORDEM DE
 * GRANDEZA é emprestada, não a métrica. Um teste que só teria poder pra
 * detectar algo BEM maior que essa âncora não dá confiança de que um
 * resultado "significativo" nessa faixa não seja um falso positivo ou uma
 * distorção não percebida (winner's curse) — precisamente o que este PR corrige.
 */
export const LOW_POWER_MDE_THRESHOLD = 0.30;

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
  /**
   * #4559: lift relativo MÍNIMO que o teste líder vs 2ª colocada teria poder
   * (80%) pra detectar, dado o tamanho de amostra ATUAL dos 2 braços — ver
   * `minDetectableRelativeLift`. `null` quando não há 2 células amostradas
   * (mesma condição de `pValue`); opcional pra não quebrar fixtures de teste
   * que constroem `AbcAudienceTable` à mão sem este campo (mesmo padrão de
   * `suspectedDriftDays` abaixo).
   */
  minDetectableLiftRelative?: number | null;
  /**
   * #4449 item 1: dias (YYYY-MM-DD BRT) excluídos da agregação pelo guard
   * `<3 células` (#3404) que TAMBÉM têm sinal de 3 campanhas do mesmo grupo
   * no NOME (ver `expectedCellFromCampaignName`) — ou seja, provavelmente não
   * é uma consolidação real (só 1-2 células enviadas de propósito), e sim uma
   * campanha que falhou o parse (naming da lista divergente). Vazio quando
   * nenhum dia excluído bate esse critério — omitido/opcional pra não quebrar
   * fixtures de teste que constroem `AbcAudienceTable` à mão sem este campo.
   */
  suspectedDriftDays?: string[];
  /**
   * #4567 (achado CRITICAL do review pré-merge do #4559): true quando a
   * célula líder OU a 2ª colocada (as duas que decidem `significantClick`)
   * tiveram 1+ campanha sem `campaignStats` — o clique usado nesta
   * comparação é, em parte, NÃO-VERIFICADO (caiu no total não-atribuído por
   * falta de dado, não porque a atribuição foi checada e bateu).
   * `renderAbcClickAttributionNote` sozinho não pega esse caso: quando TODA
   * campanha de uma célula carece de `campaignStats`, `clicksTotal` e
   * `clicksAttributed` ficam IGUAIS (mesmo valor contaminado), sem nenhuma
   * divergência aparente pra sinalizar. Tratado como o MESMO nível de
   * degradação de confiança que `isLowPower` já força hoje em
   * `renderAbcAudienceTable` — nunca o "já dá pra concluir" puro.
   * `false`/ausente (default) = toda campanha das 2 células decisórias
   * tinha `campaignStats` (preserva fixtures de teste existentes sem o
   * campo).
   */
  attributionUnknown?: boolean;
}

function emptyCellV2(cell: "A" | "B" | "C"): CellSummaryV2 {
  return {
    cell,
    campaignCount: 0,
    sent: 0,
    delivered: 0,
    opens: 0,
    clicksAttributed: 0,
    unattributedCampaignCount: 0,
    clicksTotal: 0,
    unsubscriptions: 0,
    openRate: 0,
    ctor: 0,
    clickRate: 0,
    unsubRate: 0,
    bounceRate: 0,
    spamRate: 0,
  };
}

/**
 * #4449 item 1: extrai a célula A/B/C esperada de um nome de campanha, SEM
 * depender de `listName` nem de `parseAbcAudienceCampaign` ter conseguido
 * resolver ciclo+célula — sinal puramente textual usado só pra responder "esta
 * campanha PARECIA fazer parte de um grupo de teste A/B/C?", independente de
 * o parse completo ter dado certo. Cobre os 3 naming conhecidos: warm diário
 * ("... dNN-X"), warm/cold mensal ("... — X: ..." / "... — X · sufixo"), e o
 * fluxo `--group` (".../grupo:{key}-X"). Usado só pra distinguir "consolidação
 * real" (poucas campanhas existiram) de "drift de naming" (3 campanhas
 * pretendiam existir, 1+ falhou o parse completo) no guard `<3` de
 * `aggregateCellsV2` abaixo — nunca usado pra decidir a AGREGAÇÃO em si (só
 * `parseAbcAudienceCampaign`, mais estrito, faz isso).
 *
 * Limitação conhecida e aceita: o agrupamento por dia em `aggregateCellsV2`
 * não escopa este sinal por CICLO (campanha que falhou o parse não tem ciclo
 * resolvível) — em tese, 2 testes A/B/C de ciclos DIFERENTES caindo no mesmo
 * dia calendário poderiam produzir um falso positivo de drift. Aceito de
 * propósito: o pior caso é uma nota de alarme a mais pro editor investigar e
 * descartar (barato, autocorretivo) — o oposto (silenciar um drift real) é o
 * próprio bug que este item existe pra corrigir.
 */
export function expectedCellFromCampaignName(campaignName: string): "A" | "B" | "C" | null {
  const daily = campaignName.match(/Clarice News \d{4} d\d{2}-([ABC])\b/i);
  if (daily) return daily[1].toUpperCase() as "A" | "B" | "C";
  const monthly = campaignName.match(/(?:Clarice News|cold)\s+\d{4}-\d{2}\s*[—–-]\s*([ABC])\b/i);
  if (monthly) return monthly[1].toUpperCase() as "A" | "B" | "C";
  const group = campaignName.match(/grupo:[\w-]*-([ABC])$/i);
  if (group) return group[1].toUpperCase() as "A" | "B" | "C";
  return null;
}

/**
 * Agrega uma lista de campanhas JÁ FILTRADA (por audiência/ciclo) em CellSummaryV2[A,B,C].
 *
 * #3404: envios de CONSOLIDAÇÃO (só 1-2 células enviadas num dado dia, sem par
 * completo A/B/C — ex: ciclo 2606-07, terça 07-07, envio só pra Célula B pós
 * sinal de vencedor) são excluídos da agregação. Sem isso, o dado que "prova"
 * a célula vencedora na comparação estatística já inclui volume extra que só
 * ela recebeu — viés circular. Agrupa por (audiência, dia BRT) — mesma técnica
 * de `groupMonthlyAbcTests` (scheduledAt‖sentDate →
 * toLocaleDateString("en-CA", {timeZone: "America/Sao_Paulo"})) — e só inclui
 * campanhas de dias com as 3 células representadas.
 *
 * #4449 item 1: o guard `<3` acima (pré-existente, #3404/#2976) não distinguia
 * "dia com <3 campanhas reconhecidas no TOTAL" (consolidação real — comportamento
 * correto, mantido) de "dia com 3 campanhas do mesmo grupo, mas 1+ falhou o
 * parse completo" (drift de naming — 1 campanha corrompida derrubava as OUTRAS
 * 2 que tinham parseado corretamente, sem nenhum sinal visível — confirmado ao
 * vivo no teste "lista com célula ERRADA... é descartada", PR #4448). Agora
 * cada dia excluído pelo guard é checado contra `expectedCellFromCampaignName`
 * (sinal textual, não precisa do parse completo): se ≥3 células distintas
 * aparecem nos NOMES das campanhas daquele dia mas o parse só resolveu <3, o
 * dia entra em `driftDays` — ainda EXCLUÍDO da agregação (mesmo default seguro
 * de antes: dado ausente > dado errado), mas agora com um sinal explícito pro
 * editor investigar, em vez de ficar indistinguível de consolidação real.
 */
function aggregateCellsV2(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number }>,
  cycle: string,
  audienceFilter: ClariceAudience | "any",
): { cells: CellSummaryV2[]; driftDays: string[] } {
  const acc: Record<"A" | "B" | "C", { sent: number; delivered: number; opens: number; clicksAttributed: number; clicksTotal: number; unattributed: number; unsub: number; bounces: number; spam: number; count: number }> = {
    A: { sent: 0, delivered: 0, opens: 0, clicksAttributed: 0, clicksTotal: 0, unattributed: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
    B: { sent: 0, delivered: 0, opens: 0, clicksAttributed: 0, clicksTotal: 0, unattributed: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
    C: { sent: 0, delivered: 0, opens: 0, clicksAttributed: 0, clicksTotal: 0, unattributed: 0, unsub: 0, bounces: 0, spam: 0, count: 0 },
  };
  const parsedCampaigns: Array<{
    c: BrevoCampaign & { listName?: string; listSize?: number };
    cell: "A" | "B" | "C";
    audience: ClariceAudience;
    dayKey: string;
  }> = [];
  const cellsPerDay = new Map<string, Set<"A" | "B" | "C">>();
  // #4449 item 1: sinal TEXTUAL (independe de parse completo/listName) de
  // quantas células distintas foram TENTADAS em cada dia — usado só pra
  // distinguir drift de consolidação real no guard abaixo.
  const nameOnlyCellsByDay = new Map<string, Set<"A" | "B" | "C">>();
  for (const c of campaigns) {
    const when = c.scheduledAt ?? c.sentDate;
    if (!when) continue;
    const ms = Date.parse(when);
    if (!Number.isFinite(ms)) continue;
    const dayKey = new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const expected = expectedCellFromCampaignName(c.name);
    if (expected) {
      if (!nameOnlyCellsByDay.has(dayKey)) nameOnlyCellsByDay.set(dayKey, new Set());
      nameOnlyCellsByDay.get(dayKey)!.add(expected);
    }
    const parsed = parseAbcAudienceCampaign(c.name, c.listName);
    if (!parsed || parsed.cycle !== cycle) continue;
    const groupKey = `${parsed.audience}|${dayKey}`;
    if (!cellsPerDay.has(groupKey)) cellsPerDay.set(groupKey, new Set());
    cellsPerDay.get(groupKey)!.add(parsed.cell);
    parsedCampaigns.push({ c, cell: parsed.cell, audience: parsed.audience, dayKey });
  }
  const driftDays = new Set<string>();
  for (const { c, cell, audience, dayKey } of parsedCampaigns) {
    if (audienceFilter !== "any" && audience !== audienceFilter) continue;
    const groupKey = `${audience}|${dayKey}`;
    if ((cellsPerDay.get(groupKey)?.size ?? 0) < 3) {
      // #4449 item 1: ≥3 células distintas nos NOMES daquele dia, mas o parse
      // só resolveu <3 → provável drift de naming, não consolidação real.
      if ((nameOnlyCellsByDay.get(dayKey)?.size ?? 0) >= 3) driftDays.add(dayKey);
      continue; // consolidação (real) OU drift (sinalizado acima) — ambos ficam fora da agregação
    }
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;
    const a = acc[cell];
    a.sent += s.sent ?? 0;
    a.delivered += s.delivered ?? 0;
    a.opens += s.uniqueViews ?? 0;
    // #3398 (revertido 260713): uniqueClicks já vem sem clique de unsubscribe direto
    // da Brevo — ver comentário equivalente em aggregateAbcSummary.
    const totalClicks = s.uniqueClicks ?? 0;
    // #4559: o vencedor por CLIQUE precisa usar cliques ATRIBUÍDOS a um
    // contato da lista (`campaignStats[0].uniqueClicks`, sempre por-lista),
    // não `pickStats`/`globalStats.uniqueClicks` (agregado da campanha
    // inteira — pode incluir clique que a Brevo não conseguiu ligar a
    // NENHUM membro da lista: scanner, preview, encaminhamento, espelho
    // público — HIPÓTESE, não confirmada por dado de clique real, ver
    // verificação pendente do #4559). Achado ao vivo (issue #4559): uma
    // única campanha fria do ciclo 2607-08 concentrava K=166 desse tráfego,
    // o suficiente pra inverter o vencedor de um teste de assunto que na
    // verdade estava empatado.
    // #4567 (achado CRITICAL do review pré-merge): `campaignStats` ausente
    // (resposta antiga da API, lista deletada, mudança de shape) caía pro
    // valor de `totalClicks` SILENCIOSAMENTE — indistinguível de "checado e
    // bateu", o que derrotava este próprio fix (o painel podia declarar
    // vencedor com confiança plena sobre dado inteiramente não-atribuído).
    // `hasAttribution` torna essa disponibilidade um SINAL PRÓPRIO
    // (`unattributedCampaignCount`), nunca só uma diferença de valor.
    const cs = c.statistics?.campaignStats?.[0];
    const hasAttribution = !!cs && Number.isFinite(cs.uniqueClicks);
    const attributedClicks = hasAttribution ? cs!.uniqueClicks : totalClicks;
    a.clicksAttributed += attributedClicks;
    a.clicksTotal += totalClicks;
    if (!hasAttribution) a.unattributed += 1;
    a.unsub += s.unsubscriptions ?? 0;
    a.bounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    a.spam += s.complaints ?? 0;
    a.count += 1;
  }
  const cells = (["A", "B", "C"] as const).map((cell) => {
    const d = acc[cell];
    if (d.count === 0) return emptyCellV2(cell);
    return {
      cell,
      campaignCount: d.count,
      sent: d.sent,
      delivered: d.delivered,
      opens: d.opens,
      clicksAttributed: d.clicksAttributed,
      unattributedCampaignCount: d.unattributed,
      clicksTotal: d.clicksTotal,
      unsubscriptions: d.unsub,
      openRate: d.delivered > 0 ? (d.opens / d.delivered) * 100 : 0,
      ctor: d.opens > 0 ? (d.clicksAttributed / d.opens) * 100 : 0,
      clickRate: d.delivered > 0 ? (d.clicksAttributed / d.delivered) * 100 : 0,
      unsubRate: d.sent > 0 ? (d.unsub / d.sent) * 100 : 0,
      bounceRate: d.sent > 0 ? (d.bounces / d.sent) * 100 : 0,
      spamRate: d.sent > 0 ? (d.spam / d.sent) * 100 : 0,
    };
  });
  return { cells, driftDays: [...driftDays].sort() };
}

function buildAbcAudienceTable(result: { cells: CellSummaryV2[]; driftDays: string[] }): AbcAudienceTable {
  const { cells, driftDays } = result;
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
  let minDetectableLiftRelative: number | null = null;
  let attributionUnknown = false;
  if (leaderClickRate && sampled.length >= 2) {
    const leader = sampled.find((c) => c.cell === leaderClickRate)!;
    // 2ª colocada por click rate (a que mais ameaça a liderança).
    const runnerUp = [...sampled]
      .filter((c) => c.cell !== leaderClickRate)
      .sort((a, b) => b.clickRate - a.clickRate)[0];
    if (runnerUp) {
      // #4559: leader.clicksAttributed/runnerUp.clicksAttributed já são
      // cliques ATRIBUÍDOS (aggregateCellsV2 preenche o campo com
      // clicksAttributed do acumulador) — tanto o z-test quanto o guard de
      // poder abaixo decidem sobre a mesma base.
      const test = twoProportionZTest(leader.clicksAttributed, leader.delivered, runnerUp.clicksAttributed, runnerUp.delivered);
      pValue = test.pValue;
      significantClick = test.pValue < SIGNIFICANCE_ALPHA;
      minDetectableLiftRelative = minDetectableRelativeLift(leader.clicksAttributed, leader.delivered, runnerUp.clicksAttributed, runnerUp.delivered);
      // #4567 (achado CRITICAL do review pré-merge do #4559): líder OU 2ª
      // colocada tiveram 1+ campanha SEM `campaignStats` — o clique que
      // decide ESTE teste é, em parte, não-verificado (caiu no total por
      // falta de dado, não porque a atribuição bateu). Sinaliza pra o render
      // forçar o texto com ressalva, nunca o "já dá pra concluir" puro.
      attributionUnknown =
        (leader.unattributedCampaignCount ?? 0) > 0 || (runnerUp.unattributedCampaignCount ?? 0) > 0;
    }
  }

  return {
    cells, leaderOpenRate, leaderClickRate, significantClick, pValue,
    minDetectableLiftRelative, suspectedDriftDays: driftDays, attributionUnknown,
  };
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

/**
 * #4449 item 1: nota diagnóstica de dias suspeitos de DRIFT DE NAMING (guard
 * `<3` de `aggregateCellsV2` excluiu o dia, mas 3 células distintas apareciam
 * nos NOMES das campanhas daquele dia — ver `expectedCellFromCampaignName`).
 * Mesmo padrão de `renderUnclassifiedCampaignsNote`/`renderGroupCampaignsMissingCellNote`
 * (string vazia quando não há nada a reportar). Texto explicitamente distinto
 * do resto das notas desta tabela — "alarme", não "informação de contexto".
 */
function renderAbcDriftNote(driftDays: string[]): string {
  if (driftDays.length === 0) return "";
  const plural = driftDays.length === 1 ? "" : "s";
  const list = driftDays.map((d) => d.split("-").reverse().join("/")).join(", ");
  return `<p class="section-note"><small>⚠️ ${driftDays.length} dia${plural} com possível DRIFT DE NAMING (${list}): o grupo parece ter tido 3 campanhas, mas 1 ou mais não teve a célula reconhecida — excluído da comparação por segurança (dado ausente é mais seguro que dado errado), mas isso pode NÃO ser consolidação real. Confira o naming da LISTA de destinatários dessas campanhas (ver #4447/#4449).</small></p>`;
}

/**
 * #4559: nota de divergência entre cliques TOTAIS (`clicksTotal`,
 * globalStats/pickStats — pode incluir tráfego não atribuível a nenhum
 * contato da lista) e cliques ATRIBUÍDOS (`clicks`, usado pra decidir o
 * vencedor). "" quando nenhuma célula amostrada diverge — não adiciona ruído
 * quando as duas fontes concordam (caso comum, sem esse tipo de tráfego
 * fantasma). Exportado pra teste unitário.
 */
export function renderAbcClickAttributionNote(cells: CellSummaryV2[]): string {
  // `clicksTotal` é opcional (fixture de teste sem o campo) — trata ausente
  // como "sem divergência conhecida", nunca como 0 (que compararia falso
  // contra `.clicksAttributed` > 0 e disparataria a nota indevidamente).
  const total = (c: CellSummaryV2) => c.clicksTotal ?? c.clicksAttributed;
  const diverging = cells.filter((c) => c.campaignCount > 0 && total(c) !== c.clicksAttributed);
  if (diverging.length === 0) return "";
  const parts = diverging
    .map((c) => `Célula ${c.cell}: ${total(c).toLocaleString("pt-BR")} totais, ${c.clicksAttributed.toLocaleString("pt-BR")} atribuídos à lista`)
    .join(" · ");
  return `<p class="section-note"><small>ℹ️ Cliques totais reportados divergem dos atribuídos a contato da lista (${parts}) — o vencedor por clique usa só o número ATRIBUÍDO, nunca o total (ver #4559).</small></p>`;
}

/** Renderiza 1 tabela (Agregada/Fria/Quente) do Resumo A/B/C por Audiência. Exportado pra teste unitário. */
export function renderAbcAudienceTable(title: string, table: AbcAudienceTable): string {
  const { cells, leaderOpenRate, leaderClickRate, significantClick, pValue, minDetectableLiftRelative, suspectedDriftDays, attributionUnknown } = table;
  const driftNote = renderAbcDriftNote(suspectedDriftDays ?? []);
  if (cells.filter((c) => c.campaignCount > 0).length < 2) {
    // #3127: omite a subseção inteira (sem header nem stub "Sem dados") quando
    // esta audiência especificamente não teve nenhum envio no ciclo — ruído
    // visual, já que as outras 1-2 audiências do mesmo ciclo normalmente têm
    // dado. Mesmo idioma de renderAbcSection (branch sem resetNote).
    // #3396: <2 células amostradas (não só ===0) — com só 1 célula (ex: A saiu,
    // B/C ainda não), não há comparação possível ainda; mesmo critério que
    // pickLeader já usa (sampled.length < 2 → null).
    // #4449 item 1: EXCETO quando há sinal de drift — aí a nota (só ela, sem
    // tabela/título) ainda sai, pra não mascarar silenciosamente o problema.
    return driftNote;
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
        return `<tr><td><strong>Célula ${c.cell}</strong></td><td colspan="6" style="opacity:0.5;">— sem envios —</td></tr>`;
      }
      // #3088: teal (--brand) falha AA em texto pequeno — tags de destaque
      // voltam a --ink (negrito + ▲ já diferenciam visualmente).
      const openTag = c.cell === leaderOpenRate ? ` <strong style="color:${DS.ink}">▲ ABERTURA</strong>` : "";
      // #3675: colunas Click rate e Bounce/Spam removidas (pedido do editor,
      // preferência de UI). A tag ▲CLIQUE (critério decisório real, #2976)
      // migrou pra célula de CTOR — não some, só muda de coluna.
      const clickTag = c.cell === leaderClickRate ? ` <strong style="color:${DS.ink}">▲ CLIQUE</strong>` : "";
      return `<tr>
        <td><strong>Célula ${c.cell}</strong></td>
        <td>${c.campaignCount}</td>
        <td>${c.delivered.toLocaleString("pt-BR")}</td>
        <td class="metric">${c.openRate.toFixed(1)}%${openTag}</td>
        <td class="metric">${c.ctor.toFixed(1)}%${clickTag}</td>
        <td>${c.clicksAttributed.toLocaleString("pt-BR")}</td>
        <td>${c.unsubRate.toFixed(2)}%</td>
      </tr>`;
    })
    .join("\n");

  // #3396: sampled.length sempre >= 2 aqui — o guard early-return acima já
  // cobre <2 (retorna "" antes de chegar neste ponto).
  const sampled = cells.filter((c) => c.campaignCount > 0);
  // #3303: mesma classe de bug já corrigida em renderAbcSection (#3281) — sem
  // este guard, opens>0/clicks=0 (comum nas primeiras horas pós-envio, clique
  // atrasa em relação à abertura) caía no branch !leaderClickRate ("Empate no
  // clique"), sugerindo enganosamente um empate REAL no critério decisório
  // (clique, #2976) em vez de "ainda não há dado". Texto diferente do
  // renderAbcSection de propósito ("Aguardando dados de CLIQUE", não o genérico
  // "Aguardando dados suficientes") — esta tabela não tem uma métrica de
  // abertura secundária também aguardando; o resto dos campos (open rate, CTOR)
  // já está populado quando isso dispara.
  const allZero = sampled.every((c) => c.clicksAttributed === 0);
  // #4559: guard de poder estatístico — um resultado "significativo" (p<0.05)
  // com amostra ATRIBUÍDA tão pequena que o teste só teria poder pra detectar
  // um lift bem maior que o menor lift editorialmente relevante
  // (LOW_POWER_MDE_THRESHOLD, 30% — âncora numérica do protocolo CTA-01, ver
  // doc do const) não deve ser anunciado como "já dá pra concluir" sem essa
  // ressalva: tanto pode ser um falso positivo (5% de chance sob H0) quanto
  // uma distorção não percebida na fonte do dado — o próprio cenário que
  // motivou este fix. #4567: `>=` (não `>`) pra alinhar com o `>=` do CTA-01
  // em `evaluateExperimentDecision` (experiment-cta.ts:333).
  const isLowPower = minDetectableLiftRelative != null && minDetectableLiftRelative >= LOW_POWER_MDE_THRESHOLD;
  // #4567 (achado CRITICAL do review pré-merge do #4559): atribuição
  // desconhecida na célula líder ou na 2ª colocada recebe o MESMO
  // tratamento que `isLowPower` já força — nunca "já dá pra concluir" puro.
  // Sem isso, uma campanha decisória sem `campaignStats` fazia
  // `clicksAttributed` cair pro total NÃO-atribuído silenciosamente (mesmo
  // valor em ambos os campos, sem divergência pra `renderAbcClickAttributionNote`
  // detectar) e o painel podia declarar vencedor com confiança plena sobre
  // dado nunca verificado contra a lista.
  const needsCaveat = isLowPower || attributionUnknown === true;
  const caveatReasons: string[] = [];
  if (isLowPower) {
    caveatReasons.push(
      `a amostra ATRIBUÍDA ainda é pequena: o teste só tem poder (80%) pra detectar lift relativo ≥ ${(minDetectableLiftRelative! * 100).toFixed(0)}%`,
    );
  }
  if (attributionUnknown) {
    caveatReasons.push(
      `a célula líder e/ou a 2ª colocada tiveram campanha SEM dado de atribuição (campaignStats ausente) — o clique usado pode ser tráfego não-verificado, nunca checado contra a lista`,
    );
  }
  const caveatText = caveatReasons.join("; e ");
  const conclusionNote =
    allZero
      ? "Aguardando dados de clique — primeiras horas pós-envio."
      : !leaderClickRate
      ? "Empate no clique — aguardar mais dados."
      : significantClick && !needsCaveat
      ? `Vencedor por CLIQUE: <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — diferença estatisticamente significativa (p ${pValue !== null ? pValue.toFixed(4) : "?"} &lt; ${SIGNIFICANCE_ALPHA}). Já dá pra concluir.`
      : significantClick && needsCaveat
      ? `Vencedor por CLIQUE (com ressalva): <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — diferença estatisticamente significativa (p ${pValue !== null ? pValue.toFixed(4) : "?"} &lt; ${SIGNIFICANCE_ALPHA}), mas ${caveatText}. Tratar como indicativo, não conclusivo (#4559).`
      : `Vencedor provisório por clique: <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — diferença <strong>NÃO</strong> significativa ainda (p ${pValue !== null ? pValue.toFixed(4) : "?"} ≥ ${SIGNIFICANCE_ALPHA}). Precisa de mais dados antes de concluir.`;

  const attributionNote = renderAbcClickAttributionNote(cells);

  return `
  <h4 class="subsection-title">${escHtml(title)}</h4>
  ${driftNote}
  <p class="section-note">${conclusionNote}</p>
  ${attributionNote}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th scope="col" title="Célula do teste A/B/C">Célula</th>
        <th scope="col" title="Dias/envios contabilizados">Envios</th>
        <th scope="col" title="Total entregue">Delivered</th>
        <th scope="col" title="Aberturas únicas ÷ delivered">Open rate</th>
        <th scope="col" title="CTOR = cliques únicos ATRIBUÍDOS ÷ aberturas — qualidade da abertura entre quem abriu; ▲CLIQUE marca o vencedor por cliques ÷ delivered, o &quot;fundo do poço&quot; do engajamento (#2976)">CTOR</th>
        <th scope="col" title="Cliques únicos ATRIBUÍDOS a algum contato da lista (campaignStats) — usado pra decidir o vencedor; pode divergir do total reportado, ver nota acima (#4559)">Cliques</th>
        <th scope="col" title="Descadastros ÷ sent">Unsub</th>
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
  // #3396: <2 células amostradas em CADA sub-tabela (não só ===0) — senão o
  // wrapper externo (título + nota de metodologia) ainda renderiza quando as
  // 3 sub-tabelas já se omitem sozinhas (renderAbcAudienceTable) mas alguma
  // tem exatamente 1 célula com envio.
  const allEmpty =
    result.aggregate.cells.filter((c) => c.campaignCount > 0).length < 2 &&
    result.cold.cells.filter((c) => c.campaignCount > 0).length < 2 &&
    result.warm.cells.filter((c) => c.campaignCount > 0).length < 2;
  // #4449 item 1: driftDays das 3 sub-tabelas, deduplicado — usado só pra
  // decidir se o wrapper "allEmpty" ainda deve renderizar algo (a nota), nunca
  // pra reconstruir uma tabela (cada sub-tabela já cuida da sua própria nota).
  const driftDays = [
    ...new Set([
      ...(result.aggregate.suspectedDriftDays ?? []),
      ...(result.cold.suspectedDriftDays ?? []),
      ...(result.warm.suspectedDriftDays ?? []),
    ]),
  ].sort();
  if (allEmpty && driftDays.length === 0) return "";
  // #3092: título opaco ("2607-07" não comunica nada de imediato) — sufixo
  // legível do mês/ano de ENVIO quando o formato do ciclo permite derivá-lo.
  const envioLabel = formatCycleEnvioLabel(cycle);
  const cycleTitle = envioLabel ? `${escHtml(cycle)} · ${envioLabel}` : escHtml(cycle);
  if (allEmpty) {
    // #4449 item 1: nenhuma sub-tabela tem dado suficiente pra renderizar,
    // mas há sinal de drift — a seção não pode desaparecer em silêncio (senão
    // volta a ser indistinguível de "nenhum envio ainda", o próprio sintoma
    // que este item existe pra corrigir).
    return `
<section class="phase2-section" id="abc-audience-${escHtml(cycle)}">
  <h2 class="section-title">Resumo A/B/C por Audiência (${cycleTitle})</h2>
  ${renderAbcDriftNote(driftDays)}
</section>`;
  }
  return `
<section class="phase2-section" id="abc-audience-${escHtml(cycle)}">
  <h2 class="section-title">Resumo A/B/C por Audiência (${cycleTitle})</h2>
  <p class="section-note"><small>Agrupado por TIPO de audiência (fria = nunca recebeu; quente = base engajada), não por data de envio — o comportamento entre elas diverge o suficiente (abertura ~15% vs ~60%) pra dispersar o sinal se agrupado por data. Vencedor decidido pelo CLIQUE (click rate), não só pela abertura.</small></p>
  ${renderAbcAudienceTable("Agregada (Fria + Quente)", result.aggregate)}
  ${renderAbcAudienceTable("Fria (nunca recebeu)", result.cold)}
  ${renderAbcAudienceTable("Quente (já engajada)", result.warm)}
</section>`;
}

/**
 * Versão enxuta de `renderAbcAudienceSection` só com a tabela Agregada (#3408)
 * — pra Visão Geral (resumo curado pra reunião de parceria). As sub-tabelas
 * Fria/Quente continuam existindo normalmente na aba Engajamento via
 * `renderAbcAudienceSection` acima; esta função nunca as renderiza. Mesmo
 * wrapper (título do ciclo + nota de metodologia) pra manter contexto de qual
 * ciclo e o que "Agregada" significa, sem herdar Fria/Quente. Exportado pra
 * teste unitário.
 */
export function renderAbcAudienceAggregateSection(
  cycle: string,
  result: { aggregate: AbcAudienceTable; cold: AbcAudienceTable; warm: AbcAudienceTable },
): string {
  // #3396: mesmo critério de <2 células amostradas, mas só considera a
  // tabela Agregada — Fria/Quente não são exibidas aqui, então seu conteúdo
  // não deve influenciar se este wrapper aparece ou não.
  if (result.aggregate.cells.filter((c) => c.campaignCount > 0).length < 2) return "";
  const envioLabel = formatCycleEnvioLabel(cycle);
  const cycleTitle = envioLabel ? `${escHtml(cycle)} · ${envioLabel}` : escHtml(cycle);
  return `
<section class="phase2-section" id="abc-audience-aggregate-${escHtml(cycle)}">
  <h2 class="section-title">Resumo A/B/C por Audiência (${cycleTitle})</h2>
  <p class="section-note"><small>Agregada = fria (nunca recebeu) + quente (já engajada) combinadas — o detalhe por audiência está na aba Engajamento. Vencedor decidido pelo CLIQUE (click rate), não só pela abertura.</small></p>
  ${renderAbcAudienceTable("Agregada (Fria + Quente)", result.aggregate)}
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
  /** #3452: soma de cliques únicos (uniqueClicks) das campanhas enviadas neste dia */
  clicks: number;
  /** #3452: CTOR agregado = clicks / opens (0 quando opens=0) — mesmo padrão da tabela principal (base = opens, não delivered) */
  ctor: number;
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
  type Acc = { count: number; delivered: number; opens: number; clicks: number };
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

    if (!acc[wk]) acc[wk] = { count: 0, delivered: 0, opens: 0, clicks: 0 };
    acc[wk].count += 1;
    acc[wk].delivered += s.delivered ?? 0;
    acc[wk].opens += s.uniqueViews ?? 0;
    acc[wk].clicks += s.uniqueClicks ?? 0;
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
        clicks: d.clicks,
        // #3452: base = opens (não delivered) — mesmo padrão da tabela principal (`ctor = pct(s.uniqueClicks, s.uniqueViews)`).
        ctor: d.opens > 0 ? (d.clicks / d.opens) * 100 : 0,
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
  {
    label: "CTOR",
    tooltip:
      "CTOR (click-to-open rate) agregado = cliques únicos ÷ aberturas únicas deste dia. Engajamento com o conteúdo entre quem abriu (base = opens, não delivered — mesmo padrão da tabela principal).",
  },
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
      const ctorFmt = r.ctor.toFixed(1) + "%";
      return `<tr>
        <td><strong>${escHtml(r.label)}</strong></td>
        <td>${r.count}</td>
        <td>${r.delivered.toLocaleString("pt-BR")}</td>
        <td>${r.opens.toLocaleString("pt-BR")}</td>
        <td class="metric">${openRateFmt}${winnerTag}${smallSampleNote}</td>
        <td class="metric">${ctorFmt}<br><small>${r.clicks.toLocaleString("pt-BR")}</small></td>
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
 * Renderiza a seção de resumo A/B/C (diário S1 ou mensal por data).
 * Exportado pra teste unitário.
 *
 * #3124: alinhado ao critério decisório real desde #2976 (clique, não
 * abertura) — `renderAbcAudienceSection` já decidia por clique; esta seção
 * (que não tem equivalente por audiência) coroava `▲ LÍDER` só por open rate,
 * podendo divergir do vencedor real (observado no ciclo 2606-07: abertura
 * dava A, clique dava B). Agora mostra as DUAS tags separadas (`▲ ABERTURA`/
 * `▲ CLIQUE`, mesmo padrão de `renderAbcAudienceTable`) e o texto de conclusão
 * usa clique como critério decisório.
 */
export function renderAbcSection(
  abcRows: CellSummary[],
  opts: { title?: string; id?: string } = {},
): string {
  // #2889: título/id parametrizáveis pra reusar no Resumo A/B/C MENSAL (default = diário S1).
  // #3123: título não promete mais "(d01–d07)" — a janela agora é derivada dos
  // dados (ver aggregateAbcSummary), não mais um corte fixo de 7 dias.
  const secTitle = opts.title ?? "Resumo A/B/C — S1";
  const secId = opts.id ?? "abc-summary";
  // #3675: o placeholder "aguardando novo teste" (explicava o reset #2871 do
  // ciclo 2605 — variante B venceu, consolidada em d06) ficou vestigial: os
  // testes atuais já aparecem em "Resumo A/B/C por Audiência"
  // (renderAbcAudienceSection, populado com dado real do ciclo corrente).
  // Zero células → sempre oculta, sem distinguir mais o motivo do zero.
  if (abcRows.every((r) => r.campaignCount === 0)) return "";

  const sampledRows = abcRows.filter((r) => r.campaignCount > 0);
  const allSampled = sampledRows.length >= 2;

  function pickLeader(metric: (r: CellSummary) => number): "A" | "B" | "C" | null {
    if (!allSampled) return null;
    const max = sampledRows.reduce((m, r) => Math.max(m, metric(r)), -Infinity);
    const tied = sampledRows.filter((r) => metric(r) === max);
    return tied.length === 1 ? tied[0].cell : null;
  }

  // #3124: dois líderes possíveis — abertura (secundário, ruidoso) e clique
  // (critério decisório real, #2976). Podem divergir (ciclo 2606-07: abertura
  // dava A, clique dava B) — por isso duas tags separadas, nunca uma só "LÍDER".
  const leaderOpenRate = pickLeader((r) => r.openRate);
  const leaderClickRate = pickLeader((r) => r.clickRate);

  // #3124: ordenar por CLIQUE (era por abertura) — reflete o critério decisório.
  // células sem dados (campaignCount 0) vão pro fim.
  const orderedRows = [...abcRows].sort((a, b) => {
    if (a.campaignCount === 0 && b.campaignCount === 0) return 0;
    if (a.campaignCount === 0) return 1;
    if (b.campaignCount === 0) return -1;
    return b.clickRate - a.clickRate;
  });

  const cellRows = orderedRows
    .map((r) => {
      // #3088: teal falha AA em texto pequeno — tags voltam a --ink.
      const openTag =
        r.campaignCount > 0 && r.cell === leaderOpenRate
          ? ` <strong style="color:${DS.ink}">▲ ABERTURA</strong>`
          : "";
      const clickTag =
        r.campaignCount > 0 && r.cell === leaderClickRate
          ? ` <strong style="color:${DS.ink}">▲ CLIQUE</strong>`
          : "";
      // #2257: taxa MPP-inclusiva (primária, bate com a Brevo UI) + orgânica em
      // parênteses quando disponível — mesmo padrão da tabela de campanhas (#1153).
      const organicInline =
        r.campaignCount > 0 && r.organicOpenRate != null
          ? ` <span class="rate-inline">(${r.organicOpenRate.toFixed(1)}% s/ MPP)</span>`
          : "";
      const openRateFmt = r.campaignCount > 0 ? r.openRate.toFixed(1) + "%" : "—";
      const clickRateFmt = r.campaignCount > 0 ? r.clickRate.toFixed(2) + "%" : "—";
      return `<tr>
        <td><strong>Célula ${r.cell}</strong></td>
        <td>${r.campaignCount > 0 ? r.totalDelivered : "—"}</td>
        <td>${r.campaignCount > 0 ? r.totalViews : "—"}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${openRateFmt}${organicInline}${openTag}</td>
        <td class="${r.campaignCount > 0 ? "metric" : ""}">${clickRateFmt}${clickTag}</td>
        <td>${r.campaignCount}</td>
      </tr>`;
    })
    .join("\n");

  // #3281: guard checa CLIQUE (critério decisório desde #3124), não abertura.
  // Pouco depois de um envio é comum ter opens>0 e clicks=0 (clique atrasa
  // horas em relação à abertura) — checar totalViews aqui fazia esse caso
  // cair no branch !leaderClickRate ("Empate no clique com 0.00%"), sugerindo
  // enganosamente um empate real no critério principal. Checando o clique,
  // esse caso cai no branch certo ("Aguardando dados suficientes"). Texto
  // genérico (não "de abertura") de propósito — code-review do PR #3287
  // notou que esse branch também cobre o caso opens>0/clicks=0, onde
  // abertura JÁ existe (às vezes até com líder próprio, ▲ ABERTURA); "de
  // abertura" ficaria impreciso/contraditório com a própria tabela.
  //
  // #3305 (refactor puro, sem mudança de comportamento): `allZero` derivava
  // de `totalClicks` (campo bruto) enquanto `maxClickRate`/`leaderClickRate`
  // derivam de `clickRate` — dois cálculos independentes dizendo a mesma
  // coisa (totalClicks === 0 ⟺ clickRate === 0 sempre que totalDelivered >
  // 0, garantido por `aggregateAbcSummary`). `allZero` agora deriva de
  // `maxClickRate`, a MESMA fonte que `pickLeader`/`leaderClickRate` usa —
  // evita que uma futura migração de métrica desincronize o guard de novo
  // (a causa raiz do #3281). Decisão do editor (#3305): "1 clique isolado
  // basta pra declarar vencedor provisório" continua sendo o critério
  // oficial — nenhum limiar mínimo de amostra foi adicionado aqui.
  const maxClickRate = allSampled ? sampledRows.reduce((m, r) => Math.max(m, r.clickRate), 0) : 0;
  const allZero = allSampled && maxClickRate === 0;
  const statusNote = allZero
    ? `Aguardando dados suficientes — primeiras horas pós-envio.`
    : !allSampled
    ? `Dados insuficientes para comparação — aguardar mais dias de envio.`
    : !leaderClickRate
    ? `Empate no clique com ${maxClickRate.toFixed(2)}% — aguardar mais dias de envio.`
    : `Vencedor provisório por CLIQUE: <strong style="color:${DS.ink}">Célula ${leaderClickRate}</strong> — aguardar checkpoint de análise para decisão final.`;

  return `
<section class="phase2-section" id="${secId}">
  <h2 class="section-title">${secTitle}</h2>
  <p class="section-note">${statusNote}</p>
  <p class="section-note"><small>Vencedor decidido pelo CLIQUE (click rate = cliques únicos ÷ delivered), não só pela abertura — mesmo critério do Resumo por Audiência (#2976). Open rate <strong>com Apple MPP</strong> (igual à UI da Brevo); entre parênteses, a taxa <strong>sem MPP</strong> (orgânica), exibida só quando todos os dias da célula têm esse dado.</small></p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th scope="col" title="Célula do teste A/B/C">Célula</th>
        <th scope="col" title="Soma de entregues dos dias enviados">Delivered (total)</th>
        <th scope="col" title="Soma de aberturas únicas (com Apple MPP, como na UI da Brevo) dos dias enviados">Opens (total)</th>
        <th scope="col" title="Open rate agregado com Apple MPP (opens ÷ delivered); entre parênteses, a taxa sem MPP quando disponível">Open rate agr.</th>
        <th scope="col" title="Cliques únicos ÷ delivered — o &quot;fundo do poço&quot; do engajamento, decide o vencedor real (#2976)">Click rate agr.</th>
        <th scope="col" title="Dias enviados contabilizados">Dias</th>
      </tr>
    </thead>
    <tbody>${cellRows}</tbody>
  </table>
  </div>
</section>`;
}
