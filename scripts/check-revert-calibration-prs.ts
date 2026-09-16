#!/usr/bin/env npx tsx
/**
 * scripts/check-revert-calibration-prs.ts (#8176)
 *
 * Watchdog: varre as PRs ABERTAS em branches `revert/calibration-*`
 * (abertas por `scripts/revert-calibration.ts`) e alarma (log de warning +
 * instrução de ação manual) as que ficaram órfãs — abertas há mais de
 * `--threshold-hours` (default 2h) sem merge nem fechamento.
 *
 * Existe porque `revert-calibration.ts` abre a PR via `spawnSync`
 * (subprocesso, fora da ferramenta Bash de uma sessão Claude Code) e não
 * há garantia de que alguém esteja observando quando ela roda — a
 * docstring dele promete "auto-merge do #5251" mas isso nunca acontece de
 * fato sem esta rede de segurança (ver `scripts/lib/revert-calibration-
 * orphan.ts` pro racional completo, inclusive por que as alternativas A/B
 * da issue foram descartadas em favor deste watchdog).
 *
 * É RELATÓRIO — nunca bloqueia, nunca mergeia nada sozinho (`exit 0`
 * sempre, mesmo com órfãs encontradas ou `gh` indisponível). Mesma
 * disciplina fail-soft de `check-issue-file-collisions.ts`/
 * `check-dependency-prose-lint.ts`: `gh` indisponível é sinal fraco de
 * auditoria opcional, não motivo pra alarmar ou travar.
 *
 * Uso:
 *   npx tsx scripts/check-revert-calibration-prs.ts
 *   npx tsx scripts/check-revert-calibration-prs.ts --threshold-hours 4
 *   npx tsx scripts/check-revert-calibration-prs.ts --json
 *
 * @see scripts/lib/revert-calibration-orphan.ts (lógica pura + racional completo)
 * @see scripts/revert-calibration.ts (quem abre as PRs que este watchdog audita)
 */

import { spawnSync } from "node:child_process";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  DEFAULT_ORPHAN_THRESHOLD_MS,
  REVERT_CALIBRATION_BRANCH_PREFIX,
  selectOrphanRevertPrs,
  type OrphanRevertPr,
  type RevertPrCandidate,
} from "./lib/revert-calibration-orphan.ts";

interface GhPrListItem {
  number: number;
  headRefName: string;
  createdAt: string;
  url: string;
  comments?: unknown[];
}

/**
 * Busca as PRs ABERTAS na branch de revert de calibração via `gh pr list`.
 * `null` quando `gh` falha ou devolve algo ilegível — o caller trata como
 * sinal fraco (loga e segue), nunca como "nenhuma órfã encontrada".
 */
export function fetchOpenRevertCalibrationPrs(): RevertPrCandidate[] | null {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--search",
      `head:${REVERT_CALIBRATION_BRANCH_PREFIX}`,
      "--json",
      "number,headRefName,createdAt,url,comments",
      "--limit",
      "100",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return null;
  try {
    const items = JSON.parse(result.stdout) as GhPrListItem[];
    if (!Array.isArray(items)) return null;
    return items.map((it) => ({
      number: it.number,
      headRefName: it.headRefName,
      createdAt: it.createdAt,
      url: it.url,
      comments: Array.isArray(it.comments) ? it.comments.length : 0,
    }));
  } catch {
    return null;
  }
}

function formatOrphanMessage(orphan: OrphanRevertPr): string {
  return (
    `PR #${orphan.number} (${orphan.headRefName}) aberta há ${orphan.ageHours.toFixed(1)}h sem merge/fechamento — ` +
    `revert-calibration.ts abre a PR mas não garante review/merge automático (#8176). ` +
    `Ação manual: revisar e mergear (ou fechar) ${orphan.url}.`
  );
}

export function main(
  rootDir: string = process.cwd(),
  argv: string[] = process.argv.slice(2),
  // Injetável pra teste (#8176) — reatribuir um named export de um módulo
  // ESM de fora não funciona (binding só-leitura); passar a função aqui é
  // o jeito real de trocar a fonte de dados sem tocar `gh` de verdade.
  fetchFn: () => RevertPrCandidate[] | null = fetchOpenRevertCalibrationPrs,
): void {
  const thresholdHoursArg = getArg(argv, "threshold-hours");
  const thresholdMs = thresholdHoursArg
    ? Number(thresholdHoursArg) * 60 * 60 * 1000
    : DEFAULT_ORPHAN_THRESHOLD_MS;
  const asJson = hasFlag(argv, "json");

  const prs = fetchFn();
  if (prs === null) {
    console.log(
      "[check-revert-calibration-prs] gh indisponível ou saída inesperada — sem alarme " +
        "(sinal fraco, mesma disciplina de check-issue-file-collisions.ts).",
    );
    return;
  }

  const orphans = selectOrphanRevertPrs(prs, Date.now(), thresholdMs);

  if (asJson) {
    console.log(JSON.stringify({ checked: prs.length, orphans }, null, 2));
  }

  if (orphans.length === 0) {
    if (!asJson) {
      console.log(
        `[check-revert-calibration-prs] nenhuma PR órfã em branches ${REVERT_CALIBRATION_BRANCH_PREFIX}* ` +
          `(${prs.length} aberta(s) no total).`,
      );
    }
    return;
  }

  for (const orphan of orphans) {
    const msg = formatOrphanMessage(orphan);
    if (!asJson) console.warn(`[check-revert-calibration-prs] AVISO: ${msg}`);
    logEvent(
      {
        edition: null,
        stage: null,
        agent: "check-revert-calibration-prs",
        level: "warn",
        message: "revert_calibration_pr_orphaned",
        details: { pr: orphan.number, url: orphan.url, ageHours: orphan.ageHours, comments: orphan.comments },
      },
      rootDir,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
