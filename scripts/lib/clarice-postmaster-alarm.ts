/**
 * lib/clarice-postmaster-alarm.ts (#5399 achado 2, estendido pelo #5412)
 *
 * Lógica PURA (sem I/O) do alarme de sinal de spam do Postmaster degradado
 * pra `indeterminate` — mesmo molde de `scripts/lib/clarice-opens-catchup-alarm.ts`.
 *
 * Contexto: o freio de ISP (`decideBrake`, `scripts/lib/clarice-envio-policy.ts`)
 * já é fail-safe por desenho quando `spamSignal.source === "indeterminate"`
 * (assume 70% de utilização — `INDETERMINATE_SPAM_UTIL` —, nunca acelera,
 * nunca para sozinho). O problema NÃO é o freio decidir errado; é que
 * `clarice-envio-alarm.ts`, `clarice-envio-guard-alarm.ts`,
 * `clarice-guardrail-alarm.ts` e `clarice-opens-catchup-alarm.ts` — os 4
 * alarmes já wired do domínio Clarice — não têm NENHUMA referência a
 * postmaster (grep limpo, achado ao vivo 16/08/2026): o operador pode decidir
 * volume MANUALMENTE sem saber que o sinal primário de spam está cego.
 *
 * `isPostmasterEntryStale` (#5399) cobria só o eixo `date`/`POSTMASTER_DATA_STALE_MS`
 * (branch `"date-stale"` de `resolveSpamSignal`). #5412 (achado 1 do
 * self-review da PR #5411): `resolveSpamSignal` também produz
 * `source==="indeterminate"` por `"recorded-stale"` (gravação velha — o sync
 * provavelmente parou) e `"low-coverage"` (janela sondada com poucos dias de
 * dado válido) — nenhum dos dois disparava o alarme. Em vez de reimplementar
 * mais 2 branches à mão, `isPostmasterEntryStale` agora DELEGA pra
 * `resolveSpamSignal` inteira (`source === "indeterminate"`) — cobre os 5
 * motivos possíveis (`missing`/`malformed`/`recorded-stale`/`date-stale`/
 * `low-coverage`) por construção, sem poder divergir de novo do que o
 * freio de ISP realmente vê.
 *
 * #5412 (achado 2): `fetchPostmasterSpamEntry` (clarice-schedule-ramp.ts)
 * colapsa "fetch falhou (rede/erro/non-2xx)" e "fetch OK mas sem leitura
 * válida" no mesmo `null` — os dois viravam o MESMO texto de alarme
 * ("verifique a task de sync"), quando na verdade "dashboard fora do ar" é
 * um problema DIFERENTE (rede/Worker) do "sync não populou leitura fresca".
 * `PostmasterStaleAlarmState.lastStaleReason` carrega essa distinção
 * (`"fetch-failed"` é um valor adicional, fora do enum de
 * `SpamSignalIndeterminateReason`) — passada explicitamente pelo I/O
 * (`scripts/clarice-postmaster-alarm.ts`, via `fetchPostmasterSpamEntryDetailed`),
 * não inferida aqui (esta camada continua pura, sem saber COMO o fetch foi feito).
 *
 * ─── Por que N ciclos consecutivos, não a 1ª leitura stale isolada ─────────
 *
 * O sync roda a cada 12h (`Diaria-Postmaster-Spam-Sync`). Uma checagem
 * isolada pegando o meio de uma janela de atraso normal (ex: o sync ainda
 * não rodou hoje, mas roda em instantes) não é sinal de nada quebrado — 2
 * ciclos CONSECUTIVOS sem uma leitura fresca é. `CONSECUTIVE_STALE_THRESHOLD`
 * decide o N ("por mais de um ciclo", #5399).
 */

import { resolveSpamSignal, POSTMASTER_DATA_STALE_MS, type SpamSignalIndeterminateReason } from "../../workers/brevo-dashboard/src/thresholds.ts";

export { POSTMASTER_DATA_STALE_MS };

