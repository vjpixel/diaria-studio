#!/usr/bin/env npx tsx
/**
 * check-continuo-merge-gate.ts (#6926)
 *
 * CLI que decide se `continuo-pr-review.sh` pode mergear a PR que acabou de
 * revisar — ver `scripts/lib/continuo-merge-gate.ts` pra lógica pura/ordem
 * dos portões. Este arquivo só faz I/O: 1 chamada `gh pr view` (a maioria
 * dos campos precisados de uma vez — headRefOid, mergeable,
 * statusCheckRollup, comments, body, additions, deletions), 1 chamada
 * paginada `gh api .../pulls/{n}/files` (ver nota abaixo sobre por que NÃO
 * é `gh pr view --json files`), 1 chamada `gh issue view` por issue
 * referenciada pelo corpo (tipicamente 0 ou 1), e imprime o veredito como
 * JSON.
 *
 * Uso:
 *   npx tsx scripts/check-continuo-merge-gate.ts --pr 6929
 *
 * Sem flag de SHA revisado: `reviewedHeadSha` é SEMPRE auto-derivado do
 * marcador de review mais recente (`extractIndependentReviewHeadSha`,
 * `scripts/lib/pr-review-authenticity.ts`) — NUNCA recebido como argumento
 * do chamador. Achado do review da PR #6932 (P0/P1, 2 agentes
 * independentes): uma versão anterior aceitava `--reviewed-head-sha` como
 * flag, e o caminho "PR já tinha review independente" (`AUTH_RC=0` de
 * `continuo-pr-review.sh`) passava o HEAD ATUAL como se fosse o SHA
 * revisado — o portão de corrida do #5716 (`currentHeadSha !==
 * reviewedHeadSha`) comparava um valor consigo mesmo e nunca podia
 * disparar. Auto-derivar do marcador fecha isso por construção: o único
 * jeito de `reviewedHeadSha` bater com `currentHeadSha` é a revisão ter
 * mesmo coberto o HEAD atual.
 *
 * `--diff-threshold` (opcional): override do limiar de linhas de diff —
 * default é `EFFORT_DIFF_LINE_THRESHOLD` (DUPLICADO, não importado, de
 * `.claude/hooks/pr-create-review.mjs` — ver comentário na constante
 * abaixo — mas reusando o MESMO VALOR, #4813/#6393, decisão do editor de
 * não inventar limiar novo). Existe só pra teste/debug; o cron nunca
 * precisa passá-lo.
 *
 * Exit codes (fail-closed — todo valor != 0 significa "NÃO mergear"):
 *   0 = merge     (todos os portões passaram)
 *   1 = escalate  (algum portão pediu revisão humana/próximo tick — não é
 *                  erro, é "ainda não dá pra decidir sozinho")
 *   2 = reject    (superseded, ou veredito da revisão foi reject)
 *   3 = error     (gh falhou, PR inexistente, JSON malformado, uso
 *                  inválido, OU exceção não-tratada — ver nota abaixo)
 *
 * Nota sobre exit 3 e exceções (#6932, P2): o corpo principal roda dentro
 * de um try/catch que mapeia QUALQUER exceção não prevista para exit 3.
 * Sem isso, uma exceção síncrona não capturada faria o Node sair com o
 * código default 1 — que colide de propósito com o exit code de
 * `escalate` acima, fazendo um CRASH real do script (bug, payload
 * inesperado do `gh`) se passar por `gh pr view — deixando pro pickup do
 * overnight` no log do cron, indistinguível de uma escalada normal e
 * invisível pro `INFRA_ERRORS`/`log_infra_error` que `continuo-pr-
 * review.sh` mantém especificamente pra não perder rastro desse tipo de
 * falha (#6910).
 *
 * @see scripts/lib/continuo-merge-gate.ts
 * @see scripts/lib/continuo-superseded-check.ts
 * @see scripts/lib/pr-review-authenticity.ts (extractIndependentReviewVerdict/HeadSha)
 * @see scripts/lib/pr-checks-gate.ts (evaluatePrChecksGate)
 * @see scripts/lib/sensitive-path-guard.ts (classifyChangedPaths)
 * @see hermes/scripts/continuo-pr-review.sh
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluatePrChecksGate } from "./lib/pr-checks-gate.ts";
import { classifyChangedPaths } from "./lib/sensitive-path-guard.ts";
import { extractIndependentReviewVerdict, extractIndependentReviewHeadSha } from "./lib/pr-review-authenticity.ts";
import { extractClosingIssueNumbers, computeSupersededVerdict } from "./lib/continuo-superseded-check.ts";
import { evaluateContinuoMergeGate, type ContinuoMergeGateResult } from "./lib/continuo-merge-gate.ts";

/**
 * #6926: reusa o MESMO valor do limiar de tamanho de diff que já decide
 * effort de review em `.claude/hooks/pr-create-review.mjs`
 * (`EFFORT_DIFF_LINE_THRESHOLD`, #4813/#6393) — decisão do editor,
 * "não inventa limiar novo". DUPLICADO, não importado: `tsconfig.json`
 * só inclui `scripts/**\/*.ts` (o hook é `.mjs`, sem declaração de tipos —
 * `import` direto falha `tsc --noEmit` com TS7016), e o próprio hook é
 * self-contained de propósito (nunca importa `scripts/*.ts` de volta — ver
 * docblock dele). Se o valor mudar lá, mudar aqui também —
 * `test/continuo-merge-gate-threshold-sync.test.ts` trava os dois iguais.
 */
