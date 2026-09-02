#!/usr/bin/env node
/**
 * scripts/hub-staleness-check.ts (#4924 item 5 — "alternativa mais barata";
 * persistência + alarme + task agendada: #5123, itens 1-4 órfãos do #4924)
 *
 * CLI que audita o cache Beehiiv sincronizado
 * (`data/beehiiv-cache/posts/*.json`, atualizado no Stage 0 de toda edição)
 * contra os 6 datasets de hub commitados (`scripts/lib/hubs/*-sources.generated.json`).
 * Continua chamado pelo playbook do Stage 6 (`.claude/agents/orchestrator-stage-6.md`,
 * informacional, nunca bloqueia) E agora também roda como task agendada
 * diária (`Diaria-Hub-Staleness-Check`, `scripts/lib/scheduled-tasks.ts`) —
 * antes disso, só existia a checagem embutida no Stage 6, que só corre
 * quando uma edição publica; sem edição num dia (ou pipeline pausado), a
 * defasagem crescia sem ninguém perceber.
 *
 * **Persistência (#5123 item 2).** Cada execução escreve um snapshot em
 * `data/hubs/staleness-{YYYY-MM-DD}.json` (histórico, 1 arquivo por dia) e
 * atualiza `data/hubs/staleness-state.json` (idempotência: mapa de
 * 1ª-detecção por entrada + fingerprint do último alarme — ver
 * `scripts/lib/hub-staleness-check.ts`, `computeFirstSeenMap`/
 * `StalenessAlarmState`). O snapshot é sempre escrito, mesmo sem drift
 * (`stale: []`) — é o histórico "está tudo em dia hoje" que confirma que a
 * task de fato rodou naquele dia.
 *
 * **Alarme (#5123 item 3).** Entrada com `ageDays >= --threshold-days`
 * (default 3 — "menos que o ciclo de 4 dias já observado", #4924) dispara
 * e-mail pro editor (`resolveEditorEmail`), com idempotência por
 * fingerprint (mesmo padrão de `hub-drift-check.ts`/`apoios-diff-alarm.ts`
 * — não reenvia todo dia pelo MESMO conjunto ainda não resolvido).
 *
 * **Política de commit (#5123 item 4, decisão do editor registrada aqui e
 * no corpo do #5123): só alarma, NUNCA regenera nem commita.** O
 * `.generated.ts` é asset versionado — commitar automaticamente por trás do
 * editor tem blast radius (regen depende de `beehiiv-sync.ts` estar em dia,
 * pode picotar prosa que o editor ainda não revisou) que este alarme não
 * paga sozinho, e `test/hub-page-drift.test.ts` já reprova o CI se o hub
 * ficar desatualizado sem ninguém perceber — a rede de segurança já existe
 * no caminho de PR. O comando sugerido (`buildRegenCommands`, impresso no
 * e-mail/relatório) é rodado manualmente pelo editor.
 *
 * **Issue no GitHub por HUB defasado (#6151, mesmo padrão do #5339;
 * granularidade corrigida no #6254).** Diferente dos outros 9+ alarmes
 * deste repo, este script mandava só e-mail — o achado não deixava rastro
 * persistente além da caixa de entrada (achado #6151: dedup do e-mail
 * confirmou que o mesmo drift já tinha sido alarmado antes, sem nenhuma
 * issue aberta cobrindo). Todas as entradas vencidas de um mesmo hub agora
 * viram/reusam 1 ÚNICA issue via `scripts/lib/alarm-issues.ts`
 * (`groupOverdueByHub` + `toAlarmFinding`, `scripts/lib/hub-staleness-check.ts`)
 * — `check` = slug do hub, `fingerprint` = constante
 * (`STALE_HUB_FINDING_FINGERPRINT`), `family: "estado"` (a issue se
 * auto-comenta/fecha quando NENHUMA edição do hub aparecer mais como
 * vencida). **Achado #6254 (260826): a 1ª versão gerava 1 issue por
 * `(hub × edição)` — 11 issues pra 4 hubs numa única rodada, crescendo sem
 * teto — porque `fingerprint` incluía o slug da edição.** Estado de
 * tracking em `data/hubs/alarm-issues.json` (separado de
 * `staleness-state.json` — mesmo racional de `hub-drift-check.ts`:
 * idempotência do e-mail e tracking de issue são preocupações
 * independentes). Continua **NUNCA** rodando os regens sozinho — a issue só
 * documenta o achado, a decisão de quando regenerar continua manual (#4924
 * item 2).
 *
 * Uso:
 *   npx tsx scripts/hub-staleness-check.ts                       # detecta + persiste + alarma se necessário
 *   npx tsx scripts/hub-staleness-check.ts --dry-run              # detecta + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/hub-staleness-check.ts --threshold-days 5     # override do limiar de alarme (default 3)
 *   npx tsx scripts/hub-staleness-check.ts --to email@x           # override do destinatário do alarme
 *
 * **Fail-soft, NUNCA bloqueia (#2643, label `local`).** O cache Beehiiv só
 * existe com o junction `data/` (OneDrive) populado — em sessão cloud, ou
 * antes do 1º `beehiiv-sync.ts`, o diretório não existe. Isso é tratado
 * como "nada a reportar", não como erro: imprime um aviso em stderr e sai
 * com exit 0 (nem persiste snapshot vazio — sem dado real não há o que
 * fotografar).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPosts, HUB_KEYWORD_PATTERNS, type HubSourceEntry } from "./generate-hub-sources.ts";
import {
  findStaleHubEditions,
  formatStaleHubReport,
  computeFirstSeenMap,
  computeAgedStale,
  filterOverdue,
  shouldAlarmStaleness,
  computeStalenessFingerprint,
  advanceStalenessState,
  buildStalenessAlarmEmail,
  emptyStalenessAlarmState,
  toAlarmFinding,
  groupOverdueByHub,
  type StaleHubEdition,
  type StaleFirstSeenMap,
  type StalenessAlarmState,
} from "./lib/hub-staleness-check.ts";
import { isMainModule, hasFlag, getArg } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");
const HUBS_DIR = resolve(ROOT, "scripts/lib/hubs");
const HUBS_DATA_DIR = resolve(ROOT, "data/hubs");
const STATE_PATH = join(HUBS_DATA_DIR, "staleness-state.json");
const ALARM_ISSUES_STATE_PATH = join(HUBS_DATA_DIR, "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[hub-staleness-check]";
const DEFAULT_THRESHOLD_DAYS = 3;
/** #6151: task roda diária (09:30) — 2 execuções limpas consecutivas = 48h
 * sem o achado antes de fechar a issue automaticamente, mesmo valor de
 * `hub-drift-check.ts`/`home-meta-check.ts` pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Lê os `{slug}-sources.generated.json` commitados dos hubs registrados em
 * `HUB_KEYWORD_PATTERNS`. Sempre commitados (diferente de `POSTS_DIR`) —
 * ausência de um arquivo individual vira dataset vazio pra aquele hub
 * (nunca aborta a checagem inteira por um hub faltando). */
