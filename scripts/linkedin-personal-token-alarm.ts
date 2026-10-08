#!/usr/bin/env node
/**
 * scripts/linkedin-personal-token-alarm.ts (#9568)
 *
 * Alarme diário do LinkedIn PESSOAL automatizado (2º passo da task
 * `Diaria-LinkedIn-Personal`). Lógica pura em `scripts/lib/linkedin-personal.ts`;
 * aqui é só I/O via `scripts/lib/alarm-issues.ts`.
 *
 * Dois eixos:
 *   1. Token (`evaluateTokenExpiry`, família `estado`, fecha sozinha quando o
 *      token é renovado): > 14 dias = nada; ≤ 14 = P2; ≤ 3 (inclui < 24h) ou
 *      expirado = P1; `EXPIRES_AT` ausente/ilegível = P2; `GET /v2/userinfo`
 *      com 401/403 = P1 "token revogado". Token nunca configurado = sem
 *      alarme (o lembrete manual do Stage 6 é o modo legítimo).
 *   2. Intenções das edições dos últimos 7 dias (`evaluatePersonalIntents`,
 *      família `evento`): `posting`/`send_unknown` há mais de 1h, `armed`
 *      vencido há mais de 3h, `armed` sem token nesta máquina.
 *
 * Uso:
 *   npx tsx scripts/linkedin-personal-token-alarm.ts            # avalia + cria/reusa/fecha issue
 *   npx tsx scripts/linkedin-personal-token-alarm.ts --dry-run  # avalia + imprime, sem gh
 *
 * Estado: `data/linkedin-personal-token-alarm-issues.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir } from "./lib/edition-paths.ts";
import {
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  planAlarmReconciliation,
  saveAlarmIssuesState,
} from "./lib/alarm-issues.ts";
import {
  ALARM_SCAN_DAYS,
  LINKEDIN_PERSONAL_ENV,
  PERSONAL_INTENT_FILE,
  aammddBrt,
  checkTokenRemote,
  evaluatePersonalIntents,
  evaluateTokenExpiry,
  tokenAlarmFreezeOnUnknownRemote,
  type PersonalPostIntent,
} from "./lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "linkedin-personal-token-alarm-issues.json");
const LOG_PREFIX = "[linkedin-personal-token-alarm]";
/** 1 execução limpa (token renovado) já basta pra fechar: o sinal não oscila.
 * Exceção (#9915): checagem remota indeterminada não conta como execução limpa
 * pra issue de token revogado — ver `tokenAlarmFreezeOnUnknownRemote`. */
export const CLOSE_AFTER_RUNS = 1;

/** Intenções legíveis das edições dos últimos `ALARM_SCAN_DAYS` dias (BRT). */
export function readRecentIntents(rootDir: string, now: Date, days = ALARM_SCAN_DAYS): PersonalPostIntent[] {
  const out: PersonalPostIntent[] = [];
  for (let i = 0; i <= days; i++) {
    const aammdd = aammddBrt(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    const p = resolve(rootDir, editionDir(aammdd), "_internal", PERSONAL_INTENT_FILE);
    if (!existsSync(p)) continue;
    try {
      out.push(JSON.parse(readFileSync(p, "utf8")) as PersonalPostIntent);
    } catch (e) {
      console.error(`${LOG_PREFIX} ${p} ilegível: ${(e as Error).message}`);
    }
  }
  return out;
}

async function main(): Promise<number> {
  loadProjectEnv(ROOT);
  const now = new Date();
  const token = (process.env[LINKEDIN_PERSONAL_ENV.accessToken] ?? "").trim();
  const remote = token ? await checkTokenRemote(fetch, token) : null;
  if (remote?.state === "unknown") console.warn(`${LOG_PREFIX} não consegui checar o token na LinkedIn: ${remote.reason}`);
  const tokenFinding = evaluateTokenExpiry(process.env, now, remote);
  const findings = [...(tokenFinding ? [tokenFinding] : []), ...evaluatePersonalIntents(readRecentIntents(ROOT, now), process.env, now)];
  console.log(`${LOG_PREFIX} ${findings.length === 0 ? "nada a alarmar" : findings.map((f) => f.title).join(" | ")}`);
  const state = loadAlarmIssuesState(STATE_PATH);
  const allowlist = tokenAlarmFreezeOnUnknownRemote(remote, state);
  if (allowlist.length > 0) console.warn(`${LOG_PREFIX} issue de token revogado mantida como está até a LinkedIn responder (#9915).`);
  if (hasFlag(process.argv, "dry-run")) {
    const actions = planAlarmReconciliation(findings, state, CLOSE_AFTER_RUNS, allowlist);
    console.log(`${LOG_PREFIX} --dry-run: ${actions.map((a) => a.kind).join(", ") || "nenhuma ação"} — gh NÃO foi chamado.`);
    return 0;
  }
  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, { cwd: ROOT, closeAfterRuns: CLOSE_AFTER_RUNS, allowlist });
  saveAlarmIssuesState(nextState, STATE_PATH);
  let failed = false;
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      failed = true;
      console.error(`${LOG_PREFIX} issue não criada/reusada (${o.fingerprint}): ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }
  return failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  // #9911: exitCode, não process.exit — no Windows o exit logo após o fetch sai 127.
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`) });
}
