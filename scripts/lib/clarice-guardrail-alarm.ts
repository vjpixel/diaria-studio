/**
 * clarice-guardrail-alarm.ts (#4064)
 *
 * Lógica PURA (sem I/O) do alarme de guardrail furado do ramp Clarice — a
 * PARTE 1 da issue #4064 (só alarme, notificação por e-mail; a trava no
 * pré-flight do agendamento fica pra depois, decisão explícita do editor).
 *
 * Caso concreto que motivou a issue (#4061): o braço B do experimento CTA-01
 * fechou o envio 8 com 11,1% de abertura (limiar: 15%) e o envio 9B saiu no
 * dia seguinte mesmo assim (2,0% de abertura) — o sinal existia, estava
 * medido, mas nada notificava o editor a tempo de suspender o envio seguinte
 * (correção #4935: campanha agendada na Brevo NÃO é imutável — dá pra
 * cancelar via API, `PUT /emailCampaigns/{id}/status` com `status: cancel`
 * ou `suspended`, e recriar; a urgência do alarme continua válida porque
 * cancelar/recriar é uma ação que precisa da atenção do editor a tempo).
 *
 * Decisão do editor (260727, janela ajustada pra 10h em #4475): job roda
 * ~10h após CADA envio (`GUARDRAIL_EVAL_WINDOW_MS` — abertura já estabilizou,
 * folga antes do envio seguinte, que sai 06:00 BRT no dia seguinte). Reusa
 * `evaluateArmGuardrails`/`thresholds.ts`
 * (workers/brevo-dashboard/src/experiment-cta.ts) SEM reimplementar limiar —
 * `armMetricsFromCampaign` só adapta o shape de UMA campanha (não um
 * experimento A/B) pro formato `ArmMetrics` que essa função já espera.
 * EXCEÇÃO (#4154): spam usa `CTA_SPAM_BREACH_YELLOW_PCT` (constante própria
 * de `experiment-cta.ts`, não `thresholds.spamRate`) — ver docstring de
 * `describeBreaches` abaixo.
 */
import {
  evaluateArmGuardrails,
  CTA_SPAM_BREACH_YELLOW_PCT,
  type ArmMetrics,
  type ArmGuardrailResult,
} from "../../workers/brevo-dashboard/src/experiment-cta.ts";
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from "../../workers/brevo-dashboard/src/thresholds.ts";

/** Janela de espera pós-envio antes de avaliar guardrails (decisão do editor,
 * 260727 — 6h originais, ajustada pra 10h em #4475 pra dar mais folga de
 * estabilização da abertura antes da avaliação). */
export const GUARDRAIL_EVAL_WINDOW_MS = 10 * 60 * 60 * 1000;

// ─── Adapter: 1 campanha → ArmMetrics (reuso de evaluateArmGuardrails) ──────

export interface CampaignGuardrailInput {
  id: number | string;
  name: string;
  /** ISO. */
  sentDate: string;
  sent: number;
  delivered: number;
  uniqueViews: number;
  unsubscriptions: number;
  complaints: number;
  hardBounces: number;
  softBounces: number;
}

/**
 * Adapta os stats de UMA campanha (não um braço de experimento A/B) pro shape
 * `ArmMetrics` — `evaluateArmGuardrails` só usa `sent/delivered/uniqueViews/
 * unsubscriptions/complaints/hardBounces/softBounces`; `decisionClicks`/
 * `uniqueClicks` são irrelevantes pra guardrail (ficam 0), e `armId`/`label`
 * viram identificadores da campanha em si.
 */
export function armMetricsFromCampaign(input: CampaignGuardrailInput): ArmMetrics {
  return {
    armId: String(input.id),
    label: input.name,
    campaignCount: 1,
    sent: input.sent,
    delivered: input.delivered,
    uniqueViews: input.uniqueViews,
    uniqueClicks: 0,
    decisionClicks: 0,
    unsubscriptions: input.unsubscriptions,
    complaints: input.complaints,
    hardBounces: input.hardBounces,
    softBounces: input.softBounces,
  };
}

