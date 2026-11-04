/**
 * test/gh-pr-review-api-body-12169.test.ts (#12169)
 *
 * Rodada overnight 261104b: implementadores e fixers de sessões diferentes
 * escreviam o corpo dos comentários de self-review em `f1.md`/`f2.md` no
 * scratchpad compartilhado; na PR #12135 dois comentários de OUTRA sessão
 * (sobre a #12114) saíram na PR errada, porque o arquivo foi reescrito entre a
 * escrita e o `gh-pr-review-api.ts comment`.
 *
 * Cobre:
 *   - `--body` inline e `--body-file -` (stdin) dispensam o arquivo;
 *   - `--body-file` de nome genérico é recusado (exit 2) sem chamar o `gh`;
 *   - nome com o número da issue/PR passa;
 *   - `--body` e `--body-file` juntos são recusados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXIT_OK, EXIT_USAGE, isUniqueBodyFileName, runCli, type GhRunFn } from "../scripts/gh-pr-review-api.ts";
import { AUTO_REVIEW_MARKER } from "../scripts/lib/auto-review-marker.ts";

const SHA = "1f1b431d7057630378cefe88efafd776f1c6079a";
const ROOT = process.cwd();

function fakeGh() {
  const calls: string[][] = [];
  const run: GhRunFn = (args) => {
    calls.push(args);
    return { status: 0, stdout: "https://github.com/x/pull/5#discussion_r1", stderr: "" };
  };
  return { run, calls };
}
const noFiles = (p: string): string => {
  throw new Error(`ENOENT: ${p}`);
};
const comment = (...body: string[]) => ["comment", "--pr", "5", "--path", "a.ts", "--line", "3", "--commit", SHA, ...body];

describe("gh-pr-review-api: corpo sem arquivo intermediário (#12169)", () => {
  it("--body inline vira o corpo, com o marcador da automação", () => {
    const gh = fakeGh();
    const r = runCli(comment("--body", "Confiança média, P3: achado"), gh.run, noFiles, ROOT);
    assert.equal(r.exitCode, EXIT_OK, r.stderr);
    assert.ok(gh.calls[0].includes(`body=Confiança média, P3: achado\n\n${AUTO_REVIEW_MARKER}`));
  });

  it("--body-file - lê o corpo do stdin", () => {
    const gh = fakeGh();
    const r = runCli(comment("--body-file", "-"), gh.run, noFiles, ROOT, () => "do stdin\n");
    assert.equal(r.exitCode, EXIT_OK, r.stderr);
    assert.ok(gh.calls[0].some((a) => a.startsWith("body=do stdin")));
  });

  it("reply aceita --body inline", () => {
    const gh = fakeGh();
    const r = runCli(["reply", "--pr", "5", "--comment-id", "9", "--body", "recuso: x"], gh.run, noFiles, ROOT);
    assert.equal(r.exitCode, EXIT_OK, r.stderr);
  });
});

describe("gh-pr-review-api: --body-file de nome genérico é recusado (#12169)", () => {
  it("cenário da PR #12135: f1.md no scratchpad compartilhado não é postado", () => {
    for (const path of ["/tmp/claude-1000/x/scratchpad/f1.md", "/tmp/f2.md", "finding.md", "/tmp/12135/f1.md"]) {
      const gh = fakeGh();
      const r = runCli(comment("--body-file", path), gh.run, () => "texto de outra sessão", ROOT);
      assert.equal(r.exitCode, EXIT_USAGE, path);
      assert.match(r.stderr, /nome genérico/, path);
      assert.equal(gh.calls.length, 0, `nada postado para ${path}`);
    }
  });

  it("nome com o número da issue/PR passa", () => {
    const gh = fakeGh();
    const r = runCli(comment("--body-file", "/tmp/sr-12169-4821.md"), gh.run, () => "meu achado", ROOT);
    assert.equal(r.exitCode, EXIT_OK, r.stderr);
  });

  it("isUniqueBodyFileName olha só o nome-base", () => {
    assert.equal(isUniqueBodyFileName("/tmp/sr10606-1.md"), true);
    assert.equal(isUniqueBodyFileName("C:\\Temp\\sr-12169-7.md"), true);
    assert.equal(isUniqueBodyFileName("/tmp/12169/f1.md"), false);
    assert.equal(isUniqueBodyFileName("/tmp/f123.md"), false);
  });

  it("--body e --body-file juntos, ou nenhum dos dois: exit 2 sem chamar o gh", () => {
    for (const argv of [comment("--body", "a", "--body-file", "/tmp/sr-12169-1.md"), comment(), comment("--body", "  ")]) {
      const gh = fakeGh();
      const r = runCli(argv, gh.run, () => "x", ROOT, () => "x");
      assert.equal(r.exitCode, EXIT_USAGE, JSON.stringify(argv));
      assert.equal(gh.calls.length, 0);
    }
  });
});
