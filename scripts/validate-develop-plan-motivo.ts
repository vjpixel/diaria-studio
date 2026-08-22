#!/usr/bin/env npx tsx
/**
 * validate-develop-plan-motivo.ts (#5708)
 *
 * CLI para o gate de "motivo fora do vocabulário fechado" — ver
 * `scripts/lib/develop-plan-motivo.ts` para a lógica pura/documentação
 * completa do mecanismo. Este arquivo é só o ponto de entrada de linha de
 * comando, seguindo o mesmo padrão de `scripts/check-state-changed-pending.ts`.
 *
 * Roda na Fase 2 de `.claude/skills/diaria-develop/SKILL.md`, junto do gate
 * de re-triagem pendente do #5476 — antes de escrever o relatório final da
 * sessão. `exit 1` = pelo menos uma issue `pulada` tem `motivo` fora do
 * vocabulário fechado (ou ausente) — a sessão deveria reclassificar essa(s)
 * issue(s) num motivo real (ou rodar as 4 checagens do #5383/#5392, se o que
 * está por trás do rótulo inventado é uma classificação de bloqueio não
 * verificada) antes de fechar o relatório.
 *
 * Uso:
 *   npx tsx scripts/validate-develop-plan-motivo.ts --plan data/develop/260819/plan.json
 *
 * @see scripts/lib/develop-plan-motivo.ts
 * @see scripts/check-state-changed-pending.ts (padrão de estilo)
 * @see .claude/skills/diaria-develop/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  checkDevelopPlanMotivos,
  findHeliosBuraco,
  DEVELOP_PULADA_MOTIVOS,
  type DevelopPlanIssueLike,
} from "./lib/develop-plan-motivo.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[validate-develop-plan-motivo] uso: --plan {path}");
    process.exit(2);
  }

  if (!existsSync(planPath)) {
    console.error(`[validate-develop-plan-motivo] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  const result = checkDevelopPlanMotivos(planPath);
  // #5907 (b) — buraco do helios: status deixado-para-o-helios em issue de
  // track develop/bloqueada. Reportado junto, mesma passada de gate.
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as IssuesBearing<DevelopPlanIssueLike>;
  const heliosBuraco = findHeliosBuraco(normalizeIssues(plan));
  if (result.status === "ok" && heliosBuraco.length === 0) {
    console.log("ok — todo motivo de issue pulada está no vocabulário fechado");
    process.exit(0);
  }

  if (heliosBuraco.length > 0) {
    console.error(
      `[validate-develop-plan-motivo] #5907(b): status "deixado-para-o-helios" em issue de track develop/bloqueada — o helios NUNCA pega essas; a issue fica num buraco (develop não faz, overnight não faz). Reclassifique (mergeada / entregue-fora-de-codigo / nao-tentada / pulada com motivo válido) ou corrija o exec_track_painel:`,
    );
    for (const n of heliosBuraco) {
      console.error(`  #${Number.isFinite(n) ? n : "?"}`);
    }
  }
  if (result.status !== "ok") {
    console.error(
      `[validate-develop-plan-motivo] motivo fora do vocabulário fechado (${DEVELOP_PULADA_MOTIVOS.join(", ")}), ou sem evidência obrigatória:`,
    );
    for (const entry of result.entries) {
      const label = Number.isFinite(entry.number) ? `#${entry.number}` : "#?";
      if (entry.reason === "missing-evidencia") {
        console.error(
          `  ${label} — motivo "${entry.motivo}" sem campo ja_resolvida_evidencia (evidência obrigatória, ver docstring de develop-plan-motivo.ts)`,
        );
      } else {
        console.error(`  ${label} — motivo: ${entry.motivo ?? "(ausente)"}`);
      }
    }
  }
  process.exit(1);
}
