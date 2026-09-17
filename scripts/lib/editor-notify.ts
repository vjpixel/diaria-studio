/**
 * scripts/lib/editor-notify.ts (#7957)
 *
 * Portão ÚNICO de notificação ao editor — decisão do editor (10/09/2026):
 * e-mail só quando ele precisa AGIR e há envio/dinheiro em risco, e só UMA
 * VEZ (no momento em que a issue de alarme é criada). Toda a caixa de
 * entrada hoje ganha ~200 e-mails/semana porque cada um dos ~44 scripts de
 * alarme deste repo (`grep -rl sendGmailMessage scripts/`) chama
 * `sendGmailMessage` direto, sempre que detecta QUALQUER achado — sem
 * distinguir "issue nova" de "issue já aberta reavisada pela 5ª vez".
 *
 * `notifyEditor` substitui essa chamada direta por 1 de 4 severidades:
 *
 *   - `"urgente"`  — Brevo suspensa, kill-switch/morte de teste de ads,
 *     limite de assinantes Kit, vazamento de billing, guardrail de
 *     entregabilidade Clarice. Garante a issue (`ensureAlarmIssue`,
 *     `scripts/lib/alarm-issues.ts`) e manda e-mail **só quando o resultado
 *     indica issue RECÉM-CRIADA** (`action === "created"`) — issue já aberta
 *     pro mesmo fingerprint (`"reused"`/`"reopened"`/`"updated"`) nunca
 *     re-emite e-mail. É esse sinal — `AlarmIssueResult.action` — que
 *     `alarm-issues.ts` já expõe; nenhuma mudança precisou ser feita lá.
 *   - `"acao"`     — todos os demais alarmes que hoje viram issue (drifts,
 *     staleness, health checks, STALL do overnight). Garante a issue, NUNCA
 *     manda e-mail (sob `email_policy: "urgent_only"`, ver abaixo).
 *   - `"info"`     — superfície de relatório do Studio (edição, overnight/
 *     develop, Clarice, digest de ads, CAC, gate pendente). Este módulo
 *     não pode importar `scripts/studio-ui/**` (regra 4 de
 *     `test/lib-boundary.test.ts` — `scripts/lib/**` nunca importa de
 *     `studio-ui/`), então a integração REAL com `registerReport`
 *     (`scripts/studio-ui/studio-reports.ts`) fica a cargo do CALLER (que
 *     não mora em `lib/` e pode importar dos dois lados) — ver item 4/5 da
 *     #7957, follow-up. Aqui, `"info"` só garante que o achado fica visível
 *     em `data/run-log.jsonl` (`scripts/lib/run-log.ts`, já lido pelo
 *     auto-reporter e por `/diaria-log`) em vez de morrer em silêncio.
 *   - `"silencio"` — nem e-mail, nem issue (ex: `codex-credential-alarm`,
 *     `kit-subscriber-state-transition-alarm` — decisão explícita do
 *     editor). Só log, mesmo mecanismo de `"info"`.
 *
 * ─── Rollout reversível (#7957 item 6) ──────────────────────────────────────
 *
 * `platform.config.json` → `notifications.email_policy`:
 *   - `"legacy"` (default, ausência de config) — preserva o comportamento
 *     ATUAL de todo script ainda não migrado: email em toda ocorrência de
 *     `"acao"`/`"urgente"`/`"info"` (não só na criação), porque hoje cada
 *     alarme já migrado pra `notifyEditor` mandava e-mail sempre que
 *     detectava QUALQUER achado. Isso permite reverter pra "manda e-mail
 *     como antes" com 1 linha de config, sem precisar reverter código, se o
 *     regime novo esconder algo urgente demais durante a migração.
 *   - `"urgent_only"` — regime alvo da #7957: só `"urgente"` COM issue
 *     recém-criada manda e-mail; `"acao"`/`"info"`/`"silencio"` nunca.
 *
 * `"silencio"` nunca manda e-mail em NENHUMA das duas políticas — não é o
 * que o rollback resolve (esses checks nunca passaram por `alarm-issues.ts`
 * antes, então não há "comportamento anterior" de e-mail pra preservar ali).
 *
 * ─── Guard mecânico (#7957 item 2) ──────────────────────────────────────────
 *
 * `test/editor-notify-boundary.test.ts` reprova qualquer import de
 * `sendGmailMessage` fora deste arquivo, de `scripts/lib/gmail-send.ts`
 * (definição) e de `scripts/lib/push-notify.ts` (canal de baixo nível que
 * este módulo usa por baixo, via `sendPushNotification` — não um caminho
 * concorrente ao portão) — mais uma ALLOWLIST explícita dos ~44 scripts
 * ainda não migrados (dívida a encolher a cada migração, nunca a crescer).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ensureAlarmIssue,
  type AlarmFamily,
  type AlarmFinding,
  type AlarmFindingOutcome,
  type AlarmIssueResult,
  type AlarmPriority,
  type GhRunFn,
  defaultAlarmGhRun,
} from "./alarm-issues.ts";
import { sendPushNotification, type PushMessage } from "./push-notify.ts";
import { logEvent, type RunLogEvent } from "./run-log.ts";

export type NotifySeverity = "urgente" | "acao" | "info" | "silencio";

export type EmailPolicy = "legacy" | "urgent_only";

const DEFAULT_EMAIL_POLICY: EmailPolicy = "legacy";

/**
 * Lê `notifications.email_policy` de `platform.config.json` — `"legacy"`
 * (default) se a chave/arquivo estiver ausente ou o JSON for inválido
 * (fail-soft, mesmo padrão de `resolveEditorEmail`/`resolveRunLogPath`:
 * nunca lança, nunca trava um alarme agendado por causa de config
 * malformada).
 */
