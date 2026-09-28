/**
 * test/propose-intentional-error-candidate-cli-8592.test.ts (#8592)
 *
 * Casca fina do CLI (`scripts/propose-intentional-error-candidate.ts`) sobre
 * `proposeIntentionalErrorCandidate` (já coberto a fundo em
 * `propose-intentional-error-candidate-8592.test.ts`). Cobre só o
 * roteamento de flags + exit codes — nunca escreve nada em disco (o script
 * é read-only por design).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../scripts/propose-intentional-error-candidate.ts";

describe("#8592: CLI propose-intentional-error-candidate", () => {
  it("sem --md nem --edition-dir → exit 2 (uso inválido)", () => {
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      assert.equal(main([]), 2);
      assert.ok(logged.some((l) => /Uso:/.test(l)));
    } finally {
      console.error = originalError;
    }
  });

  it("--md apontando pra arquivo inexistente → exit 2", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(main(["--md", "/tmp/definitely-does-not-exist-8592.md"]), 2);
    } finally {
      console.error = originalError;
    }
  });

  it("--edition-dir com 02-reviewed.md existente e candidato encontrado → exit 0, stdout com candidate preenchido", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-propose-ie-cli-"));
    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "**RADAR**\n[Notícia sobre Claude](https://example.com/x)\nUm comentário sobre Claude, da Anthropic.\n",
      );
      const exitCode = main(["--edition-dir", dir]);
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(logged.join("\n"));
      assert.equal(parsed.candidate.correct_value, "Claude");
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md sem nenhuma entidade conhecida → exit 0, candidate: null", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-propose-ie-cli-"));
    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "**RADAR**\n[Notícia qualquer](https://example.com/y)\nSem marca conhecida.\n");
      const exitCode = main(["--edition-dir", dir]);
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(logged.join("\n"));
      assert.equal(parsed.candidate, null);
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