export const EFFORT_DIFF_LINE_THRESHOLD = 500;

interface GhPrViewPayload {
  headRefOid?: unknown;
  mergeable?: unknown;
  statusCheckRollup?: unknown;
  comments?: unknown;
  body?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

interface GhIssueViewPayload {
  state?: unknown;
}

/** `spawnSync` de `gh`, fail-hard: erro/JSON malformado nunca vira dado "ok". */
function ghJson<T>(args: string[], cwd: string): { ok: true; data: T } | { ok: false; reason: string } {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, reason: `gh não pôde ser executado: ${result.error.message}` };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { ok: false, reason: `gh saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) return { ok: false, reason: "gh retornou stdout vazio" };
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch (e) {
    return { ok: false, reason: `JSON malformado de gh: ${(e as Error).message}` };
  }
}

/**
 * Lista de paths alterados via REST paginado (`gh api .../pulls/{n}/files
 * --paginate`), NÃO `gh pr view --json files` (achado do review da PR
 * #6932, P2): o campo GraphQL `files` de `gh pr view` é uma connection sem
 * garantia documentada de que o `gh` CLI a pagina até o fim — um PR
 * tocando muitos arquivos poderia ter a lista truncada silenciosamente,
 * sub-relatando `sensitive` como `false` pra arquivos além do corte. REST
 * paginado é o mesmo padrão que o resto do repo já usa pra diff de PR
 * (`changedPathsFromGit` em `sensitive-path-guard.ts` usa `git diff`
 * local; aqui não há checkout, então REST paginado é o equivalente
 * correto). Retorna `null` em qualquer falha — fail-closed via `sensitive:
 * null` no chamador, nunca "lista vazia = nada sensível".
 */
function fetchChangedFiles(prNumber: number, cwd: string): string[] | null {
  const result = spawnSync(
    "gh",
    ["api", `repos/{owner}/{repo}/pulls/${prNumber}/files`, "--paginate", "--jq", ".[].filename"],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout ?? "").toString();
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Estado (`OPEN`/`CLOSED`) de cada issue referenciada pelo corpo, via `gh
 *  issue view` — 1 chamada por número (tipicamente 0 ou 1 issue por PR).
 *  Issue que falha ao buscar (deletada, transferida pra outro repo, `gh`
 *  com erro transitório) fica SEM entrada no mapa — tratada como estado
 *  desconhecido por `computeSupersededVerdict` (fail-closed: nunca
 *  "CLOSED" por omissão). */
function fetchIssueStates(numbers: readonly number[], cwd: string): Map<number, "OPEN" | "CLOSED"> {
  const states = new Map<number, "OPEN" | "CLOSED">();
  for (const n of numbers) {
    const result = ghJson<GhIssueViewPayload>(["issue", "view", String(n), "--json", "state"], cwd);
    if (result.ok && (result.data.state === "OPEN" || result.data.state === "CLOSED")) {
      states.set(n, result.data.state);
    }
  }
  return states;
}

const EXIT_CODES: Record<ContinuoMergeGateResult["action"], number> = {
  merge: 0,
  escalate: 1,
  reject: 2,
};

function run(): number {
  const { values } = parseArgs(process.argv.slice(2));
  const prRaw = values.pr;
  const prNumber = prRaw ? Number(prRaw) : NaN;
  const diffThreshold = values["diff-threshold"] ? Number(values["diff-threshold"]) : EFFORT_DIFF_LINE_THRESHOLD;

  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[check-continuo-merge-gate] uso: --pr N [--diff-threshold N]");
    return 3;
  }

  const cwd = process.cwd();
  const prView = ghJson<GhPrViewPayload>(
    ["pr", "view", String(prNumber), "--json", "headRefOid,mergeable,statusCheckRollup,comments,body,additions,deletions"],
    cwd,
  );

  if (!prView.ok) {
    console.error(`[check-continuo-merge-gate] PR #${prNumber}: erro ao buscar dados — ${prView.reason}`);
    return 3;
  }