/** N checagens consecutivas com leitura stale antes de alarmar. */
export const CONSECUTIVE_STALE_THRESHOLD = 2;

/** Entry mínima que `resolveSpamSignal` (e portanto `isPostmasterEntryStale`)
 * precisa — mesmo Pick que `fetchPostmasterSpamEntry` (clarice-schedule-ramp.ts)
 * já devolve. `null`/`undefined` = nenhuma leitura chegou. */
export type PostmasterEntryForStaleCheck = Parameters<typeof resolveSpamSignal>[0];

/** #5412 — motivo da última checagem stale: os 5 valores de
 * `SpamSignalIndeterminateReason` (`missing`/`malformed`/`recorded-stale`/
 * `date-stale`/`low-coverage`), OU `"fetch-failed"` quando o FETCH ao
 * dashboard falhou (rede/erro/non-2xx) — distinto de "fetch OK mas sem
 * leitura válida" (que cai em `missing`/`malformed`). */
export type PostmasterStaleReason = SpamSignalIndeterminateReason | "fetch-failed";

export interface PostmasterStaleAlarmState {
  consecutiveStale: number;
  /** ISO do último e-mail de alarme enviado pra este streak, ou `null` se
   * ainda não alarmamos (streak resetado, ou ainda abaixo do threshold). */
  lastAlarmedAt: string | null;
  /** ISO da última checagem — só informativo, fora da idempotência. */
  lastCheckedAt: string | null;
  /** #5412 — motivo da checagem stale mais recente, ou `null` quando a
   * última checagem NÃO estava stale (streak zerado/nunca começou). */
  lastStaleReason: PostmasterStaleReason | null;
}

export function emptyPostmasterStaleAlarmState(): PostmasterStaleAlarmState {
  return { consecutiveStale: 0, lastAlarmedAt: null, lastCheckedAt: null, lastStaleReason: null };
}

/**
 * Pure: a leitura está STALE (`spamSignal.source === "indeterminate"`, por
 * QUALQUER um dos 5 motivos que `resolveSpamSignal` produz)? Delega pra
 * `resolveSpamSignal` inteira em vez de reimplementar um subconjunto dos
 * branches (#5412 — ver docstring do módulo).
 */
export function isPostmasterEntryStale(entry: PostmasterEntryForStaleCheck, now: Date): boolean {
  return resolveSpamSignal(entry, now).source === "indeterminate";
}

/**
 * Pure: computa o próximo estado dado a entry mais recente lida do
 * dashboard. Uma leitura FRESCA zera o streak e re-arma o alarme pra próxima
 * ocorrência (mesmo padrão de `clarice-opens-catchup-alarm.ts`).
 *
 * `fetchFailed` (#5412, opcional — default `false`): `true` quando o
 * CHAMADOR sabe que o fetch ao dashboard falhou (rede/erro/non-2xx) — esta
 * função não infere isso de `entry` sozinha (um `entry: null` por fetch OK
 * sem leitura e um `entry: null` por fetch falho são indistinguíveis sem
 * essa informação extra do I/O).
 */
export function advanceState(
  state: PostmasterStaleAlarmState,
  entry: PostmasterEntryForStaleCheck,
  now: Date,
  opts: { fetchFailed?: boolean } = {},
): PostmasterStaleAlarmState {
  const lastCheckedAt = now.toISOString();
  const signal = resolveSpamSignal(entry, now);
  if (signal.source !== "indeterminate") {
    return { consecutiveStale: 0, lastAlarmedAt: null, lastCheckedAt, lastStaleReason: null };
  }
  const lastStaleReason: PostmasterStaleReason = opts.fetchFailed ? "fetch-failed" : (signal.reason ?? "missing");
  return { ...state, consecutiveStale: state.consecutiveStale + 1, lastCheckedAt, lastStaleReason };
}

/**
 * Pure: `true` quando o streak atingiu o threshold E ainda não alarmamos pra
 * ESTE streak (evita reenviar e-mail a cada checagem enquanto o streak
 * continua crescendo além do threshold).
 */
