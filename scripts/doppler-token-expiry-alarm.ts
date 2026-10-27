#!/usr/bin/env node
/** #11077: consulta o vault, mesmo sem token local. Não renova credenciais nem
 * arma tasks. Uso: npx tsx scripts/doppler-token-expiry-alarm.ts [--dry-run].
 * Campos *_EXPIRES_AT presentes são monitorados; Threads/LinkedIn pessoais
 * também são exigidos quando o respectivo access token existe no vault.
 * Token nunca configurado não gera falso alarme.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { defaultDopplerRunner, type DopplerRunner } from "./sync-env.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { applyAlarmReconciliation, loadAlarmIssuesState, planAlarmReconciliation, saveAlarmIssuesState, type AlarmFinding } from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = resolve(ROOT, "data/doppler-token-expiry-alarm-issues.json");
const CHECK = "doppler-token-expiry";
const DAY = 86_400_000;

export function evaluateDopplerExpiries(env: Record<string, string | undefined>, now: Date): AlarmFinding[] {
  const keys = new Set(Object.keys(env).filter((key) => /^[A-Z][A-Z0-9_]*_EXPIRES_AT$/.test(key)));
  for (const prefix of ["THREADS_PERSONAL", "LINKEDIN_PERSONAL"]) {
    if (env[`${prefix}_ACCESS_TOKEN`]?.trim()) keys.add(`${prefix}_TOKEN_EXPIRES_AT`);
  }
  return [...keys].sort().flatMap((key): AlarmFinding[] => {
    const raw = env[key]?.trim();
    const timestamp = raw && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
    const remaining = timestamp - now.getTime();
    if (Number.isFinite(timestamp) && remaining > 14 * DAY) return [];
    const band = !Number.isFinite(timestamp) ? "unknown" : remaining <= 0 ? "expired" : remaining <= 3 * DAY ? "critical" : "warn";
    const status = band === "unknown" ? "vencimento ausente ou ilegível" : band === "expired" ? "token vencido" : `vence em ${Math.floor(remaining / DAY)} dia(s)`;
    return [{
      check: CHECK, fingerprint: key, family: "estado", labels: ["bug"],
      priority: band === "critical" || band === "expired" ? "P1" : "P2",
      title: `Doppler: ${key} — ${status}`,
      body: `O campo \`${key}\` em \`diaria-studio/dev\` indica: ${status}. ` +
        "Verifique a renovação pelo procedimento OAuth da plataforma e a persistência no Doppler. " +
        "O alarme consulta o vault independentemente da presença do token nesta máquina. " +
        "Nenhum valor de secret é registrado. Esta issue fecha quando o vault indicar mais de 14 dias de validade. " +
        "Este alarme não arma tasks nem renova tokens (o Threads pessoal renova pela task Diaria-Threads-Personal-Token, #10772).",
      contentSignature: band,
    }];
  });
}

/** Falha de leitura aborta ANTES da reconciliação: nunca fecha issues por falta
 * de acesso ao vault. Não propaga stdout/stderr/erro que possa conter secrets. */
export function readDopplerExpiries(runner: DopplerRunner = defaultDopplerRunner): Record<string, string> {
  try {
    const snapshot = runner(["secrets", "download", "--no-file", "--format", "env", "--project", "diaria-studio", "--config", "dev"]);
    const parsed = parse(snapshot);
    if (Object.keys(parsed).length === 0) throw new Error();
    return parsed;
  } catch {
    throw new Error("Não foi possível ler o Doppler diaria-studio/dev; alarmes preservados. Verifique CLI, autenticação e acesso ao vault.");
  }
}

async function main(): Promise<number> {
  const findings = evaluateDopplerExpiries(readDopplerExpiries(), new Date());
  console.log(`[doppler-token-expiry-alarm] ${findings.map((f) => `${f.priority}: ${f.title}`).join(" | ") || "nada a alarmar"}`);
  const state = loadAlarmIssuesState(STATE);
  if (hasFlag(process.argv, "dry-run")) {
    console.log(`--dry-run: ${planAlarmReconciliation(findings, state, 1).map((a) => a.kind).join(", ") || "nenhuma ação"}; gh não chamado.`);
    return 0;
  }
  const result = applyAlarmReconciliation(findings, state, { cwd: ROOT, closeAfterRuns: 1 });
  saveAlarmIssuesState(result.nextState, STATE);
  return result.findingOutcomes.some((o) => o.action === "failed") ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: () => console.error("[doppler-token-expiry-alarm] Falha na execução; verifique Doppler e reconciliação de alarmes. Valores de secrets omitidos.") });
}