/**
 * Avalia os guardrails de UMA campanha — mesmos limiares do doc, via
 * `evaluateArmGuardrails`/`thresholds.ts`.
 *
 * #4131 finding 3: `treatZeroAsBreach: true` na chamada abaixo — este alarme
 * só avalia campanhas que já cruzaram `GUARDRAIL_EVAL_WINDOW_MS` (~10h
 * pós-envio, #4475, ver `isReadyForEvaluation`), então o guard
 * `openRatePct > 0` do path original de `evaluateArmGuardrails` (pensado pra
 * dashboard, dado ainda propagando minutos após o envio) não se aplicaria
 * aqui. Historicamente isso fazia 0% de abertura madura disparar o alarme
 * como falha catastrófica de entrega — ver #5166 abaixo pra por que esse
 * sinal (maduro ou não) deixou de gatilhar.
 *
 * #5166 (achado 12/08/2026): abertura NUNCA gatilha este alarme, mesmo
 * madura/em 0%. O breaker de abertura (`openBreach`, limiar `<15%`) nasceu
 * pro experimento CTA (#4061) — base warm, onde abertura baixa É sinal de
 * risco — e este alarme reusava o mesmo limiar pra TODA campanha Clarice,
 * sem distinguir da fila de 1º envio (`ramp-warm`/`novos`), estruturalmente
 * fria (~96%). Isso desalinhou com a decisão do editor em #4705/#5025: o
 * motor que decide VOLUME (`clarice-envio-policy.ts`) já tirou abertura do
 * freio de propósito — pra essa fila, abertura baixa é composição esperada,
 * não risco de ISP; usá-la como freio produziu a catraca 10.014→322→1.053→
 * 817 e-mails/dia em agosto/2026, com o Postmaster confirmando 0% de spam
 * nos mesmos dias. Ao vivo em 12/08: o motor de volume acelerou +14,89%
 * (freio ok) na MESMA madrugada em que este alarme mandou 2 e-mails de
 * "guardrail furado" citando só abertura (14,7% e 12,7%) — dois sistemas
 * dizendo coisas opostas sobre o mesmo dado, pro mesmo destinatário, no
 * mesmo dia.
 *
 * Retirado por completo (não só pra audiência fria, opção mais simples da
 * issue, não mutuamente exclusiva com filtrar por audiência no futuro): o
 * experimento CTA tem seu próprio gate/dashboard (`experiment-cta.ts`,
 * `evaluateArmGuardrails` chamado direto lá) que continua usando abertura
 * normalmente — só este e-mail duplicado deixa de gatilhar por ela. Só
 * bounce/unsub/spam continuam disparando o alarme (os mesmos 3 sinais que
 * `RED_RISK_THRESHOLDS`, em `clarice-envio-policy.ts`, já usa pra decidir
 * volume — hard bounce/bounce total/unsub já espelham 1:1 esses limiares,
 * via `DEFAULT_HEALTH_THRESHOLDS`; spam mantém o limiar próprio e mais
 * apertado deste módulo, `CTA_SPAM_BREACH_YELLOW_PCT`, compensando o
 * undercounting conhecido de `complaints` da Brevo — #4063/#4154 — que
 * afrouxá-lo pra igualar `RiskThresholdsPct` reabriria).
 *
 * `openRatePct` continua no resultado — vira contexto informativo no corpo
 * do e-mail (`buildGuardrailAlarmEmail`) e no log do CLI, nunca gatilho.
 * Trade-off aceito: uma falha real de entrega que não eleve bounce/unsub/spam
 * (rara — normalmente bounce sobe junto) só é pega por `shouldSunsetNonOpener`
 * (sunset permanente após 2 envios sem abertura) ou pelo monitor de spam do
 * Postmaster, não mais por este e-mail imediato.
 *
 * #5525 (achado ao vivo, campanha 146 "novos-260816"): breakers percentuais
 * sem piso de volume disparam com UM ÚNICO evento em campanhas pequenas —
 * sent=33, 1 unsub = 3,03% ≥ limiar de 3% (`thresholds.unsubRate.yellow`).
 * Investigação via dashboard confirmou: 4 de ~13 campanhas `novos` na janela
 * investigada cruzaram o breaker de unsub com só 1-3 unsubs absolutos
 * (sent 24-99), enquanto a taxa AGREGADA do cohort (12 unsub / 756 sent ≈
 * 1,6%) fica confortavelmente abaixo do próprio limiar amarelo (2%) — ruído
 * de amostra pequena em torno de uma taxa real saudável, não um problema
 * recorrente real. `MIN_SENT_FOR_RATE_BREACH`/`MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND`
 * abaixo suprimem bounce/unsub/spam breach quando o volume é pequeno DEMAIS
 * pra taxa ser confiável — MAS mantêm uma rede de segurança por CONTAGEM
 * ABSOLUTA (nunca por %), pra uma catástrofe real numa campanha pequena
 * (ex: 15 de 30 descadastrando) continuar visível. Escopo: só este path do
 * ALARME — `evaluateArmGuardrails` (usado direto pelo experimento CTA em
 * `experiment-cta.ts`) fica intocado, porque os braços desse experimento
 * sempre têm volume grande o bastante (300+ na prática) pra esse blind spot
 * nunca se manifestar lá.
 */
