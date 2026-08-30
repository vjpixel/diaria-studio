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
 * **#6436 — 2ª checagem, independente do `plan.json`:** além dos 3 motivos
 * transitórios acima, este CLI também varre `data/sessions/` inteiro
 * (`listActiveSessions`) por claims mais velhas que `CLAIM_STALE_AGE_MS`
 * (`scripts/lib/claim-staleness.ts`) SEM PR aberto correspondente — cobre a
 * sessão `continuo` (cron de 60min do Hermes), que re-reivindica a mesma
 * issue indefinidamente sem nunca soltar, deixando-a `claimed-por-outra-
 * sessao` pra sempre mesmo sem nenhum trabalho visível em andamento.
 *
 * @see scripts/lib/block-staleness.ts
 * @see scripts/lib/claim-staleness.ts (#6436, checagem de claim envelhecida)
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
  type IssueState,
  type PrState,
} from "./lib/block-staleness.ts";
import { isIssueClaimedByOther, listActiveSessions } from "./lib/session-registry.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import { flattenClaims, findAgedClaims, CLAIM_STALE_AGE_MS } from "./lib/claim-staleness.ts";

/** Monta um consultor real, apoiado em `gh` (PR state + labels) e
 * `isIssueClaimedByOther` (leitura direta de `data/sessions/*.json`, sem
 * rede). Cada método é fail-soft na própria chamada: falha de `gh`
 * (offline, sem auth, rate limit) vira `UNKNOWN`/`null`, nunca lança —
 * `findStaleBlocks` já trata esses valores como "não verificável".
 */
function buildRealConsultor(repoRoot: string): BlockStalenessConsultor {
  // #6754 fleet review — a categoria `bloqueio-execucao` agora checa TODAS
  // as labels de `BLOCKED_LABELS_SET` (4 labels) por issue; sem cache isso
  // vira 4 chamadas `gh issue view` idênticas (mesmo issue, mesmo campo
  // `labels`, só o filtro final muda). Memoiza por issueNumber dentro desta
  // instância de consultor — 1 fetch por issue, independente de quantas
  // labels forem checadas.
  const labelsCache = new Map<number, Set<string> | null>();
  function fetchLabels(issueNumber: number): Set<string> | null {
    if (labelsCache.has(issueNumber)) return labelsCache.get(issueNumber) ?? null;
    const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "labels"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    let value: Set<string> | null;
    if (result.error || result.status !== 0 || !result.stdout) {
      value = null;
    } else {
      try {
        const parsed = JSON.parse(result.stdout) as { labels?: Array<{ name?: string }> };
        value = new Set((parsed.labels ?? []).map((l) => l.name).filter((n): n is string => !!n));
      } catch {
        value = null;
      }
    }
    labelsCache.set(issueNumber, value);
    return value;
  }

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
      const labels = fetchLabels(issueNumber);
      if (labels === null) return null;
      return labels.has(label);
    },
    getIssueState(issueNumber: number): IssueState {
      const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "state"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (result.error || result.status !== 0 || !result.stdout) return "UNKNOWN";
      try {
        const parsed = JSON.parse(result.stdout) as { state?: string };
        const state = (parsed.state ?? "").toUpperCase();
        if (state === "OPEN" || state === "CLOSED") return state;
        return "UNKNOWN";
      } catch {
        return "UNKNOWN";
      }
    },
  };
}

/**
 * #6436 — `true`/`false`/`null` (não verificável) se existe PR ABERTO cujo
 * título/corpo cita `#{issueNumber}`. Fail-soft: qualquer falha do `gh`
 * (offline, rate limit, não-autenticado) devolve `null`, nunca `false` —
 * `findAgedClaims` trata `null` como "não reportar" (mesmo princípio dos
 * demais métodos de `buildRealConsultor` acima).
 */
function buildHasOpenPr(repoRoot: string): (issueNumber: number) => boolean | null {
  return (issueNumber: number): boolean | null => {
    const result = spawnSync(
      "gh",
      ["pr", "list", "--state", "open", "--search", `#${issueNumber}`, "--json", "number"],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    if (result.error || result.status !== 0 || !result.stdout) return null;
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ number?: number }>;
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return null;
    }
  };
}

/**
 * #6754 — `true`/`false` se a issue está `CLOSED`; `null` (não verificável)
 * em qualquer falha de `gh` (offline, rate limit, não-autenticado). Issue
 * fechada nunca precisa de re-triagem por claim envelhecida — ver docstring
 * de `findAgedClaims` em `claim-staleness.ts`.
 */
function buildIsIssueClosed(repoRoot: string): (issueNumber: number) => boolean | null {
  return (issueNumber: number): boolean | null => {
    const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "state"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error || result.status !== 0 || !result.stdout) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { state?: string };
      const state = (parsed.state ?? "").toUpperCase();
      if (state === "CLOSED") return true;
      if (state === "OPEN") return false;
      return null;
    } catch {
      return null;
    }
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

  const repoRoot = process.cwd();
  const consultor = buildRealConsultor(repoRoot);
  const findings = findStaleBlocks(issues, consultor);

  // #6436 — teto de idade de claim sem PR aberto, INDEPENDENTE do plan.json
  // (varre `data/sessions/` inteiro, não só as issues `pulada` deste plano —
  // uma issue claimed pela `continuo` pode nunca ter entrado neste plan.json).
  const sessions = listActiveSessions(repoRoot);
  const claimEntries = flattenClaims(sessions);
  const hasOpenPr = buildHasOpenPr(repoRoot);
  const isIssueClosed = buildIsIssueClosed(repoRoot);
  const agedClaims = findAgedClaims(
    claimEntries,
    Date.now(),
    CLAIM_STALE_AGE_MS,
    hasOpenPr,
    isIssueClosed,
  );

  if (findings.length === 0 && agedClaims.length === 0) {
    console.log(
      "ok — nenhum bloqueio pulada (pr-em-voo/claimed-por-outra-sessao/bloqueio-execucao) caducado, nenhuma claim envelhecida sem PR",
    );
    process.exit(0);
  }

  if (findings.length > 0) {
    console.error(
      `[check-block-staleness] bloqueio(s) caducado(s) — reavalie dispatch antes de fechar a rodada:`,
    );
    for (const f of findings) {
      console.error(`  #${f.number} (motivo "${f.motivo}"): ${f.reason}`);
    }
  }
  if (agedClaims.length > 0) {
    console.error(
      `[check-block-staleness] claim(s) envelhecida(s) sem PR aberto (#6436, teto ${CLAIM_STALE_AGE_MS / 3_600_000}h) — considerar pendência de re-triagem (check-state-changed-pending.ts --add-pending):`,
    );
    for (const c of agedClaims) {
      const ageH = (c.ageMs / 3_600_000).toFixed(1);
      console.error(
        `  #${c.issueNumber} — claimed por ${c.kind}-${c.machineTag}-${c.sessionId} há ${ageH}h (desde ${c.claimedAt}), sem PR aberto`,
      );
    }
  }
  process.exit(1);
}