export function shouldAlarm(state: PostmasterStaleAlarmState): boolean {
  return state.consecutiveStale >= CONSECUTIVE_STALE_THRESHOLD && state.lastAlarmedAt === null;
}

/** Pure: marca este streak como já alarmado. */
export function markAlarmed(state: PostmasterStaleAlarmState, now: Date): PostmasterStaleAlarmState {
  return { ...state, lastAlarmedAt: now.toISOString() };
}

/** #5412 — texto humano por motivo, usado no corpo do e-mail. Distingue
 * explicitamente "dashboard não respondeu" (`fetch-failed`) de "fetch OK,
 * leitura stale" (os demais motivos) — achado 2 da issue: os dois casos
 * apontavam o operador pro MESMO lugar errado quando o problema real era o
 * dashboard/Worker, não o sync. */
function describeStaleReason(reason: PostmasterStaleReason | null): string {
  switch (reason) {
    case "fetch-failed":
      return "o DASHBOARD não respondeu à consulta (rede, erro HTTP, ou Worker fora do ar) — não dá pra saber se o sync rodou ou não; investigue a disponibilidade do dashboard, não só a task de sync";
    case "missing":
      return "nenhuma leitura foi registrada ainda em `postmaster:spam`";
    case "malformed":
      return "a leitura registrada tem dado inválido (`spamRatePct` ausente/não-numérico)";
    case "recorded-stale":
      return "a leitura não é REGRAVADA há mais de 48h — sinal de que o sync provavelmente parou de rodar";
    case "date-stale":
      return "a MEDIÇÃO mais recente é antiga demais (a gravação existe, mas os dias sondados não trazem dado novo)";
    case "low-coverage":
      return "a cobertura da janela sondada é baixa demais (poucos dias com dado válido pra confiar na média)";
    default:
      return "motivo não identificado";
  }
}

/** Pure: monta assunto + corpo do e-mail de alarme — texto puro, mesmo
 * padrão dos outros alarmes já wired. `issueRef` (#5339-like, opcional) —
 * outcome de `applyAlarmReconciliation` (`scripts/lib/alarm-issues.ts`) pro
 * streak atual. `undefined` (dry-run, ou wiring ainda não chamado) omite a
 * citação sem quebrar nada. */
