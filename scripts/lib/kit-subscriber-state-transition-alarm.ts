/**
 * scripts/lib/kit-subscriber-state-transition-alarm.ts (#7660)
 *
 * Lógica PURA (sem I/O) do alarme de perda de assinante no Kit. Compara o
 * snapshot anterior com o atual e emite em DOIS eventos distintos:
 *
 *   1. transição `active` → {complained,bounced,cancelled,inactive}
 *      (`detectKitStateTransitions`);
 *   2. DESAPARECIMENTO — o assinante saiu do conjunto inteiro
 *      (`detectKitDisappearances`), independente do estado anterior.
 *
 * O segundo não é refinamento do primeiro: o caso que originou a issue
 * passou pelos dois em 12 dias, e nenhum deixou registro em lugar nenhum do
 * projeto — as duas transições só existem porque alguém foi olhar à mão,
 * onze dias depois, cutucado pelo próprio leitor no WhatsApp.
 */

import type { KitSubscriberSummary } from "./kit-subscribers.ts";

/** Estados de destino que contam como transição de perda (decisão do
 *  editor, #7660 — ver docstring do módulo). `bounced` INCLUÍDO por
 *  default mais seguro. */
export const KIT_STATE_TRANSITION_ALARM_STATES: readonly string[] = [
  "complained",
  "bounced",
  "cancelled",
  "inactive",
];

/** Estado de origem — só assinantes que ESTAVAM `active` no snapshot
 *  anterior contam. */
export const KIT_STATE_TRANSITION_FROM_STATE = "active";

/** Chave estável de finding pro `alarm-issues.ts` — 1 issue por assinante,
 *  não 1 por transição (mesmo padrão de `kitDoiOrphanFindingKey`). Só o id
 *  entra — nunca o estado/destino (varia, quebraria a idempotência). */
export const KIT_STATE_TRANSITION_FINDING_KEY_PREFIX = "kit-subscriber-state-transition";

export function kitStateTransitionFindingKey(subscriberId: number): string {
  return `${KIT_STATE_TRANSITION_FINDING_KEY_PREFIX}:${subscriberId}`;
}

export interface KitStateTransition {
  id: number;
  address: string;
  fromState: string;
  toState: string;
  /** ISO do snapshot em que a transição foi detectada (= `now` do caller). */
  detectedAt: string;
  /** `apoio_nivel` custom field, quando preenchido — sinal de que é um
   *  apoiador real, não cadastro de teste. */
  apoioNivel?: string;
  /** Último `sent`/`opened`/`clicked` conhecido, quando o caller passar —
   *  ajuda o editor a priorizar. */
  engagement?: { sent: number; opened: number; clicked: number };
}

export interface KitStateTransitionSnapshotEntry {
  id: number;
  state: string;
  /**
   * E-mail do assinante no momento do snapshot. OPCIONAL porque snapshots
   * gravados antes do #7660 follow-up só têm `{id, state}` — ler um deles
   * não pode quebrar a primeira execução depois do deploy.
   *
   * Passou a ser persistido quando o alarme ganhou a detecção de
   * DESAPARECIMENTO: quem sumiu da conta não está no snapshot ATUAL, então
   * o anterior é a ÚNICA fonte do endereço. Sem ele o alarme só saberia
   * dizer "o id 4264399626 sumiu", que não é acionável por um humano.
   */
  address?: string;
  /**
   * `apoio_nivel` do assinante — é ele que separa "apoiador pagante
   * evaporou" de "cadastro de teste removido", e como quem some não está no
   * snapshot atual, o anterior é a única fonte.
   *
   * Ausente por DOIS motivos distintos, e o comum não é o do `address`
   * acima: (1) o assinante simplesmente não é apoiador — o caso da maioria
   * da base, permanente, nunca vai deixar de acontecer; (2) o snapshot é
   * anterior a este campo — transitório, some quando os snapshots velhos
   * rolarem. Não deduzir de "ausente" que o snapshot é antigo.
   */
  apoioNivel?: string;
}