function loadHubDatasets(): Record<string, HubSourceEntry[]> {
  const out: Record<string, HubSourceEntry[]> = {};
  for (const slug of Object.keys(HUB_KEYWORD_PATTERNS)) {
    const path = resolve(HUBS_DIR, `${slug}-sources.generated.json`);
    if (!existsSync(path)) {
      out[slug] = [];
      continue;
    }
    try {
      out[slug] = JSON.parse(readFileSync(path, "utf8")) as HubSourceEntry[];
    } catch (e) {
      process.stderr.write(
        `${LOG_PREFIX} ⚠ falha ao parsear ${path}: ${e instanceof Error ? e.message : e} — tratando como dataset vazio\n`,
      );
      out[slug] = [];
    }
  }
  return out;
}

// ─── Estado (idempotência do alarme + memória de 1ª-detecção) ─────────────

interface PersistedState {
  alarm: StalenessAlarmState;
  firstSeen: StaleFirstSeenMap;
}

function emptyPersistedState(): PersistedState {
  return { alarm: emptyStalenessAlarmState(), firstSeen: {} };
}

export function loadState(statePath: string = STATE_PATH): PersistedState {
  if (!existsSync(statePath)) return emptyPersistedState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PersistedState>;
    const firstSeen =
      raw.firstSeen && typeof raw.firstSeen === "object" && !Array.isArray(raw.firstSeen)
        ? (raw.firstSeen as StaleFirstSeenMap)
        : {};
    const alarm =
      raw.alarm && typeof raw.alarm === "object"
        ? {
            lastAlarmedFingerprint:
              typeof raw.alarm.lastAlarmedFingerprint === "string" ? raw.alarm.lastAlarmedFingerprint : null,
            lastCheckedAt: typeof raw.alarm.lastCheckedAt === "string" ? raw.alarm.lastCheckedAt : null,
          }
        : emptyStalenessAlarmState();
    return { alarm, firstSeen };
  } catch {
    return emptyPersistedState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima.
export { saveState, loadAlarmIssuesState, saveAlarmIssuesState };

// ─── Estado (dedup/reconciliação de ISSUE por achado, #6151) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional de
// hub-drift-check.ts/home-meta-check.ts: idempotência do E-MAIL
// (acima) e tracking de ISSUE por achado são preocupações independentes.

/** `YYYY-MM-DD` em UTC — mesma resolução de `HubSourceEntry.date`/
 * `StaleHubEdition.date`. Determinístico via param injetável pra teste. */
function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const thresholdArg = getArg(argv, "threshold-days");
  const thresholdDays = thresholdArg ? Number.parseInt(thresholdArg, 10) : DEFAULT_THRESHOLD_DAYS;

  if (!existsSync(POSTS_DIR)) {
    process.stderr.write(
      `${LOG_PREFIX} ${POSTS_DIR} ausente — precisa do junction data/ (OneDrive) populado por beehiiv-sync.ts. Pulando checagem (fail-soft, ver CLAUDE.md label "local").\n`,
    );
    process.exitCode = 0;
    return;
  }

  const posts = loadPosts();
  const datasets = loadHubDatasets();
  const { stale, warnings } = findStaleHubEditions(posts, datasets);

  for (const w of warnings) process.stderr.write(`${LOG_PREFIX} ⚠ ${w}\n`);

  const report = formatStaleHubReport(stale);
  if (report) {
    console.log(report);
  } else {
    console.log(`${LOG_PREFIX} todos os hubs em dia — nada a reportar.`);
  }

  const now = new Date();
  const today = todayISO(now);
  const state = loadState();
  const firstSeen = computeFirstSeenMap(stale, state.firstSeen, today);
  const aged = computeAgedStale(stale, firstSeen, today);
  const overdue = filterOverdue(aged, thresholdDays);

  console.log(
    `${LOG_PREFIX} ${stale.length} entrada(s) stale, ${overdue.length} vencida(s) (>= ${thresholdDays} dia(s)).`,
  );

  // #6151 — reconcilia issue por entrada vencida ANTES de montar o e-mail (o
  // e-mail cita a issue de cada achado pendente), mesmo padrão de
  // hub-drift-check.ts/home-meta-check.ts. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  // #6254 — 1 finding POR HUB (agrupado via groupOverdueByHub), não 1 por
  // entrada — a versão anterior gerava 1 issue por (hub × edição).
  const alarmFindings = groupOverdueByHub(overdue).map(({ hubSlug, entries }) => toAlarmFinding(hubSlug, entries));
  const alarmIssuesState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmIssuesState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
    console.log(`${LOG_PREFIX} --dry-run: snapshot NÃO persistido, alarme NÃO enviado, cursor NÃO avançado.`);
    if (shouldAlarmStaleness(state.alarm, overdue)) {
      const { subject, body } = buildStalenessAlarmEmail(overdue, thresholdDays, now);
      console.log(`${LOG_PREFIX} --dry-run: alarmaria com:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    }
    return;
  }

  const { nextState: nextAlarmIssuesState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmIssuesState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextAlarmIssuesState, ALARM_ISSUES_STATE_PATH);
  // #6254 — chave agora é `o.check` (= hubSlug), não mais `o.fingerprint`
  // (que virou uma constante, `STALE_HUB_FINDING_FINGERPRINT` — a
  // granularidade da issue é por hub). `buildStalenessAlarmEmail` faz o
  // mesmo lookup por hubSlug.
  issueRefs = new Map(
    findingOutcomes.map((o) => [
      o.check,
      { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
    ]),
  );
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      console.error(`${LOG_PREFIX} [${o.check}] issue não criada/reusada: ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} [${o.check}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }

  // Snapshot diário — sempre escrito, mesmo `stale: []` (confirma que a task
  // rodou). #5123 item 2.
  mkdirSync(HUBS_DATA_DIR, { recursive: true });
  const snapshotPath = join(HUBS_DATA_DIR, `staleness-${today}.json`);
  writeFileAtomic(snapshotPath, JSON.stringify({ date: today, thresholdDays, stale: aged }, null, 2) + "\n");
  console.log(`${LOG_PREFIX} snapshot gravado em ${snapshotPath}.`);

  // Alarme — #5123 item 3.
  let nextAlarmState = state.alarm;
  if (shouldAlarmStaleness(state.alarm, overdue)) {
    const { subject, body } = buildStalenessAlarmEmail(overdue, thresholdDays, now, issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    // Mesmo racional de hub-drift-check.ts: sem try/catch — se o envio
    // falhar, o cursor abaixo não avança, então a próxima execução tenta
    // alarmar de novo em vez de marcar como "já avisado" sem o editor ter
    // recebido nada.
    await sendGmailMessage(to, subject, body);
    console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (${overdue.length} vencida(s)).`);
    nextAlarmState = advanceStalenessState(computeStalenessFingerprint(overdue), now);
  } else if (overdue.length > 0) {
    console.log(`${LOG_PREFIX} ${overdue.length} vencida(s), mas o mesmo conjunto já foi alarmado antes — sem novo e-mail.`);
  } else {
    console.log(`${LOG_PREFIX} nenhuma entrada vencida — sem alarme.`);
    nextAlarmState = advanceStalenessState(null, now);
  }

  saveState({ alarm: nextAlarmState, firstSeen }, STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda
  // DEPOIS de awaits de rede (sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING documentado em worker-drift-check.ts/hub-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