/** Piso de volume (`sent`) abaixo do qual um breach percentual só é
 * confiável se também cruzar `MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND` em
 * contagem absoluta (#5525). Escolhido acima do range observado de envios
 * `novos` (24-99) e abaixo do range típico dos envios diários (centenas a
 * milhares) — não é um piso estatístico formal, é o mesmo estilo de
 * constante simples/editor-tunável do resto deste módulo (ver
 * `thresholds.ts`). */
export const MIN_SENT_FOR_RATE_BREACH = 200;
/** Rede de segurança: mesmo abaixo de `MIN_SENT_FOR_RATE_BREACH`, o breach
 * continua disparando se o evento (unsubs/bounces/complaints) atingir esta
 * contagem ABSOLUTA — nunca deixa uma campanha pequena com resultado
 * genuinamente catastrófico ficar invisível só por causa do piso acima. */
export const MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND = 10;

export function evaluateSendGuardrails(
  input: CampaignGuardrailInput,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): ArmGuardrailResult {
  const raw = evaluateArmGuardrails(armMetricsFromCampaign(input), thresholds, { treatZeroAsBreach: true });
  // #5525: campanha pequena demais pra taxa percentual ser confiável — só
  // mantém o breach se a contagem ABSOLUTA do evento também for alta o
  // bastante (rede de segurança contra blind spot numa catástrofe real).
  const smallSend = input.sent < MIN_SENT_FOR_RATE_BREACH;
  const bounceBreach =
    raw.bounceBreach &&
    (!smallSend || input.hardBounces + input.softBounces >= MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND);
  const unsubBreach =
    raw.unsubBreach && (!smallSend || input.unsubscriptions >= MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND);
  const spamBreach = raw.spamBreach && (!smallSend || input.complaints >= MIN_ABSOLUTE_EVENT_COUNT_FOR_SMALL_SEND);
  return {
    ...raw,
    openBreach: false,
    bounceBreach,
    unsubBreach,
    spamBreach,
    anyBreach: bounceBreach || unsubBreach || spamBreach,
  };
}

// ─── Janela de avaliação + idempotência ─────────────────────────────────────