/**
 * Pura — detecta transições de estado entre `previous` (snapshot do dia
 * anterior) e `current` (snapshot de hoje). Só conta quando o assinante
 * estava `active` no snapshot anterior e está em um dos estados de alarme
 * (`KIT_STATE_TRANSITION_ALARM_STATES`) no atual. Assinantes novos
 * (sem entry no `previous`) NÃO contam — não há transição detectável; o
 * cadastro novo é assunto do DOI orphan guard (#6810), não deste alarme.
 */
export function detectKitStateTransitions(
  previous: readonly KitStateTransitionSnapshotEntry[],
  current: readonly KitSubscriberSummary[],
  now: Date,
  alarmStates: readonly string[] = KIT_STATE_TRANSITION_ALARM_STATES,
): KitStateTransition[] {
  const prev = new Map(previous.map((p) => [p.id, p.state] as const));
  const transitions: KitStateTransition[] = [];
  for (const s of current) {
    const fromState = prev.get(s.id);
    if (fromState === undefined) continue;
    if (fromState !== KIT_STATE_TRANSITION_FROM_STATE) continue;
    if (!alarmStates.includes(s.state)) continue;
    transitions.push({
      id: s.id,
      address: s.email_address,
      fromState,
      toState: s.state,
      detectedAt: now.toISOString(),
      apoioNivel: s.fields?.apoio_nivel,
    });
  }
  return transitions;
}

// ─── Desaparecimento (#7660, 3º comentário) ────────────────────────────────

/**
 * Assinante que sumiu do conjunto inteiro entre dois snapshots — não mudou
 * de estado, deixou de existir na conta.
 *
 * É um evento DISTINTO da transição de estado, e não um caso dela: o caso
 * que originou a issue passou pelos dois em 12 dias (virou `complained` em
 * 28-29/08, sumiu da conta entre 08/09 22:30 e 09/09 02:30 — o editor o
 * removeu pelo painel), e um diff que só olha quem está presente nos DOIS
 * lados perde exatamente o segundo. Por isso tem tipo, detector e
 * fingerprint próprios: as duas emissões precisam coexistir sem uma
 * deduplicar a outra.
 */
export interface KitDisappearance {
  id: number;
  /** `null` quando o snapshot anterior é antigo demais pra ter `address`
   *  (ver `KitStateTransitionSnapshotEntry.address`) — o alarme ainda emite,
   *  só sem conseguir nomear quem sumiu. */
  address: string | null;
  /** Estado no último snapshot em que o assinante existia. */
  lastState: string;
  detectedAt: string;
  apoioNivel?: string;
}

export const KIT_DISAPPEARANCE_FINDING_KEY_PREFIX = "kit-subscriber-disappeared";

export function kitDisappearanceFindingKey(subscriberId: number): string {
  return `${KIT_DISAPPEARANCE_FINDING_KEY_PREFIX}:${subscriberId}`;
}

/**
 * Pura — assinantes presentes em `previous` e ausentes em `current`.
 *
 * Diferente de `detectKitStateTransitions`, NÃO exige que o estado anterior
 * fosse `active`: quem some estando `complained` some do mesmo jeito, e foi
 * justamente esse o caso real. Filtrar por `active` aqui reproduziria o
 * silêncio que a issue existe pra acabar.
 */
export function detectKitDisappearances(
  previous: readonly KitStateTransitionSnapshotEntry[],
  current: readonly KitSubscriberSummary[],
  now: Date,
): KitDisappearance[] {
  const presentIds = new Set(current.map((s) => s.id));
  return previous
    .filter((p) => !presentIds.has(p.id))
    .map((p) => ({
      id: p.id,
      address: p.address ?? null,
      lastState: p.state,
      detectedAt: now.toISOString(),
      apoioNivel: p.apoioNivel,
    }));
}

// ─── Correlação com o histórico de envio (#7660, 1º comentário) ────────────

