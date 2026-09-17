/**
 * test/resolve-edition-scheduled-at-8207.test.ts (#8207)
 *
 * Cobre o wrapper CLI `scripts/resolve-edition-scheduled-at.ts` — o que
 * `.claude/agents/orchestrator-stage-6.md` passa a chamar nos DOIS ramos do
 * gate (`sim` default e `sim HH:MM`), em vez de duas rotas de cálculo
 * divergentes (a causa raiz do #8207).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { main } from "../scripts/resolve-edition-scheduled-at.ts";

describe("resolve-edition-scheduled-at CLI (#8207)", () => {
  let originalArgv: string[];
  let originalWrite: typeof process.stdout.write;
  let stdout: string;

  beforeEach(() => {
    originalArgv = process.argv;
    originalWrite = process.stdout.write.bind(process.stdout);
    stdout = "";
    process.stdout.write = ((chunk: string) => {
      stdout += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.stdout.write = originalWrite;
    process.exitCode = undefined;
  });

  it("--aammdd sem --hhmm → default 06:00 BRT", () => {
    process.argv = ["node", "resolve-edition-scheduled-at.ts", "--aammdd", "260917"];
    main();
    assert.equal(stdout, "2026-09-17T09:00:00.000Z");
    assert.equal(process.exitCode, undefined);
  });

  it("--aammdd + --hhmm → horário pedido", () => {
    process.argv = ["node", "resolve-edition-scheduled-at.ts", "--aammdd", "260917", "--hhmm", "18:30"];
    main();
    assert.equal(stdout, "2026-09-17T21:30:00.000Z");
  });

  it("--aammdd ausente → exitCode 1, nada no stdout", () => {
    process.argv = ["node", "resolve-edition-scheduled-at.ts"];
    main();
    assert.equal(process.exitCode, 1);
    assert.equal(stdout, "");
  });

  it("AAMMDD/HH:MM inválidos → exitCode 1", () => {
    process.argv = ["node", "resolve-edition-scheduled-at.ts", "--aammdd", "260631"];
    main();
    assert.equal(process.exitCode, 1);
  });
});
