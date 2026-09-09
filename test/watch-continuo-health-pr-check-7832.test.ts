/**
 * test/watch-continuo-health-pr-check-7832.test.ts (#7832)
 *
 * A checagem 9 de `watch-continuo-health.sh` (fila de PRs abertas sem
 * merge) alarmava só com a CONTAGEM de PRs abertas + a idade da mais
 * velha. O #7807 mostrou que o alarme estava certo (9 abertas, mais velha
 * há 9.8h) mas o corpo que ele gera manda investigar o gate de merge — em
 * 09/09/2026 as 9 estavam vermelhas por 8 causas MECÂNICAS independentes
 * (teto de SKILL.md, `vitest` em 3 PRs, lockfile fora de sync, TS2345,
 * `removal-declaration` faltando, conflito com master), não porque nenhum
 * merger estava decidindo. O diagnóstico levou uma sessão inteira abrindo
 * log de job por job — dado que uma única chamada de
 * `gh pr view <N> --json statusCheckRollup` já dá.
 *
 * Este teste cobre DUAS coisas, na mesma disciplina de
 * `watch-continuo-health-price-alarm-6818.test.ts` (extração estática do
 * bloco + `bash -n`), mas indo além com execução DINÂMICA da função nova
 * (`pr_first_failed_check`) contra um `gh` mockado — porque o formato de
 * saída por PR é o próprio ponto da issue, não algo que dê pra travar só
 * lendo o texto do script:
 *
 *   1. Formato de saída novo — 1 linha por PR com o primeiro check que
 *      falhou (ou "(verde, só esperando merger)" quando não há check
 *      vermelho).
 *   2. Fail-soft — `gh pr view` falhando (exit != 0, ou saída vazia) numa
 *      PR vira "(status indisponível)" só naquela linha, nunca derruba o
 *      alarme inteiro (#7832 §Escopo: "mesma disciplina do `checked: -1`
 *      do §3b").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "hermes", "scripts", "watch-continuo-health.sh");
const source = readFileSync(SCRIPT, "utf8");

/** Extrai o corpo da função `pr_first_failed_check` (#7832) para reuso isolado nos testes dinâmicos. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  assert.ok(start >= 0, `função ${name} não encontrada no script — foi removida/renomeada?`);
  const rest = src.slice(start);
  // A função termina na primeira linha que é só "}" (sem indentação) após o início.
  const closeMatch = rest.match(/\n}\n/);
  assert.ok(closeMatch && closeMatch.index !== undefined, `fim da função ${name} não encontrado`);
  return rest.slice(0, closeMatch!.index! + 2);
}

/**
 * Roda `pr_first_failed_check "$1"` num subshell bash, com um `gh` mockado
 * (script executável que simula `gh pr view <N> --json statusCheckRollup`)
 * na frente do PATH.
 */
function runPrFirstFailedCheck(prnum: string, ghScript: string): { stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "watch-continuo-pr-check-"));
  try {
    const ghPath = join(dir, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env bash\n${ghScript}\n`);
    chmodSync(ghPath, 0o755);

    const funcSrc = extractFunction(source, "pr_first_failed_check");
    const driver = `${funcSrc}\npr_first_failed_check "$1"\n`;
    const driverPath = join(dir, "driver.sh");
    writeFileSync(driverPath, driver);

    const res = spawnSync("bash", [driverPath, prnum], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return { stdout: res.stdout, status: res.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#7832 — watch-continuo-health.sh: primeiro check falho por PR", () => {
  it("sintaxe bash do script continua válida (bash -n)", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n falhou: ${res.stderr}`);
  });

  it("a checagem 9 chama pr_first_failed_check dentro do ramo de alarme (não fora dele)", () => {
    const start = source.indexOf("# ── 9. fila de PRs abertas sem merge");
    assert.ok(start >= 0, "bloco da checagem 9 não encontrado");
    const rest = source.slice(start);
    const nextSection = rest.indexOf("\n# ── 10.");
    assert.ok(nextSection > 0, "fim do bloco da checagem 9 não encontrado (próxima seção ausente)");
    const block = rest.slice(0, nextSection);

    const alarmBranchStart = block.indexOf('"$QUEUE_COUNT" -ge "$QUEUE_COUNT_THRESHOLD"');
    assert.ok(alarmBranchStart >= 0, "condição de alarme (limiar) não encontrada");
    const alarmBranch = block.slice(alarmBranchStart);
    assert.match(alarmBranch, /pr_first_failed_check/, "o ramo de alarme precisa montar a linha por PR");
    assert.match(alarmBranch, /Primeiro check que falhou por PR/, "corpo da issue precisa explicar a coluna nova");
  });

  it("PR com 1 check FAILURE (CheckRun) vira '#N  {workflow} — {nome}'", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          name: "Unused code check (knip)",
          workflowName: "PR Checks",
        },
        { __typename: "CheckRun", conclusion: "SUCCESS", name: "markdown-guards", workflowName: "Markdown guards" },
      ],
    })}\nJSON\n`;
    const { stdout, status } = runPrFirstFailedCheck("7803", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7803  PR Checks — Unused code check (knip)");
  });

  it("PR com >1 check falho reporta o primeiro + contagem dos demais", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      statusCheckRollup: [
        { __typename: "CheckRun", conclusion: "FAILURE", name: "test", workflowName: "CI" },
        { __typename: "CheckRun", conclusion: "FAILURE", name: "typecheck", workflowName: "CI" },
        { __typename: "CheckRun", conclusion: "ERROR", name: "lint", workflowName: "PR Checks" },
      ],
    })}\nJSON\n`;
    const { stdout, status } = runPrFirstFailedCheck("7783", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7783  CI — test   [+2 outros]");
  });

  it("PR toda verde vira '(verde, só esperando merger)' — separa de PR vermelha", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      statusCheckRollup: [
        { __typename: "CheckRun", conclusion: "SUCCESS", name: "test", workflowName: "CI" },
        { __typename: "StatusContext", state: "SUCCESS", context: "legacy-status" },
      ],
    })}\nJSON\n`;
    const { stdout, status } = runPrFirstFailedCheck("7824", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7824  (verde, só esperando merger)");
  });

  it("FAIL-SOFT: gh pr view saindo com erro vira '(status indisponível)' — não derruba a chamada", () => {
    const gh = `echo "gh: some transient error" >&2\nexit 1\n`;
    const { stdout, status } = runPrFirstFailedCheck("9999", gh);
    assert.equal(status, 0, "a função em si não deve propagar o erro do gh (fail-soft)");
    assert.equal(stdout.trim(), "#9999  (status indisponível)");
  });

  it("FAIL-SOFT: gh pr view saindo com sucesso mas vazio também vira '(status indisponível)'", () => {
    const gh = `printf ''\n`;
    const { stdout, status } = runPrFirstFailedCheck("1", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#1  (status indisponível)");
  });

  it("FAIL-SOFT: JSON malformado (statusCheckRollup imprevisto) também degrada, nunca lança", () => {
    const gh = `echo 'not json at all'\n`;
    const { stdout, status } = runPrFirstFailedCheck("2", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#2  (status indisponível)");
  });

  it("StatusContext com state FAILURE também conta como check falho (não só CheckRun)", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE", context: "ci/legacy" }],
    })}\nJSON\n`;
    const { stdout, status } = runPrFirstFailedCheck("42", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#42  ci/legacy");
  });
});
