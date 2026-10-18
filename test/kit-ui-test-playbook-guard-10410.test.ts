/**
 * test/kit-ui-test-playbook-guard-10410.test.ts (#10410, #10411)
 *
 * O teste pela UI do Kit (#10395) manda o Claude in Chrome abrir o broadcast
 * REAL da edição (base inteira, `public: true`). A proibição de clicar em
 * Send/Schedule/Continue e a reação ao exit 11 do `--mark-ui-test-sent` são
 * prosa de playbook — este teste trava que elas continuem no ponto de uso
 * (passo 3/4 do §5c-1-kit) e que o gate do Stage 6 aponte pro caminho da UI.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

describe("§5c-1-kit: teste pela UI no broadcast real (#10410)", () => {
  const stage5 = read(".claude/agents/orchestrator-stage-5.md");
  const line = stage5.split("\n").find((l) => l.includes("Preferido — \"Send test email\" da UI do Kit")) ?? "";

  it("passo 3 proíbe Send/Schedule/Continue explicitamente", () => {
    assert.ok(line, "linha do caminho preferido não encontrada");
    assert.match(line, /PROIBIDO neste passo \(#10410\): clicar em Send, Schedule, Continue/);
    assert.match(line, /broadcast REAL/);
  });

  it("passo 4 documenta a releitura e o exit 11 como halt (nunca seguir)", () => {
    assert.match(line, /GET \/v4\/broadcasts\/\{id\}/);
    assert.match(line, /exit 11/);
    assert.match(line, /render-halt-banner\.ts/);
    assert.match(line, /nunca seguir pro §5f nem pro Stage 6/);
    assert.match(line, /exit 12/);
  });
});

describe("Stage 6: correção do rascunho Kit defasado (#10411)", () => {
  const stage6 = read(".claude/agents/orchestrator-stage-6.md");
  const line = stage6.split("\n").find((l) => l.includes("Rascunho Kit defasado (#9428")) ?? "";

  it("aponta --draft-only-for-ui-test + Send test + --mark-ui-test-sent; --send-test só fallback", () => {
    assert.ok(line);
    const pref = line.indexOf("--draft-only-for-ui-test");
    const mark = line.indexOf("--mark-ui-test-sent");
    const fallback = line.indexOf("--send-test");
    assert.ok(pref >= 0 && mark > pref && fallback > mark, "ordem: UI primeiro, --send-test por último");
    assert.match(line, /fallback só sem Chrome/);
  });
});
