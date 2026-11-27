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
 * Sem duplicar: se o dispatch da Etapa 5 já rodou o `--apply` hoje sem aviso
 * (dia BRT, marcador `data/brevo-diaria/.daily-apply.json`, ver
 * `scripts/lib/brevo-diaria-daily-apply.ts`), esta task não roda de novo.
 * Marcador do dia COM aviso ⇒ roda de novo. O dispatch, nas edições com
 * campanha, roda sempre (não lê o marcador para pular). Ler marcador →
 * `--apply` → gravar marcador corre dentro de um lock LOCAL da máquina
 * (`os.tmpdir()`; entre máquinas não protege).
 *
 * Kill switch do canal: `brevo_diaria` ausente, ou
 * `brevo_diaria.stage5_target_total: null` explícito (o desligamento que
 * também faz a Etapa 5 pular o canal) ⇒ roda só `evaluate-brevo-diaria.ts
 * --push`, o comportamento anterior ao #13981 (descadastros nativos,
 * supressões, órfãos seguem diários), sem o resto do `--apply`. Valor
 * presente e inválido (string, NaN, negativo, chave ausente) ⇒ exit 1 com o
 * motivo, sem rodar nada: config quebrada não é desligamento. Além disso: o
 * guard da task (`contacts.json` ausente ⇒ aborta antes, `scheduled-tasks.ts`)
 * e as guardas do próprio `--apply` (custo MV sem `--confirm-mv`, cota da
 * conta, flags por passo).
 *
 * Exit code:
 *   0   — `--apply` sem aviso; ou pulou (marcador do dia sem aviso); ou, no
 *         kill switch, o evaluate saiu 0;
 *   3   — `DAILY_APPLY_WARNINGS_EXIT_CODE`: o `--apply` terminou (store
 *         escrito, marcador gravado) mas com aviso fail-soft (exit 3 do
 *         evaluate, pool Kit, `sync-kit-frio`, órfãos, stdout sem JSON,
 *         marcador não gravado). Dentro do `--apply` esses avisos saem 0;
 *         aqui viram ≠ 0 para a unit ficar vermelha. No kill switch, é o
 *         exit 3 do próprio evaluate, propagado;
 *   105 — `TRANSIENT_NETWORK_EXIT_CODE`: o `--apply` (ou o evaluate do kill
 *         switch, salvo o exit 3 dele) saiu ≠ 0 com assinatura de falha de rede na saída; a task
 *         declara `retryOnTransientNetwork: "step-declares"` e a unit tenta
 *         de novo em 15 min (o `--apply` é idempotente, e sem marcador
 *         gravado a nova rodada roda). Assinatura de rede de um passo
 *         fail-soft junto com uma falha dura de outro motivo também cai
 *         aqui: o custo é uma rerrodada idempotente a mais;
 *   1   — config inválida, lock do `--apply` diário que não saiu, ou o
 *         código do `--apply` com erro duro (qualquer outro ≠ 0 é repassado).
 *
 * Uso: npx tsx scripts/brevo-diaria-daily-apply.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { brtDayKey } from "./lib/shared/brt.ts";
import { isValidStage5TargetTotal } from "./lib/brevo-diaria-max-add.ts";
import { hasTransientNetworkSignature, TRANSIENT_NETWORK_EXIT_CODE } from "./lib/transient-network-failure.ts";
import {
  applyAlreadyRanToday,
  DAILY_APPLY_TASK_LOCK_TIMEOUT_MS,
  readDailyApplyMarker,
  withDailyApplyLock,
  writeDailyApplyMarker,
  type DailyApplyMarker,
} from "./lib/brevo-diaria-daily-apply.ts";
import { extractRunWarnings, realExec, type ExecFn, type ExecResult } from "./brevo-diaria-stage5-dispatch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Mesmo valor do `PARTIAL_FAILURE_EXIT_CODE` do evaluate: rodou, mas com aviso. */
export const DAILY_APPLY_WARNINGS_EXIT_CODE = 3;

export interface DailyApplyDeps {
  exec: ExecFn;
  now: () => Date;
  readMarker: () => DailyApplyMarker | null;
  writeMarker: (m: DailyApplyMarker) => void;
  readPlatformConfig: () => { brevo_diaria?: { stage5_target_total?: unknown } };
  /** Lock do `--apply` diário; default sem lock (testes). */
  withLock?: <T>(fn: () => T) => T;
  log: (msg: string) => void;
}

export interface DailyApplyResult {
  code: number;
  /** O que rodou: `apply` (o `--apply`), `evaluate-only` (kill switch) ou `none`. */
  ran: "apply" | "evaluate-only" | "none";
  reason: string;
  warnings: string[];
  /** Presente quando a falha foi o lock (`daily-apply-lock`) ou a config (`config`). */
  step?: "daily-apply-lock" | "config";
}

