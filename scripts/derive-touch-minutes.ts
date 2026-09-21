#!/usr/bin/env npx tsx
/**
 * derive-touch-minutes.ts (#7982) — deriva os "minutos de toque editorial"
 * por edição a partir do run-log e alimenta `data/calibration/touch-minutes.jsonl`
 * (fonte de `calibration-touch-minutes-report.ts`).
 *
 * Fonte: eventos do Stage 4 emitidos pelo orchestrator —
 *   "gate revisao: apresentado"        (a cada apresentação do resumo)
 *   "gate revisao response: <resp>"    (sim | editar | ajustar | abortar)
 * Regra (determinística, sobre a ÚLTIMA aprovação `sim` da edição):
 *   - início = 1ª apresentação; fim = `sim`.
 *   - âncora = último evento (apresentado/resposta não-sim) antes do `sim`.
 *   - âncora é uma apresentação: signoffMinutes = sim - âncora (o editor só
 *     olhou e aprovou); editMinutes = âncora - início.
 *   - âncora é `ajustar`/`editar` sem re-apresentação: signoffMinutes = 0,
 *     editMinutes = sim - início (tudo foi toque de edição).
 * Edição sem apresentação+sim (ex.: aprovada via painel #6444) é ignorada:
 * sem dado, nunca inventar zero.
 *
 * DRY-RUN por padrão (imprime as linhas). `--write` faz append em
 * `data/calibration/touch-minutes.jsonl`, sem duplicar edição já presente.
 *
 * Uso: npx tsx scripts/derive-touch-minutes.ts [--edition AAMMDD] [--root-dir X] [--write]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { resolveRunLogPath } from "./lib/run-log.ts";
import { readRunLog } from "./report-stage4-timing.ts";
import type { RunLogEntry } from "./lib/stage4-timing-report.ts";
import type { TouchSample } from "./lib/calibration-audit.ts";

const PRESENTED = "gate revisao: apresentado";
const RESPONSE_RE = /^gate revisao response:\s*(sim|editar|ajustar|abortar)\b/i;

const toMinutes = (ms: number): number => Math.round((ms / 60000) * 10) / 10;

/** Deriva uma amostra por edição. Puro. */
export function deriveTouchSamples(entries: readonly RunLogEntry[]): TouchSample[] {
  const byEdition = new Map<string, { t: number; kind: string }[]>();
  for (const e of entries) {
    if (e.stage !== 4 || !e.edition || !e.timestamp || typeof e.message !== "string") continue;
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    let kind: string | null = null;
    if (e.message === PRESENTED) kind = "presented";
    else {
      const m = RESPONSE_RE.exec(e.message);
      if (m) kind = m[1].toLowerCase();
    }
    if (!kind) continue;
    const list = byEdition.get(e.edition) ?? [];
    list.push({ t, kind });
    byEdition.set(e.edition, list);
  }
  const out: TouchSample[] = [];
  for (const [edition, evs] of byEdition) {
    evs.sort((a, b) => a.t - b.t);
    let simIdx = -1;
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].kind === "sim") {
        simIdx = i;
        break;
      }
    }
    if (simIdx < 0) continue;
    const before = evs.slice(0, simIdx);
    // Recomeça após um abortar anterior (rodada descartada).
    let start = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i].kind === "abortar") {
        start = i + 1;
        break;
      }
    }
    const window = before.slice(start);
    const first = window.find((x) => x.kind === "presented");
    if (!first) continue;
    const sim = evs[simIdx];
    const anchor = window[window.length - 1];
    const signoff = anchor.kind === "presented" ? sim.t - anchor.t : 0;
    const edit = sim.t - first.t - signoff;
    out.push({ edition, editMinutes: toMinutes(edit), signoffMinutes: toMinutes(signoff) });
  }
  return out.sort((a, b) => a.edition.localeCompare(b.edition));
}

/** Edições já presentes no JSONL (linhas inválidas ignoradas). */
export function existingEditions(text: string): Set<string> {
  const s = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { edition?: unknown };
      if (typeof o.edition === "string") s.add(o.edition);
    } catch {
      // ignora
    }
  }
  return s;
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const root = values["root-dir"] ?? process.cwd();
  const only = values["edition"];
  const outPath = resolve(root, "data/calibration/touch-minutes.jsonl");
  let samples = deriveTouchSamples(readRunLog(resolveRunLogPath(root)));
  if (only) samples = samples.filter((s) => s.edition === only);
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  const have = existingEditions(existing);
  const fresh = samples.filter((s) => !have.has(s.edition));
  console.log(`derivadas: ${samples.length}, novas: ${fresh.length}, já presentes: ${samples.length - fresh.length}`);
  for (const s of fresh) console.log(JSON.stringify(s));
  if (!flags.has("write")) {
    console.log("(dry-run — passe --write para gravar)");
    return;
  }
  if (fresh.length === 0) return;
  mkdirSync(dirname(outPath), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(outPath, prefix + fresh.map((s) => JSON.stringify(s)).join("\n") + "\n");
  console.log(`gravado em ${outPath}`);
}

if (isMainModule(import.meta.url)) main();
