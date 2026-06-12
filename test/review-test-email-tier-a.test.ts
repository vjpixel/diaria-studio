/**
 * test/review-test-email-tier-a.test.ts (#1212 Tier A)
 *
 * Grep tests pra garantir que invariantes do fail-closed bailout estão
 * presentes em:
 * - .claude/agents/review-test-email.md (spec do agent)
 * - .claude/agents/orchestrator-stage-5.md (handling do orchestrator — publicação)
 *
 * Pre-fix: agent retornava status: "email_not_found" e orchestrator
 * tratava como "review limpo" (review_completed=true). 8/8 edições
 * (260505-260513) caíram nesse falso negativo.
 *
 * #1694: publication logic moved from orchestrator-stage-4.md to
 * orchestrator-stage-5.md (Stage 4 is now "Revisão"; Stage 5 is "Publicação").
 * Tests updated to check orchestrator-stage-5.md for publication invariants.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_AGENT = resolve(ROOT, ".claude/agents/review-test-email.md");
// #1694: publication logic is in Stage 5 now; Stage 4 = Revisão
const ORCHESTRATOR_5 = resolve(ROOT, ".claude/agents/orchestrator-stage-5.md");

describe("review-test-email Tier A (#1212)", () => {
  const reviewAgent = readFileSync(REVIEW_AGENT, "utf8");
  const orchestrator = readFileSync(ORCHESTRATOR_5, "utf8");

  it("review-test-email retorna status: 'inconclusive' quando email não chega", () => {
    assert.match(reviewAgent, /status.*inconclusive/i,
      "review-test-email.md deve documentar status: inconclusive (fail-closed)");
  });

  it("review-test-email NÃO retorna mais 'email_not_found' como ok", () => {
    // Verificar que o spec proíbe explicitamente review_completed=true neste caminho
    assert.match(reviewAgent, /NUNCA retornar.*review_completed.*true|fail-closed/i,
      "review-test-email.md deve proibir explicitamente review_completed=true em email_not_found");
  });

  it("orchestrator-stage-5 trata status 'inconclusive' separadamente", () => {
    // #1694: publication loop moved to stage-5.md — check that file now
    assert.match(orchestrator, /status.*inconclusive/i,
      "orchestrator-stage-5.md deve documentar tratamento de status: inconclusive");
  });

  it("orchestrator-stage-5 gate display mostra AMBOS review_final_issues + unfixed_issues", () => {
    // Pre-#1212: gate só mostrava review_final_issues
    // #1694: gate is in stage-5.md now
    assert.match(orchestrator, /unfixed_issues.*review_final_issues|review_final_issues.*unfixed_issues/s,
      "gate deve exibir tanto unfixed_issues quanto review_final_issues (stage-5.md)");
  });

  it("orchestrator-stage-5 introduz review_status field", () => {
    // #1694: review loop is in stage-5.md
    assert.match(orchestrator, /review_status/,
      "orchestrator-stage-5.md deve introduzir review_status field em 05-published.json");
  });

  it("#1434: orchestrator-stage-5 chama filterAgentIssues antes de fix-mode", () => {
    // Sem wire, lib `scripts/lib/agent-issue-validator.ts` fica órfã e
    // bugs do #1421 continuam runtime via fix-mode disparado pra
    // "corrigir" falso-positivos. Esse test guarda contra revert silencioso.
    // #1694: check moved to stage-5.md
    assert.match(
      orchestrator,
      /filterAgentIssues/,
      "orchestrator-stage-5.md deve mencionar filterAgentIssues pré-fix-mode (#1434)",
    );
    assert.match(
      orchestrator,
      /agent-issue-validator/,
      "orchestrator-stage-5.md deve referenciar o path da lib pra contexto",
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
