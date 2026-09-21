#!/usr/bin/env node
/**
 * scripts/gtm-drift-check.ts (#8585)
 *
 * Task de drift do container GTM PUBLICADO (`GTM-TC8C65ZN`) — fecha a
 * lacuna descrita na #8578/#8572: `test/meta-capi-8388.test.ts` só audita
 * `docs/gtm-signup-container-import-proposal.json` (uma PROPOSTA de import
 * versionada aqui), nunca o container que está de fato no ar. Este script
 * baixa `https://www.googletagmanager.com/gtm.js?id=GTM-TC8C65ZN` (público,
 * GET simples, sem credencial — mesmo raciocínio de `home-meta-check.ts`) e
 * compara os campos relevantes do evento `CompleteRegistration` (pixel ID,
 * nome do evento, value/currency, presença de `vtp_eventId`) contra a
 * proposta versionada + `META_CAPI_COMPLETE_REGISTRATION_VALUE`/`_CURRENCY`
 * (`scripts/lib/shared/meta-capi.ts`). Divergência dispara alarme por
 * e-mail + issue GitHub — mesmo molde de `home-meta-check.ts`/
 * `subscribe-redirect-drift-check.ts`.
 *
 * O guard existente (`test/meta-capi-8388.test.ts`) continua útil pra
 * consistência interna da proposta versionada — este script não o
 * substitui, cobre a pergunta que ele nunca respondia ("o que está
 * publicado de verdade no GTM?").
 *
 * Ver `scripts/lib/gtm-drift-check.ts` pra decisão pura
 * (`evaluateGtmDrift`) + fingerprint/idempotência do alarme — inclusive o
 * porquê de cada eixo ter 3 desfechos (`match`/`mismatch`/`not-found`) e só
 * `mismatch` acionar alarme.
 *
 * Uso:
 *   npx tsx scripts/gtm-drift-check.ts               # avalia + persiste + alarma se NOVO drift + reconcilia issues
 *   npx tsx scripts/gtm-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste/alarma/toca gh
 *   npx tsx scripts/gtm-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * quando há drift pra de fato enviar o e-mail; a checagem HTTP em si não
 * precisa de credencial nenhuma (GET público, sem auth). `gh` CLI
 * autenticado — só necessário pra criar/comentar/fechar issue (#5112); sem
 * ele, `ensureAlarmIssue` falha fail-soft (o e-mail sai assim mesmo). Não
 * precisa do junction `data/` pra rodar a checagem em si — só pra persistir
 * o estado de idempotência (`data/gtm-drift-check/state.json` +
 * `alarm-issues.json`).
 *
 * Como os outros alarmes locais deste repo, o registro da task no
 * systemd e a 1ª execução ao vivo não rodaram nesta unidade (worktree
 * isolado de subagente overnight — regra de dispatch #738/#3453 proíbe
 * qualquer chamada de rede real nesta sessão, mesmo GET público de
 * leitura) — validado só via `test/gtm-drift-check.test.ts` com a lógica
 * pura + fetch mockado (sem rede real).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { BROWSER_USER_AGENT } from "./lib/apex-cutover.ts";
import {
  META_CAPI_DEFAULT_DATASET_ID,
  META_CAPI_COMPLETE_REGISTRATION_VALUE,
  META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
} from "./lib/shared/meta-capi.ts";
import {
  evaluateGtmDrift,
  hasGtmDrift,
  computeGtmDriftFingerprint,
  advanceGtmDriftAlarmState,
  emptyGtmDriftAlarmState,
  buildGtmDriftAlarmEmail,
  gtmDriftFindingKey,
  type GtmDriftAlarmState,
  type GtmCheckResult,
  type GtmExpectedConfig,
} from "./lib/gtm-drift-check.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmFindingOutcome,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "gtm-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "gtm-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[gtm-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
export const GTM_CONTAINER_ID = "GTM-TC8C65ZN";
export const GTM_JS_URL = `https://www.googletagmanager.com/gtm.js?id=${GTM_CONTAINER_ID}`;
/** Task diária — 2 execuções limpas consecutivas = ~48h sem o achado antes
 * de fechar a issue automaticamente, mesmo valor de
 * `home-meta-check.ts`/`subscribe-redirect-drift-check.ts` pra cadência
 * diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência do E-MAIL) ────────────────────────────────────────

export function loadState(statePath: string = STATE_PATH): GtmDriftAlarmState {
  if (!existsSync(statePath)) return emptyGtmDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GtmDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyGtmDriftAlarmState();
  }
}

export { saveState, loadAlarmIssuesState, saveAlarmIssuesState };

/** Converte um `GtmCheckResult` de `status: "mismatch"` no `AlarmFinding`
 * genérico que `scripts/lib/alarm-issues.ts` consome. `family: "estado"` —
 * condição re-checável (resolve sozinho quando o container voltar a bater
 * com o esperado). `P2`: não é fire (nada quebrado em produção — o pixel
 * client-side/CAPI continuam funcionando, só a QUALIDADE do dado de
 * conversão/dedup degrada), mas tem histórico de custar tempo real de
 * diagnóstico (#8572) — mesma prioridade de `home-meta-check.ts`. */
