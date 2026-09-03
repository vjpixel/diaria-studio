#!/usr/bin/env node
/**
 * scripts/hub-drift-check.ts (#4750)
 *
 * Smoke-test de runtime: para cada entrada de `HUB_META`
 * (`workers/arquivo/src/hubs/meta.ts`), bate `GET {DIARIA_ARQUIVO_URL}/temas/{slug}`
 * no Worker `arquivo` publicado e verifica 200. Se algum hub responder algo
 * diferente de 200 (404, 5xx) ou a chamada de rede falhar, alarma o editor
 * por e-mail — nomeando o(s) hub(s), o slug e a URL exata.
 *
 * Contexto: `test/hub-registry-completeness.test.ts` cruza `HUB_LOADERS`/
 * `HUB_REGISTRY`/`HUB_META` entre si — mas é inteiramente TEST-TIME. Nada
 * checava o que está de fato servido pelo Worker publicado; se os registries
 * divergirem por um caminho que não passe pelo CI de PR, o drift chegaria em
 * produção como um 404/link quebrado sem nenhum log/alarme (#4750, follow-up
 * do fleet review da PR #4749 — mesma classe de problema da #4723, aqui
 * aplicada ao caso específico "hub servindo 404" em vez de "código velho no
 * ar").
 *
 * Ver `scripts/lib/hub-drift-check.ts` pra decisão pura por hub
 * (`evaluateHubDrift`) + fingerprint/idempotência do alarme.
 *
 * Uso:
 *   npx tsx scripts/hub-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/hub-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/hub-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário quando há drift pra
 * de fato enviar o e-mail; a checagem HTTP em si não precisa de credencial
 * nenhuma (GET público, sem auth). Não precisa do junction `data/` para ler
 * `HUB_META` (módulo do repo, local ao checkout) — só pra persistir o estado
 * de idempotência (`data/hub-drift-check/state.json`).
 *
 * Fail-soft por hub: uma falha de rede NUM hub específico não impede a
 * checagem dos demais — cada `fetch` é isolado (`Promise.all` sobre
 * `checkHub`, que nunca lança).
 *
 * Estado (idempotência): `data/hub-drift-check/state.json`.
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4740), o registro da task no Task Scheduler e a 1ª execução ao vivo nunca
 * rodaram nesta unidade (worktree isolado, sem `data/.credentials.json` real
 * nem acesso à URL de produção repetido em teste) — validado só via testes
 * com a lógica pura + fetch mockado (sem rede real).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { DIARIA_ARQUIVO_URL } from "./lib/canonical-urls.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";
import {
  evaluateAllHubDrift,
  hasPendingHubDrift,
  computeHubDriftFingerprint,
  shouldAlarmHubDrift,
  advanceHubDriftState,
  emptyHubDriftAlarmState,
  buildHubDriftAlarmEmail,
  hubDriftFindingKey,
  type HubCheckInput,
  type HubDriftResult,
  type HubDriftAlarmState,
} from "./lib/hub-drift-check.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "hub-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "hub-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[hub-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
/** #5339: task roda diária (10:00) — 2 execuções limpas consecutivas = 48h
 * sem o achado antes de fechar a issue automaticamente, mesmo valor de
 * `home-meta-check.ts`/`on-hold-vencimento-alarm.ts`/
 * `worker-drift-check.ts` pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) — mesmo padrão I/O de worker-drift-check.ts ─────

export function loadState(statePath: string = STATE_PATH): HubDriftAlarmState {
  if (!existsSync(statePath)) return emptyHubDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<HubDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyHubDriftAlarmState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima. Arquivo separado
// de STATE_PATH de propósito: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.
export { saveState };

/** Converte um `HubDriftResult` quebrado ("broken"/"error") no `AlarmFinding`
 * genérico que `scripts/lib/alarm-issues.ts` consome (#5339). `check` =
 * slug do hub (cada hub é seu próprio eixo). `fingerprint` usa
 * `hubDriftFindingKey`, a MESMA fórmula usada por `computeHubDriftFingerprint`
 * e repassada a `buildHubDriftAlarmEmail`. Todo achado nasce `P2` — bug com
 * workaround (deploy manual do Worker `arquivo`), mesma prioridade de
 * `worker-drift-check.ts`. */