export function resolveEmailPolicy(platformConfigPath: string): EmailPolicy {
  if (!existsSync(platformConfigPath)) return DEFAULT_EMAIL_POLICY;
  try {
    const cfg = JSON.parse(readFileSync(platformConfigPath, "utf8")) as {
      notifications?: { email_policy?: string };
    };
    return cfg.notifications?.email_policy === "urgent_only" ? "urgent_only" : DEFAULT_EMAIL_POLICY;
  } catch {
    return DEFAULT_EMAIL_POLICY;
  }
}

export interface NotifyEditorFinding {
  /** Eixo/categoria do achado — mesmo `check` de `AlarmFinding` (só usado
   * quando `severity` é `"acao"`/`"urgente"`, mas sempre logado). */
  check: string;
  /** Identificador estável do achado — mesmo `fingerprint` de
   * `AlarmFinding`. */
  fingerprint: string;
  severity: NotifySeverity;
  /** Assunto/título — vira `AlarmFinding.title` (acao/urgente) ou o
   * `message` do run-log (info/silencio) ou o assunto do e-mail. */
  subject: string;
  /** Corpo — vira `AlarmFinding.body` (acao/urgente) ou o `details` do
   * run-log (info/silencio) ou o corpo do e-mail. */
  body: string;
  /** #5553 — família do achado, só relevante pra `"acao"`/`"urgente"` (ver
   * `AlarmFamily`). Default `"estado"`. */
  family?: AlarmFamily;
  labels?: string[];
  /** Default `"P2"` (CLAUDE.md: toda issue nasce com label de prioridade) —
   * repassado a `ensureAlarmIssue`, que já aplica esse default sozinho. */
  priority?: AlarmPriority;
  /** #8271 — só relevante sob `email_policy: "legacy"`; ver docstring de
   * `LegacyResendIntent`. Default `"resend-every-run"` (comportamento
   * histórico). */
  legacyResendIntent?: LegacyResendIntent;
}

