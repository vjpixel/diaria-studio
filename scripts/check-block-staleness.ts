#!/usr/bin/env npx tsx
/**
 * check-block-staleness.ts (#6259)
 *
 * CLI para o gate de "bloqueio caducado" — ver `scripts/lib/block-staleness.ts`
 * pra lógica pura/documentação completa do mecanismo. Este arquivo monta o
 * `BlockStalenessConsultor` real (via `gh` e `session-registry.ts`) e é só o
 * ponto de entrada de linha de comando, seguindo o mesmo padrão de
 * `scripts/check-state-changed-pending.ts`.
 *
 * Reforça, não substitui, a re-varredura de convergência (#5706): aquela
 * cobre issue NOVA em `gh issue list`; esta cobre issue JÁ CONHECIDA cujo
 * bloqueio (`pulada` com motivo `pr-em-voo`/`claimed-por-outra-sessao`/
 * `bloqueio-execucao`) caducou — ver docblock de `block-staleness.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-block-staleness.ts --plan data/overnight/260826/plan.json
 *   npx tsx scripts/check-block-staleness.ts --plan data/develop/260826/plan.json
 *
 * `exit 0` = nenhum bloqueio caducado (ou nada verificável — fail-soft,
 * #738: `gh`/`session-registry` indisponível nunca trava, só reduz
 * cobertura e avisa em stderr). `exit 1` = lista de issues cujo motivo
 * `pulada` já não se sustenta — reavaliar dispatch antes de fechar a
 * rodada/sessão (mesma disciplina do gate 0.5/#5476/#5706).
 *
 * @see scripts/lib/block-staleness.ts
 * @see scripts/check-state-changed-pending.ts (padrão de estilo + gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see context/overnight-dispatch-rules.md
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  findStaleBlocks,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
  type PrState,
} from "./lib/block-staleness.ts";
import { isIssueClaimedByOther } from "./lib/session-registry.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";

/** Monta um consultor real, apoiado em `gh` (PR state + labels) e
 * `isIssueClaimedByOther` (leitura direta de `data/sessions/*.json`, sem
 * rede). Cada método é fail-soft na própria chamada: falha de `gh`
 * (offline, sem auth, rate limit) vira `UNKNOWN`/`null`, nunca lança —
 * `findStaleBlocks` já trata esses valores como "não verificável".
 */
function buildRealConsultor(repoRoot: string): BlockStalenessConsultor {
  return {
    getPrState(prNumber: number): PrState {
      const result = spawnSync("gh", ["pr", "view", String(prNumber), "--json", "state"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (result.error || result.status !== 0 || !result.stdout) return "UNKNOWN";
      try {
        const parsed = JSON.parse(result.stdout) as { state?: string };
        const state = (parsed.state ?? "").toUpperCase();
        if (state === "OPEN" || state === "MERGED" || state === "CLOSED") return state;
        return "UNKNOWN";
      } catch {
        return "UNKNOWN";
      }
    },
    isIssueClaimedActive(issueNumber: number): boolean {
      try {
        return isIssueClaimedByOther(repoRoot, issueNumber, "") !== null;
      } catch {
        // Falha de leitura de data/sessions/ (junction ausente, JSON
        // corrompido por conflito de sync) — fail-soft pro lado "ainda
        // reivindicada" (nunca reabre bloqueio por engano de infraestrutura).
        return true;
      }
    },
    hasLabel(issueNumber: number, label: string): boolean | null {
      const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "labels"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (result.error || result.status !== 0 || !result.stdout) return null;
      try {
        const parsed = JSON.parse(result.stdout) as { labels?: Array<{ name?: string }> };
        const labels = parsed.labels ?? [];
        return labels.some((l) => l.name === label);
      } catch {
        return null;
      }
    },
  };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-block-staleness] uso: --plan {path}");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-block-staleness] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-block-staleness] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  const issues = normalizeIssues<BlockStalenessPlanIssue>(
    planRaw as IssuesBearing<BlockStalenessPlanIssue>,
  );

  const consultor = buildRealConsultor(process.cwd());
  const findings = findStaleBlocks(issues, consultor);

  if (findings.length === 0) {
    console.log("ok — nenhum bloqueio pulada (pr-em-voo/claimed-por-outra-sessao/bloqueio-execucao) caducado");
    process.exit(0);
  }

  console.error(
    `[check-block-staleness] bloqueio(s) caducado(s) — reavalie dispatch antes de fechar a rodada:`,
  );
  for (const f of findings) {
    console.error(`  #${f.number} (motivo "${f.motivo}"): ${f.reason}`);
  }
  process.exit(1);
}
