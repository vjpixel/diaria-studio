#!/usr/bin/env node
/**
 * scripts/check-kit-worker-custom-fields.ts (#9663)
 *
 * Confere que todo `KIT_*_FIELD = "{key}"` de `workers/*\/wrangler.toml`
 * existe como custom field na conta Kit. O Kit v4 descarta em silêncio as
 * chaves de `fields` desconhecidas (2xx sem gravar) — sem este guard, um
 * worker apontando pra field inexistente perde o dado sem nenhum sinal (foi o
 * caso de `KIT_CONFIRMOU_VIA_FIELD = "confirmou_via"` no worker `reativar`,
 * #9663). Lógica pura em `scripts/lib/kit-worker-custom-fields-guard.ts`.
 *
 * Armado via `check-brevo-diaria-guardrail.ts` (task agendada de 4 em 4h),
 * que chama `runKitWorkerFieldsGuard` com o mesmo alarme. Este CLI é a forma
 * avulsa (diagnóstico manual / pós-deploy de worker).
 *
 * Só LÊ do Kit (`GET /v4/custom_fields`). Nunca cria field.
 *
 * Uso:
 *   npx tsx scripts/check-kit-worker-custom-fields.ts            # checa + alarma (issue via notifyEditor) se faltar
 *   npx tsx scripts/check-kit-worker-custom-fields.ts --dry-run  # checa + imprime, sem alarme
 *
 * Exit: 0 = tudo existe; 1 = leitura do Kit falhou; 2 = field(s) ausente(s).
 * Env: `KIT_API_KEY`.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { kitFetch } from "./lib/kit-client.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import {
  checkKitWorkerCustomFields,
  runKitWorkerFieldsGuard,
  buildMissingKitFieldsAlarmBody,
  missingFieldsFingerprint,
  type WorkerKitFieldVar,
} from "./lib/kit-worker-custom-fields-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKERS_DIR = resolve(ROOT, "workers");

/** Alarme compartilhado com `check-brevo-diaria-guardrail.ts`. */
export async function alarmMissingKitWorkerFields(missing: WorkerKitFieldVar[]): Promise<void> {
  const keys = [...new Set(missing.map((m) => m.fieldKey))];
  const result = await notifyEditor(
    {
      check: "check-kit-worker-custom-fields",
      fingerprint: missingFieldsFingerprint(missing),
      severity: "acao",
      priority: "P1",
      subject: `[diar.ia.br] Worker grava em custom field inexistente no Kit (${keys.join(", ")}) — dado perdido em silêncio`,
      body: buildMissingKitFieldsAlarmBody(missing, new Date().toISOString()),
    },
    { cwd: ROOT },
  );
  if (result.issue?.action === "failed") throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
}

/** Alarme do guard desarmado por config (review #9665) — fingerprint estável, 1 issue só. */
export async function alarmKitWorkerFieldsGuardDisarmed(reason: string): Promise<void> {
  const result = await notifyEditor(
    {
      check: "check-kit-worker-custom-fields-disarmed",
      fingerprint: "disarmed:config",
      severity: "acao",
      priority: "P2",
      subject: "[diar.ia.br] Guard de custom fields do Kit (#9663) desarmado — config ausente ou key rejeitada",
      body: [
        `O guard que confere os KIT_*_FIELD dos workers contra o Kit não roda: ${reason}.`,
        "",
        "Enquanto isso, um worker gravando em custom field inexistente perde o dado em silêncio (#9663).",
        "Correção: disponibilizar uma KIT_API_KEY válida no ambiente da task `check-brevo-diaria-guardrail` (Doppler/.env) — ausente, ou revogada/sem permissão (401/403, #9670).",
        "",
        `(alarme automático — ${new Date().toISOString()})`,
      ].join("\n"),
    },
    { cwd: ROOT },
  );
  if (result.issue?.action === "failed") throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
}

/** Puro — motivo de config que desarma o guard, ou `null`. */
export function kitWorkerFieldsGuardPreflight(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.KIT_API_KEY?.trim() ? null : "KIT_API_KEY ausente no ambiente";
}

/** Deps de produção do guard — reusado pelo `check-brevo-diaria-guardrail.ts`. */
export function kitWorkerFieldsGuardProdDeps(isDryRun: boolean, log: (msg: string) => void) {
  return {
    check: () => checkKitWorkerCustomFields({ workersDir: WORKERS_DIR, kitGet: (p: string) => kitFetch(p) }),
    alarm: alarmMissingKitWorkerFields,
    preflight: () => kitWorkerFieldsGuardPreflight(),
    alarmDisarmed: alarmKitWorkerFieldsGuardDisarmed,
    isDryRun,
    log,
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const isDryRun = hasFlag(process.argv.slice(2), "dry-run");
  const log = (msg: string) => process.stderr.write(`[check-kit-worker-custom-fields] ${msg}\n`);
  const missing = await runKitWorkerFieldsGuard(kitWorkerFieldsGuardProdDeps(isDryRun, log));
  if (missing === null) process.exitCode = 1;
  else if (missing > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[check-kit-worker-custom-fields] erro:", e);
    process.exitCode = 1;
  });
}