/**
 * O que o store de onboarding (`data/onboarding/store.json`) sabe sobre um
 * endereço que acabou de sair. O caller lê o store; esta camada só formata.
 *
 * Existe porque um `complained` isolado é um dado, e um `complained` em
 * alguém que recebeu envio anômalo dias antes é um dado com causa provável
 * ao lado. No caso de origem, o assinante recebeu o e-mail 1 de boas-vindas
 * indevidamente em 24/08 (incidente #6043, 585 pessoas), depois de ~8 meses
 * lendo a diária — quatro dias antes de o Hotmail registrar a queixa.
 */
export interface KitLossOnboardingContext {
  /** ISO do envio do e-mail 1 de boas-vindas; `null` = nunca saiu. */
  email1SentAt: string | null;
  /** `seeded_by` do store — entrada criada por recuperação manual. */
  seededBy?: string;
}

/** Janela em que um envio de onboarding é reportado como CORRELACIONADO
 *  (destaque), não só como histórico. 30 dias cobre a cadência inteira da
 *  sequência (e-mail 1 → 3 leva D+10) com folga. */
export const KIT_LOSS_CORRELATION_WINDOW_DAYS = 30;

/** Pura — linhas de correlação pro corpo da issue. Sem contexto (endereço
 *  desconhecido, store ausente, endereço fora do store) devolve uma linha
 *  dizendo isso — nunca silêncio, que se leria como "não houve envio". */
export function onboardingCorrelationLines(
  ctx: KitLossOnboardingContext | undefined,
  detectedAt: string,
): string[] {
  if (!ctx) {
    return [
      "Correlação de envio: nenhum registro deste endereço em `data/onboarding/store.json`",
      "(ou o store não estava disponível nesta execução).",
    ];
  }
  if (!ctx.email1SentAt) {
    const seeded = ctx.seededBy ? ` Entrada semeada manualmente por ${ctx.seededBy}.` : "";
    return [`Correlação de envio: está no store de onboarding, sem e-mail 1 enviado.${seeded}`];
  }
  const dias = Math.floor(
    (Date.parse(detectedAt) - Date.parse(ctx.email1SentAt)) / 86_400_000,
  );
  const dentroDaJanela = dias >= 0 && dias <= KIT_LOSS_CORRELATION_WINDOW_DAYS;
  // `dias` negativo não deveria acontecer (o envio precede a detecção), mas
  // nada no tipo impede — e "(-3 dia(s) antes)" seria uma frase sem sentido.
  const intervalo = !Number.isFinite(dias)
    ? "."
    : dias >= 0
      ? ` (${dias} dia(s) antes desta detecção).`
      : ` (${Math.abs(dias)} dia(s) DEPOIS desta detecção — ordem inesperada, conferir os dois carimbos).`;
  const linhas = [
    `${dentroDaJanela ? "⚠️ CORRELAÇÃO" : "Correlação de envio"}: recebeu o e-mail 1 de ` +
      `boas-vindas em ${ctx.email1SentAt}${intervalo}`,
  ];
  if (ctx.seededBy) linhas.push(`Entrada semeada manualmente por ${ctx.seededBy}.`);
  if (dentroDaJanela) {
    linhas.push(
      "Boas-vindas para quem já era leitor antigo é o padrão do incidente #6043 (585 envios",
      "indevidos em 24/08/2026) — checar se este endereço estava naquele lote antes de tratar",
      "a saída como espontânea.",
    );
  }
  return linhas;
}

/** Playbook de recuperação — o mesmo para transição e desaparecimento, e a
 *  razão de o alarme não ser só um relatório: sem ele, quem lê a issue
 *  precisa redescobrir do zero que `complained` não volta por API e que o
 *  recadastro dispara boas-vindas indevidas (#7660, 3º comentário). */
