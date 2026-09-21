/**
 * calibration-touch-minutes-report.ts (#7982, itens 2-3 — relatório MENSAL)
 *
 * Compara minutos totais de toque editorial (edição + sign-off) antes/depois
 * da ativação de cada fase de calibração e SINALIZA a fase pra revisão/
 * rollback se o total não caiu em N meses (default 3, `--months`). Só lê;
 * nunca reverte (decisão é do editor).
 *
 * Entradas (arquivos versionados/sincronizados em `data/`, mantidos pelo editor
 * — não existe medição automática de "minutos de toque" hoje, ver PR #7982):
 *  - `data/calibration/phases.json`: `[{ "name": "Fase 5", "activatedAt": "2026-09-01" }]`
 *  - `data/calibration/touch-minutes.jsonl`: uma linha por edição,
 *    `{"edition":"260901","editMinutes":22,"signoffMinutes":6}`
 *
 * DRY-RUN por padrão (imprime markdown). `--write` grava
 * `data/calibration-audit/touch-{YYYY-MM}.md` e registra na superfície de
 * Relatórios do Studio (kind `calibration-audit`, sem e-mail).
 *
 * Uso: npx tsx scripts/calibration-touch-minutes-report.ts [--months N] [--write]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  computeTouchByPhase,
  DEFAULT_STALL_MONTHS,
  flagStalledPhases,
  renderTouchMarkdown,
  type CalibrationPhase,
  type TouchSample,
} from "./lib/calibration-audit.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse tolerante de JSONL: linhas inválidas/sem os campos numéricos são descartadas e contadas. */
export function parseTouchJsonl(text: string): { samples: TouchSample[]; skipped: number } {
  const samples: TouchSample[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<TouchSample>;
      if (
        typeof o.edition === "string" &&
        typeof o.editMinutes === "number" &&
        typeof o.signoffMinutes === "number"
      ) {
        samples.push({ edition: o.edition, editMinutes: o.editMinutes, signoffMinutes: o.signoffMinutes });
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  return { samples, skipped };
}

/** Valida phases.json; devolve mensagem de erro ou a lista. */
export function validatePhases(raw: unknown): { phases: CalibrationPhase[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "phases.json deve ser um array de { name, activatedAt }" };
  const phases: CalibrationPhase[] = [];
  for (const [i, p] of raw.entries()) {
    const o = p as Partial<CalibrationPhase> | null;
    if (!o || typeof o.name !== "string" || !o.name) return { error: `phases.json[${i}]: name ausente` };
    if (typeof o.activatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.activatedAt) || Number.isNaN(Date.parse(`${o.activatedAt}T00:00:00Z`))) {
      return { error: `phases.json[${i}] (${o.name}): activatedAt deve ser YYYY-MM-DD válido` };
    }
    phases.push({ name: o.name, activatedAt: o.activatedAt });
  }
  return { phases };
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const months = values["months"] ? Number(values["months"]) : DEFAULT_STALL_MONTHS;
  if (!Number.isInteger(months) || months < 1) {
    console.error("--months deve ser inteiro >= 1");
    process.exit(2);
  }
  const phasesPath = resolve(ROOT, "data/calibration/phases.json");
  const touchPath = resolve(ROOT, "data/calibration/touch-minutes.jsonl");
  if (!existsSync(phasesPath) || !existsSync(touchPath)) {
    console.error(
      "[calibration-touch-minutes-report] entradas ausentes (data/calibration/phases.json e/ou touch-minutes.jsonl) — nada a reportar. Ver docstring do script.",
    );
    process.exit(0);
  }
  let rawPhases: unknown;
  try {
    rawPhases = JSON.parse(readFileSync(phasesPath, "utf-8"));
  } catch (e) {
    console.error(`[calibration-touch-minutes-report] phases.json ilegível: ${(e as Error).message}`);
    process.exit(2);
  }
  const v = validatePhases(rawPhases);
  if ("error" in v) {
    console.error(`[calibration-touch-minutes-report] ${v.error}`);
    process.exit(2);
  }
  const phases = v.phases;
  const { samples, skipped } = parseTouchJsonl(readFileSync(touchPath, "utf-8"));
  const now = new Date();
  const results = computeTouchByPhase(samples, phases, { months, now });
  let md = renderTouchMarkdown(results, { months, generatedAt: now.toISOString() });
  if (skipped) md += `\nAviso: ${skipped} linha(s) de touch-minutes.jsonl descartada(s) por formato inválido.\n`;

  if (!flags.has("write")) {
    process.stdout.write(md + "\n[dry-run] nada gravado nem registrado (use --write).\n");
    return;
  }
  const ym = now.toISOString().slice(0, 7);
  const rel = `data/calibration-audit/touch-${ym}.md`;
  mkdirSync(resolve(ROOT, "data/calibration-audit"), { recursive: true });
  writeFileSync(resolve(ROOT, rel), md, "utf-8");
  const stalled = flagStalledPhases(results).length;
  const r = registerReport(ROOT, {
    kind: "calibration-audit",
    sessionId: `touch-${ym}`,
    title: `Minutos de toque editorial ${ym} — ${stalled} fase(s) sinalizada(s)`,
    htmlPath: rel,
  });
  process.stdout.write(`${r.ok ? "registrado" : "falha ao registrar"}: ${rel}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[calibration-touch-minutes-report] erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