export function toAlarmFinding(r: HubDriftResult): AlarmFinding {
  return {
    check: r.slug,
    fingerprint: hubDriftFindingKey(r),
    // #5553 — condição RE-CHECÁVEL (hub no ar); resolve sozinho quando
    // voltar a responder.
    family: "estado",
    title: `[diar.ia.br] hub "${r.label}" fora do ar (arquivo.diar.ia.br)`,
    body: [
      "Achado automático do alarme `Diaria-Hub-Drift-Check`",
      "(`scripts/hub-drift-check.ts`).",
      "",
      `Hub: \`${r.label}\` (slug: ${r.slug})`,
      `Detalhe: ${r.message}`,
      `URL: ${r.url}`,
      "",
      "Verifique se o Worker `arquivo` está deployado com o commit mais recente",
      "(cd workers/arquivo && npx wrangler deploy) e se o slug existe de fato em",
      "workers/arquivo/src/hubs/registry.ts.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

// ─── Checagem HTTP por hub (I/O, fail-soft) ────────────────────────────────

/**
 * Bate `GET url` e resolve pra `{ httpStatus, fetchError }` — NUNCA lança:
 * uma falha de rede (timeout, DNS, conexão recusada) vira `fetchError`
 * preenchido em vez de propagar, pra não derrubar a checagem dos outros hubs
 * (ver `Promise.all` em `main()`, cada chamada é isolada de qualquer forma,
 * mas o contrato "nunca lança" simplifica o caller).
 */
export async function checkHub(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ httpStatus: number | null; fetchError: string | null }> {
  try {
    const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return { httpStatus: res.status, fetchError: null };
  } catch (e) {
    return { httpStatus: null, fetchError: (e as Error).message };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  if (HUB_META.length === 0) {
    console.log(`${LOG_PREFIX} HUB_META está vazio — nada a checar.`);
    return;
  }

  console.log(`${LOG_PREFIX} ${HUB_META.length} hub(s) em HUB_META — checando contra ${DIARIA_ARQUIVO_URL}.`);

  const inputs: HubCheckInput[] = await Promise.all(
    HUB_META.map(async (hub) => {
      const url = `${DIARIA_ARQUIVO_URL}/temas/${hub.slug}`;
      const { httpStatus, fetchError } = await checkHub(url);
      return { slug: hub.slug, label: hub.label, url, httpStatus, fetchError };
    }),
  );

  const results: HubDriftResult[] = evaluateAllHubDrift(inputs);

  for (const r of results) {
    console.log(`${LOG_PREFIX} ${r.slug} (${r.label}): ${r.status} — ${r.message}`);
  }

  const state = loadState();
  const pending = hasPendingHubDrift(results);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // #5339 — reconcilia issue por hub quebrado ANTES de montar o e-mail (o
  // e-mail cita a issue de cada achado pendente), mesmo padrão de
  // worker-drift-check.ts/home-meta-check.ts. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  const brokenResults = results.filter((r) => r.status === "broken" || r.status === "error");
  const alarmFindings = brokenResults.map(toAlarmFinding);
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

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

  if (shouldAlarmHubDrift(state, results)) {
    const { subject, body } = buildHubDriftAlarmEmail(results, new Date(), issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Mesmo racional de worker-drift-check.ts/apoios-diff-alarm.ts: sem
      // try/catch — se o envio falhar, o cursor abaixo não avança (aborta
      // antes do saveState), então a próxima execução tenta alarmar de novo
      // em vez de marcar este drift como "já avisado" sem o editor ter
      // recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente, ou o mesmo drift já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  const nextFingerprint = pending ? computeHubDriftFingerprint(results) : null;
  saveState(advanceHubDriftState(nextFingerprint, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de awaits de rede (checkHub/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING no Windows documentado em worker-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
