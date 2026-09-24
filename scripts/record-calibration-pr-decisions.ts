#!/usr/bin/env npx tsx
/**
 * record-calibration-pr-decisions.ts (#7982, item 3 — produtor de
 * decisionAt/estimatedReviewMinutes)
 *
 * `renderLatencyMarkdown` (`scripts/lib/calibration-audit.ts`), consumido
 * pelo relatório TRIMESTRAL de `calibration-allowlist-growth-report.ts`, sai
 * sempre `n/d` na seção de latência porque nada grava `decisionAt`/
 * `estimatedReviewMinutes` nas entradas `kind: "calibration"` de
 * `data/reports/index.jsonl` — este script é esse produtor.
 *
 * Varre as entradas `kind: "calibration"` sem `decisionAt`, consulta o
 * estado real da PR correspondente (`sessionId` = número da PR) via `gh pr
 * view --json state,mergedAt`, e — só para PRs MERGEADAS — faz upsert da
 * mesma entrada acrescentando `decisionAt` (= `mergedAt`) e
 * `estimatedReviewMinutes` (minutos entre `createdAt` e o merge). PR aberta,
 * fechada sem merge, ou não encontrada: sem update (nunca inventa dado).
 * Entrada que já tem `decisionAt` nunca é recalculada — "primeira decisão
 * vence" (mesma convenção de `derive-touch-minutes.ts`: decisão já
 * registrada é histórico).
 *
 * Somente leitura por padrão (DRY-RUN, imprime as atualizações). `--write`
 * faz o upsert de verdade via `registerReport` (preserva `title`/`htmlPath`/
 * `kind`/`sessionId`/`createdAt` da entrada existente).
 *
 * Fail-soft: `gh` indisponível ou saída inesperada para uma PR específica
 * só pula aquela entrada (mesma disciplina de
 * `check-revert-calibration-prs.ts`) — nunca aborta o script inteiro.
 *
 * Uso: npx tsx scripts/record-calibration-pr-decisions.ts [--write] [--json]
 */
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { computeCalibrationDecisionUpdates, type CalibrationPrState } from "./lib/calibration-audit.ts";
import { listReports, registerReport, getReportById, reportId } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(import.meta.dirname, "..");

interface GhPrViewResult {
  state: string;
  mergedAt: string | null;
}

/** Consulta `gh pr view {n}` — `null` se `gh` falhar/saída ilegível (sinal fraco, nunca trava). */
export function fetchPrState(prNumber: string): CalibrationPrState | null {
  const result = spawnSync("gh", ["pr", "view", prNumber, "--json", "state,mergedAt"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as GhPrViewResult;
    const merged = parsed.state === "MERGED";
    return { merged, mergedAt: merged ? (parsed.mergedAt ?? null) : null };
  } catch {
    return null;
  }
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const write = flags.has("write");
  const asJson = flags.has("json");

  const calibrationEntries = listReports(ROOT).filter((r) => r.kind === "calibration");
  const pending = calibrationEntries.filter((e) => !e.decisionAt);

  const prStates = new Map<string, CalibrationPrState>();
  for (const e of pending) {
    const st = fetchPrState(e.sessionId);
    if (st) prStates.set(e.sessionId, st);
  }

  const updates = computeCalibrationDecisionUpdates(pending, prStates);

  if (asJson) {
    console.log(JSON.stringify({ pending: pending.length, updates }, null, 2));
  } else {
    console.log(`entradas "calibration" sem decisionAt: ${pending.length}; atualizáveis agora: ${updates.length}`);
    for (const u of updates) {
      console.log(`  #${u.sessionId}: decisionAt=${u.decisionAt} estimatedReviewMinutes=${u.estimatedReviewMinutes}`);
    }
  }

  if (!write || updates.length === 0) {
    if (!write) console.log("(dry-run — passe --write para gravar)");
    return;
  }

  for (const u of updates) {
    const id = reportId("calibration", u.sessionId);
    const existing = getReportById(ROOT, id);
    if (!existing) continue; // corrida rara: entrada removida entre listReports e agora
    registerReport(ROOT, {
      kind: "calibration",
      sessionId: existing.sessionId,
      title: existing.title,
      htmlPath: existing.htmlPath,
      createdAt: existing.createdAt,
      decisionAt: u.decisionAt,
      estimatedReviewMinutes: u.estimatedReviewMinutes,
    });
  }
  console.log(`gravado(s) ${updates.length} update(s) em data/reports/index.jsonl`);
}

if (isMainModule(import.meta.url)) main();
