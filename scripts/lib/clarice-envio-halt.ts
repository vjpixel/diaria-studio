/**
 * clarice-envio-halt.ts (#10096)
 *
 * Parada DURÁVEL da rampa Clarice por fila insuficiente.
 *
 * A regra do editor (260811) é "fila insuficiente → PARAR, nunca enviar
 * volume menor que o proposto sem avisar". Até o #10096 a parada valia por
 * UMA rodada: a seguinte recalculava a base a partir do último dia com envio
 * e mandava um volume muito menor, sem aviso — exatamente o que a regra
 * proíbe (ciclo 2609-10: 40.180 → parou → 31 → 101).
 *
 * Agora, quando `clarice-envio-run.ts` para por fila insuficiente, grava
 * `data/clarice-envio-halt.json`. Enquanto o arquivo existir, toda rodada
 * agendada sai em "parada pendente" (relatório `-fila-insuficiente-pendente`,
 * sem tocar Brevo/MV) até o editor decidir explicitamente:
 *
 *   npx tsx scripts/lib/clarice-envio-halt.ts                       # mostra o estado
 *   npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason "..." # retoma a automação
 *
 * `--volume N` no caminho manual (`/diaria-clarice-envio`) também passa —
 * é número confirmado pelo editor — mas NÃO limpa a parada: a próxima rodada
 * AGENDADA continua pendente até o `--clear`. O envio manual é uma decisão
 * pontual; retomar a automação diária é outra.
 *
 * Distinto do kill switch (`clarice-envio-enabled.ts`): o kill switch é a
 * intenção do editor ("rampa ligada/pausada"); a parada é um FATO que a
 * automação encontrou e que espera resposta. Arquivos separados pra um nunca
 * apagar o outro.
 *
 * Leitura fail-SAFE: arquivo presente mas ilegível conta como PARADA ATIVA
 * (`halted: true`, `invalid: true`) — sinal de problema numa trava de envio
 * real nunca vira "pode enviar".
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";
import { getMachineId } from "./machine-id.ts";
import { logEvent } from "./run-log.ts";

export interface ClariceEnvioHalt {
  /** Motivo estruturado. Hoje só `fila-insuficiente`. */
  kind: "fila-insuficiente";
  /** ISO — quando a rodada parou. */
  since: string;
  /** `envio-{aammdd}` da rodada que parou. */
  reportId: string;
  cycle: string;
  queueAvailable: number;
  desiredVolume: number;
  baseVolume: number;
}

export type ClariceEnvioHaltRead =
  | { halted: false }
  | { halted: true; invalid: false; halt: ClariceEnvioHalt }
  | { halted: true; invalid: true; error: string };

export function clariceEnvioHaltPath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-halt.json");
}

function isHalt(v: unknown): v is ClariceEnvioHalt {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "fila-insuficiente" &&
    typeof o.since === "string" &&
    typeof o.reportId === "string" &&
    typeof o.cycle === "string" &&
    typeof o.queueAvailable === "number" &&
    typeof o.desiredVolume === "number" &&
    typeof o.baseVolume === "number"
  );
}

export function readClariceEnvioHalt(rootDir: string): ClariceEnvioHaltRead {
  const p = clariceEnvioHaltPath(rootDir);
  if (!existsSync(p)) return { halted: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!isHalt(raw)) return { halted: true, invalid: true, error: "shape inesperado" };
    return { halted: true, invalid: false, halt: raw };
  } catch (e) {
    return { halted: true, invalid: true, error: (e as Error).message };
  }
}

/** Grava a parada. Propaga erro de escrita — perder a parada em silêncio
 * reabriria o #10096. */
export function writeClariceEnvioHalt(rootDir: string, halt: ClariceEnvioHalt): void {
  const p = clariceEnvioHaltPath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(halt, null, 2) + "\n", "utf8");
}

/** Limpa a parada (decisão do editor). Devolve `false` se não havia parada. */
export function clearClariceEnvioHalt(
  rootDir: string,
  reason: string,
  opts: { now?: () => Date; machine?: string; logRunEvent?: boolean } = {},
): boolean {
  const p = clariceEnvioHaltPath(rootDir);
  if (!existsSync(p)) return false;
  const before = readClariceEnvioHalt(rootDir);
  rmSync(p, { force: true });
  if (opts.logRunEvent !== false) {
    logEvent(
      {
        edition: null,
        stage: null,
        agent: "clarice-envio-halt",
        level: "info",
        message: `parada da rampa Clarice limpa pelo editor (motivo: ${reason})`,
        details: {
          clearedAt: (opts.now ?? (() => new Date()))().toISOString(),
          machine: opts.machine ?? (getMachineId() || null),
          sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
          reason,
          halt: before.halted && !before.invalid ? before.halt : null,
        },
      },
      rootDir,
    );
  }
  return true;
}

/** Texto do relatório de uma rodada que encontrou a parada ativa. Puro. */
export function describeHaltForReport(read: Exclude<ClariceEnvioHaltRead, { halted: false }>, currentCycle: string | null): string {
  const clearCmd = 'npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason "..."';
  if (read.invalid) {
    return (
      `🛑 parada da rampa ATIVA, mas data/clarice-envio-halt.json está ilegível (${read.error}) — tratando como parada (lado seguro). ` +
      `Confira o arquivo e, decidido retomar, rode \`${clearCmd}\`.`
    );
  }
  const h = read.halt;
  const cycleNote =
    currentCycle && currentCycle !== h.cycle
      ? ` O ciclo mudou desde a parada (${h.cycle} → ${currentCycle}) — a fila do ciclo novo provavelmente já comporta o volume; confira e libere.`
      : "";
  return (
    `🛑 rampa PARADA desde ${h.since} (${h.reportId}): fila insuficiente no ciclo ${h.cycle} ` +
    `(disponível ${h.queueAvailable}, desejado ${h.desiredVolume}, base ${h.baseVolume}). ` +
    `A parada da regra 260811 é durável (#10096): nenhuma rodada agendada envia até decisão explícita do editor.${cycleNote} ` +
    `Pra retomar: \`${clearCmd}\`; pra um envio pontual com volume confirmado: /diaria-clarice-envio com --volume N.`
  );
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (flags.has("clear") || "clear" in values) {
    const reason = (values.reason ?? "").trim();
    if (!reason) {
      console.error('[clarice-envio-halt] --clear exige --reason "..." (decisão do editor que libera a rampa).');
      process.exitCode = 2;
    } else {
      console.log(clearClariceEnvioHalt(root, reason) ? "cleared" : "no-halt");
    }
  } else {
    const read = readClariceEnvioHalt(root);
    console.log(read.halted ? JSON.stringify(read, null, 2) : "no-halt");
  }
}
