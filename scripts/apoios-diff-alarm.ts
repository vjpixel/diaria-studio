#!/usr/bin/env node
/**
 * apoios-diff-alarm.ts (#4485 item 2)
 *
 * Task diária: computa o MESMO diff do dry-run de
 * `scripts/sync-apoio-nivel-beehiiv.ts` (desejado × estado atual da Beehiiv)
 * — reusando as mesmas funções puras exportadas de lá, sem reimplementar a
 * lógica — e, se houver diff pendente (adições/trocas/remoções), envia um
 * e-mail de alarme ao editor via Gmail API. **NUNCA aplica `--push`** — o
 * gate humano de `/diaria-apoios-sync` (Passo 3) continua sendo a única
 * forma de gravar de verdade na Beehiiv.
 *
 * Idempotente por FINGERPRINT do diff (`scripts/lib/apoios-diff-alarm.ts`) —
 * o mesmo diff pendente não gera um novo e-mail a cada rodada diária; só
 * quando o conteúdo muda ou depois de ter sido resolvido e reaparecer (ver
 * docstring do módulo pura).
 *
 * **Reconciliação de promessas pendentes (#4490 causa 4; extraída pra
 * `runApoioReconciliationCycle` no self-review consolidado do PR #4503):**
 * antes de computar o diff, roda a MESMA sequência de
 * `scripts/sync-apoio-nivel-beehiiv.ts::main()` (`scripts/lib/apoio-reconciliation-cycle.ts`)
 * — drena Gmail, importa notificações de PAGAMENTO CONFIRMADO como contato
 * (achado crítico 1), e reconsulta `reconcilePendingPromises` pra cada
 * promessa pendente do store; se confirmar pagamento, promove a contato
 * ANTES do cálculo. Sem isso, esta task diária (a cadência PRETENDIDA pelo
 * #4485 item 2 — registro no Task Scheduler ainda PENDENTE do editor, #4506
 * item 6, ver CLAUDE.md) nunca fecharia o loop da causa 4 sozinha assim que
 * armada — só `/diaria-apoios-sync` rodado manualmente fazia essa
 * reconciliação. Idempotente via o store,
 * fail-soft pra tudo EXCETO `ApoiaSeAuthError` (achado crítico 2) — chave
 * apoia.se rejeitada aborta o alarme (loud, saída não-zero) em vez de
 * "seguindo sem ela".
 *
 * Uso:
 *   npx tsx scripts/apoios-diff-alarm.ts [--dry-run] [--to email@x.com]
 *
 *   --dry-run  computa o diff e avalia se alarmaria, mas NÃO envia e-mail
 *              nem avança o cursor de idempotência — inspeção sem efeito
 *              colateral (mesmo contrato de `cursos-error-alarm.ts`).
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: mesmas credenciais do `sync-apoio-nivel-beehiiv.ts` dry-run
 * (BEEHIIV_API_KEY/BEEHIIV_PUBLICATION_ID, APOIA_SE_API_KEY/APOIA_SE_API_SECRET/APOIA_SE_CAMPAIGN)
 * + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito de
 * `clarice-guardrail-alarm.ts`/`cursos-error-alarm.ts`) + o junction `data/`
 * (OneDrive) pra `contacts.jsonl` e o cache apoia.se.
 *
 * Estado (idempotência): `data/apoios-diff-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { readApoiaSeEnv, defaultCacheDir, competenceMonth } from "./lib/apoia-se.ts";
import { runApoioReconciliationCycle } from "./lib/apoio-reconciliation-cycle.ts";
import { buildApoiosData, readPastMonthSnapshots, type MonthSnapshot } from "./studio-ui/studio-apoios.ts";
import {
  computeDesiredApoioLevels,
  diffApoioTags,
  fetchCurrentBeehiivState,
  shouldBlockRemovals,
  evaluateBlastRadiusGuard,
} from "./sync-apoio-nivel-beehiiv.ts";
import {
  emptyApoiosDiffAlarmState,
  advanceState,
  shouldAlarm,
  hasPendingDiff,
  computeDiffFingerprint,
  buildApoiosDiffAlarmEmail,
  maskEmailForIssue,
  type ApoiosDiffAlarmState,
  type DiffAlarmInput,
  type DiffAlarmGuardWarnings,
} from "./lib/apoios-diff-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "apoios-diff-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "apoios-diff-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[apoios-diff-alarm]";
/** #5339: task roda diária (09:45) — 2 execuções limpas consecutivas = 48h
 * sem diff pendente antes de fechar a issue automaticamente, mesmo valor de
 * `hub-drift-check.ts`/`robots-txt-drift-check.ts`/`beehiiv-home-meta-check.ts`
 * pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function loadState(statePath: string = STATE_PATH): ApoiosDiffAlarmState {
  if (!existsSync(statePath)) return emptyApoiosDiffAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ApoiosDiffAlarmState>;
    const fingerprint = typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null ? raw.lastAlarmedFingerprint : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyApoiosDiffAlarmState();
  }
}

export function saveState(state: ApoiosDiffAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE, #5339) ──────────────────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional dos outros
// alarmes deste lote: idempotência do E-MAIL (acima) e tracking de ISSUE
// são preocupações independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte o diff pendente INTEIRO (não cada entry — `vjpixel/diaria-studio`
 * é repo PÚBLICO, e cada entry carrega o e-mail de um assinante/apoiador;
 * ver `maskEmailForIssue`) num único `AlarmFinding` (#5339). `check` fixo
 * ("apoios-diff") e `fingerprint` = `computeDiffFingerprint(input)`, a MESMA
 * fórmula que já alimenta a idempotência do e-mail — reaparece só quando o
 * conjunto de mudanças pendentes muda de shape, igual ao alarme por e-mail.
 * O corpo lista os e-mails MASCARADOS (`maskEmailForIssue`) — só o e-mail
 * (canal privado) mostra o e-mail completo. */
