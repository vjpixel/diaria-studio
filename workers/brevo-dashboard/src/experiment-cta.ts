/**
 * #3884: painel de avaliação de experimentos A/B da Clarice (mensal) + registro
 * "Experimento vigente" com as regras do protocolo pré-registrado, pensado como
 * LISTA de experimentos (não texto hardcoded) — comporta rounds futuros (ex:
 * CTA-01 round 2, testando posição do bloco dedicado ou CTA do encerramento).
 *
 * Import circular com sections-core.ts (mesmo padrão documentado em
 * render-links.ts #2832 e weekly-plan.ts): `pickStats`/`escHtml` são usados
 * aqui mas definidos lá, e as funções de render deste módulo são importadas
 * por sections-core.ts. Seguro — todo uso é dentro de corpos de função
 * chamados em request-time, nunca em top-level do módulo.
 *
 * Fonte do protocolo do experimento CTA-01: docs/experiments/cta-ab-mensal-2606-07.md
 * (setup executado por scripts/clarice-cta-ab-setup.ts, PR #3890).
 *
 * Limitação conhecida (mesma de `render-links.ts`/`parseLinksStats`): a API
 * Brevo v3 só expõe cliques TOTAIS por URL (`linksStats`), não unique-clicks
 * por link — a métrica de decisão (cliques no CTA de topo) usa esse total como
 * proxy, igual a todo o resto do dashboard que já lê `linksStats`.
 */
