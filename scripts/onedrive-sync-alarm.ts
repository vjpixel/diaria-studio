#!/usr/bin/env node
/**
 * scripts/onedrive-sync-alarm.ts (#5548, item 3)
 *
 * Task periódica (ver `docs/onedrive-sync-setup.md` pro horário/timer
 * recomendado): checa se o daemon `onedrive.service` (systemd --user) está
 * de fato ativo E se `data/.onedrive-sync-canary.json` continua sendo
 * atualizado dentro da tolerância configurada — os dois sinais que teriam
 * detectado o incidente #5548 (serviço morto há 17h, `data/` continuando
 * localmente funcional, ninguém percebendo).
 *
 * Lógica pura em `scripts/lib/onedrive-sync-alarm.ts` — este arquivo é só
 * I/O: `systemctl --user is-active onedrive` (SÓ LEITURA — ver guard
 * abaixo), leitura/escrita do canário, envio de e-mail, dedup/criação de
 * issue via `scripts/lib/alarm-issues.ts`.
 *
 * **GUARD (invariável, #5548 regras obrigatórias):** este script NUNCA
 * chama `systemctl` com `start`/`stop`/`restart`/`enable`/`disable` — só
 * `is-active` (leitura). Religar o serviço é ação manual do editor.
 *
 * **Guard de máquina sem OneDrive** (sessão cloud, clone fresco, ou
 * qualquer máquina onde o cliente OneDrive não está instalado): a consulta
 * ao systemd falha com ENOENT ou "unit not found" — tratado como
 * `serviceState: "unknown"`, nunca como "parado". Se `data/` também não
 * existir (sessão cloud sem o junction), o canário é pulado inteiramente
 * (sem I/O em diretório inexistente) e o veredito fica limitado ao sinal do
 * serviço.
 *
 * Uso:
 *   npx tsx scripts/onedrive-sync-alarm.ts                    # avalia + alarma se necessário
 *   npx tsx scripts/onedrive-sync-alarm.ts --dry-run           # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/onedrive-sync-alarm.ts --to email@x        # override do destinatário
 *   npx tsx scripts/onedrive-sync-alarm.ts --tolerance-hours 6 # override da tolerância do canário (default 6h)
 *   npx tsx scripts/onedrive-sync-alarm.ts --quota-gb 5        # orçamento de cota (default 5, #10957)
 *   npx tsx scripts/onedrive-sync-alarm.ts --quota-warn-pct 80 # aviso de cota a partir de N% (default 80)
 *   npx tsx scripts/onedrive-sync-alarm.ts --onedrive-config P # config do cliente (default ~/.config/onedrive/config)
 *
 * **Sinal de COTA (#10957):** além do serviço e do canário, lê (só leitura)
 * o log do daemon (`journalctl --user -u onedrive`) atrás de recusa de
 * upload por falta de espaço, e mede o que `data/` sincroniza (descontando
 * o `skip_file` efetivo) contra o orçamento `--quota-gb`. Achado próprio
 * (`check: "onedrive-quota"`, fingerprints `quota-full`/`quota-near`), com
 * a causa no texto: maiores diretórios e arquivos, e quanto é `.mp4`.
 * Lógica pura em `scripts/lib/onedrive-quota.ts`.
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.onedrive-sync-alarm-issues.json` (tracking de issue por
 * achado, `alarm-issues.ts`) — fora de `data/weekly`/`data/apoia-se`/etc.
 * de propósito: este alarme não pertence a nenhum subsistema existente.
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedVerdict` pro
 * portão `notifyEditorForOutcomes`):** severidade `"acao"` — só cria/reusa
 * a issue, nunca manda e-mail sob `notifications.email_policy:
 * "urgent_only"`. Sob `"legacy"`, `legacyResendIntent:
 * "dedupe-new-occurrences-only"` preserva o comportamento histórico: o
 * fingerprint É o verdict, e `shouldSendOnedriveSyncAlarm` só reenviava
 * quando o verdict MUDAVA — re-executar com o MESMO verdict reusa a issue
 * (`action: "reused"`) e não deve re-emitir e-mail; verdict que muda gera
 * fingerprint novo (`action: "created"`) e continua e-mailiando.
 * `shouldSendOnedriveSyncAlarm`/`markOnedriveSyncAlarmed`/
 * `.onedrive-sync-alarm-state.json` continuam definidos em
 * `lib/onedrive-sync-alarm.ts` (e testados lá) mas não são mais chamados
 * por este script.
 */
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  parseSystemctlIsActiveOutput,
  buildOnedriveSyncCanary,
  evaluateCanaryFreshness,
  evaluateOnedriveSyncAlarm,
  buildOnedriveSyncAlarmEmail,
  isAlarmingVerdict,
  type OnedriveServiceState,
  type OnedriveSyncAlarmVerdict,
  type OnedriveSyncAlarmEvaluation,
} from "./lib/onedrive-sync-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  scanOnedriveLogForQuotaFull,
  summarizeDataUsage,
  evaluateOnedriveQuota,
  isAlarmingQuotaVerdict,
  buildQuotaCauseText,
  DEFAULT_QUOTA_GB,
  DEFAULT_QUOTA_WARN_PCT,
  parseQuotaFullLatch,
  type OnedriveQuotaEvaluation,
  type QuotaFullLatch,
  type QuotaLogScan,
} from "./lib/onedrive-quota.ts";
import { readSkipFilePatterns, buildSkipFileMatcher, ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE } from "./lib/onedrive-skip-file.ts";
import { walkFileSizes } from "./lib/walk-file-sizes.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  alarmIssueStateKey,
  ALARM_ACTION_LABEL,
  type AlarmFinding,
  type AlarmFindingOutcome,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const CANARY_PATH = join(DATA_DIR, ".onedrive-sync-canary.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".onedrive-sync-alarm-issues.json");
/** Trava de `quota-full` entre execuções (review do PR #11139): o journal
 * só cobre a janela `--tolerance-hours`, então a recusa precisa sobreviver
 * a uma janela muda. Ver `QuotaFullLatch` em lib/onedrive-quota.ts. */
const QUOTA_LATCH_PATH = join(DATA_DIR, ".onedrive-quota-latch.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[onedrive-sync-alarm]";
const DEFAULT_TOLERANCE_HOURS = 6;
/** Cadência recomendada é a cada 4h (ver docs/onedrive-sync-setup.md) — 2
 * execuções limpas consecutivas = ~8h sem o achado, mesma ordem de grandeza
 * dos outros alarmes de cadência curta do repo (`clarice-guardrail-alarm.ts`,
 * `worker-drift-check.ts`, a cada 4h/6h, também usam 2). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Sinal 1: estado do serviço (SÓ LEITURA) ───────────────────────────────

/** `null` = não foi possível determinar (systemctl ausente, unit não
 * encontrada, qualquer erro de consulta) — caller trata como "unknown". */
export function readOnedriveServiceState(execFn: typeof execFileSync = execFileSync): OnedriveServiceState {
  try {
    const out = execFn("systemctl", ["--user", "is-active", "onedrive"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return parseSystemctlIsActiveOutput(String(out ?? ""), 0);
  } catch (e: unknown) {
    const err = e as { status?: number | null; stdout?: string };
    // `systemctl is-active` sai com status != 0 pra inactive/failed/unknown,
    // mas ainda escreve o estado em stdout — é isso que o parser usa.
    if (typeof err.stdout === "string") {
      return parseSystemctlIsActiveOutput(err.stdout, err.status ?? null);
    }
    return "unknown";
  }
}

// ─── Sinal 2: canário de frescor ───────────────────────────────────────────

function statMtimeOrNull(path: string): Date | null {
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

function writeCanary(now: Date): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const canary = buildOnedriveSyncCanary(now, hostname());
  writeFileAtomic(CANARY_PATH, JSON.stringify(canary, null, 2) + "\n");
}

// ─── Sinal 3: cota (#10957, SÓ LEITURA) ────────────────────────────────────

export const QUOTA_CHECK = "onedrive-quota";

/** Linhas do log do daemon nas últimas `sinceHours`. `null` = journal
 * indisponível (sem systemd, sem permissão) — o sinal de log fica sem
 * medida, nunca vira "sem recusa". */
export function readOnedriveJournalLines(sinceHours: number, execFn: typeof execFileSync = execFileSync): string[] | null {
  try {
    const out = execFn(
      "journalctl",
      ["--user", "-u", "onedrive", "--since", `-${sinceHours}h`, "--no-pager", "-o", "cat"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    ) as unknown as string;
    return String(out ?? "").split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Padrões efetivos do skip_file + se `*.mp4` está entre eles. Config
 * ausente = default do cliente (mp4 sincroniza); ilegível = `null` em
 * `mp4Excluded` e default do cliente nos padrões (conservador: conta tudo
 * que o cliente sobe por padrão). */
const MP4_PROBE_NAMES = ["diaria-comentada-000000.mp4", "x.MP4"] as const;

export function readEffectiveSkipFile(configPath: string): { patterns: string[]; mp4Excluded: boolean | null } {
  if (!existsSync(configPath)) {
    return { patterns: [...ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE], mp4Excluded: false };
  }
  try {
    const patterns = readSkipFilePatterns(readFileSync(configPath, "utf8")) ?? [...ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE];
    const matcher = buildSkipFileMatcher(patterns);
    // Dois nomes sem nada em comum além da extensão: um padrão estreito
    // (`diaria-*.mp4`) não conta como "*.mp4 fora do sync".
    return { patterns, mp4Excluded: MP4_PROBE_NAMES.every((n) => matcher(n)) };
  } catch {
    return { patterns: [...ONEDRIVE_CLIENT_DEFAULT_SKIP_FILE], mp4Excluded: null };
  }
}

/** Lê a trava persistida. Ausente = solta. Ilegível/inválida = solta, mas
 * avisa no stderr (mesmo tratamento do estado de alarm-issues). */
export function loadQuotaFullLatch(path: string): QuotaFullLatch | null {
  if (!existsSync(path)) return null;
  try {
    const { latch, invalid } = parseQuotaFullLatch(JSON.parse(readFileSync(path, "utf8")));
    if (invalid) console.error(`${LOG_PREFIX} trava de cota inválida em ${path} — tratando como solta.`);
    return latch;
  } catch (e) {
    console.error(`${LOG_PREFIX} trava de cota ilegível em ${path} — tratando como solta: ${(e as Error).message}`);
    return null;
  }
}

/** Grava a trava (`null` grava `null`, que é "solta" e deixa rastro de que
 * a trava existiu e foi solta). */
export function saveQuotaFullLatch(path: string, latch: QuotaFullLatch | null): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(latch, null, 2) + "\n");
}

export function toQuotaAlarmFinding(ev: OnedriveQuotaEvaluation): AlarmFinding {
  return {
    check: QUOTA_CHECK,
    fingerprint: ev.verdict,
    title: `[diar.ia.br] OneDrive cota: ${ev.verdict}`,
    body: [
      "Achado automático do alarme `Diaria-OneDrive-Sync-Alarm`",
      "(`scripts/onedrive-sync-alarm.ts`, sinal de cota do #10957).",
      "",
      buildQuotaCauseText(ev),
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // Cota só normaliza por AÇÃO do editor (liberar espaço, aplicar o
    // skip_file, esvaziar a lixeira) — mesmo raciocínio do #7701.
    labels: ["bug", ALARM_ACTION_LABEL],
    priority: ev.verdict === "quota-full" ? "P1" : "P2",
    family: "estado",
  };
}

function issueLineFor(outcome: AlarmFindingOutcome): string {
  return outcome.action === "failed"
    ? `\n\nIssue: falha ao criar/reusar (${outcome.error})`
    : `\n\nIssue: #${outcome.issueNumber} (${outcome.url})`;
}

/** E-mail único pros achados qualificados desta execução — sync e/ou cota.
 * Só o de sync existia antes do #10957; com os dois, o assunto cita ambos. */
export function buildCombinedAlarmEmail(
  qualifying: readonly AlarmFindingOutcome[],
  syncEvaluation: OnedriveSyncAlarmEvaluation,
  quota: OnedriveQuotaEvaluation,
): { subject: string; body: string } {
  const sync = qualifying.find((o) => o.check !== QUOTA_CHECK);
  const quotaOutcome = qualifying.find((o) => o.check === QUOTA_CHECK);
  const parts: string[] = [];
  const subjects: string[] = [];
  if (sync) {
    parts.push(buildOnedriveSyncAlarmEmail(syncEvaluation, issueLineFor(sync)).body);
    subjects.push(syncEvaluation.verdict);
  }
  if (quotaOutcome) {
    parts.push(
      `${buildQuotaCauseText(quota)}\n\nAchado automático de \`Diaria-OneDrive-Sync-Alarm\` (sinal de cota, #10957).${issueLineFor(quotaOutcome)}`,
    );
    subjects.push(`cota ${quota.verdict}`);
  }
  return { subject: `⚠️ OneDrive: ${subjects.join(" + ")}`, body: parts.join("\n\n---\n\n") };
}

// ─── Estado (dedup/reconciliação de ISSUE por achado — alarm-issues.ts) ────
// loadAlarmIssuesState continua LOCAL (#7124) — diverge do padrão comum ao
// logar o parse error via console.error, não só um catch silencioso; não
// forçado para o helper genérico pra não perder o diagnóstico.

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

export function toAlarmFinding(verdict: OnedriveSyncAlarmVerdict, serviceState: OnedriveServiceState): AlarmFinding {
  return {
    check: "onedrive-sync",
    fingerprint: verdict,
    title: `[diar.ia.br] OneDrive sync: ${verdict}`,
    body: [
      "Achado automático do alarme `Diaria-OneDrive-Sync-Alarm`",
      "(`scripts/onedrive-sync-alarm.ts`, #5548).",
      "",
      `verdict=${verdict}, serviceState=${serviceState}.`,
      "",
      verdict === "alarm-service-down"
        ? "O serviço onedrive.service (systemd --user) não está ativo — o sync entre máquinas parou. " +
          "`data/` continua sendo um diretório local funcional (nada falha visivelmente), só as escritas " +
          "param de propagar pra outra ponta. Religar: `systemctl --user restart onedrive` (ação manual " +
          "do editor — este alarme nunca muta o serviço)."
        : "O canário data/.onedrive-sync-canary.json não muda há mais tempo que a tolerância configurada, " +
          "mesmo com o serviço reportando um estado não-parado. Pode indicar sync degradado sem o daemon " +
          "detectar, ou esta própria task parada de rodar.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5548) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    // #7701 — `alarm-service-down` é o único verdict deste alarme cuja condição
    // SÓ normaliza por AÇÃO (`systemctl --user restart onedrive`, ação manual
    // do editor — este alarme nunca muta o serviço). Sem `alarm-acao`,
    // `classifyExecTrack` roteava `alarm` puro pra `fora-de-rodada` e a issue
    // #7503 ficou parada até o editor religar o serviço à mão (10h de baixa).
    // `alarm-canary-stale` fica como está (`alarm` puro): é ambíguo — pode
    // ser sync degradado que se resolve sozinho, ou a task parada (#7701).
    labels: verdict === "alarm-service-down" ? ["bug", ALARM_ACTION_LABEL] : ["bug"],
    priority: "P1",
    family: "estado",
  };
}

/** Cota não medida (sem data/ e sem journal) não é evidência de que
 * normalizou — congela as issues de cota em vez de contar streak (#10520).
 * Só as chaves de cota; as de sync seguem o fluxo normal. */
export function quotaAbsenceUnmeasured(verdict: OnedriveQuotaEvaluation["verdict"]): (key: string) => boolean {
  if (verdict !== "unmeasured") return () => false;
  const keys = new Set([alarmIssueStateKey(QUOTA_CHECK, "quota-full"), alarmIssueStateKey(QUOTA_CHECK, "quota-near")]);
  return (key) => keys.has(key);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const toleranceHours = getIntArg(argv, "tolerance-hours", { min: 1 }) ?? DEFAULT_TOLERANCE_HOURS;
  const toleranceMs = toleranceHours * 60 * 60 * 1000;
  const quotaGb = getIntArg(argv, "quota-gb", { min: 1 }) ?? DEFAULT_QUOTA_GB;
  const quotaWarnPct = getIntArg(argv, "quota-warn-pct", { min: 1, max: 100 }) ?? DEFAULT_QUOTA_WARN_PCT;
  const onedriveConfigPath =
    getStringArg(argv, "onedrive-config", { example: "~/.config/onedrive/config" }) ??
    join(homedir(), ".config", "onedrive", "config");

  const now = new Date();
  const serviceState = readOnedriveServiceState();

  const dataDirExists = existsSync(DATA_DIR);
  const previousCanaryMtime = dataDirExists ? statMtimeOrNull(CANARY_PATH) : null;
  const canaryFreshness = evaluateCanaryFreshness(previousCanaryMtime, now, toleranceMs);

  const evaluation = evaluateOnedriveSyncAlarm(serviceState, canaryFreshness);
  console.log(
    `${LOG_PREFIX} service=${serviceState} canary=${canaryFreshness} verdict=${evaluation.verdict} tolerance=${toleranceHours}h`,
  );

  // Sinal 3 (cota, #10957). A varredura de data/ e o journal são só leitura.
  const skip = readEffectiveSkipFile(onedriveConfigPath);
  const journal = readOnedriveJournalLines(toleranceHours);
  const quotaLog: QuotaLogScan | null = journal ? scanOnedriveLogForQuotaFull(journal) : null;
  const usage = dataDirExists
    ? summarizeDataUsage(
        walkFileSizes(DATA_DIR, (rel, err) => console.error(`${LOG_PREFIX} varredura: pulei ${rel || "."}: ${err.message}`)),
        buildSkipFileMatcher(skip.patterns),
      )
    : null;
  const prevLatch = loadQuotaFullLatch(QUOTA_LATCH_PATH);
  const quota = evaluateOnedriveQuota({
    log: quotaLog,
    usage,
    quotaBytes: quotaGb * 1024 ** 3,
    warnPct: quotaWarnPct,
    mp4Excluded: skip.mp4Excluded,
    latch: prevLatch,
    now,
  });
  if (!isDryRun && dataDirExists && (prevLatch !== null || quota.latch !== null)) {
    saveQuotaFullLatch(QUOTA_LATCH_PATH, quota.latch);
  }
  console.log(
    `${LOG_PREFIX} cota: verdict=${quota.verdict} quota=${quotaGb}GB warn=${quotaWarnPct}% ` +
      `log=${quotaLog ? `${quotaLog.matchCount} recusa(s)/${quotaLog.uploadSuccessCount} upload(s)` : "indisponível"} ` +
      `latch=${quota.latch ? `armada desde ${quota.latch.since}` : prevLatch ? "solta agora" : "solta"} ` +
      `synced=${usage ? usage.syncedBytes : "n/a"}B mp4Excluded=${skip.mp4Excluded}`,
  );

  if (!dataDirExists) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — canário pulado.`);
  } else if (!isDryRun) {
    // Sobrescreve o canário DEPOIS de já ter lido o mtime anterior acima —
    // side A desta máquina (ver docstring de onedrive-sync-alarm.ts).
    writeCanary(now);
  }

  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict)
    ? [toAlarmFinding(evaluation.verdict, serviceState)]
    : [];
  if (isAlarmingQuotaVerdict(quota.verdict)) alarmFindings.push(toQuotaAlarmFinding(quota));
  const alarmState = loadAlarmIssuesState();
  const isAbsenceUnmeasured = quotaAbsenceUnmeasured(quota.verdict);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS, [], isAbsenceUnmeasured);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, canário NÃO gravado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    isAbsenceUnmeasured,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} nenhum achado (verdict=${evaluation.verdict}) — nenhum alarme necessário.`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    (qualifying) => buildCombinedAlarmEmail(qualifying, evaluation, quota),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: toOverride,
      // #8271: fingerprint É o verdict — `shouldSendOnedriveSyncAlarm` só
      // reenviava quando o verdict MUDAVA. Reexecução com o MESMO verdict
      // reusa a issue (`action: "reused"`) e não deve re-emitir e-mail sob
      // `email_policy: "legacy"` — verdict novo gera fingerprint novo
      // (`action: "created"`) e continua e-mailiando normalmente.
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado (verdict=${evaluation.verdict}).`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