export interface NotifyEditorDeps {
  /** cwd pro `gh` CLI de `ensureAlarmIssue` — default `process.cwd()`. */
  cwd?: string;
  /** `GhRunFn` injetável (testes) — default `defaultAlarmGhRun` (gh real). */
  ghRun?: GhRunFn;
  /** Entry de cache local opcional pra `ensureAlarmIssue` reusar sem round-
   * trip — a maioria dos callers não mantém `AlarmIssuesState` própria
   * (não é o objetivo deste portão substituir `alarm-issues.ts` inteiro,
   * só o e-mail); sem isso, `ensureAlarmIssue` cai no fallback por marcador
   * (`findExistingAlarmIssue`), sempre correto, com 1 round-trip a mais. */
  cachedEntry?: { issueNumber: number; url: string; closedAt?: string | null; contentSignature?: string };
  /** Path de `platform.config.json` — default o do repo real; testes podem
   * apontar pra um fixture. Usado tanto pra `email_policy` quanto (via
   * `sendPushNotification`) pra resolver o destinatário. */
  platformConfigPath?: string;
  /** `rootDir` pro run-log (`"info"`/`"silencio"`) — default `process.cwd()`. */
  rootDir?: string;
  /** `sendPushNotification` injetável (testes) — evita bater na rede/Gmail
   * real. Default a implementação de produção de `push-notify.ts`. */
  sendPush?: (message: PushMessage, opts: { to?: string; platformConfigPath?: string }) => Promise<{ ok: boolean; error?: string }>;
  /** `logEvent` injetável (testes) — default grava em `data/run-log.jsonl`. */
  log?: (event: RunLogEvent, rootDir: string) => void;
  /** Destinatário do e-mail — default resolvido por `sendPushNotification`
   * via `resolveEditorEmail`. */
  emailTo?: string;
  /** Override de `email_policy` — pula a leitura de `platform.config.json`.
   * Usado por testes; produção sempre lê do config real. */
  emailPolicy?: EmailPolicy;
}

export interface NotifyEditorResult {
  severity: NotifySeverity;
  emailPolicy: EmailPolicy;
  /** Presente só quando `severity` é `"acao"`/`"urgente"`. */
  issue?: AlarmIssueResult;
  emailSent: boolean;
  emailError?: string;
}

function defaultPlatformConfigPath(cwd: string): string {
  return `${cwd}/platform.config.json`;
}

/**
 * Intenção de reenvio do REMETENTE sob `email_policy: "legacy"` (#8271,
 * regressão achada no review consolidado 260917b sobre a migração #8251).
 *
 * A migração pra `notifyEditor`/`notifyEditorForOutcomes` tirou a dedup
 * POR-SCRIPT que existia antes (`lastAlarmedCycle`/`lastAlarmedDay` e
 * afins) e passou a decisão inteiramente pro portão — mas os remetentes
 * migrados não são todos iguais quanto ao que "reenviar" deveria significar
 * sob `legacy`:
 *
 *   - `"dedupe-new-occurrences-only"` — só manda e-mail quando o achado é
 *     genuinamente NOVO (`action === "created"` ou `"reopened"`, nunca
 *     `"reused"`/`"updated"`). É o que `linkedin-weekly-staleness-alarm.ts`
 *     e `meta-capi-staleness-alarm.ts` precisam: antes da migração, rodar
 *     2× na mesma janela (mesmo ciclo/dia) só e-mailiava na 1ª — o estado
 *     próprio impedia a 2ª. Sem este campo, `legacy` tratava `"reused"`
 *     igual a `"created"` e reintroduziu o e-mail duplicado que a dedup
 *     antiga existia pra evitar.
 *   - `"resend-every-run"` (default, preserva o comportamento histórico de
 *     `legacy` pré-#8271) — manda e-mail em qualquer outcome bem-sucedido
 *     (`action !== "failed"`), inclusive `"reused"`. É o que
 *     `on-hold-vencimento-alarm.ts` e `route-marker-staleness-alarm.ts`
 *     precisam DE PROPÓSITO (#7960): o fingerprint deles é derivado do
 *     CONJUNTO de achados da execução atual, então um achado que continua
 *     pendente semana após semana produz o MESMO fingerprint → `"reused"`
 *     → e ainda assim precisa continuar cutucando o editor toda semana até
 *     ele agir — "resend periódico enquanto não resolvido" é o
 *     comportamento intencional, documentado nominalmente na #7960. Trocar
 *     o default pra `"dedupe-new-occurrences-only"` silenciaria esses dois
 *     alarmes depois da 1ª semana, o que é um defeito PIOR que o duplicado
 *     que este campo corrige (alarme que silencia > alarme que repete).
 *
 * Todo remetente ainda não migrado (ALLOWLIST de
 * `test/editor-notify-boundary.test.ts`) nunca passa este campo — herda o
 * default `"resend-every-run"`, idêntico ao comportamento de `legacy` antes
 * deste campo existir. Só quem sabe que seu fingerprint já é uma dedup por
 * OCORRÊNCIA (não por conjunto persistente) deve optar por
 * `"dedupe-new-occurrences-only"`.
 */
export type LegacyResendIntent = "dedupe-new-occurrences-only" | "resend-every-run";