import type { BrevoCampaign } from "./types.ts";
// #2976: `twoProportionZTest`/`ZTestResult` já existem em sections-core.ts
// (usados hoje pelo Resumo A/B/C por audiência) — reusados aqui como
// primitiva estatística, em vez de duplicar erf/normCdf/z-test.
import { escHtml, pickStats, twoProportionZTest, type ZTestResult } from "./sections-core.ts";
import { pct, cellClass, getCampaignLinksStats, brevoReportLink, STATUS_COLOR } from "./render-links.ts";
import { isBounceBreach, DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "./thresholds.ts";

type CampaignRow = BrevoCampaign & { listName?: string; listSize?: number; linksStats?: Record<string, number> };

// ─── Definição de experimento ────────────────────────────────────────────────

export type ExperimentStatus = "ativo" | "encerrado" | "vencedor";

export interface ExperimentArmDef {
  /** Identificador curto do braço, minúsculo (ex: "a", "b") — casa com o retorno de `matchCampaign`. */
  id: string;
  /** Rótulo de exibição (ex: "A (controle) — copy atual"). */
  label: string;
  /** Valor de `utm_campaign` deste braço (ex: "clarice-2606-07-cta-a") — usado pra achar o link da métrica de decisão em `linksStats`. */
  utmCampaign: string;
}

export interface ExperimentDefinition {
  id: string;
  name: string;
  status: ExperimentStatus;
  cycle: string;
  hypothesis: string;
  arms: ExperimentArmDef[];
  decisionMetricLabel: string;
  /** `utm_term` do link que decide o teste (ex: "topo"). */
  decisionUtmTerm: string;
  decisionRuleText: string;
  /** Lift relativo mínimo do braço tratamento sobre o controle pra cruzar a regra (ex: 0.30 = +30%). */
  liftThreshold: number;
  /** p-valor máximo (bicaudal) pra considerar significativo (ex: 0.05). */
  pValueThreshold: number;
  guardrailsNote: string;
  docPath?: string;
  /**
   * Casa o `name` de uma campanha Brevo com este experimento. Retorna
   * `{pairKey, armId}` (pairKey identifica o ENVIO/par — 2 campanhas com o
   * mesmo pairKey e braços diferentes formam 1 comparação A/B) ou `null` se a
   * campanha não pertence a este experimento.
   */
  matchCampaign: (name: string) => { pairKey: string; armId: string } | null;
}

// ─── CTA-01 (ciclo 2606-07) ───────────────────────────────────────────────────

/**
 * Naming das campanhas geradas por `scripts/clarice-cta-ab-setup.ts`:
 * "Diar.ia Mensal 2606 — envio 8A (cta-a qui 23/07)" / "... envio 8B (cta-b ...)".
 * `pairKey` = número do envio (8, 9, ...); `armId` = "a"/"b" (do "cta-a"/"cta-b",
 * fonte mais confiável que a letra maiúscula do nome da lista, que é só rótulo).
 */
const CTA01_NAME_RE = /envio\s*(\d+)[AB]\s*\(cta-([ab])/i;

export function matchCta01Campaign(name: string): { pairKey: string; armId: string } | null {
  const m = CTA01_NAME_RE.exec(name);
  if (!m) return null;
  return { pairKey: `envio-${m[1]}`, armId: m[2].toLowerCase() };
}

export const CTA01_EXPERIMENT: ExperimentDefinition = {
  id: "cta-01",
  name: "CTA-01 — copy do CTA do topo (Diar.ia Mensal, ciclo 2606-07)",
  status: "ativo",
  cycle: "2606-07",
  hypothesis:
    "Trocar o CTA do topo (Apresentação) por uma versão com benefício explícito e âncora de ação aumenta a " +
    "taxa de clique única no link em ≥30% relativo vs o texto atual (\"se cadastre gratuitamente [aqui]\").",
  arms: [
    { id: "a", label: "A (controle) — copy atual", utmCampaign: "clarice-2606-07-cta-a" },
    { id: "b", label: "B (tratamento) — copy B1 aprovada 22/07", utmCampaign: "clarice-2606-07-cta-b" },
  ],
  decisionMetricLabel: "Cliques no CTA do topo (utm_term=topo) ÷ entregues, por braço, acumulado entre envios",
  decisionUtmTerm: "topo",
  decisionRuleText:
    "Acumular envios até ~150 cliques de topo somados nos 2 braços (ou fim do ciclo, o que vier primeiro). " +
    "Teste de duas proporções sobre cliques: se B ≥ +30% relativo com p<0,05 e guardrails limpos → B vira o " +
    "novo controle (entra no template/render) e o round 2 testa a próxima variável. Senão → mantém A.",
  liftThreshold: 0.30,
  pValueThreshold: 0.05,
  guardrailsNote:
    "Mesmos circuit breakers da aba Rampa, por braço: abertura <15%, hard bounce ≥2% (ou total hard+soft ≥5%), " +
    "unsub ≥3%, spam ≥0,1%.",
  docPath: "docs/experiments/cta-ab-mensal-2606-07.md",
  matchCampaign: matchCta01Campaign,
};

/**
 * Registro de experimentos — CTA-01 ativo hoje. Rounds futuros (posição do
 * bloco dedicado, CTA do encerramento) entram aqui como novas entradas; a
 * seção "Experimento vigente" e o painel de avaliação iteram esta lista, sem
 * precisar de mudança estrutural.
 */
export const EXPERIMENTS: ExperimentDefinition[] = [CTA01_EXPERIMENT];

// ─── Pareamento + agregação por braço ────────────────────────────────────────

export interface ExperimentCampaignRef {
  pairKey: string;
  armId: string;
  campaign: CampaignRow;
}

/** Casa cada campanha da janela contra o experimento; ignora as que não pertencem a ele. */
export function matchExperimentCampaigns(
  campaigns: CampaignRow[],
  experiment: ExperimentDefinition,
): ExperimentCampaignRef[] {
  const out: ExperimentCampaignRef[] = [];
  for (const c of campaigns) {
    const m = experiment.matchCampaign(c.name ?? "");
    if (!m) continue;
    // Só conta braços DEFINIDOS no experimento — um armId fora do registro
    // (nome mudou/typo) é ignorado silenciosamente aqui, mas nunca contamina
    // as métricas de um braço que não existe.
    if (!experiment.arms.some((a) => a.id === m.armId)) continue;
    out.push({ pairKey: m.pairKey, armId: m.armId, campaign: c });
  }
  return out;
}

export interface ExperimentPair {
  pairKey: string;
  /** armId → campanha (ausente se o par ainda não tem as 2 campanhas). */
  arms: Record<string, CampaignRow | undefined>;
}

/**
 * Agrupa campanhas em pares por `pairKey` (ex: 1 par por envio do ramp).
 * Ordenado por `pairKey` (ordem alfanumérica — "envio-8" antes de "envio-9").
 * Exportado pra teste unitário e pra render da tabela de pareamento.
 */
export function pairExperimentCampaigns(
  campaigns: CampaignRow[],
  experiment: ExperimentDefinition,
): ExperimentPair[] {
  const refs = matchExperimentCampaigns(campaigns, experiment);
  const byPair = new Map<string, ExperimentPair>();
  for (const r of refs) {
    let pair = byPair.get(r.pairKey);
    if (!pair) {
      pair = { pairKey: r.pairKey, arms: {} };
      byPair.set(r.pairKey, pair);
    }
    pair.arms[r.armId] = r.campaign;
  }
  return [...byPair.values()].sort((a, b) => a.pairKey.localeCompare(b.pairKey, "pt-BR", { numeric: true }));
}

export interface ArmMetrics {
  armId: string;
  label: string;
  /** Nº de campanhas deste braço com stats reais somadas. */
  campaignCount: number;
  sent: number;
  delivered: number;
  /** Aberturas únicas (MPP-inclusivo — mesma base do resto do dashboard). */
  uniqueViews: number;
  /** Cliques únicos no nível da campanha inteira (globalStats/campaignStats). */
  uniqueClicks: number;
  /** Cliques (totais, por URL — ver limitação no topo do arquivo) no link da métrica de decisão. */
  decisionClicks: number;
  unsubscriptions: number;
  complaints: number;
  hardBounces: number;
  softBounces: number;
}

function emptyArmMetrics(armId: string, label: string): ArmMetrics {
  return {
    armId, label, campaignCount: 0, sent: 0, delivered: 0, uniqueViews: 0, uniqueClicks: 0,
    decisionClicks: 0, unsubscriptions: 0, complaints: 0, hardBounces: 0, softBounces: 0,
  };
}

/**
 * Cliques no link da métrica de decisão (ex: `utm_term=topo`) desta campanha,
 * pro braço `armDef`. Soma todos os links que casarem — normalmente 1 só (o
 * render canônico tem 1 CTA por posição), mas soma defensivamente em vez de
 * pegar só a 1ª ocorrência do `Object.entries`.
 */
export function countDecisionClicks(
  campaign: CampaignRow,
  armDef: ExperimentArmDef,
  decisionUtmTerm: string,
): number {
  const linksStats = getCampaignLinksStats(campaign);
  if (!linksStats) return 0;
  let total = 0;
  for (const [url, clicks] of Object.entries(linksStats)) {
    if (!Number.isFinite(clicks) || clicks <= 0) continue;
    if (url.includes(`utm_campaign=${armDef.utmCampaign}`) && url.includes(`utm_term=${decisionUtmTerm}`)) {
      total += clicks;
    }
  }
  return total;
}

/**
 * Acumula métricas por braço entre TODAS as campanhas do experimento já
 * enviadas (com stats reais) — independe de o par estar completo (um braço
 * pode ter 1 envio a mais que o outro enquanto o experimento roda). Braços
 * sem nenhuma campanha ainda retornam zerados (nunca `undefined`/ausentes),
 * na mesma ordem de `experiment.arms`.
 */
export function computeArmMetrics(
  campaigns: CampaignRow[],
  experiment: ExperimentDefinition,
): ArmMetrics[] {
  const byArm = new Map<string, ArmMetrics>(experiment.arms.map((a) => [a.id, emptyArmMetrics(a.id, a.label)]));
  const refs = matchExperimentCampaigns(campaigns, experiment);
  for (const { armId, campaign } of refs) {
    const armDef = experiment.arms.find((a) => a.id === armId);
    const metrics = byArm.get(armId);
    if (!armDef || !metrics) continue;
    const picked = pickStats(campaign);
    if (!picked) continue; // sem stats reais ainda (agendada/enviada há pouco)
    const { stats } = picked;
    metrics.campaignCount += 1;
    metrics.sent += stats.sent;
    metrics.delivered += stats.delivered;
    metrics.uniqueViews += stats.uniqueViews;
    metrics.uniqueClicks += stats.uniqueClicks;
    metrics.unsubscriptions += stats.unsubscriptions;
    metrics.complaints += stats.complaints;
    metrics.hardBounces += stats.hardBounces;
    metrics.softBounces += stats.softBounces;
    metrics.decisionClicks += countDecisionClicks(campaign, armDef, experiment.decisionUtmTerm);
  }
  return experiment.arms.map((a) => byArm.get(a.id)!);
}

// ─── Teste de duas proporções (z-test) ───────────────────────────────────────

export interface ExperimentDecisionResult {
  rateControl: number;
  rateTreatment: number;
  /** Lift relativo do tratamento sobre o controle: (rateTreatment - rateControl) / rateControl. */
  liftRelative: number;
  zStatistic: number;
  /** p-valor bicaudal. */
  pValue: number;
  significant: boolean;
  /** `liftRelative >= liftThreshold && significant` — regra pré-registrada do protocolo. */
  meetsDecisionRule: boolean;
  /** true se algum dos 2 braços ainda não tem denominador (delivered=0) — teste não é confiável. */
  insufficientData: boolean;
}

/**
 * Avalia a regra de decisão pré-registrada de um experimento A/B sobre a
 * métrica de decisão (numerador = `decisionClicks`, denominador = `delivered`)
 * de 2 braços. Reusa `twoProportionZTest` (#2976, já definido/testado em
 * sections-core.ts pro Resumo A/B/C por audiência) como primitiva estatística
 * — sem duplicar erf/normCdf/z-test aqui — e adiciona a semântica de
 * "lift relativo ≥ threshold E p < alpha" específica desta avaliação.
 *
 * `liftThreshold`/`alpha` = regra de decisão pré-registrada (default 30%/0,05
 * — os valores do protocolo CTA-01, parametrizados pra reuso em experimentos
 * futuros com regra diferente).
 */
export function evaluateExperimentDecision(
  control: Pick<ArmMetrics, "decisionClicks" | "delivered">,
  treatment: Pick<ArmMetrics, "decisionClicks" | "delivered">,
  liftThreshold = 0.30,
  alpha = 0.05,
): ExperimentDecisionResult {
  const insufficientData = !(control.delivered > 0) || !(treatment.delivered > 0);
  const rateControl = control.delivered > 0 ? control.decisionClicks / control.delivered : 0;
  const rateTreatment = treatment.delivered > 0 ? treatment.decisionClicks / treatment.delivered : 0;
  const liftRelative = rateControl > 0
    ? (rateTreatment - rateControl) / rateControl
    : (rateTreatment > 0 ? Infinity : 0);

  if (insufficientData) {
    return { rateControl, rateTreatment, liftRelative, zStatistic: 0, pValue: 1, significant: false, meetsDecisionRule: false, insufficientData: true };
  }

  // x1/n1 = tratamento, x2/n2 = controle → z = (pTratamento - pControle)/se
  // (positivo quando o tratamento cresce sobre o controle — leitura intuitiva
  // do lift). pValue é bicaudal (usa |z|), então a ordem dos argumentos não
  // afeta significância — só o sinal de `z`, aqui deliberado.
  const zTest: ZTestResult = twoProportionZTest(
    treatment.decisionClicks, treatment.delivered,
    control.decisionClicks, control.delivered,
  );
  const significant = zTest.pValue < alpha;
  const meetsDecisionRule = Number.isFinite(liftRelative) && liftRelative >= liftThreshold && significant;

  return {
    rateControl, rateTreatment, liftRelative,
    zStatistic: zTest.z, pValue: zTest.pValue, significant, meetsDecisionRule, insufficientData: false,
  };
}

// ─── Guardrails por braço (reusa os circuit breakers da Rampa) ──────────────

export interface ArmGuardrailResult {
  armId: string;
  openRatePct: number;
  hardBounceRatePct: number;
  bounceRatePct: number;
  unsubRatePct: number;
  spamRatePct: number;
  openBreach: boolean;
  bounceBreach: boolean;
  unsubBreach: boolean;
  spamBreach: boolean;
  anyBreach: boolean;
}

/**
 * Mesmos thresholds de `thresholds.ts` (fonte única dos circuit breakers da
 * Rampa/Envios/Totais por mês) — nenhum limiar novo inventado aqui.
 */
export function evaluateArmGuardrails(
  m: ArmMetrics,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): ArmGuardrailResult {
  const openRatePct = m.delivered > 0 ? (m.uniqueViews / m.delivered) * 100 : 0;
  const hardBounceRatePct = m.sent > 0 ? (m.hardBounces / m.sent) * 100 : 0;
  const bounceRatePct = m.sent > 0 ? ((m.hardBounces + m.softBounces) / m.sent) * 100 : 0;
  const unsubRatePct = m.sent > 0 ? (m.unsubscriptions / m.sent) * 100 : 0;
  const spamRatePct = m.sent > 0 ? (m.complaints / m.sent) * 100 : 0;
  // #3078: mesmo guard de "openAlert exige dado real" usado em sections-core.ts
  // (renderDashboardHtml) — exige `openRatePct > 0`, não só `delivered > 0`.
  // Uma campanha recém-enviada pode ter delivered>0 mas uniqueViews ainda em
  // 0 (dado de abertura ainda propagando, MPP leva minutos) — sem este guard
  // mais estrito, esse instante transitório seria erroneamente reportado como
  // guardrail cruzado. Trade-off aceito (mesmo do original): uma campanha
  // genuinamente com 0% de abertura PERMANENTE nunca alerta — raro na prática
  // (Brevo sempre tem MPP).
  const openBreach = openRatePct > 0 && openRatePct < thresholds.openRate.yellow;
  const bounceBreach = isBounceBreach(hardBounceRatePct, bounceRatePct, thresholds);
  const unsubBreach = unsubRatePct >= thresholds.unsubRate.yellow;
  const spamBreach = spamRatePct >= thresholds.spamRate.yellow;
  return {
    armId: m.armId, openRatePct, hardBounceRatePct, bounceRatePct, unsubRatePct, spamRatePct,
    openBreach, bounceBreach, unsubBreach, spamBreach,
    anyBreach: openBreach || bounceBreach || unsubBreach || spamBreach,
  };
}

// ─── Render: seção "Experimento vigente" ─────────────────────────────────────

function statusBadge(status: ExperimentStatus): string {
  if (status === "vencedor") return `<span class="alert-label" style="color:${STATUS_COLOR.green}">🏆 Vencedor</span>`;
  if (status === "encerrado") return `<span style="opacity:0.65;">⚪ Encerrado</span>`;
  return `<span class="alert-label" style="color:${STATUS_COLOR.green}">🟢 Ativo</span>`;
}

/**
 * Bloco "Experimento vigente" (pedido do editor, #3884): regras do(s)
 * experimento(s) — hipótese, braços, métrica de decisão, regra pré-registrada,
 * guardrails — visíveis na hora de avaliar/decidir, sem abrir o protocolo
 * completo em `docs/experiments/`. Iterando `experiments` (lista, não texto
 * hardcoded) — comporta múltiplos experimentos simultâneos/históricos.
 * `""` quando a lista está vazia (nenhum experimento registrado).
 */
export function renderExperimentRegistrySection(experiments: ExperimentDefinition[] = EXPERIMENTS): string {
  if (experiments.length === 0) return "";
  const items = experiments
    .map((exp) => {
      const armsList = exp.arms
        .map((a) => `<li><strong>${escHtml(a.id.toUpperCase())}</strong> — ${escHtml(a.label)}</li>`)
        .join("\n");
      const docNote = exp.docPath
        ? `<p class="section-note">Protocolo completo: <code>${escHtml(exp.docPath)}</code></p>`
        : "";
      return `<details class="links-ctr experiment-registry-item" id="experiment-${escHtml(exp.id)}" open>
  <summary class="links-summary">${statusBadge(exp.status)} · ${escHtml(exp.name)}</summary>
  <div class="links-table-wrap">
    <p class="section-note"><strong>Hipótese:</strong> ${escHtml(exp.hypothesis)}</p>
    <p class="section-note" style="margin-bottom:2px;"><strong>Braços:</strong></p>
    <ul class="payments-list">${armsList}</ul>
    <p class="section-note"><strong>Métrica de decisão:</strong> ${escHtml(exp.decisionMetricLabel)}</p>
    <p class="section-note"><strong>Regra pré-registrada:</strong> ${escHtml(exp.decisionRuleText)}</p>
    <p class="section-note"><strong>Guardrails:</strong> ${escHtml(exp.guardrailsNote)}</p>
    ${docNote}
  </div>
</details>`;
    })
    .join("\n");
  return `<section class="phase2-section" id="experiment-registry">
  <h2 class="section-title">Experimento vigente</h2>
  <p class="section-note">Regras registradas de cada experimento em andamento/encerrado — consulta rápida na hora de avaliar e decidir, sem abrir o protocolo completo.</p>
${items}
</section>`;
}

// ─── Render: painel de avaliação (pareamento + métricas + z-test + guardrails) ─

/**
 * Painel de avaliação de UM experimento: pareia campanhas A/B, acumula
 * métricas por braço, roda o z-test sobre a métrica de decisão, avalia
 * guardrails e expõe um campo manual (client-side, localStorage — sem key do
 * Beehiiv) pra conversões coladas do Acquisition details. Read-only: nenhuma
 * chamada de rede é feita por este módulo — `campaigns` já vem buscado pelo
 * call site (mesmo fetch que alimenta as outras abas).
 *
 * Generaliza pra N braços na tabela/pareamento, mas o z-test compara só os 2
 * primeiros braços de `experiment.arms` (controle=arms[0], tratamento=arms[1])
 * — suficiente pro protocolo A/B atual; um experimento A/B/C futuro precisaria
 * de comparações pairwise adicionais (fora de escopo aqui).
 */
export function renderExperimentEvaluationSection(
  experiment: ExperimentDefinition,
  campaigns: CampaignRow[],
): string {
  const sectionId = `experiment-eval-${escHtml(experiment.id)}`;
  const pairs = pairExperimentCampaigns(campaigns, experiment);
  if (pairs.length === 0) {
    return `<section class="phase2-section" id="${sectionId}">
  <h2 class="section-title">${escHtml(experiment.name)} — avaliação</h2>
  <p class="section-note">Nenhuma campanha do experimento encontrada ainda na janela buscada.</p>
</section>`;
  }

  const armMetrics = computeArmMetrics(campaigns, experiment);
  const guardrails = armMetrics.map((m) => evaluateArmGuardrails(m));

  const pairRows = pairs
    .map((p) => {
      const cells = experiment.arms
        .map((a) => {
          const c = p.arms[a.id];
          return c
            ? `${brevoReportLink(c.id)} <small>${escHtml(c.listName ?? "?")}</small>`
            : `<span style="opacity:0.5">— aguardando</span>`;
        })
        .join("</td><td>");
      return `<tr><td>${escHtml(p.pairKey)}</td><td>${cells}</td></tr>`;
    })
    .join("\n");

  const metricsRows = armMetrics
    .map((m, i) => {
      const g = guardrails[i];
      const decisionRate = pct(m.decisionClicks, m.delivered, 2);
      return `<tr>
        <td><strong>${escHtml(m.label)}</strong></td>
        <td>${m.campaignCount}</td>
        <td>${m.delivered}</td>
        <td${cellClass("metric", g.openBreach && "alert")}>${pct(m.uniqueViews, m.delivered)}</td>
        <td${cellClass("metric")}>${m.uniqueClicks}</td>
        <td${cellClass("metric")}>${m.decisionClicks}<br><small>${decisionRate}</small></td>
        <td${cellClass(g.unsubBreach && "alert")}>${pct(m.unsubscriptions, m.sent)}</td>
        <td${cellClass(g.spamBreach && "alert")}>${pct(m.complaints, m.sent, 3)}</td>
        <td${cellClass(g.bounceBreach && "alert")}>${pct(m.hardBounces + m.softBounces, m.sent)}</td>
      </tr>`;
    })
    .join("\n");

  const anyGuardrailBreach = guardrails.some((g) => g.anyBreach);
  const guardrailsNote = anyGuardrailBreach
    ? `<p class="section-note"><span class="alert-label">⚠ guardrail cruzado</span> em pelo menos 1 braço — ver células em vermelho na tabela acima.</p>`
    : `<p class="section-note">Guardrails limpos nos 2 braços até o momento.</p>`;

  const control = armMetrics[0];
  const treatment = armMetrics[1];
  let zTestHtml = "";
  if (control && treatment) {
    const zTest = evaluateExperimentDecision(control, treatment, experiment.liftThreshold, experiment.pValueThreshold);
    if (zTest.insufficientData) {
      zTestHtml = `<p class="section-note">Dados insuficientes pro teste estatístico ainda (braço sem entregas registradas).</p>`;
    } else {
      const liftLabel = Number.isFinite(zTest.liftRelative)
        ? `${(zTest.liftRelative * 100).toFixed(1)}%`
        : "∞ (controle com 0 cliques)";
      const decisionLine = zTest.meetsDecisionRule
        ? `<span class="alert-label" style="color:${STATUS_COLOR.green}">✓ regra de decisão cruzada — ${escHtml(treatment.label)} vence (lift ≥ ${(experiment.liftThreshold * 100).toFixed(0)}%, p&lt;${experiment.pValueThreshold})</span>`
        : `<span class="section-note" style="margin:0;">Regra de decisão ainda não cruzada — manter ${escHtml(control.label)}.</span>`;
      zTestHtml = `<div class="table-wrap" style="padding:12px;">
    <p style="margin:0 0 6px 0;"><strong>Taxa ${escHtml(control.label)}:</strong> ${pct(control.decisionClicks, control.delivered, 3)} (${control.decisionClicks}/${control.delivered})<br>
    <strong>Taxa ${escHtml(treatment.label)}:</strong> ${pct(treatment.decisionClicks, treatment.delivered, 3)} (${treatment.decisionClicks}/${treatment.delivered})<br>
    <strong>Lift relativo:</strong> ${liftLabel} · <strong>z:</strong> ${zTest.zStatistic.toFixed(3)} · <strong>p-valor (bicaudal):</strong> ${zTest.pValue.toFixed(4)}</p>
    <p style="margin:0;">${decisionLine}</p>
  </div>`;
    }
  }

  // #3884: campo manual de conversões Beehiiv (client-side, localStorage) — a
  // dashboard não tem key do Beehiiv, então não há fetch algum aqui. O editor
  // cola os números do Acquisition details; nada é enviado a nenhum servidor.
  const deliveredByArm = Object.fromEntries(armMetrics.map((m) => [m.armId, m.delivered]));
  const conversionsInputs = experiment.arms
    .map(
      (a) => `<label style="display:block;margin:6px 0;font-size:0.85rem;">
      Cadastros Beehiiv — ${escHtml(a.label)} (<code>utm_campaign=${escHtml(a.utmCampaign)}</code>):
      <input type="number" min="0" step="1" class="exp-conversions-input" data-experiment="${escHtml(experiment.id)}" data-arm="${escHtml(a.id)}" style="margin-left:6px;width:100px;padding:2px 6px;border:1px solid var(--rule);border-radius:4px;">
    </label>`,
    )
    .join("\n");
  const conversionsSection = `<div class="table-wrap" style="padding:12px;margin-top:12px;">
    <p class="section-note">Conversões Beehiiv por braço (cola manualmente do Acquisition details — a dashboard não tem key do Beehiiv; avaliar automação depois). Salvo só neste navegador (localStorage), nunca enviado a nenhum servidor.</p>
    ${conversionsInputs}
    <p id="exp-conversions-output-${escHtml(experiment.id)}" class="section-note" style="margin-top:8px;"></p>
  </div>
  <script>
  (function() {
    var expId = ${JSON.stringify(experiment.id)};
    var delivered = ${JSON.stringify(deliveredByArm)};
    var inputs = Array.prototype.slice.call(document.querySelectorAll('.exp-conversions-input[data-experiment="' + expId + '"]'));
    var output = document.getElementById('exp-conversions-output-' + expId);
    function storageKey(armId) { return 'exp-conversions-' + expId + '-' + armId; }
    function render() {
      var lines = [];
      inputs.forEach(function(inp) {
        var armId = inp.getAttribute('data-arm');
        var n = Number(inp.value);
        if (inp.value !== '' && !isNaN(n) && delivered[armId] > 0) {
          lines.push(armId.toUpperCase() + ': ' + (n / delivered[armId] * 100).toFixed(3) + '% (' + n + '/' + delivered[armId] + ')');
        }
      });
      if (output) output.textContent = lines.length ? 'Taxa de conversão (cadastros ÷ entregues): ' + lines.join(' · ') : '';
    }
    inputs.forEach(function(inp) {
      var saved = localStorage.getItem(storageKey(inp.getAttribute('data-arm')));
      if (saved !== null) inp.value = saved;
      inp.addEventListener('input', function() {
        localStorage.setItem(storageKey(inp.getAttribute('data-arm')), inp.value);
        render();
      });
    });
    render();
  })();
  </script>`;

  return `<section class="phase2-section" id="${sectionId}">
  <h2 class="section-title">${escHtml(experiment.name)} — avaliação</h2>
  <p class="section-note">Acumulado entre envios pareados por braço. Cliques do CTA de decisão são cliques TOTAIS por URL (a API Brevo v3 não expõe unique-clicks por link — mesma limitação documentada no resto do dashboard).</p>
  <h3 class="subsection-title">Pareamento por envio</h3>
  <div class="table-wrap">
  <table>
    <thead><tr><th scope="col">Envio</th>${experiment.arms.map((a) => `<th scope="col">${escHtml(a.label)}</th>`).join("")}</tr></thead>
    <tbody>${pairRows}</tbody>
  </table>
  </div>
  <h3 class="subsection-title">Acumulado por braço</h3>
  <div class="table-wrap">
  <table>
    <thead><tr>
      <th scope="col">Braço</th><th scope="col">Envios</th><th scope="col">Entregues</th>
      <th scope="col" title="Abertura única, MPP-inclusiva">Abertura</th>
      <th scope="col" title="Cliques únicos no nível da campanha inteira">Cliques únicos</th>
      <th scope="col" title="Cliques totais no link da métrica de decisão (utm_term configurado) — Brevo v3 não dá unique por link">Cliques decisão</th>
      <th scope="col">Unsub</th><th scope="col">Spam</th><th scope="col">Bounce</th>
    </tr></thead>
    <tbody>${metricsRows}</tbody>
  </table>
  </div>
  ${guardrailsNote}
  <h3 class="subsection-title">Teste de duas proporções — ${escHtml(experiment.decisionMetricLabel)}</h3>
  ${zTestHtml || `<p class="section-note">Sem os 2 braços com dados ainda.</p>`}
  <h3 class="subsection-title">Conversões (manual)</h3>
  ${conversionsSection}
</section>`;
}

/** Renderiza o painel de avaliação de TODOS os experimentos registrados, concatenado. `""` se a lista estiver vazia. */
export function renderExperimentsEvaluationSections(
  campaigns: CampaignRow[],
  experiments: ExperimentDefinition[] = EXPERIMENTS,
): string {
  return experiments.map((exp) => renderExperimentEvaluationSection(exp, campaigns)).join("\n");
}
