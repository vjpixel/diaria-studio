/**
 * test/check-pr-checks-gate-claude-binary-guard.test.ts (#7189)
 *
 * Regressão do cenário real da issue: `npx tsx
 * scripts/check-pr-checks-gate.ts --pr 7161` devolveu, no lugar de um
 * `statusCheckRollup` JSON, o texto de erro do pacote
 * `@anthropic-ai/claude-code` ("claude native binary not installed") — e
 * isso NUNCA pode virar `verdict: "pass"`/`"fail"` (que uma leitura
 * automatizada trataria como veredito real do gate de merge), nem cair
 * dentro do `verdict: "error"` genérico (o chamador precisa distinguir
 * "payload malformado" de "ambiente corrompido" — exit code dedicado).
 *
 * Testa `resolveGateResult`, que é PURA (recebe o `spawnSync` já
 * executado) — não dispara um `gh` real nem toca rede/CI, e roda
 * determinística em qualquer ambiente (inclusive um onde o binário claude
 * ESTÁ instalado corretamente, que é o caso comum em CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGateResult, type GhPrViewSpawnOutcome } from "../scripts/check-pr-checks-gate.ts";

/** Texto exato reportado ao vivo na issue #7189. */
const CLAUDE_BINARY_ERROR_TEXT = `Error: claude native binary not installed.

Either postinstall did not run (--ignore-scripts, some pnpm configs)
or the platform-native optional dependency was not downloaded
(--omit=optional).

Run the postinstall manually (adjust path for local vs global install):
  node node_modules/@anthropic-ai/claude-code/install.cjs`;

function spawnOutcome(partial: Partial<GhPrViewSpawnOutcome>): GhPrViewSpawnOutcome {
  return { error: undefined, status: 0, stdout: "", stderr: "", ...partial };
}

describe("resolveGateResult — regressão #7189: erro de binário nativo nunca vira veredito de check", () => {
  it("assinatura no stdout (reprodução literal do achado ao vivo) => verdict dedicado, nunca pass/fail/error genérico", () => {
    const result = resolveGateResult(
      spawnOutcome({ status: 0, stdout: CLAUDE_BINARY_ERROR_TEXT, stderr: "" }),
    );
    assert.equal(result.verdict, "claude_binary_error");
    assert.match(result.reason, /claude native binary not installed/);
    assert.match(result.reason, /stdout/);
    assert.deepEqual(result.failingChecks, []);
    assert.deepEqual(result.pendingChecks, []);
  });

  it("assinatura no stderr (com status != 0, como um crash do wrapper emitiria) => também dedicado, não 'error' genérico", () => {
    const result = resolveGateResult(
      spawnOutcome({ status: 1, stdout: "", stderr: CLAUDE_BINARY_ERROR_TEXT }),
    );
    assert.equal(result.verdict, "claude_binary_error");
    assert.match(result.reason, /stderr/);
  });

  it("assinatura na mensagem de erro do próprio spawnSync (ex: ENOENT disfarçado) => também dedicado", () => {
    const result = resolveGateResult(
      spawnOutcome({ error: new Error(CLAUDE_BINARY_ERROR_TEXT), status: null }),
    );
    assert.equal(result.verdict, "claude_binary_error");
    assert.match(result.reason, /mensagem de erro do spawn/);
  });

  it("checagem da assinatura vence mesmo quando o JSON também é válido — nunca tenta parsear no meio do texto de erro", () => {
    // Caso hipotético: a assinatura aparece concatenada a um JSON válido.
    // A checagem de ambiente roda ANTES do parse, então nunca cai no branch
    // de "JSON malformado" nem tenta interpretar o resto como rollup.
    const result = resolveGateResult(
      spawnOutcome({
        status: 0,
        stdout: `${CLAUDE_BINARY_ERROR_TEXT}\n{"statusCheckRollup":[]}`,
        stderr: "",
      }),
    );
    assert.equal(result.verdict, "claude_binary_error");
  });

  it("payload normal SEM a assinatura continua caindo no caminho de veredito real (regressão de comportamento pré-#7189)", () => {
    const result = resolveGateResult(
      spawnOutcome({
        status: 0,
        stdout: JSON.stringify({
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
        stderr: "",
      }),
    );
    assert.equal(result.verdict, "pass");
  });

  it("falha de comando genuína (JSON malformado, sem a assinatura) continua 'error', não 'claude_binary_error'", () => {
    const result = resolveGateResult(spawnOutcome({ status: 0, stdout: "{not json", stderr: "" }));
    assert.equal(result.verdict, "error");
  });
});