export function toAlarmFinding(input: DiffAlarmInput): AlarmFinding {
  const lines = [
    "Achado automático do alarme `Diaria-Apoios-Diff-Alarm`",
    "(`scripts/apoios-diff-alarm.ts`).",
    "",
    `Adições/trocas de nível pendentes: ${input.toApply.length}`,
    `Remoções pendentes: ${input.toRemove.length}`,
    "",
  ];
  if (input.toApply.length > 0) {
    lines.push("Adições/trocas (e-mail mascarado — detalhe completo só no e-mail de alarme):");
    for (const e of input.toApply) {
      lines.push(`  + ${maskEmailForIssue(e.email)}: ${e.fromLevel ?? "(nenhum)"} -> ${e.toLevel}`);
    }
    lines.push("");
  }
  if (input.toRemove.length > 0) {
    lines.push("Remoções (e-mail mascarado):");
    for (const e of input.toRemove) {
      lines.push(`  - ${maskEmailForIssue(e.email)}: ${e.fromLevel} -> (nenhum)`);
    }
    lines.push("");
  }
  lines.push(
    "Rode /diaria-apoios-sync (revisa o diff + Passo 1 de drift check antes) ou",
    "npx tsx scripts/sync-apoio-nivel-beehiiv.ts --push pra aplicar.",
    "",
    "Esta issue é criada automaticamente pelo alarme (#5339) e será",
    "comentada/fechada sozinha quando o diff deixar de reproduzir por",
    `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
  );

  return {
    check: "apoios-diff",
    fingerprint: computeDiffFingerprint(input),
    // #5553 — condição RE-CHECÁVEL (o diff pendente é recomputado toda
    // execução); resolve sozinho quando alguém aplica/o diff esvazia.
    family: "estado",
    title: `[diar.ia.br] apoio_nivel: diff pendente (${input.toApply.length} adição(ões)/troca(s), ${input.toRemove.length} remoção(ões))`,
    body: lines.join("\n"),
    labels: ["enhancement"],
    priority: "P2",
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  // #4490 causa 4 / self-review consolidado do PR #4503: esta é a task diária
  // PRETENDIDA pelo #4485 item 2 (`Diaria-Apoios-Diff-Alarm`) — o registro
  // (armar via `npx tsx scripts/setup-systemd-timers.ts --task Diaria-Apoios-Diff-Alarm`) +
  // 1ª execução ao vivo ainda são ação PENDENTE do editor (#4506 item 6, ver
  // CLAUDE.md); este script já está pronto pra rodar assim que armado. Sem esta
  // reconciliação, uma promessa que confirma pagamento só é promovida a
  // contato se alguém rodar `/diaria-apoios-sync` manualmente, o que
  // reintroduz a dependência de "alguém lembrar" que a causa 4 deveria
  // eliminar. Mesma sequência de `sync-apoio-nivel-beehiiv.ts::main()`
  // (extraída pra `runApoioReconciliationCycle` — achado alto de duplicação
  // do self-review) — drena Gmail, importa notificações CONFIRMADAS (achado
  // crítico 1) e reconcilia promessas pendentes (achado crítico 2) ANTES do
  // resto do cálculo (buildApoiosData relê contacts.jsonl do disco a seguir,
  // então qualquer contato importado/promovido aqui já entra no diff
  // computado abaixo). Fail-soft pra tudo, EXCETO `ApoiaSeAuthError` (ver
  // `cycle.authError` abaixo).
  const cycle = await runApoioReconciliationCycle(ROOT);
  if (cycle.drainSkipped) {
    console.error(
      `${LOG_PREFIX} aviso: drain de promessas (Gmail) pulado (${cycle.drainSkipReason ?? "erro desconhecido"}) — ` +
        "reconciliação segue só com promessas já no store.",
    );
  }
  if (cycle.promessasDrained > 0) {
    console.error(`${LOG_PREFIX} ${cycle.promessasDrained} promessa(s) nova(s) drenada(s) do Gmail.`);
  }
  if (cycle.notificationsImported > 0) {
    console.error(
      `${LOG_PREFIX} ${cycle.notificationsImported} notificação(ões) de pagamento confirmado importada(s) como contato novo.`,
    );
  }
  if (cycle.promoted.length > 0) {
    console.error(
      `${LOG_PREFIX} ${cycle.promoted.length} promessa(s) confirmada(s) como pagamento — ` +
        `promovida(s) a contato: ${cycle.promoted.map((p) => `${p.name} <${p.email}>`).join(", ")}`,
    );
  }
  if (cycle.remainingPending.length > 0) {
    console.error(
      `${LOG_PREFIX} ${cycle.remainingPending.length} promessa(s) ainda pendente(s) (sem confirmação de pagamento).`,
    );
  }
  if (cycle.stale.length > 0) {
    // #4506 item 2: cada uma já foi logada individualmente dentro de
    // reconcilePendingPromises — este é só o resumo agregado no nível do alarme.
    console.error(
      `${LOG_PREFIX} aviso: ${cycle.stale.length} promessa(s) pendente(s) há mais de 90 dias sem confirmar — ver avisos acima.`,
    );
  }
  if (cycle.warning) {
    console.error(`${LOG_PREFIX} aviso: ${cycle.warning}`);
  }
  if (cycle.authError) {
    // Achado crítico 2 (PR #4503): chave apoia.se rejeitada é LOUD, nunca
    // "seguindo sem ela" — sem isso, toda promessa pendente falharia em
    // silêncio pra sempre, indistinguível de "ainda não pagou". Aborta ANTES
    // de computar/enviar o diff (com a credencial quebrada, `buildApoiosData`
    // também erraria pra todo contato — não há diff confiável pra alarmar).
    console.error(
      `${LOG_PREFIX} ERRO FATAL: chave apoia.se rejeitada durante a reconciliação de promessas pendentes ` +
        `(${cycle.authError}) — verifique APOIA_SE_API_KEY/APOIA_SE_API_SECRET. Alarme abortado sem enviar e-mail.`,
    );
    process.exit(1);
  }

  const data = await buildApoiosData(ROOT);
  if (data.error) {
    console.error(`${LOG_PREFIX} aviso: buildApoiosData reportou erro (dados podem estar incompletos): ${data.error}`);
  }

  const now = new Date();
  const currentMonth = competenceMonth(now);
  let pastSnapshots: MonthSnapshot[] = [];
  try {
    const env = readApoiaSeEnv();
    pastSnapshots = readPastMonthSnapshots(defaultCacheDir(env.campaign), currentMonth);
  } catch (e) {
    console.error(`${LOG_PREFIX} aviso: não foi possível ler snapshots de meses anteriores: ${(e as Error).message}`);
  }

  const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);
  const current = await fetchCurrentBeehiivState(publicationId, apiKey);
  const diff = diffApoioTags(desired, current);

  const input: DiffAlarmInput = {
    toApply: diff.toApply.map((e) => ({ email: e.email, contactName: e.contactName, fromLevel: e.fromLevel, toLevel: e.toLevel })),
    toRemove: diff.toRemove.map((e) => ({ email: e.email, contactName: e.contactName, fromLevel: e.fromLevel, toLevel: e.toLevel })),
  };

  const state = loadState();
  console.log(
    `${LOG_PREFIX} diff: ${input.toApply.length} adição(ões)/troca(s), ${input.toRemove.length} remoção(ões) ` +
      `(último alarme: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // #5339 — reconcilia UMA issue pro diff pendente inteiro (ver
  // `toAlarmFinding` — nunca 1 issue por assinante, e-mail é mascarado no
  // corpo por ser repo PÚBLICO) ANTES de montar o e-mail. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  const alarmFindings = hasPendingDiff(input) ? [toAlarmFinding(input)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: { issueNumber: number | null; url: string | null; action: string; error?: string } | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    const outcome = findingOutcomes[0];
    if (outcome) {
      issueRef = { issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error };
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (shouldAlarm(state, input)) {
    // Self-review finding 5 (PR #4503): informa no e-mail quais remoções um
    // `--push` real recusaria — avaliado SEM os escape hatches
    // (`--allow-partial`/`--force-blast-radius`), o pior caso, já que este
    // script nunca sabe se o editor vai usá-los.
    const partialDataBlocksRemovals = shouldBlockRemovals(data.error, diff, false) && diff.toRemove.length > 0;
    const blastGuard = evaluateBlastRadiusGuard(diff.toRemove.length, current, false);
    const guardWarnings: DiffAlarmGuardWarnings = {
      partialDataBlocksRemovals,
      blastRadiusBlocked: blastGuard.blocked,
      blastRadiusRatioPct: Math.round(blastGuard.ratio * 1000) / 10,
    };
    const { subject, body } = buildApoiosDiffAlarmEmail(input, guardWarnings, issueRef);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(
      `${LOG_PREFIX} nenhum e-mail necessário (sem diff pendente, ou o mesmo diff já foi alarmado antes).`,
    );
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = hasPendingDiff(input) ? computeDiffFingerprint(input) : null;
  saveState(advanceState(nextFingerprint, now));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
