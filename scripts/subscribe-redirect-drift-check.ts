#!/usr/bin/env node
/**
 * scripts/subscribe-redirect-drift-check.ts (#6365)
 *
 * Smoke-test de runtime: bate `GET` em cada alvo de `buildDefaultTargets`
 * (destino do redirect `/subscribe` no Kit + `/` e `/p/{slug}` do Worker
 * `diaria-site`) e verifica 200 **e** a presença dos marcadores esperados
 * (status sozinho não basta — página de erro pode vir 200, ver docstring de
 * `scripts/lib/subscribe-redirect-drift-check.ts`). Se algum alvo estiver
 * quebrado, alarma o editor por e-mail — nomeando o alvo, a URL e o detalhe.
 *
 * Contexto: `test/site-worker-routes-6359.test.ts` garante que a REGRA de
 * redirect existe no código committed e aponta pra `kit.com` — mas isso
 * passa para sempre, inclusive no dia em que o destino morrer. Depois do
 * cutover do apex (#467), `/subscribe` é a única porta de cadastro pelo
 * site e o destino está inteiramente fora do nosso controle (conta Kit de
 * terceiro) — mesma classe de problema de `hub-drift-check.ts`/
 * `worker-drift-check.ts`, aqui aplicada à superfície de cadastro.
 *
 * Ver `scripts/lib/subscribe-redirect-drift-check.ts` pra decisão pura por
 * alvo (`evaluateSubscribeDrift`) + fingerprint/idempotência do alarme.
 *
 * Uso:
 *   npx tsx scripts/subscribe-redirect-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/subscribe-redirect-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/subscribe-redirect-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário quando há drift pra
 * de fato enviar o e-mail; as checagens HTTP em si não precisam de
 * credencial nenhuma (GET público, com User-Agent de navegador — sem UA a
 * Cloudflare devolve challenge no destino Kit, ver memória "curl sem UA
 * recebe challenge"). Não precisa do junction `data/` pra rodar a checagem —
 * só pra persistir o estado de idempotência
 * (`data/subscribe-redirect-drift-check/state.json`).
 *
 * Fail-soft por alvo: uma falha de rede NUM alvo específico não impede a
 * checagem dos demais — cada `fetch` é isolado (`Promise.all`), nunca lança.
 *
 * Como os outros alarmes locais deste repo (#4320/#4382/#4490/#4534/#4723/
 * #4740/#4750), o registro da task no Task Scheduler/systemd e a 1ª execução
 * ao vivo não rodaram nesta unidade (worktree isolado, sem
 * `data/.credentials.json` real) — validado via testes com a lógica pura +
 * fetch mockado, e via 1 GET manual de leitura contra o destino Kit real
 * (confirmado 200 + marcadores presentes em 26/08/2026, ao escrever este
 * script — não repetido em teste automatizado, que usa fetch mockado).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { WORKER_DEV_HOST, EXPECTED_ROOT_MARKER, SAMPLE_ARCHIVE_SLUG, BROWSER_USER_AGENT } from "./lib/apex-cutover.ts";
import {
  buildDefaultTargets,
  evaluateAllSubscribeDrift,
  hasPendingSubscribeDrift,
  computeSubscribeDriftFingerprint,
  shouldAlarmSubscribeDrift,
  advanceSubscribeDriftState,
  emptySubscribeDriftAlarmState,
  buildSubscribeDriftAlarmEmail,
  subscribeDriftFindingKey,
  type DriftCheckInput,
  type DriftCheckResult,
  type SubscribeDriftAlarmState,
} from "./lib/subscribe-redirect-drift-check.ts";
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
const STATE_PATH = resolve(ROOT, "data", "subscribe-redirect-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "subscribe-redirect-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[subscribe-redirect-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
/** Task roda diária — 2 execuções limpas consecutivas = ~48h sem o achado
 * antes de fechar a issue automaticamente, mesmo valor de
 * `hub-drift-check.ts`/`worker-drift-check.ts`/`home-meta-check.ts`
 * pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) ──────────────────────────────────────────────────

export function loadState(statePath: string = STATE_PATH): SubscribeDriftAlarmState {
  if (!existsSync(statePath)) return emptySubscribeDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SubscribeDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptySubscribeDriftAlarmState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima. Arquivo separado
// de STATE_PATH de propósito: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.
export { saveState };

/** Converte um `DriftCheckResult` quebrado ("broken"/"error") no
 * `AlarmFinding` genérico que `scripts/lib/alarm-issues.ts` consome. `check`
 * = key do alvo. `fingerprint` usa `subscribeDriftFindingKey`, a MESMA
 * fórmula usada por `computeSubscribeDriftFingerprint` e repassada a
 * `buildSubscribeDriftAlarmEmail`. Prioridade `P1` — diferente do `P2`
 * padrão dos outros drift-checks deste repo: um `/subscribe` quebrado é
 * a única porta de cadastro do apex pós-cutover (#467), sem workaround
 * pro leitor externo enquanto não for corrigido (justificativa explícita,
 * "Sempre indicar prioridade ao criar issues" do CLAUDE.md). */