const DEFAULT_LEGACY_RESEND_INTENT: LegacyResendIntent = "resend-every-run";

/** `true` se, sob `policy`, este resultado de `ensureAlarmIssue` deve gerar
 * e-mail — pura, sem I/O, exposta pra teste direto do rollout switch.
 *
 *   - `"urgent_only"`: só `severity === "urgente"` E `issue.action ===
 *     "created"` (issue RECÉM-CRIADA, nunca reused/reopened/updated) —
 *     `legacyResendIntent` não se aplica aqui (já é dedupe por construção).
 *   - `"legacy"`: `"acao"`/`"urgente"` com issue tratada com sucesso
 *     (`action !== "failed"`) — QUANDO manda e-mail depende de
 *     `legacyResendIntent` (ver docstring do tipo acima); default
 *     `"resend-every-run"` preserva o comportamento pré-#8271 (qualquer
 *     outcome bem-sucedido e-mailia).
 *
 * `"info"`/`"silencio"` nunca chegam aqui (tratados antes, sem issue).
 */
export function shouldEmailForIssueOutcome(
  severity: "acao" | "urgente",
  issue: AlarmIssueResult,
  policy: EmailPolicy,
  legacyResendIntent: LegacyResendIntent = DEFAULT_LEGACY_RESEND_INTENT,
): boolean {
  if (issue.action === "failed") return false;
  if (policy === "urgent_only") return severity === "urgente" && issue.action === "created";
  // "legacy"
  if (legacyResendIntent === "dedupe-new-occurrences-only") {
    return issue.action === "created" || issue.action === "reopened";
  }
  return true; // "resend-every-run"
}

/**
 * Portão único de notificação ao editor (#7957). Ver docstring do módulo
 * pra semântica completa das 4 severidades e do rollout switch.
 */
export async function notifyEditor(
  finding: NotifyEditorFinding,
  deps: NotifyEditorDeps = {},
): Promise<NotifyEditorResult> {
  const cwd = deps.cwd ?? process.cwd();
  const rootDir = deps.rootDir ?? cwd;
  const platformConfigPath = deps.platformConfigPath ?? defaultPlatformConfigPath(cwd);
  const emailPolicy = deps.emailPolicy ?? resolveEmailPolicy(platformConfigPath);
  const log = deps.log ?? logEvent;
  const sendPush = deps.sendPush ?? sendPushNotification;

  if (finding.severity === "info" || finding.severity === "silencio") {
    log(
      {
        edition: null,
        stage: null,
        agent: finding.check,
        level: "info",
        message: finding.subject,
        details: { fingerprint: finding.fingerprint, body: finding.body, channel: finding.severity },
      },
      rootDir,
    );
    return { severity: finding.severity, emailPolicy, emailSent: false };
  }

  // "acao" | "urgente" -> garante a issue.
  const alarmFinding: AlarmFinding = {
    check: finding.check,
    fingerprint: finding.fingerprint,
    title: finding.subject,
    body: finding.body,
    family: finding.family ?? "estado",
    labels: finding.labels,
    priority: finding.priority,
  };
  const issue = ensureAlarmIssue(alarmFinding, deps.cachedEntry, cwd, deps.ghRun ?? defaultAlarmGhRun);

  if (issue.action === "failed") {
    log(
      {
        edition: null,
        stage: null,
        agent: finding.check,
        level: "error",
        message: `ensureAlarmIssue falhou pra ${finding.check}:${finding.fingerprint}`,
        details: { error: issue.error },
      },
      rootDir,
    );
    return { severity: finding.severity, emailPolicy, issue, emailSent: false };
  }

  if (!shouldEmailForIssueOutcome(finding.severity, issue, emailPolicy, finding.legacyResendIntent)) {
    return { severity: finding.severity, emailPolicy, issue, emailSent: false };
  }

  const message: PushMessage = {
    subject: finding.subject,
    body: issue.url ? `${finding.body}\n\n${issue.url}` : finding.body,
  };
  const pushResult = await sendPush(message, { to: deps.emailTo, platformConfigPath });
  return {
    severity: finding.severity,
    emailPolicy,
    issue,
    emailSent: pushResult.ok,
    emailError: pushResult.ok ? undefined : pushResult.error,
  };
}

