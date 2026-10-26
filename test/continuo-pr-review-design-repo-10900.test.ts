/**
 * test/continuo-pr-review-design-repo-10900.test.ts (#10900)
 *
 * Decisão do editor 261023b: `hermes/scripts/continuo-pr-review.sh` revisa e
 * mergeia também as PRs do `vjpixel/diaria-design`, com o mesmo gate do
 * studio. Roda as funções REAIS do script (extraídas por awk, mesma técnica
 * do #6934/#6910) contra `npx`/`gh`/`git` falsos no PATH e prova:
 *   - na vez do design: `GH_REPO` aponta pro design no gate e no `gh pr merge`,
 *     o lock é o do design (`--repo`), e o `git pull` do studio NÃO roda;
 *   - na volta pro studio: sem `GH_REPO`, sem `--repo`, `git pull` roda;
 *   - `log_infra_error` grava `repo` só na linha do design;
 *   - a listagem do design usa o MESMO filtro `--jq` da do studio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "hermes/scripts/continuo-pr-review.sh");
const src = readFileSync(SCRIPT, "utf8");

/** Mesmo recorte de `awk '/^nome\(\) \{/,/^\}/'` dos testes .sh irmãos. */
function extractFn(name: string): string {
  const start = src.indexOf(`\n${name}() {\n`);
  assert.ok(start !== -1, `função ${name}() não encontrada no script`);
  const end = src.indexOf("\n}\n", start + 1);
  assert.ok(end !== -1, `fim de ${name}() não encontrado`);
  return src.slice(start + 1, end + 3);
}

const FAKE_NPX = `#!/usr/bin/env bash
shift
script="$1"; shift
case "$script" in
  scripts/check-continuo-merge-gate.ts)
    echo "gate GH_REPO=\${GH_REPO:-}" >> "$EVENTS_LOG"
    echo '{"details":{"reviewedHeadSha":"deadbeef1234"}}'
    exit 0 ;;
  scripts/lib/session-registry.ts)
    echo "$1 $*" >> "$EVENTS_LOG"
    exit 0 ;;
esac
exit 9
`;
const FAKE_GH = `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "merge GH_REPO=\${GH_REPO:-} $3"; echo "merge GH_REPO=\${GH_REPO:-} $3" >> "$EVENTS_LOG"; exit 0; fi
exit 9
`;
const FAKE_GIT = `#!/usr/bin/env bash
if [ "$1" = "pull" ]; then echo "pull" >> "$EVENTS_LOG"; fi
exit 0
`;

