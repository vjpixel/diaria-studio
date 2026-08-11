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
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
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
  type RobotsCheckInput,
  type RobotsDriftResult,
  type RobotsDriftAlarmState,
} from "./lib/robots-txt-drift-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "robots-txt-drift-check", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const WORKERS_DIR = resolve(ROOT, "workers");
const LOG_PREFIX = "[robots-txt-drift-check]";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "DiariaBot/1.0 (+https://diar.ia.br)";

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

export function saveState(state: RobotsDriftAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
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

  if (shouldAlarmRobotsDrift(state, results)) {
    const { subject, body } = buildRobotsDriftAlarmEmail(results);
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
  saveState(advanceRobotsDriftState(nextFingerprint, new Date()));
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