export interface NotifyEditorForOutcomesDeps {
  /** cwd usado só pra derivar `platformConfigPath` default — este helper
   * NUNCA chama `gh` (não cria/atualiza issue nenhuma). Default `process.cwd()`. */
  cwd?: string;
  platformConfigPath?: string;
  sendPush?: (message: PushMessage, opts: { to?: string; platformConfigPath?: string }) => Promise<{ ok: boolean; error?: string }>;
  emailTo?: string;
  emailPolicy?: EmailPolicy;
  /** #8271 — só relevante sob `email_policy: "legacy"`; ver docstring de
   * `LegacyResendIntent`. Default `"resend-every-run"` (comportamento
   * histórico — preserva o reenvio periódico intencional de
   * `on-hold-vencimento-alarm.ts`/`route-marker-staleness-alarm.ts`, que
   * chamam `notifyEditor` direto e nunca passam este campo). Callers de
   * `notifyEditorForOutcomes` cujo fingerprint já dedupla por OCORRÊNCIA
   * (ex: ciclo/dia, não um conjunto persistente de achados) devem passar
   * `"dedupe-new-occurrences-only"` — caso de `linkedin-weekly-staleness-alarm.ts`
   * e `meta-capi-staleness-alarm.ts`. */
  legacyResendIntent?: LegacyResendIntent;
}

export interface NotifyEditorForOutcomesResult {
  emailPolicy: EmailPolicy;
  emailSent: boolean;
  emailError?: string;
  /** Outcomes que passaram por `shouldEmailForIssueOutcome` — vazio quando
   * nenhum e-mail é necessário (inclusive quando `outcomes` está vazio). */
  qualifying: AlarmFindingOutcome[];
}

/**
 * Decide e manda (no máximo) 1 e-mail combinado a partir de
 * `AlarmFindingOutcome[]` já produzido por `applyAlarmReconciliation` — pra
 * scripts que usam `planAlarmReconciliation`/`applyAlarmReconciliation`
 * (não `ensureAlarmIssue` direto) e por isso não podem chamar `notifyEditor()`
 * (chamaria `ensureAlarmIssue` uma 2ª VEZ pro mesmo achado, arriscando
 * reabrir uma issue que a reconciliação acabou de fechar ou disputar o
 * mesmo fingerprint com resultado divergente — ver a ALLOWLIST de
 * `test/editor-notify-boundary.test.ts`, seção "#7960").
 *
 * NÃO cria/atualiza issue nenhuma — a reconciliação (`applyAlarmReconciliation`)
 * continua INTOCADA, chamada normalmente pelo script antes deste helper.
 * Aqui só se decide o E-MAIL, reusando `shouldEmailForIssueOutcome` (mesma
 * política de `notifyEditor`) por outcome, e mandando via
 * `sendPushNotification` (o mesmo canal de baixo nível que `notifyEditor`
 * usa por baixo) quando QUALQUER outcome qualificar.
 *
 * `buildMessage` recebe só os outcomes QUALIFICANTES (nunca a lista
 * completa) — o caller decide o assunto/corpo do e-mail combinado a partir
 * deles; chamado só quando `qualifying.length > 0` (nunca com array vazio).
 */
export async function notifyEditorForOutcomes(
  outcomes: readonly AlarmFindingOutcome[],
  severity: "acao" | "urgente",
  buildMessage: (qualifying: readonly AlarmFindingOutcome[]) => PushMessage,
  deps: NotifyEditorForOutcomesDeps = {},
): Promise<NotifyEditorForOutcomesResult> {
  const cwd = deps.cwd ?? process.cwd();
  const platformConfigPath = deps.platformConfigPath ?? defaultPlatformConfigPath(cwd);
  const emailPolicy = deps.emailPolicy ?? resolveEmailPolicy(platformConfigPath);
  const sendPush = deps.sendPush ?? sendPushNotification;

  const qualifying = outcomes.filter((o) => shouldEmailForIssueOutcome(severity, o, emailPolicy, deps.legacyResendIntent));
  if (qualifying.length === 0) {
    return { emailPolicy, emailSent: false, qualifying: [] };
  }

  const message = buildMessage(qualifying);
  const pushResult = await sendPush(message, { to: deps.emailTo, platformConfigPath });
  return {
    emailPolicy,
    emailSent: pushResult.ok,
    emailError: pushResult.ok ? undefined : pushResult.error,
    qualifying,
  };
}
