/**
 * check-pr-bugfix-test.ts (#970)
 *
 * Roda em GH Action `pr-checks.yml` pra cada PR. Detecta se o PR é bugfix
 * (heurística por título "fix:" / closes label `bug` / etc) e, se for,
 * verifica se há teste novo no diff. Sem teste, exige label `no-regression-test`
 * + justificativa explícita no body.
 *
 * Implementa o invariante #633: "PR de bugfix exige teste de regressão".
 *
 * Env vars (passados pelo GH Action):
 *   GH_TOKEN     — auth pra gh CLI
 *   PR_BODY      — body do PR
 *   PR_TITLE     — título do PR
 *   PR_NUMBER    — número do PR
 *   BASE_SHA     — sha do base (master) na hora do PR
 *   HEAD_SHA     — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (não é bugfix, OU é bugfix com teste novo, OU é bugfix com label de exceção)
 *   1 — falha (é bugfix sem teste novo e sem label de exceção)
 *   2 — input inválido / erro de gh CLI
 */

import { spawnSync } from "node:child_process";

interface PrLabel {
  name: string;
}

interface PrInfo {
  labels: PrLabel[];
}

export function isBugfixPr(title: string, body: string, labels: string[]): boolean {
  // Heurísticas pra detectar bug fix:
  if (labels.includes("bug")) return true;
  if (/^fix(\(|:)/i.test(title)) return true;
  // "closes #N" no body onde #N é label `bug` — mais caro de checar via API,
  // skip pra MVP. Title + label cobrem ~95% dos casos.
  if (/\b(bugfix|fixe|hotfix)\b/i.test(title)) return true;
  return false;
}

export function hasExceptionLabel(labels: string[]): boolean {
  return labels.includes("no-regression-test");
}

function getChangedFiles(baseSha: string, headSha: string): string[] {
  const r = spawnSync("git", ["diff", "--name-status", `${baseSha}..${headSha}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff failed: ${r.stderr}`);
  }
  return r.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const parts = l.split("\t");
      return { status: parts[0], path: parts[1] };
    })
    .filter((f) => f.status === "A" || f.status === "M")
    .map((f) => f.path);
}

export function hasNewOrModifiedTest(changedFiles: string[]): boolean {
  return changedFiles.some(
    (f) =>
      (f.startsWith("test/") || f.startsWith("tests/")) &&
      (f.endsWith(".test.ts") || f.endsWith(".test.js")),
  );
}

function getPrLabels(prNumber: string): string[] {
  const r = spawnSync(
    "gh",
    ["pr", "view", prNumber, "--json", "labels", "--jq", ".labels[].name"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`gh pr view failed: ${r.stderr}`);
  }
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function justificationInBody(body: string): boolean {
  // Procura indício de justificativa quando label `no-regression-test` é usado.
  // Lower bar: pelo menos 30 chars de contexto sobre por que não tem teste.
  const re = /no[-\s]?regression[-\s]?test:?\s*([^\n]{30,})/i;
  return re.test(body);
}

function main(): void {
  const prTitle = process.env.PR_TITLE ?? "";
  const prBody = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!prNumber || !baseSha || !headSha) {
    console.error("[#970] env vars ausentes: PR_NUMBER, BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  let labels: string[];
  try {
    labels = getPrLabels(prNumber);
  } catch (e) {
    console.error(`[#970] erro ao buscar labels do PR: ${(e as Error).message}`);
    process.exit(2);
  }

  if (!isBugfixPr(prTitle, prBody, labels)) {
    console.log(`[#970] PR não é bugfix (título='${prTitle.slice(0, 60)}', labels=${labels.join(",")}). Skip.`);
    process.exit(0);
  }

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(baseSha, headSha);
  } catch (e) {
    console.error(`[#970] git diff falhou: ${(e as Error).message}`);
    process.exit(2);
  }

  if (hasNewOrModifiedTest(changedFiles)) {
    const testFiles = changedFiles.filter(
      (f) => (f.startsWith("test/") || f.startsWith("tests/")) && (f.endsWith(".test.ts") || f.endsWith(".test.js")),
    );
    console.log(`[#970] Bugfix com teste(s) modificado(s)/novo(s): ${testFiles.join(", ")}. Pass.`);
    process.exit(0);
  }

  if (hasExceptionLabel(labels)) {
    if (!justificationInBody(prBody)) {
      console.error(
        `[#970] PR tem label 'no-regression-test' mas falta justificativa no body.\n` +
          `       Adicione "no-regression-test: <razão clara em 30+ chars>" ao body.`,
      );
      process.exit(1);
    }
    console.log(`[#970] Bugfix sem teste mas com label de exceção + justificativa. Pass.`);
    process.exit(0);
  }

  console.error(
    [
      `[#970] PR de bugfix sem teste novo (regra #633).`,
      ``,
      `Adicione um teste de regressão (test/*.test.ts) que demonstre que o bug não voltaria,`,
      `OU adicione label 'no-regression-test' + justificativa no body explicando por que`,
      `o fix não pode ser testado (ex: "agent prompt", "config-only change").`,
      ``,
      `Title: ${prTitle}`,
      `Files changed: ${changedFiles.length}`,
      `Test files added/modified: 0`,
    ].join("\n"),
  );
  process.exit(1);
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