export function kitLossRecoveryPlaybook(): string[] {
  return [
    "## Recuperação (#7660)",
    "",
    "1. O Kit NÃO reativa `complained`/`bounced` por API. O único caminho é a pessoa",
    "   se recadastrar pelo form de DOI (`platform.config.json` → `kit.doiFormId`).",
    "   `cancelled`/`inactive` têm caminhos diferentes — conferir o painel antes.",
    "2. **Armadilha do recadastro**: o Kit cria um assinante NOVO (id novo, `created_at`",
    "   = agora), então a rodada diária de `onboarding-welcome-run.ts` (09:05 BRT) o",
    "   detecta como cadastro novo e manda o e-mail 1 de boas-vindas — para alguém que",
    "   lê a diária há meses. ANTES da rodada seguinte ao recadastro, semear:",
    "",
    "   ```",
    "   npx tsx scripts/onboarding-welcome-run.ts \\",
    "     --emails <endereço> --seed-email1-sent-at <ISO do recadastro> --seeded-by \"#7660\"",
    "   ```",
    "",
    "   Sem `--send` é dry-run. A janela é curta e o envio transacional sai com 60s de",
    "   lead — depois que sai, não há desfazer.",
    "3. Se o assinante era apoiador pagante, a conversa é do editor, não da automação.",
  ];
}

/**
 * Pura — o esqueleto comum aos dois corpos de issue (cabeçalho, rótulo de
 * apoiador, correlação, playbook, rodapé). Os dois EVENTOS continuam com
 * tipos e fingerprints separados de propósito; o que se compartilha aqui é
 * só a FORMATAÇÃO, que antes estava copiada nos dois construtores e já
 * tinha começado a divergir (achado do review da PR #7828).
 */
function buildLossFindingBody(opts: {
  /** As linhas que descrevem o que aconteceu — a única parte que difere. */
  fato: readonly string[];
  apoioNivel: string | undefined;
  /** Texto do rótulo quando NÃO há `apoio_nivel` — a transição e o
   *  desaparecimento falam de tempos diferentes ("preenchido" vs "no último
   *  snapshot"). */
  semApoioNivel: string;
  comApoioNivelSufixo: string;
  correlationLines: readonly string[];
}): string {
  return [
    "Achado automático do alarme `Diaria-Kit-Subscriber-State-Transition-Alarm`",
    "(`scripts/kit-subscriber-state-transition-alarm.ts`).",
    "",
    ...opts.fato,
    "",
    opts.apoioNivel
      ? `Custom field \`apoio_nivel\` preenchido (${opts.apoioNivel}) — ${opts.comApoioNivelSufixo}`
      : opts.semApoioNivel,
    "",
    ...opts.correlationLines,
    "",
    ...kitLossRecoveryPlaybook(),
    "",
    "Esta issue é `alarm-evento` — fato histórico, NUNCA fecha sozinha.",
    "Só um humano fecha após ação concreta.",
  ].join("\n");
}

/** Pura — converte cada transição em um `AlarmFinding` do `alarm-issues.ts`.
 *  `family: "evento"` (fato histórico, não auto-resolve) — o assinante
 *  continua naquele estado até o editor agir manualmente (ex: re-registro
 *  via DOI pra `complained`), então a issue NUNCA fecha sozinha. */
export function toStateTransitionAlarmFindings(
  transitions: readonly KitStateTransition[],
  correlations: ReadonlyMap<string, KitLossOnboardingContext> = new Map(),
): import("./alarm-issues.ts").AlarmFinding[] {
  return transitions.map((t) => {
    const isApoiador = Boolean(t.apoioNivel);
    const title = isApoiador
      ? `[diar.ia.br] Kit: apoiador ${t.address} (id ${t.id}) virou ${t.toState} a partir de ${t.fromState}`
      : `[diar.ia.br] Kit: assinante ${t.address} (id ${t.id}) virou ${t.toState} a partir de ${t.fromState}`;
    const body = buildLossFindingBody({
      fato: [
        `Assinante ${t.address} (id ${t.id}) mudou de estado no Kit:`,
        `  ${t.fromState} → ${t.toState}`,
        `  detectado em ${t.detectedAt}`,
      ],
      apoioNivel: t.apoioNivel,
      comApoioNivelSufixo: "é um apoiador real, não cadastro de teste.",
      semApoioNivel: "Sem custom field `apoio_nivel` preenchido.",
      correlationLines: onboardingCorrelationLines(correlations.get(t.address.toLowerCase()), t.detectedAt),
    });
    return {
      check: KIT_STATE_TRANSITION_FINDING_KEY_PREFIX,
      fingerprint: kitStateTransitionFindingKey(t.id),
      family: "evento",
      title,
      body,
      labels: ["bug"],
      priority: "P1",
    };
  });
}

