#!/usr/bin/env node
/**
 * scripts/robots-txt-drift-check.ts (#4910 item 3)
 *
 * Smoke-test agendado: pra cada Worker de curadoria com host público
 * (descoberto via `discoverWorkerPublicHosts`, sem lista hardcoded — mesma
 * fonte de `test/worker-robots-txt-guard-4777.test.ts`), bate
 * `GET https://{host}/robots.txt` e verifica se o arquivo SERVIDO ainda
 * carrega o bloco gerenciado da Cloudflare e/ou bloqueia algum bot fora do
 * esperado. Se algum host tiver drift, alarma o editor por e-mail —
 * nomeando o(s) host(s) e o(s) motivo(s) exato(s).
 *
 * Molde: `scripts/hub-drift-check.ts` (#4750) — decisão pura testável em
 * `scripts/lib/robots-txt-drift-check.ts`, CLI fino aqui fazendo só I/O
 * (fetch + estado + e-mail), fail-soft por host (`Promise.all` sobre
 * `checkRobotsTxt`, que nunca lança), alarme por e-mail só em drift NOVO
 * (idempotência por fingerprint).
 *
 * **Por que `diar.ia.br` (Beehiiv) nunca entra na lista de hosts**:
 * `discoverWorkerPublicHosts` varre `workers/*​/wrangler.toml` — Beehiiv não
 * é um Worker deste repo, então não aparece nunca, sem precisar de
 * exclusão explícita. O `robots.txt` dele é outro fabricante inteiro (abre
 * com `# beehiiv default robots.txt`) e não tem o bloco gerenciado da
 * Cloudflare — fora de escopo deste smoke-test por natureza, não por filtro.
 *
 * **UA realista** (`DiariaBot/1.0 (+https://diar.ia.br)`, mesmo UA já usado
 * por `hub-drift-check.ts`/`seo-index-check.ts`): um `curl` com UA cru
 * (vazio/genérico) contra hosts próprios (`arquivo.diar.ia.br` etc.) já
 * responde 200 hoje, mas usar um UA identificável evita depender disso
 * continuar valendo se a Cloudflare endurecer challenge por UA no futuro.
 *
 * Uso:
 *   npx tsx scripts/robots-txt-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/robots-txt-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/robots-txt-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário
 * quando há drift pra de fato enviar o e-mail; a checagem HTTP em si é um
 * GET público sem credencial nenhuma. Não precisa do junction `data/` pra
 * descobrir hosts (lê `workers/*​/wrangler.toml`, local ao checkout) — só
 * pra persistir o estado de idempotência
 * (`data/robots-txt-drift-check/state.json`).
 *
 * Como os outros alarmes locais deste repo, o registro da task no Task
 * Scheduler/systemd e a 1ª execução ao vivo nunca rodaram nesta unidade
 * (worktree isolado, sem `data/.credentials.json` real nem chamada de rede
 * contra hosts de produção) — validado só via testes com a lógica pura +
 * fetch mockado (sem rede real), mesma disciplina do #4750/#4723/etc.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { discoverWorkerPublicHosts } from "./lib/worker-public-hosts.ts";
import {
  evaluateAllRobotsDrift,
  hasPendingRobotsDrift,
  computeRobotsDriftFingerprint,
  shouldAlarmRobotsDrift,
  advanceRobotsDriftState,
  emptyRobotsDriftAlarmState,
  buildRobotsDriftAlarmEmail,
  robotsDriftFindingKey,
  type RobotsCheckInput,
  type RobotsDriftResult,
  type RobotsDriftAlarmState,
} from "./lib/robots-txt-drift-check.ts";
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
const STATE_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const WORKERS_DIR = resolve(ROOT, "workers");
const LOG_PREFIX = "[robots-txt-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";
/** #5339: task roda diária (10:15) — 2 execuções limpas consecutivas = 48h
 * sem o achado antes de fechar a issue automaticamente, mesmo valor de
 * `hub-drift-check.ts`/`home-meta-check.ts` pra cadência diária. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) — mesmo padrão I/O de hub-drift-check.ts ───────

export function loadState(statePath: string = STATE_PATH): RobotsDriftAlarmState {
  if (!existsSync(statePath)) return emptyRobotsDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<RobotsDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyRobotsDriftAlarmState();
  }
}

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima. Arquivo separado
// de STATE_PATH de propósito: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.
export { saveState };

/** Converte um `RobotsDriftResult` com drift pendente ("drift"/"error") no
 * `AlarmFinding` genérico que `scripts/lib/alarm-issues.ts` consome (#5339).
 * `check` = host (cada host é seu próprio eixo). `fingerprint` usa
 * `robotsDriftFindingKey`, a MESMA fórmula usada por
 * `computeRobotsDriftFingerprint` e repassada a `buildRobotsDriftAlarmEmail`.
 * Todo achado nasce `P2` — mesmo racional de risco/gravidade dos outros
 * alarmes de drift deste lote (correção manual, sem impacto de produção
 * imediato). */