  const payload = prView.data;
  const currentHeadSha = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
  const mergeable =
    payload.mergeable === "MERGEABLE" || payload.mergeable === "CONFLICTING" || payload.mergeable === "UNKNOWN"
      ? payload.mergeable
      : null;
  const checksResult = evaluatePrChecksGate(payload.statusCheckRollup, {
    mergeable: typeof payload.mergeable === "string" ? payload.mergeable : undefined,
  });
  const verdict = extractIndependentReviewVerdict(payload.comments);
  const reviewedHeadSha = extractIndependentReviewHeadSha(payload.comments);

  const files = fetchChangedFiles(prNumber, cwd);
  const sensitive = files === null ? null : classifyChangedPaths(files).sensitive;

  const closingIssueNumbers = extractClosingIssueNumbers(payload.body);
  const issueStates = fetchIssueStates(closingIssueNumbers, cwd);
  const supersededVerdict = computeSupersededVerdict(closingIssueNumbers, issueStates);

  const additions = typeof payload.additions === "number" ? payload.additions : null;
  const deletions = typeof payload.deletions === "number" ? payload.deletions : null;
  const diffLineCount = additions !== null && deletions !== null ? additions + deletions : null;

  const result = evaluateContinuoMergeGate({
    superseded: supersededVerdict.superseded,
    verdict,
    currentHeadSha,
    reviewedHeadSha,
    sensitive,
    checksVerdict: checksResult.verdict,
    mergeable,
    diffLineCount,
    diffLineThreshold: diffThreshold,
  });

  const output = {
    pr: prNumber,
    action: result.action,
    reason: result.reason,
    details: {
      superseded: supersededVerdict,
      verdict,
      currentHeadSha,
      reviewedHeadSha,
      sensitive,
      checksVerdict: checksResult.verdict,
      mergeable,
      diffLineCount,
      diffLineThreshold: diffThreshold,
    },
  };

  // Sempre no stdout, SEMPRE a última coisa escrita nele — o chamador
  // (`try_merge_gate` em continuo-pr-review.sh) lê stdout e stderr em
  // streams SEPARADOS (não `2>&1` misturado) e faz `jq` sobre esta linha
  // pra extrair `action`/`reason`/`details.reviewedHeadSha`, nunca
  // depende de ordem relativa entre stdout/stderr (#6932, P3 — a versão
  // anterior fazia `tail -1` sobre os dois streams misturados, que não
  // tem ordem de interleaving garantida).
  console.log(JSON.stringify(output));
  if (result.action !== "merge") {
    console.error(`[check-continuo-merge-gate] PR #${prNumber}: ${result.action} — ${result.reason}`);
  }
  return EXIT_CODES[result.action];
}

if (isMainModule(import.meta.url)) {
  let exitCode: number;
  try {
    exitCode = run();
  } catch (e) {
    // #6932 (P2): nunca deixar uma exceção não-prevista cair no exit code
    // default do Node (1) — colide de propósito com `escalate` (ver
    // docblock do topo). Qualquer bug/payload inesperado vira exit 3
    // (`error`), sempre distinguível de uma escalada legítima.
    console.error(`[check-continuo-merge-gate] exceção não tratada: ${(e as Error)?.stack ?? String(e)}`);
    exitCode = 3;
  }
  process.exit(exitCode);
}