/**
 * Pura — `AlarmFinding` por assinante que SUMIU. Fingerprint próprio
 * (`kit-subscriber-disappeared:{id}`), nunca o da transição: o assinante do
 * caso de origem passou pelos dois eventos, e reusar a chave faria o
 * segundo ser deduplicado contra a issue do primeiro — o alarme emitiria
 * uma vez onde deveria emitir duas.
 */
export function toDisappearanceAlarmFindings(
  disappearances: readonly KitDisappearance[],
  correlations: ReadonlyMap<string, KitLossOnboardingContext> = new Map(),
): import("./alarm-issues.ts").AlarmFinding[] {
  return disappearances.map((d) => {
    const quem = d.address ?? `id ${d.id}`;
    const rotulo = d.apoioNivel ? "apoiador" : "assinante";
    const title = `[diar.ia.br] Kit: ${rotulo} ${quem} (id ${d.id}) SUMIU da conta (último estado: ${d.lastState})`;
    const body = buildLossFindingBody({
      fato: [
        `O assinante ${quem} (id ${d.id}) estava no snapshot anterior e NÃO está no atual —`,
        "não mudou de estado, deixou de existir na conta Kit.",
        `  último estado conhecido: ${d.lastState}`,
        `  detectado em ${d.detectedAt}`,
        ...(d.address === null
          ? ["", "Snapshot anterior sem `address` (gravado antes do follow-up do #7660) — só o id é conhecido."]
          : []),
        "",
        "Causas possíveis, em ordem de frequência esperada: remoção manual pelo painel do",
        "Kit (foi o que aconteceu no caso de origem), limpeza de cadastro de teste, ou purga",
        "do próprio Kit. O alarme não distingue — só garante que a saída deixe registro.",
      ],
      apoioNivel: d.apoioNivel,
      comApoioNivelSufixo: "era um apoiador real.",
      semApoioNivel: "Sem custom field `apoio_nivel` no último snapshot.",
      correlationLines: d.address
        ? onboardingCorrelationLines(correlations.get(d.address.toLowerCase()), d.detectedAt)
        : ["Correlação de envio: endereço desconhecido no snapshot anterior — não dá pra cruzar com o onboarding."],
    });
    return {
      check: KIT_DISAPPEARANCE_FINDING_KEY_PREFIX,
      fingerprint: kitDisappearanceFindingKey(d.id),
      family: "evento",
      title,
      body,
      labels: ["bug"],
      priority: "P1",
    };
  });
}

// ─── Idempotência do e-mail (latch por assinante) ──────────────────────────

export interface KitStateTransitionAlarmState {
  /** `Set` de ids já alertados (transição ativa e e-mail enviado). */
  alertedSubscriberIds: number[];
  /**
   * Ids já alertados por DESAPARECIMENTO. Latch separado do de transição
   * porque os dois eventos coexistem no mesmo assinante (ver
   * `toDisappearanceAlarmFindings`) — um único conjunto faria o segundo
   * evento ser lido como "já alertei este id".
   *
   * Opcional na LEITURA: um `.transition-latch.json` gravado antes deste
   * follow-up não tem o campo, e tratar isso como corrupção re-alarmaria
   * transições antigas sem necessidade.
   */
  alertedDisappearedIds?: number[];
  /** ISO — só pra REPORTAR, não participa da decisão. */
  lastCheckedAt: string | null;
}

