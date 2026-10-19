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

describe("#10465: --verify-ui-test-draft ligado nos playbooks dos Stages 5 e 6", () => {
  const stage5 = read(".claude/agents/orchestrator-stage-5.md");
  const stage6 = read(".claude/agents/orchestrator-stage-6.md");

  it("§5c-1-kit: passo 5 roda a releitura com ou sem o passo 4, exit 11 é halt", () => {
    const line = stage5.split("\n").find((l) => l.includes("Preferido — \"Send test email\" da UI do Kit")) ?? "";
    const verify = line.indexOf("--verify-ui-test-draft");
    assert.ok(verify > line.indexOf("--mark-ui-test-sent --at"), "verify vem depois do passo 4");
    assert.match(line.slice(verify - 400), /com ou sem o passo 4 \(#10465\)/);
    assert.match(line.slice(verify), /exit 11 = mesmo halt banner do passo 4, parar o Stage 5/);
  });

  it("§5f: exit 5 (ui_test_not_marked) relê o broadcast antes de gravar inconclusive", () => {
    const line = stage5.split("\n").find((l) => l.includes("Pré-buscar o e-mail de teste no top-level (#9000)")) ?? "";
    const exit5 = line.indexOf("exit 5 (só Kit");
    const verify = line.indexOf("--verify-ui-test-draft", exit5);
    const inconclusive = line.indexOf("`reason: \"ui_test_not_marked\"`", exit5);
    assert.ok(exit5 >= 0 && verify > exit5 && inconclusive > verify);
    assert.match(line.slice(verify), /exit 11 → halt banner/);
  });

  it("Stage 6: releitura antes do gate e do Schedule, exit 11 para a Etapa 6", () => {
    const line = stage6.split("\n").find((l) => l.includes("depois do teste pela UI (#10465")) ?? "";
    assert.ok(line, "bullet do #10465 ausente no Stage 6");
    assert.match(line, /--verify-ui-test-draft/);
    assert.match(line, /ANTES do gate e de qualquer Schedule/);
    assert.match(line, /Exit 11 → halt banner/);
    assert.match(line, /render-halt-banner\.ts/);
  });
});