export type DailyApplyMode = { mode: "apply" } | { mode: "evaluate-only"; reason: string } | { mode: "invalid"; reason: string };

/** Pura: decide o modo pelo `platform.config.json`. Só `null` explícito desliga. */
export function resolveDailyApplyMode(config: { brevo_diaria?: { stage5_target_total?: unknown } }): DailyApplyMode {
  const bd = config.brevo_diaria;
  if (!bd) return { mode: "evaluate-only", reason: "brevo_diaria ausente em platform.config.json — canal desligado, só o evaluate --push roda." };
  const t = bd.stage5_target_total;
  if (t === null) {
    return { mode: "evaluate-only", reason: "brevo_diaria.stage5_target_total: null — canal desligado (mesmo kill switch da Etapa 5), só o evaluate --push roda." };
  }
  if (!isValidStage5TargetTotal(t)) {
    return { mode: "invalid", reason: `brevo_diaria.stage5_target_total inválido (${JSON.stringify(t) ?? String(t)}) — esperado número ≥ 0, ou null para desligar; nada rodou.` };
  }
  return { mode: "apply" };
}

/** Pura: ≠ 0 com assinatura de rede vira 105 (retry da unit); o resto passa. */
export function resolveFailureExitCode(r: ExecResult): number {
  return hasTransientNetworkSignature(`${r.stderr}\n${r.stdout}`) ? TRANSIENT_NETWORK_EXIT_CODE : r.code;
}

function echo(r: ExecResult): void {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
}

export function runDailyApply(deps: DailyApplyDeps): DailyApplyResult {
  const mode = resolveDailyApplyMode(deps.readPlatformConfig());
  if (mode.mode === "invalid") {
    deps.log(`ERRO: ${mode.reason}`);
    return { code: 1, ran: "none", reason: mode.reason, warnings: [], step: "config" };
  }
  if (mode.mode === "evaluate-only") {
    deps.log(mode.reason);
    const r = deps.exec("scripts/evaluate-brevo-diaria.ts", ["--push"]);
    echo(r);
    // 3 = avaliação terminou com falha por contato (store escrito): propaga
    // como 3, nunca 105 (não é rodada a repetir).
    const code = r.code === 0 || r.code === DAILY_APPLY_WARNINGS_EXIT_CODE ? r.code : resolveFailureExitCode(r);
    return { code, ran: "evaluate-only", reason: `${mode.reason} evaluate saiu ${r.code}.`, warnings: [] };
  }
  const lock = deps.withLock ?? (<T>(fn: () => T) => fn());
  try {
    return lock((): DailyApplyResult => {
      const today = brtDayKey(deps.now());
      const marker = deps.readMarker();
      if (applyAlreadyRanToday(marker, today) && marker.warnings.length === 0) {
        const reason = `--apply já rodou hoje (${today}) por ${marker.by} às ${marker.at}, sem aviso — não roda de novo (#13981).`;
        deps.log(reason);
        return { code: 0, ran: "none", reason, warnings: [] };
      }
      const r = deps.exec("scripts/brevo-diaria-run.ts", ["--apply"]);
      echo(r);
      if (r.code !== 0) {
        return { code: resolveFailureExitCode(r), ran: "apply", reason: `brevo-diaria-run --apply saiu ${r.code} — marcador do dia não gravado.`, warnings: [] };
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
        ? { code: DAILY_APPLY_WARNINGS_EXIT_CODE, ran: "apply", reason: `--apply rodou (${today}) com ${warnings.length} aviso(s).`, warnings }
        : { code: 0, ran: "apply", reason: `--apply rodou (${today}).`, warnings };
    });
  } catch (e) {
    // Só a aquisição/liberação do lock chega aqui: o corpo não lança (exec
    // devolve código, writeMarker tem try próprio). Lock preso por outro
    // --apply desta máquina por mais que o teto, ou erro de disco no tmpdir.
    const reason = `daily-apply-lock: lock do --apply diário não saiu (${(e as Error).message}); nada rodou.`;
    deps.log(`ERRO: ${reason}`);
    return { code: 1, ran: "none", reason, warnings: [], step: "daily-apply-lock" };
  }
}

if (isMainModule(import.meta.url)) {
  const result = runDailyApply({
    exec: realExec(ROOT),
    now: () => new Date(),
    readMarker: () => readDailyApplyMarker(),
    writeMarker: (m) => writeDailyApplyMarker(m),
    readPlatformConfig: () => JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")),
    withLock: (fn) => withDailyApplyLock(fn, DAILY_APPLY_TASK_LOCK_TIMEOUT_MS),
    log: (msg) => process.stderr.write(`[brevo-diaria daily-apply] ${msg}\n`),
  });
  process.stderr.write(`[brevo-diaria daily-apply] ${result.reason}\n`);
  process.exitCode = result.code;
}