export function emptyKitStateTransitionAlarmState(): KitStateTransitionAlarmState {
  return { alertedSubscriberIds: [], alertedDisappearedIds: [], lastCheckedAt: null };
}

/** Pura — `true` quando há desaparecimento ainda não alertado. */
export function shouldAlarmKitDisappearance(
  state: KitStateTransitionAlarmState,
  disappearances: readonly KitDisappearance[],
): boolean {
  const alerted = state.alertedDisappearedIds ?? [];
  return disappearances.some((d) => !alerted.includes(d.id));
}

/** Pura — `true` quando a transição é NOVA (assinante ainda não foi
 *  alertado). Re-arma quando o assinante volta a `active` e transitiona
 *  novamente (o `advance` limpa o id do `alertedSubscriberIds`). */
export function shouldAlarmKitStateTransition(
  state: KitStateTransitionAlarmState,
  transitions: readonly KitStateTransition[],
): boolean {
  return transitions.some((t) => !state.alertedSubscriberIds.includes(t.id));
}

/**
 * Pura — quais eventos podem entrar no latch: só os que de fato viraram
 * issue. `failedFingerprints` são as findings cujo `ensureAlarmIssue`
 * falhou (`action: "failed"` — `gh` sem auth, rate limit, 5xx transitório).
 *
 * Sem este filtro o alarme reproduz, no seu próprio mecanismo, a falha que
 * ele existe pra impedir: `applyAlarmReconciliation` é fail-soft POR
 * FINDING e deixa a entrada de estado intocada pra tentar de novo na
 * execução seguinte — mas quem decide se a finding é sequer regerada é este
 * latch. Latchar um id cuja issue falhou remove a transição de `novas` pra
 * sempre, o retry nunca acontece, e o registro durável daquele assinante
 * some em silêncio (achado do review da PR #7828, P1).
 */
export function selectLatchableEvents(
  transitions: readonly KitStateTransition[],
  disappearances: readonly KitDisappearance[],
  failedFingerprints: ReadonlySet<string>,
): { transitions: KitStateTransition[]; disappearances: KitDisappearance[] } {
  return {
    transitions: transitions.filter((t) => !failedFingerprints.has(kitStateTransitionFindingKey(t.id))),
    disappearances: disappearances.filter((d) => !failedFingerprints.has(kitDisappearanceFindingKey(d.id))),
  };
}

/** Pura — avança o latch: marca os ids alertados e limpa os que voltaram
 *  a `active` (re-arma pra uma próxima transição). */
export function advanceKitStateTransitionAlarmState(
  state: KitStateTransitionAlarmState,
  transitions: readonly KitStateTransition[],
  activeSubscriberIds: readonly number[],
  now: Date,
  disappearances: readonly KitDisappearance[] = [],
): KitStateTransitionAlarmState {
  const stillAlerted = state.alertedSubscriberIds.filter(
    (id) => !activeSubscriberIds.includes(id),
  );
  const newlyAlerted = transitions.map((t) => t.id);
  const alerted = Array.from(new Set([...stillAlerted, ...newlyAlerted])).sort(
    (a, b) => a - b,
  );
  // O latch de desaparecimento não tem contrapartida ao `activeSubscriberIds`
  // acima (que re-arma quem voltou a `active`): um id do Kit não é reusado —
  // recadastro cria assinante NOVO, com id novo (#7660, 3º comentário). Então
  // este conjunto só cresce, e o desaparecimento alarma exatamente uma vez.
  const disappeared = Array.from(
    new Set([...(state.alertedDisappearedIds ?? []), ...disappearances.map((d) => d.id)]),
  ).sort((a, b) => a - b);
  return {
    alertedSubscriberIds: alerted,
    alertedDisappearedIds: disappeared,
    lastCheckedAt: now.toISOString(),
  };
}
