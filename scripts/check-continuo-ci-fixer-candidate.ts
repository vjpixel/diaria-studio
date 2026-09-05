#!/usr/bin/env npx tsx
/**
 * check-continuo-ci-fixer-candidate.ts (#7446 item 3)
 *
 * CLI wrapper de `scripts/lib/continuo-ci-fixer-eligibility.ts` — todo I/O
 * (`gh pr list` + um `check-pr-checks-gate.ts` por PR `continuo/*` aberta)
 * fica aqui; a decisão pura fica na lib. Consumido pelo tick do contínuo
 * (`hermes/skills/hermes-diaria-continuo/SKILL.md` §3) ANTES de reivindicar
 * uma issue nova: se existe candidata, o tick tenta consertar essa PR
 * primeiro (fila de conserto tem prioridade sobre fila de feature).
 *
 * Reusa `check-pr-checks-gate.ts` (nunca reimplementa o cálculo de
 * verdict de CI) via subprocesso — 1 chamada por PR `continuo/*` aberta;
 * o exit code de cada chamada mapeia direto pro `CiVerdict` da lib.
 *
 * Uso:
 *   npx tsx scripts/check-continuo-ci-fixer-candidate.ts
 *
 * Saída: JSON `{"candidate": number | null, "checked": number}` em stdout.
 * `checked` é quantas PRs `continuo/*` abertas foram avaliadas — 0 é estado
 * válido (nenhuma PR `continuo/*` aberta), não erro.
 *
 * `gh pr list` falhando é tratado como "nenhuma candidata" (`candidate:
 * null`, `checked: -1` como sentinela de erro) — fail-SOFT aqui: a pior
 * consequência de um falso negativo é o tick reivindicar issue nova em vez
 * de consertar (comportamento pré-existente), nunca um merge indevido nem
 * dado perdido.
 *
 * Exit code sempre 0 (uso não tem flags obrigatórias).
 *
 * @see scripts/lib/continuo-ci-fixer-eligibility.ts
 * @see scripts/check-pr-checks-gate.ts
 * @see scripts/mark-continuo-ci-fix-attempted.ts
 */

import { execFileSync, spawnSync } from "node:child_process";
import { selectCiFixCandidate, type CiFixCandidatePr, type CiVerdict } from "./lib/continuo-ci-fixer-eligibility.ts";

interface OpenPrRaw {
  number: number;
  headRefName: string;
  labels: { name: string }[];
}

/** `null` = `gh pr list` falhou (rede, auth) — o chamador trata como "não
 * sei", segue sem candidata. */
function listOpenContinuoPrs(): OpenPrRaw[] | null {
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--json",
        "number,headRefName,labels",
        "--jq",
        '[.[] | select(.headRefName | startswith("continuo/"))]',
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    return JSON.parse(out) as OpenPrRaw[];
  } catch {
    return null;
  }
}

/** Mesmo mapeamento de exit code → verdict que `EXIT_CODES` de
 * `scripts/check-pr-checks-gate.ts` já define, invertido. Duplicado aqui de
 * propósito: importar aquele objeto criaria acoplamento entre dois CLIs
 * pelo exit code (frágil); o exit code É a interface pública deste script
 * irmão — reler seu docblock antes de mudar qualquer um dos dois lados. */
const VERDICT_BY_EXIT_CODE: Record<number, CiVerdict> = {
  0: "pass",
  1: "fail",
  2: "pending",
  3: "error",
  4: "blocked_by_conflict",
  5: "claude_binary_error",
};

function fetchCiVerdict(prNumber: number): CiVerdict {
  // `process.execPath --import tsx`, NUNCA `npx tsx` sem `shell` — guard
  // #4343/test/spawn-npx-windows-guard.test.ts: `spawnSync("npx", ...)` sem
  // `shell: true` lança ENOENT no Windows (resolução de `.cmd`/PATH que o
  // spawn sem shell não faz), mesmo passando limpo no CI Linux.
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-pr-checks-gate.ts", "--pr", String(prNumber)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const status = result.status;
  if (status === null || status === undefined) return "error";
  return VERDICT_BY_EXIT_CODE[status] ?? "error";
}

function main(): void {
  const openPrs = listOpenContinuoPrs();
  if (openPrs === null) {
    console.log(JSON.stringify({ candidate: null, checked: -1 }));
    return;
  }

  const prs: CiFixCandidatePr[] = openPrs.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName,
    ciVerdict: fetchCiVerdict(pr.number),
    labels: pr.labels.map((l) => l.name),
  }));

  const candidate = selectCiFixCandidate(prs);
  console.log(JSON.stringify({ candidate, checked: prs.length }));
}

main();
