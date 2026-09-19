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

function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`);
  assert.ok(start >= 0, `função ${name} não encontrada no script — foi removida/renomeada?`);
  const rest = src.slice(start);
  const closeMatch = rest.match(/\n}\n/);
  assert.ok(closeMatch && closeMatch.index !== undefined, `fim da função ${name} não encontrado`);
  return rest.slice(0, closeMatch.index! + 2);
}

function runPrReviewVerdict(prnum: string, ghScript: string): { stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "watch-continuo-pr-verdict-"));
  try {
    const ghPath = join(dir, "gh");
    writeFileSync(ghPath, `#!/usr/bin/env bash\n${ghScript}\n`);
    chmodSync(ghPath, 0o755);

    const funcSrc = extractFunction(source, "pr_review_verdict");
    const driver = `${funcSrc}\npr_review_verdict "$1"\n`;
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

function verdictComment(verdict: "approve" | "reject", head: string, run: string): string {
  return `<!-- continuo-review: run=${run} at=2026-09-18T10:00:00Z verdict=${verdict} head=${head} -->`;
}
describe("#8442 — watch-continuo-health.sh: veredito do review mais recente por PR", () => {
  it("sintaxe bash do script continua válida (bash -n)", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n falhou: ${res.stderr}`);
  });

  it("a checagem 9 chama pr_review_verdict dentro do ramo de alarme", () => {
    const start = source.indexOf("# ── 9. fila de PRs abertas sem merge");
    assert.ok(start >= 0, "bloco da checagem 9 não encontrado");
    const rest = source.slice(start);
    const nextSection = rest.indexOf("\n# ── 10.");
    assert.ok(nextSection > 0, "fim do bloco da checagem 9 não encontrado");
    const block = rest.slice(0, nextSection);
    const alarmBranchStart = block.indexOf('"$QUEUE_COUNT" -ge "$QUEUE_COUNT_THRESHOLD"');
    assert.ok(alarmBranchStart >= 0, "condição de alarme não encontrada");
    const alarmBranch = block.slice(alarmBranchStart);
    assert.match(alarmBranch, /pr_review_verdict/, "o ramo de alarme precisa montar a linha de veredito por PR");
    assert.match(alarmBranch, /Veredito do review mais recente por PR/, "corpo da issue precisa explicar a coluna nova");
  });

  it("PR com veredito=approve vira '#N  veredito=approve'", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      comments: [{ body: `review ok\n\n${verdictComment("approve", "abc123", "run-1")}` }],
    })}\nJSON\n`;
    const { stdout, status } = runPrReviewVerdict("8442", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#8442  veredito=approve");
  });

  it("PR com veredito=reject vira '#N  veredito=reject'", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      comments: [
        { body: `primeiro\n\n${verdictComment("approve", "old", "run-1")}` },
        { body: `segundo\n\n${verdictComment("reject", "deadbeef", "run-2")}` },
      ],
    })}\nJSON\n`;
    const { stdout, status } = runPrReviewVerdict("8332", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#8332  veredito=reject");
  });

  it("PR com comments mas sem marcador vira '(sem review)' — o gate ainda não decidiu", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      comments: [
        { body: "LGTM, looks good to me" },
        { body: "uma sugestão de formatação" },
      ],
    })}\nJSON\n`;
    const { stdout, status } = runPrReviewVerdict("7800", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7800  (sem review)");
  });

  it("PR sem comments (lista vazia) também vira '(sem review)'", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({ comments: [] })}\nJSON\n`;
    const { stdout, status } = runPrReviewVerdict("7801", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7801  (sem review)");
  });

  it("marcador sem campo verdict= (legado) vira '(sem review)' — never infere approve", () => {
    const gh = `cat <<'JSON'\n${JSON.stringify({
      comments: [{ body: `<!-- continuo-review: run=old at=2026-09-01T00:00:00Z head=aaaa -->` }],
    })}\nJSON\n`;
    const { stdout, status } = runPrReviewVerdict("7802", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#7802  (sem review)");
  });

  it("FAIL-SOFT: gh pr view saindo com erro vira '(status indisponível)'", () => {
    const gh = `echo "gh: some transient error" >&2\nexit 1\n`;
    const { stdout, status } = runPrReviewVerdict("9999", gh);
    assert.equal(status, 0, "a função em si não deve propagar o erro do gh (fail-soft)");
    assert.equal(stdout.trim(), "#9999  (status indisponível)");
  });

  it("FAIL-SOFT: gh pr view com sucesso mas vazio também vira '(status indisponível)'", () => {
    const gh = `printf ''\n`;
    const { stdout, status } = runPrReviewVerdict("1", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#1  (status indisponível)");
  });

  it("FAIL-SOFT: JSON malformado também degrada, nunca lança", () => {
    const gh = `echo 'not json at all'\n`;
    const { stdout, status } = runPrReviewVerdict("2", gh);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "#2  (status indisponível)");
  });

  it("o marcador do file_issue da checagem 9 é único e vira substring do título (invariante #6771)", () => {
    const marker = "[watch-continuo] fila de PRs sem merge";
    const re = /file_issue "([^"]+)" \\\n\s*"([^"]+)"/g;
    let found: { marker: string; title: string } | undefined;
    for (const m of source.matchAll(re)) {
      if (m[1] === marker) found = { marker: m[1], title: m[2] };
    }
    assert.ok(found, "call site do file_issue da checagem 9 não encontrado pelo parser genérico");
    assert.ok(found!.title.includes(found!.marker), "título precisa conter o marcador (dedup depende disso)");
  });
});