export function toAlarmFinding(r: GtmCheckResult): AlarmFinding {
  return {
    check: r.check,
    fingerprint: gtmDriftFindingKey(r),
    family: "estado",
    title: `[diar.ia.br] drift no container GTM: ${r.check}`,
    body: [
      "Achado automático do smoke-test `Diaria-Gtm-Drift-Check`",
      "(`scripts/gtm-drift-check.ts`).",
      "",
      `Eixo: \`${r.check}\``,
      `Detalhe: ${r.message}`,
      "",
      `Container: ${GTM_CONTAINER_ID}`,
      `Fonte: ${GTM_JS_URL}`,
      "",
      "Refs #8585 (task) / #8578 (achado original) / #8572 (onde a lacuna",
      "custou tempo de diagnóstico). A correção é conferir/ajustar a tag do",
      "Meta Pixel no painel do GTM (https://tagmanager.google.com) — este",
      "alarme só detecta, nunca publica nada no GTM. Esta issue é criada",
      "automaticamente pelo alarme e será comentada/fechada sozinha quando",
      `o achado deixar de reproduzir por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas.`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

// ─── Checagem HTTP (I/O, fail-soft) ────────────────────────────────────────

/**
 * Bate `GET` no `gtm.js` público com User-Agent de navegador (sem UA
 * alguns edges devolvem challenge — mesma defesa de
 * `subscribe-redirect-drift-check.ts`) e resolve pra `{ text, fetchError }`
 * — NUNCA lança.
 */
export async function fetchGtmJs(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ text: string | null; fetchError: string | null }> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { text: null, fetchError: `HTTP ${res.status}` };
    return { text: await res.text(), fetchError: null };
  } catch (e) {
    return { text: null, fetchError: (e as Error).message };
  }
}

function buildExpectedConfig(): GtmExpectedConfig {
  return {
    pixelId: META_CAPI_DEFAULT_DATASET_ID,
    eventName: "CompleteRegistration",
    value: String(META_CAPI_COMPLETE_REGISTRATION_VALUE),
    currency: META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  console.log(`${LOG_PREFIX} checando ${GTM_JS_URL}`);

  const { text, fetchError } = await fetchGtmJs(GTM_JS_URL);
  if (fetchError || text === null) {
    // Fail-soft: falha de rede na checagem em si não é o drift que este
    // script existe pra detectar (é infra, não conteúdo do container) —
    // loga e sai com erro sem persistir/alarmar, mesma disciplina do
    // resto do repo (ver home-meta-check.ts).
    console.error(`${LOG_PREFIX} falha ao buscar ${GTM_JS_URL}: ${fetchError}`);
    process.exitCode = 1;
    return;
  }

  const results = evaluateGtmDrift(text, buildExpectedConfig());
  for (const r of results) {
    console.log(`${LOG_PREFIX} [${r.check}] ${r.status}: ${r.message}`);
  }

  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  const mismatches = results.filter((r) => r.status === "mismatch");
  const alarmFindings = mismatches.map(toAlarmFinding);
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;
  let allFindingOutcomes: AlarmFindingOutcome[] = [];

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
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
    allFindingOutcomes = findingOutcomes;
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.fingerprint,
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
  }

  const state = loadState();
  const pending = hasGtmDrift(results);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  if (isDryRun) {
    if (pending) {
      const { subject, body } = buildGtmDriftAlarmEmail(results, GTM_JS_URL, issueRefs);
      console.log(
        `${LOG_PREFIX} --dry-run: enviaria e-mail pra ${toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH)}:\n--- subject ---\n${subject}\n--- body ---\n${body}`,
      );
    } else {
      console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente).`);
    }
  } else if (pending) {
    const result = await notifyEditorForOutcomes(
      allFindingOutcomes,
      "acao",
      () => buildGtmDriftAlarmEmail(results, GTM_JS_URL, issueRefs),
      { cwd: ROOT, platformConfigPath: PLATFORM_CONFIG_PATH, emailTo: toOverride, legacyResendIntent: "dedupe-new-occurrences-only" },
    );
    if (result.qualifying.length === 0) {
      console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário (drift já alarmado antes).`);
    } else if (result.emailSent) {
      console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
    } else {
      console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = pending ? computeGtmDriftFingerprint(results) : null;
  saveState(advanceGtmDriftAlarmState(nextFingerprint, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // process.exitCode em vez de process.exit() — este catch roda DEPOIS de
  // awaits de rede (fetchGtmJs/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING documentado em worker-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
