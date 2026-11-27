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
 * Sem duplicar no mesmo dia: se o dispatch da Etapa 5 já rodou o `--apply`
 * hoje (dia BRT, marcador `data/brevo-diaria/.daily-apply.json`, ver
 * `scripts/lib/brevo-diaria-daily-apply.ts`), esta task não roda de novo.
 * Vale também ao contrário: o dispatch pula o `--apply` se esta task já rodou
 * no dia.
 *
 * Guardas que continuam valendo: o guard da task (`contacts.json` ausente ⇒
 * aborta antes de qualquer passo, `scheduled-tasks.ts`), e as do próprio
 * `brevo-diaria-run.ts --apply` (guard de custo MV sem `--confirm-mv`, cota da
 * conta, kill switches por passo em `platform.config.json`).
 *
 * Exit code: o do `brevo-diaria-run.ts --apply`; 0 quando pulou porque o
 * `--apply` do dia já rodou.
 *
 * Uso: npx tsx scripts/brevo-diaria-daily-apply.ts
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { brtDayKey } from "./lib/shared/brt.ts";
import {
  applyAlreadyRanToday,
  readDailyApplyMarker,
  writeDailyApplyMarker,
  type DailyApplyMarker,
} from "./lib/brevo-diaria-daily-apply.ts";
import { realExec, type ExecFn } from "./brevo-diaria-stage5-dispatch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DailyApplyDeps {
  exec: ExecFn;
  now: () => Date;
  readMarker: () => DailyApplyMarker | null;
  writeMarker: (m: DailyApplyMarker) => void;
  log: (msg: string) => void;
}

export interface DailyApplyResult {
  code: number;
  ran: boolean;
  reason: string;
}

export function runDailyApply(deps: DailyApplyDeps): DailyApplyResult {
  const today = brtDayKey(deps.now());
  const marker = deps.readMarker();
  if (applyAlreadyRanToday(marker, today)) {
    const reason = `--apply já rodou hoje (${today}) por ${marker!.by} às ${marker!.at} — não roda de novo (#13981).`;
    deps.log(reason);
    return { code: 0, ran: false, reason };
  }
  const r = deps.exec("scripts/brevo-diaria-run.ts", ["--apply"]);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code !== 0) {
    return { code: r.code, ran: true, reason: `brevo-diaria-run --apply saiu ${r.code} — marcador do dia não gravado.` };
  }
  try {
    deps.writeMarker({ day: today, at: deps.now().toISOString(), by: "task-05:30" });
  } catch (e) {
    // Fail-soft: sem marcador, o pior caso é o dispatch da Etapa 5 rodar o
    // --apply de novo hoje (idempotente).
    deps.log(`AVISO: marcador do --apply diário não gravado (${(e as Error).message}).`);
  }
  return { code: 0, ran: true, reason: `--apply rodou (${today}).` };
}

if (isMainModule(import.meta.url)) {
  const result = runDailyApply({
    exec: realExec(ROOT),
    now: () => new Date(),
    readMarker: () => readDailyApplyMarker(),
    writeMarker: (m) => writeDailyApplyMarker(m),
    log: (msg) => process.stderr.write(`[brevo-diaria daily-apply] ${msg}\n`),
  });
  process.stderr.write(`[brevo-diaria daily-apply] ${result.reason}\n`);
  process.exitCode = result.code;
}
