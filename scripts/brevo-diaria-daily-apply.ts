#!/usr/bin/env node
/**
 * brevo-diaria-daily-apply.ts (#13981)
 *
 * Passo da task `Diaria-Brevo-Diaria-Evaluate` (05:30 BRT, todo dia): roda o
 * `brevo-diaria-run.ts --apply` (mesmos argumentos que o dispatch da Etapa 5
 * usa), que começa pelo `evaluate-brevo-diaria.ts --push` que esta task rodava
 * sozinha antes e segue com o refresh do pool Pending, MV, sync Brevo, pool
 * Kit inactive, `sync-kit-frio --push` e órfãos da `envio-brevo`.
 *
 * Por que aqui: desde o #13981 o dispatch da Etapa 5 sai `skipped` fora da
 * segunda (regime semanal #11226) sem rodar o `--apply`. Sem esta task, o
 * `--apply` passaria a rodar só uma vez por semana, e quem volta a abrir
 * ficaria até uma semana com a tag `frio` no Kit (decisão do editor de
 * 27/11/2026 na #13981: o `--apply` segue diário, aqui).
 *
 * Sem duplicar: se o dispatch da Etapa 5 já rodou o `--apply` hoje (dia BRT,
 * marcador `data/brevo-diaria/.daily-apply.json`, ver
 * `scripts/lib/brevo-diaria-daily-apply.ts`), esta task não roda de novo. O
 * dispatch, nas edições com campanha, roda sempre (não lê o marcador para
 * pular). Ler marcador → `--apply` → gravar marcador corre dentro do lock do
 * marcador (mesma máquina; entre máquinas não protege).
 *
 * Kill switches do canal, lidos do `platform.config.json` antes de qualquer
 * passo (os mesmos que fazem a Etapa 5 pular o canal): `brevo_diaria`
 * ausente, ou `brevo_diaria.stage5_target_total` null/inválido ⇒ sai 0 sem
 * rodar nada, com log. Além delas: o guard da task (`contacts.json` ausente ⇒
 * aborta antes, `scheduled-tasks.ts`) e as do próprio `brevo-diaria-run.ts
 * --apply` (guard de custo MV sem `--confirm-mv`, cota da conta, flags por
 * passo).
 *
 * Exit code:
 *   0 — `--apply` sem aviso, ou pulou (marcador do dia, kill switch);
 *   3 (`DAILY_APPLY_WARNINGS_EXIT_CODE`) — `--apply` terminou (store escrito,
 *       marcador gravado) mas com aviso fail-soft: exit 3 do evaluate
 *       (contatos com falha/skip), pool Kit, `sync-kit-frio`, órfãos, ou
 *       marcador não gravado. Dentro do `--apply` esses avisos saem 0; aqui
 *       viram ≠ 0 para a unit ficar vermelha e o alarme de units falhas ver;
 *   outro ≠ 0 — o do `brevo-diaria-run.ts --apply` (erro duro, sem marcador).
 *
 * Uso: npx tsx scripts/brevo-diaria-daily-apply.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { brtDayKey } from "./lib/shared/brt.ts";
import {
  applyAlreadyRanToday,
  readDailyApplyMarker,
  withDailyApplyLock,
  writeDailyApplyMarker,
  type DailyApplyMarker,
} from "./lib/brevo-diaria-daily-apply.ts";
import { extractRunWarnings, realExec, type ExecFn } from "./brevo-diaria-stage5-dispatch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesmo valor do `PARTIAL_FAILURE_EXIT_CODE` do evaluate: rodou, mas com aviso. */
export const DAILY_APPLY_WARNINGS_EXIT_CODE = 3;

export interface DailyApplyDeps {
  exec: ExecFn;
  now: () => Date;
  readMarker: () => DailyApplyMarker | null;
  writeMarker: (m: DailyApplyMarker) => void;
  readPlatformConfig: () => { brevo_diaria?: { stage5_target_total?: number | null } };
  /** Lock do marcador; default sem lock (testes). */
  withLock?: <T>(fn: () => T) => T;
  log: (msg: string) => void;
}

export interface DailyApplyResult {
  code: number;
  ran: boolean;
  reason: string;
  warnings: string[];
}

/** Pura: o canal está desligado? Devolve o motivo, ou `null` se ligado. */
export function dailyApplyKillSwitch(config: { brevo_diaria?: { stage5_target_total?: number | null } }): string | null {
  const bd = config.brevo_diaria;
  if (!bd) return "brevo_diaria ausente em platform.config.json — canal desligado, --apply não roda.";
  const t = bd.stage5_target_total;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
    return "brevo_diaria.stage5_target_total null/inválido — canal desligado (mesmo kill switch da Etapa 5), --apply não roda.";
  }
  return null;
}

export function runDailyApply(deps: DailyApplyDeps): DailyApplyResult {
  const killed = dailyApplyKillSwitch(deps.readPlatformConfig());
  if (killed) {
    deps.log(killed);
    return { code: 0, ran: false, reason: killed, warnings: [] };
  }
  const lock = deps.withLock ?? (<T>(fn: () => T) => fn());
  return lock((): DailyApplyResult => {
    const today = brtDayKey(deps.now());
    const marker = deps.readMarker();
    if (applyAlreadyRanToday(marker, today)) {
      const reason = `--apply já rodou hoje (${today}) por ${marker!.by} às ${marker!.at} — não roda de novo (#13981).`;
      deps.log(reason);
      return { code: 0, ran: false, reason, warnings: [] };
    }
    const r = deps.exec("scripts/brevo-diaria-run.ts", ["--apply"]);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code !== 0) {
      return { code: r.code, ran: true, reason: `brevo-diaria-run --apply saiu ${r.code} — marcador do dia não gravado.`, warnings: [] };
    }
    const warnings = extractRunWarnings(r.stdout);
    try {
      deps.writeMarker({ day: today, at: deps.now().toISOString(), by: "task-05:30", warnings: [...warnings] });
    } catch (e) {
      // O --apply rodou; sem marcador o pior caso é rodar de novo hoje (idempotente).
      warnings.push(`marcador do --apply diário não gravado (${(e as Error).message}), #13981.`);
    }
    for (const w of warnings) deps.log(`AVISO: ${w}`);
    return warnings.length > 0
      ? { code: DAILY_APPLY_WARNINGS_EXIT_CODE, ran: true, reason: `--apply rodou (${today}) com ${warnings.length} aviso(s).`, warnings }
      : { code: 0, ran: true, reason: `--apply rodou (${today}).`, warnings };
  });
}

if (isMainModule(import.meta.url)) {
  const result = runDailyApply({
    exec: realExec(ROOT),
    now: () => new Date(),
    readMarker: () => readDailyApplyMarker(),
    writeMarker: (m) => writeDailyApplyMarker(m),
    readPlatformConfig: () => JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")),
    withLock: (fn) => withDailyApplyLock(fn),
    log: (msg) => process.stderr.write(`[brevo-diaria daily-apply] ${msg}\n`),
  });
  process.stderr.write(`[brevo-diaria daily-apply] ${result.reason}\n`);
  process.exitCode = result.code;
}