export function toAlarmFinding(r: RobotsDriftResult): AlarmFinding {
  return {
    check: r.host,
    fingerprint: robotsDriftFindingKey(r),
    // #5553 — condição RE-CHECÁVEL (robots.txt servido); resolve sozinho
    // quando o arquivo voltar a bater com o esperado.
    family: "estado",
    title: `[diar.ia.br] drift no robots.txt de ${r.host}`,
    body: [
      "Achado automático do alarme `Diaria-Robots-Txt-Drift-Check`",
      "(`scripts/robots-txt-drift-check.ts`).",
      "",
      `Host: \`${r.host}\``,
      `Detalhe: ${r.message}`,
      `URL: ${r.url}`,
      "",
      "Contexto (#4910): todo Worker num domínio proxiado pela Cloudflare",
      "nasce servindo um robots.txt gerenciado DEFAULT que é ANEXADO ao",
      "bloco próprio do Worker — se a plataforma mudar esse bloco, é preciso",
      "conferir a config de robots.txt gerenciado na zona Cloudflare.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

// ─── Checagem HTTP por host (I/O, fail-soft) ───────────────────────────────

/**
 * Bate `GET {url}/robots.txt` e resolve pra `{httpStatus, robotsTxt,
 * fetchError}` — NUNCA lança: uma falha de rede (timeout, DNS, conexão
 * recusada) vira `fetchError` preenchido em vez de propagar, pra não
 * derrubar a checagem dos outros hosts (mesmo contrato de `checkHub` em
 * `hub-drift-check.ts`).
 */
export async function checkRobotsTxt(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ httpStatus: number | null; robotsTxt: string | null; fetchError: string | null }> {
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) return { httpStatus: res.status, robotsTxt: null, fetchError: null };
    const body = await res.text();
    return { httpStatus: res.status, robotsTxt: body, fetchError: null };
  } catch (e) {
    return { httpStatus: null, robotsTxt: null, fetchError: (e as Error).message };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");

  const discovered = discoverWorkerPublicHosts(WORKERS_DIR);
  if (discovered.length === 0) {
    console.log(`${LOG_PREFIX} nenhum host público descoberto sob workers/ — nada a checar.`);
    return;
  }

  // Um mesmo host pode aparecer mais de uma vez (não acontece hoje — 1
  // wrangler.toml por Worker — mas dedup defensivo evita checar 2x/alarmar
  // 2x se algum wrangler.toml futuro declarar mais de uma rota pro mesmo
  // host).
  const hosts = [...new Set(discovered.map((d) => d.host))];

  console.log(`${LOG_PREFIX} ${hosts.length} host(s) público(s) descoberto(s): ${hosts.join(", ")}`);

  const inputs: RobotsCheckInput[] = await Promise.all(
    hosts.map(async (host) => {
      const url = `https://${host}/robots.txt`;
      const { httpStatus, robotsTxt, fetchError } = await checkRobotsTxt(url);
      return { host, url, robotsTxt, httpStatus, fetchError };
    }),
  );

  const results: RobotsDriftResult[] = evaluateAllRobotsDrift(inputs);

  for (const r of results) {
    console.log(`${LOG_PREFIX} ${r.host}: ${r.status} — ${r.message}`);
  }

  const state = loadState();
  const pending = hasPendingRobotsDrift(results);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // #5339 — reconcilia issue por host com drift ANTES de montar o e-mail (o
  // e-mail cita a issue de cada achado pendente), mesmo padrão de
  // hub-drift-check.ts/home-meta-check.ts. Roda toda execução
  // não-dry-run, independente de um e-mail novo disparar nesta rodada.
  const driftedResults = results.filter((r) => r.status === "drift" || r.status === "error");
  const alarmFindings = driftedResults.map(toAlarmFinding);
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

  if (shouldAlarmRobotsDrift(state, results)) {
    const { subject, body } = buildRobotsDriftAlarmEmail(results, new Date(), issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional de hub-drift-check.ts/
      // apoios-diff-alarm.ts: se o envio falhar, o cursor abaixo não avança
      // (aborta antes do saveState), então a próxima execução tenta
      // alarmar de novo em vez de marcar este drift como "já avisado" sem
      // o editor ter recebido nada.
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

  const nextFingerprint = pending ? computeRobotsDriftFingerprint(results) : null;
  saveState(advanceRobotsDriftState(nextFingerprint, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  // process.exitCode em vez de process.exit() — este catch roda DEPOIS de
  // awaits de rede (checkRobotsTxt/sendGmailMessage), mesmo cenário
  // UV_HANDLE_CLOSING documentado em worker-drift-check.ts/hub-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
