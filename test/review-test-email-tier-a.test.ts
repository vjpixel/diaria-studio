/**
 * test/review-test-email-tier-a.test.ts (#1212 Tier A)
 *
 * Grep tests pra garantir que invariantes do fail-closed bailout estão
 * presentes em:
 * - .claude/agents/review-test-email.md (spec do agent)
 * - .claude/agents/orchestrator-stage-4.md (handling do orchestrator)
 *
 * Pre-fix: agent retornava status: "email_not_found" e orchestrator
 * tratava como "review limpo" (review_completed=true). 8/8 edições
 * (260505-260513) caíram nesse falso negativo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_AGENT = resolve(ROOT, ".claude/agents/review-test-email.md");
const ORCHESTRATOR_4 = resolve(ROOT, ".claude/agents/orchestrator-stage-4.md");

describe("review-test-email Tier A (#1212)", () => {
  const reviewAgent = readFileSync(REVIEW_AGENT, "utf8");
  const orchestrator = readFileSync(ORCHESTRATOR_4, "utf8");

  it("review-test-email retorna status: 'inconclusive' quando email não chega", () => {
    assert.match(reviewAgent, /status.*inconclusive/i,
      "review-test-email.md deve documentar status: inconclusive (fail-closed)");
  });

  it("review-test-email NÃO retorna mais 'email_not_found' como ok", () => {
    // Verificar que o spec proíbe explicitamente review_completed=true neste caminho
    assert.match(reviewAgent, /NUNCA retornar.*review_completed.*true|fail-closed/i,
      "review-test-email.md deve proibir explicitamente review_completed=true em email_not_found");
  });

  it("orchestrator-stage-4 trata status 'inconclusive' separadamente", () => {
    assert.match(orchestrator, /status.*inconclusive/i,
      "orchestrator-stage-4.md deve documentar tratamento de status: inconclusive");
  });

  it("orchestrator-stage-4 gate display mostra AMBOS review_final_issues + unfixed_issues", () => {
    // Pre-#1212: gate só mostrava review_final_issues
    assert.match(orchestrator, /unfixed_issues.*review_final_issues|review_final_issues.*unfixed_issues/s,
      "gate deve exibir tanto unfixed_issues quanto review_final_issues");
  });

  it("orchestrator-stage-4 introduz review_status field", () => {
    assert.match(orchestrator, /review_status/,
      "orchestrator-stage-4.md deve introduzir review_status field em 05-published.json");
  });

  it("#1434: orchestrator-stage-4 chama filterAgentIssues antes de fix-mode", () => {
    // Sem wire, lib `scripts/lib/agent-issue-validator.ts` fica órfã e
    // bugs do #1421 continuam runtime via fix-mode disparado pra
    // "corrigir" falso-positivos. Esse test guarda contra revert silencioso.
    assert.match(
      orchestrator,
      /filterAgentIssues/,
      "orchestrator-stage-4.md deve mencionar filterAgentIssues pré-fix-mode (#1434)",
    );
    assert.match(
      orchestrator,
      /agent-issue-validator/,
      "orchestrator-stage-4.md deve referenciar o path da lib pra contexto",
    );
  });

  it("#1434: context/agents-known-issues.md existe e documenta o viés do review-test-email", () => {
    const knownIssues = readFileSync(
      resolve(ROOT, "context/agents-known-issues.md"),
      "utf8",
    );
    assert.match(knownIssues, /review-test-email/i);
    assert.match(knownIssues, /encoding/i);
    assert.match(knownIssues, /#1421/);
  });
});