export function buildPostmasterStaleAlarmEmail(
  state: PostmasterStaleAlarmState,
  entry: { date: string } | null,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const subject = `[diar.ia.br] sinal de spam do Postmaster está CEGO há ${state.consecutiveStale} checagens seguidas`;

  const lines: string[] = [
    `O sinal de spam do Postmaster (\`spamSignal.source\`) degradou pra`,
    `"indeterminate" em ${state.consecutiveStale} checagens CONSECUTIVAS da`,
    `task "Diaria-Postmaster-Spam-Alarm".`,
    "",
    `Motivo (checagem mais recente): ${describeStaleReason(state.lastStaleReason)}.`,
    "",
    `Última data de leitura conhecida: ${entry?.date ?? "(nenhuma leitura registrada ainda)"}.`,
    "",
    "O freio de ISP (clarice-envio-risk.ts / decideBrake) já é fail-safe por",
    "desenho — assume 70% de utilização quando indeterminate, nunca acelera",
    "sozinho. O risco real é outro: o OPERADOR decidir volume manualmente sem",
    "saber que o sinal primário de spam está cego.",
    "",
    ...(state.lastStaleReason === "fetch-failed"
      ? [
          "Verifique PRIMEIRO a disponibilidade do dashboard (Worker",
          "brevo-dashboard) — o fetch em si falhou, então não dá pra saber se a",
          "task de sync está rodando ou não até o dashboard voltar a responder.",
        ]
      : [
          "Verifique a task 'Diaria-Postmaster-Spam-Sync' (docs/postmaster-spam-sync-setup.md",
          "e docs/scheduled-tasks-registry.md) — o sync roda a cada 12h; se parou de",
          "rodar ou está falhando, é isso que precisa de atenção.",
        ]),
    "",
    "Este alarme não requer nenhuma ação automática — é só um aviso; o freio",
    "de ISP continua operando fail-safe enquanto isso é investigado.",
  ];

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

// ─────────────────────────────────────────────────────────────────────────
// #5446 item 2: ausência PROLONGADA de `worstCampaignSpamRatePct`/`campaignSpam`
// no KV — sinal INDEPENDENTE do streak de staleness acima. A média de
// domínio pode estar perfeitamente FRESCA (o guard acima nunca dispara)
// enquanto o enriquecimento por-campanha nunca encontra nenhuma campanha
// atribuível — exatamente o cenário real da issue: `postmaster-spam-sync.ts`
// caía no ramo `attempted === 0` ("sem campanha atribuível na janela") e
// isso era só um `console.log` benigno, indistinguível de "está tudo bem,
// não teve onda essa semana" quando na verdade a JANELA de descoberta nunca
// alcançava os dias esparsos em que o Postmaster publica `FEEDBACK_LOOP_ID`
// (root cause corrigida em `CAMPAIGN_DISCOVERY_WINDOW_DAYS`, #5449). Esta
// checagem é a rede de segurança pra caso o mesmo sintoma reapareça por
// outro motivo (accountId desatualizado de novo, mudança de formato do
// feedback_loop_id, API do Postmaster parando de publicar o metric) —
// #5449 corrigiu a CAUSA conhecida, não instrumentou contra causas futuras.
// ─────────────────────────────────────────────────────────────────────────

export interface CampaignSpamMissingAlarmState {
  /** Checagens CONSECUTIVAS (task diária) em que `worstCampaignSpamRatePct`
   * esteve ausente/não-finito na entry lida do dashboard. Zera assim que uma
   * checagem encontra o campo populado. */
  consecutiveMissing: number;
  /** ISO do último e-mail de alarme enviado pra ESTE streak, ou `null` se
   * ainda não alarmamos (streak resetado, ou ainda abaixo do threshold) —
   * mesmo padrão de idempotência de `PostmasterStaleAlarmState.lastAlarmedAt`. */
  lastAlarmedAt: string | null;
  /** ISO da última checagem — só informativo. */
  lastCheckedAt: string | null;
}

export function emptyCampaignSpamMissingAlarmState(): CampaignSpamMissingAlarmState {
  return { consecutiveMissing: 0, lastAlarmedAt: null, lastCheckedAt: null };
}

/**
 * 14 checagens diárias consecutivas (a task roda 1x/dia, mesma cadência da
 * `Diaria-Postmaster-Spam-Sync`) — 2 semanas corridas. Folga generosa de
 * propósito: mesmo com a janela de descoberta de 90 dias (#5449), campanhas
 * pequenas legitimamente não cruzam o limiar de reporte do Postmaster toda
 * semana — um threshold curto (ex: 2-3 dias, o valor usado pro streak de
 * staleness geral acima) alarmaria em toda semana de volume baixo normal,
 * que não é o sintoma real da issue. 14 dias é "isto já não é mais volume
 * baixo, é o enriquecimento por-campanha genuinamente cego".
 */
export const CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS = 14;

/** Pure: a entry TEM um pico por campanha válido pra oferecer? (mesmo guard
 * `Number.isFinite` que `resolveSpamSignal`/`campaignSignalAvailable`
 * usam — ver thresholds.ts, #5446 item 3, MESMA definição de "disponível"
 * nos dois lados do #5446.) */
export function hasAttributableCampaignSpam(entry: PostmasterEntryForStaleCheck): boolean {
  return Boolean(entry) && Number.isFinite(entry?.worstCampaignSpamRatePct);
}

/**
 * Pure: computa o próximo estado do streak de ausência. Uma checagem que
 * ACHA o campo populado zera o streak e re-arma o alarme pra próxima
 * ocorrência — mesmo padrão de `advanceState` acima. Uma entry totalmente
 * ausente (`null`/fetch falhou) também conta como "sem campanha atribuível"
 * (não há nada pra distinguir aqui — se não há entry, não há
 * `worstCampaignSpamRatePct` de jeito nenhum) — o streak de staleness geral
 * já cobre esse caso com o texto certo; este streak só precisa saber que o
 * campo específico não apareceu.
 */
export function advanceCampaignSpamMissingState(
  state: CampaignSpamMissingAlarmState,
  entry: PostmasterEntryForStaleCheck,
  now: Date,
): CampaignSpamMissingAlarmState {
  const lastCheckedAt = now.toISOString();
  if (hasAttributableCampaignSpam(entry)) {
    return { consecutiveMissing: 0, lastAlarmedAt: null, lastCheckedAt };
  }
  return { ...state, consecutiveMissing: state.consecutiveMissing + 1, lastCheckedAt };
}

/** Pure: `true` quando o streak atingiu o threshold E ainda não alarmamos pra
 * ESTE streak — mesmo contrato de `shouldAlarm` acima. */
export function shouldAlarmCampaignSpamMissing(state: CampaignSpamMissingAlarmState): boolean {
  return state.consecutiveMissing >= CAMPAIGN_SPAM_MISSING_THRESHOLD_DAYS && state.lastAlarmedAt === null;
}

/** Pure: marca este streak como já alarmado. */
export function markCampaignSpamMissingAlarmed(
  state: CampaignSpamMissingAlarmState,
  now: Date,
): CampaignSpamMissingAlarmState {
  return { ...state, lastAlarmedAt: now.toISOString() };
}

/** Pure: monta assunto + corpo do e-mail de alarme de ausência prolongada —
 * texto puro, mesmo padrão de `buildPostmasterStaleAlarmEmail` acima.
 * `issueRef` opcional (mesmo contrato dos outros alarmes deste arquivo). */
export function buildCampaignSpamMissingAlarmEmail(
  state: CampaignSpamMissingAlarmState,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const subject = `[diar.ia.br] sinal de spam POR CAMPANHA do Postmaster ausente há ${state.consecutiveMissing} dias seguidos`;

  const lines: string[] = [
    "O agregado de spam POR DOMÍNIO (`Spam (Postmaster)` na aba Rampa) pode",
    "estar perfeitamente saudável enquanto isto acontece — este alarme é",
    "sobre um sinal DIFERENTE: `worstCampaignSpamRatePct`/`campaignSpam`",
    `ficaram ausentes do KV por ${state.consecutiveMissing} checagens diárias`,
    "CONSECUTIVAS da task \"Diaria-Postmaster-Spam-Alarm\".",
    "",
    "Consequência prática: o breaker (`resolveSpamSignal`) está rodando",
    "inteiramente na média de domínio, sem nenhum sinal por-campanha — o",
    "mesmo mascaramento identificado no #4705 (uma campanha específica pode",
    "estar com spam bem acima do limite enquanto a média do domínio inteiro",
    "segue dentro da faixa segura, e ninguém veria isso). A coluna Spam da",
    "tabela Envios também fica vazia/\"sem dado atribuível\" para toda campanha",
    "nova nesta janela.",
    "",
    "Causas prováveis (mesma ordem de suspeita do #5446): (1) accountId",
    "hardcoded (`DEFAULT_POSTMASTER_ACCOUNT_ID`) desatualizado — confira",
    "`npx tsx scripts/postmaster-campaign-spam-report.ts --window-days 30`",
    "pelo aviso \"campanha(s) de OUTRA conta ESP\"; (2) o Postmaster parou de",
    "publicar FEEDBACK_LOOP_ID pra este domínio/conta; (3) volume real de",
    "envio caiu abaixo do limiar de reporte do Postmaster por tempo demais",
    "(menos provável com a janela de 90 dias do #5449, mas possível).",
    "",
    "Este alarme não requer nenhuma ação automática — é só um aviso; o freio",
    "de ISP continua operando fail-safe (média de domínio) enquanto isso é",
    "investigado.",
  ];

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
