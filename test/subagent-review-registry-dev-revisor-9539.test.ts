/**
 * test/subagent-review-registry-dev-revisor-9539.test.ts (#9539 item 2)
 *
 * As skills overnight/develop nomeiam `dev-revisor` (#9081) como fallback do
 * review quando o plugin `pr-review-toolkit` está ausente. Sem ele em
 * `REVIEW_AGENT_TYPES`, o review feito por esse agente nunca entrava no
 * registro de subagentes revisores.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_AGENT_TYPES, buildStartRecord } from "../.claude/hooks/subagent-review-registry-start.mjs";

describe("#9539 — dev-revisor entra no registro de revisores", () => {
  it("REVIEW_AGENT_TYPES lista dev-revisor", () => {
    assert.ok(REVIEW_AGENT_TYPES.has("dev-revisor"));
  });

  it("buildStartRecord registra um dispatch de dev-revisor", () => {
    const rec = buildStartRecord(
      { agent_id: "a1", agent_type: "dev-revisor", session_id: "s1" },
      { repoRoot: "/tmp/nao-usado", execFn: () => "abc123\n", nonceFn: () => "n1" },
    );
    assert.ok(rec, "dev-revisor deveria gerar registro");
    assert.equal(rec.agent_type, "dev-revisor");
  });

  it("agente fora da lista continua ignorado", () => {
    const rec = buildStartRecord(
      { agent_id: "a2", agent_type: "dev-implementador" },
      { repoRoot: "/tmp/nao-usado", execFn: () => "abc123\n", nonceFn: () => "n2" },
    );
    assert.equal(rec, null);
  });
});