export function toAlarmFinding(r: DriftCheckResult): AlarmFinding {
  return {
    check: r.key,
    fingerprint: subscribeDriftFindingKey(r),
    // Condição RE-CHECÁVEL (alvo volta a responder) — resolve sozinho quando
    // voltar a servir os marcadores esperados. Mesmo `family` de
    // `hub-drift-check.ts`.
    family: "estado",
    title: `[diar.ia.br] "${r.label}" fora do ar (superfície de cadastro do apex)`,
    body: [
      "Achado automático do alarme `Diaria-Subscribe-Redirect-Drift-Check`",
      "(`scripts/subscribe-redirect-drift-check.ts`).",
      "",
      `Alvo: \`${r.label}\` (key: ${r.key})`,
      `Detalhe: ${r.message}`,
      `URL: ${r.url}`,
      "",
      "Se o alvo for \"kit-subscribe\": o slug/perfil hospedado do Kit pode",
      "ter mudado, sido despublicado, ou a conta lapsou — confira",
      "https://app.kit.com e, se o destino mudou, atualize",
      "workers/site/public/_redirects (única fonte da URL).",
      "Se for \"worker-root\"/\"worker-sample-page\": confira se o deploy do",
      "Worker diaria-site (workers/site) está com o commit mais recente.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
  };
}

// ─── Checagem HTTP por alvo (I/O, fail-soft) ───────────────────────────────

/**
 * Bate `GET url` com User-Agent de navegador (sem UA a Cloudflare devolve
 * challenge no destino Kit, ver `BROWSER_USER_AGENT`) e resolve pra
 * `{ httpStatus, fetchError, body }` — NUNCA lança: uma falha de rede vira
 * `fetchError` preenchido em vez de propagar, pra não derrubar a checagem
 * dos outros alvos.
 */
export async function checkTarget(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ httpStatus: number | null; fetchError: string | null; body: string | null }> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body: string | null = null;
    try {
      body = await res.text();
    } catch (bodyErr) {
      // Não propaga (contrato "nunca lança" de checkTarget), mas loga a causa
      // real — sem isso, uma falha de LEITURA do corpo (conexão truncada,
      // encoding malformado) vira indistinguível de "página de erro
      // genuína" no e-mail/issue de alarme (achado do fleet review da PR
      // #6401, silent-failure-hunter, confiança alta): evaluateSubscribeDrift
      // trata body=null como marcador ausente e o texto do alarme manda o
      // editor conferir o Kit/redeploy do Worker — motivo errado se a causa
      // real foi este read falhando localmente.
      console.error(`${LOG_PREFIX} corpo ilegível em ${url} (status ${res.status}): ${(bodyErr as Error).message}`);
      body = null;
    }
    return { httpStatus: res.status, fetchError: null, body };
  } catch (e) {
    return { httpStatus: null, fetchError: (e as Error).message, body: null };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const targets = buildDefaultTargets({
    workerDevHost: WORKER_DEV_HOST,
    expectedRootMarker: EXPECTED_ROOT_MARKER,
    sampleArchiveSlug: SAMPLE_ARCHIVE_SLUG,
  });

  console.log(`${LOG_PREFIX} ${targets.length} alvo(s) — checando.`);

  const inputs: DriftCheckInput[] = await Promise.all(
    targets.map(async (target) => {
      const { httpStatus, fetchError, body } = await checkTarget(target.url);
      return { ...target, httpStatus, fetchError, body };
    }),
  );

  const results: DriftCheckResult[] = evaluateAllSubscribeDrift(inputs);

  for (const r of results) {
    console.log(`${LOG_PREFIX} ${r.key} (${r.label}): ${r.status} — ${r.message}`);
  }

  const state = loadState();
  const pending = hasPendingSubscribeDrift(results);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // Reconcilia issue por alvo quebrado ANTES de montar o e-mail (o e-mail
  // cita a issue de cada achado pendente), mesmo padrão de
  // hub-drift-check.ts/worker-drift-check.ts. Roda toda execução
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

  if (shouldAlarmSubscribeDrift(state, results)) {
    const { subject, body } = buildSubscribeDriftAlarmEmail(results, new Date(), issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Mesmo racional de hub-drift-check.ts/worker-drift-check.ts: sem
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

  const nextFingerprint = pending ? computeSubscribeDriftFingerprint(results) : null;
  saveState(advanceSubscribeDriftState(nextFingerprint, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // process.exitCode em vez de process.exit() — este catch roda DEPOIS de
  // awaits de rede (checkTarget/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING no Windows documentado em worker-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