/** `true` quando `now - sentDate >= windowMs` (default: 10h, decisão do editor, #4475). */
export function isReadyForEvaluation(
  sentDateIso: string,
  now: Date,
  windowMs: number = GUARDRAIL_EVAL_WINDOW_MS,
): boolean {
  const sentMs = Date.parse(sentDateIso);
  if (!Number.isFinite(sentMs)) return false;
  return now.getTime() - sentMs >= windowMs;
}

export interface GuardrailAlarmState {
  /** IDs (como string) de campanhas já avaliadas — nunca reavaliar/realarmar a mesma campanha 2x. */
  evaluated: string[];
}

export function emptyGuardrailAlarmState(): GuardrailAlarmState {
  return { evaluated: [] };
}

/**
 * Filtra, dentre as campanhas ENVIADAS, quais estão prontas pra avaliação
 * (cruzaram a janela de 10h, #4475) E ainda não foram avaliadas (idempotência — sem
 * isso, cada execução do job re-alarmaria a mesma campanha indefinidamente).
 */
export function pickCampaignsPendingEvaluation<T extends { id: number | string; sentDate: string }>(
  sentCampaigns: T[],
  state: GuardrailAlarmState,
  now: Date,
  windowMs: number = GUARDRAIL_EVAL_WINDOW_MS,
): T[] {
  const evaluatedSet = new Set(state.evaluated.map(String));
  return sentCampaigns.filter(
    (c) => !evaluatedSet.has(String(c.id)) && isReadyForEvaluation(c.sentDate, now, windowMs),
  );
}

/** Marca uma campanha como avaliada (idempotente — não duplica se já presente). */
export function markEvaluated(state: GuardrailAlarmState, campaignId: number | string): GuardrailAlarmState {
  const id = String(campaignId);
  if (state.evaluated.includes(id)) return state;
  return { evaluated: [...state.evaluated, id] };
}

// ─── Próximo envio agendado (nomear + prazo de suspensão) ───────────────────

export interface ScheduledSendInfo {
  name: string;
  /** ISO. */
  scheduledAt: string;
}

/**
 * Encontra o próximo envio agendado (o mais próximo no FUTURO, relativo a
 * `now`) entre campanhas `queued` — é o que o alarme precisa nomear, já que
 * cancelar/recriar exige ação do editor (via API ou painel Brevo) antes do
 * horário de disparo (#4935 — não é estado terminal, mas o prazo é real).
 * `null` se não houver nenhum agendamento futuro.
 */
export function resolveNextScheduledSend<T extends { name: string; scheduledAt: string | null }>(
  scheduled: T[],
  now: Date,
): ScheduledSendInfo | null {
  const future = scheduled
    .filter((c): c is T & { scheduledAt: string } => {
      if (!c.scheduledAt) return false;
      const ms = Date.parse(c.scheduledAt);
      return Number.isFinite(ms) && ms > now.getTime();
    })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const next = future[0];
  return next ? { name: next.name, scheduledAt: next.scheduledAt } : null;
}

// ─── E-mail de alarme ────────────────────────────────────────────────────────

/**
 * Descreve, em texto, quais métricas romperam o breaker — usa os mesmos
 * rótulos/limiares do doc, sem reimplementar limiar. EXCEÇÃO: spam usa
 * `CTA_SPAM_BREACH_YELLOW_PCT` (0,1%, fixo), não `thresholds.spamRate.yellow`
 * — achado do self-review do #4342, 3ª rodada. `evaluateArmGuardrails`
 * (#4154) desacoplou `spamBreach` do threshold compartilhado (que o #4154
 * afrouxou de 0,1% pra 0,3% pros limiares oficiais do Postmaster), mas esta
 * função continuava imprimindo `thresholds.spamRate.yellow` como "o limite"
 * — pra qualquer complaints entre 0,1% e 0,3%, o e-mail de alarme dizia
 * "furou o guardrail" mostrando um limite (0,3%) que o número não cruzou,
 * autocontraditório pro editor que recebe o alerta.
 */