function runTryMergeGate(repo: "studio" | "design"): string[] {
  const dir = mkdtempSync(join(tmpdir(), "continuo-design-10900-"));
  try {
    mkdirSync(join(dir, "bin"));
    for (const [name, body] of [["npx", FAKE_NPX], ["gh", FAKE_GH], ["git", FAKE_GIT]] as const) {
      writeFileSync(join(dir, "bin", name), body);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    const events = join(dir, "events.log");
    writeFileSync(events, "");
    const harness = [
      "set -euo pipefail",
      `REPO="${dir}"`,
      'DESIGN_REPO="vjpixel/diaria-design"',
      `DESIGN_DIR="${dir}/design"`,
      'SESSION_ID="continuo-review-test"',
      "MERGE_LOCK_MAX_RETRIES=1",
      "MERGE_LOCK_RETRY_DELAY_S=0",
      `INFRA_ERROR_LOG="${dir}/infra.jsonl"`,
      'INFRA_ERRORS=0; INFRA_ERROR_SUMMARY=""; MERGED=0; LOCK_BLOCKED=0',
      extractFn("select_review_repo"),
      extractFn("log_infra_error"),
      extractFn("acquire_merge_lock_with_retry"),
      extractFn("release_merge_lock"),
      extractFn("try_merge_gate"),
      `select_review_repo ${repo}`,
      "try_merge_gate 26",
      'echo "after GH_REPO=${GH_REPO:-}" >> "$EVENTS_LOG"',
      "select_review_repo studio",
      'echo "reset GH_REPO=${GH_REPO:-}" >> "$EVENTS_LOG"',
    ].join("\n");
    execFileSync("bash", ["-c", harness], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, EVENTS_LOG: events, GH_REPO: "" },
    });
    return readFileSync(events, "utf8").trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("continuo-pr-review.sh — PRs do vjpixel/diaria-design (#10900)", () => {
  it("vez do design: gate e merge com GH_REPO do design, lock --repo, sem git pull; volta pro studio limpa GH_REPO", () => {
    const ev = runTryMergeGate("design");
    assert.deepEqual(ev, [
      "gate GH_REPO=vjpixel/diaria-design",
      "merge-lock-acquire merge-lock-acquire --kind continuo-review --session-id continuo-review-test --repo vjpixel/diaria-design",
      "merge GH_REPO=vjpixel/diaria-design 26",
      "merge-lock-release merge-lock-release --kind continuo-review --session-id continuo-review-test --repo vjpixel/diaria-design",
      "after GH_REPO=vjpixel/diaria-design",
      "reset GH_REPO=",
    ]);
  });

  it("vez do studio: comportamento de sempre (sem GH_REPO, sem --repo, git pull depois do merge)", () => {
    const ev = runTryMergeGate("studio");
    assert.deepEqual(ev, [
      "gate GH_REPO=",
      "merge-lock-acquire merge-lock-acquire --kind continuo-review --session-id continuo-review-test",
      "merge GH_REPO= 26",
      "pull",
      "merge-lock-release merge-lock-release --kind continuo-review --session-id continuo-review-test",
      "after GH_REPO=",
      "reset GH_REPO=",
    ]);
  });

  it("log_infra_error grava `repo` só na PR do design e rotula o resumo com o repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuo-design-log-10900-"));
    try {
      const log = join(dir, "infra.jsonl");
      const out = execFileSync("bash", ["-c", [
        "set -euo pipefail",
        `INFRA_ERROR_LOG="${log}"`,
        'INFRA_ERROR_SUMMARY=""',
        'REPO="/x"; DESIGN_REPO="vjpixel/diaria-design"; DESIGN_DIR="/y"',
        extractFn("select_review_repo"),
        extractFn("log_infra_error"),
        "select_review_repo studio; log_infra_error 21 a 'motivo studio'",
        "select_review_repo design; log_infra_error 21 b 'motivo design'",
        'printf "%s" "$INFRA_ERROR_SUMMARY"',
      ].join("\n")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const [studio, design] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(studio.repo, undefined);
      assert.equal(studio.pr, 21);
      assert.equal(design.repo, "vjpixel/diaria-design");
      assert.match(out, /^PR #21 \(a\): motivo studio$/m);
      assert.match(out, /^PR vjpixel\/diaria-design#21 \(b\): motivo design$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a listagem do design usa o mesmo filtro --jq da do studio (bot/* fora)", () => {
    const studio = /^PR_NUMBERS=\$\(gh pr list --state open --json number,headRefName \\\n\s+--jq '([^']+)'\)/m.exec(src);
    const design = /DESIGN_PR_NUMBERS=\$\(GH_REPO="\$DESIGN_REPO" gh pr list --state open --json number,headRefName \\\n\s+--jq '([^']+)'/m.exec(src);
    assert.ok(studio && design, "não encontrei as duas listagens");
    assert.equal(design[1], studio[1]);
  });

  it("o laço percorre studio e design, e a sessão de review roda no checkout do repo da PR", () => {
    assert.match(src, /for n in \$DESIGN_PR_NUMBERS; do PR_ITEMS="\$PR_ITEMS design:\$n"; done/);
    assert.match(src, /select_review_repo "\$\{PR_ITEM%%:\*\}"/);
    assert.match(src, /\(cd "\$REVIEW_CWD" && echo "\$PROMPT"/);
    assert.match(src, /check-pr-review-authenticity\.ts --pr "\$PR" \$\{TARGET_REPO:\+--repo "\$TARGET_REPO"\}/);
  });
});