export function describeBreaches(
  guardrail: ArmGuardrailResult,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): string[] {
  const out: string[] = [];
  if (guardrail.openBreach) {
    out.push(`Abertura ${guardrail.openRatePct.toFixed(1)}% (limite: ≥${thresholds.openRate.yellow}%)`);
  }
  if (guardrail.bounceBreach) {
    out.push(
      `Bounce — hard ${guardrail.hardBounceRatePct.toFixed(2)}% (limite: <${thresholds.hardBounceRate.yellow}%) / total ${guardrail.bounceRatePct.toFixed(2)}% (limite: <${thresholds.bounceRate.yellow}%)`,
    );
  }
  if (guardrail.unsubBreach) {
    out.push(`Unsub ${guardrail.unsubRatePct.toFixed(2)}% (limite: <${thresholds.unsubRate.yellow}%)`);
  }
  if (guardrail.spamBreach) {
    out.push(`Spam (Brevo/complaints) ${guardrail.spamRatePct.toFixed(3)}% (limite: <${CTA_SPAM_BREACH_YELLOW_PCT}%)`);
  }
  return out;
}

/**
 * Monta o e-mail de alarme (pura/testável). Precisa SEMPRE: (a) nomear qual
 * é o próximo envio agendado e (b) até quando dá pra cancelar — requisito
 * explícito da decisão do editor. Campanha agendada na Brevo NÃO é imutável
 * (#4935): cancelar via API (`PUT /emailCampaigns/{id}/status`, `status:
 * cancel`/`suspended`) e recriar é sempre possível, mas o prazo até o
 * disparo continua real e é isso que o alarme comunica.
 *
 * #5166: abertura nunca gatilha `anyBreach` (ver `evaluateSendGuardrails`),
 * mas continua útil pro editor entender o quadro completo — sempre aparece
 * como linha de CONTEXTO, separada da lista de breaches, nunca como se
 * tivesse causado o alarme.
 */
/** `issueRef` (#5339, opcional, sempre o ÚLTIMO param — depois de
 * `thresholds`, que já tinha default antes desta unidade) — outcome de
 * `applyAlarmReconciliation` (`scripts/lib/alarm-issues.ts`) pro achado
 * desta campanha. `undefined` (dry-run, ou wiring ainda não chamado) omite
 * a citação sem quebrar nada — mesmo fallback dos outros alarmes já wired. */
export function buildGuardrailAlarmEmail(
  campaignName: string,
  guardrail: ArmGuardrailResult,
  nextScheduled: ScheduledSendInfo | null,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const breaches = describeBreaches(guardrail, thresholds);
  const subject = `[diar.ia.br] Guardrail furado no envio "${campaignName}"`;
  const lines = [
    `O envio "${campaignName}" fechou com guardrail furado, avaliado ~10h após o disparo:`,
    "",
    ...breaches.map((b) => `- ${b}`),
    "",
    `Abertura: ${guardrail.openRatePct.toFixed(1)}% (contexto — não gatilha mais este alarme, #5166).`,
    "",
  ];
  if (nextScheduled) {
    lines.push(
      `Próximo envio agendado: "${nextScheduled.name}", para ${nextScheduled.scheduledAt}.`,
      "Campanha agendada na Brevo NÃO é imutável — dá pra cancelar (painel Brevo, ou via API com " +
        "PUT /emailCampaigns/{id}/status, status: cancel ou suspended) e recriar com outras características — " +
        `se decidir não seguir com ele, cancele antes de ${nextScheduled.scheduledAt}.`,
    );
  } else {
    lines.push(
      "Nenhum próximo envio agendado encontrado no momento (nada a suspender agora, mas reavalie antes do próximo agendamento).",
    );
  }
  lines.push("", `(alarme automático — avaliação rodou em ${now.toISOString()})`);
  if (issueRef) {
    lines.push(
      "",
      issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`,
    );
  }
  return { subject, body: lines.join("\n") };
}
