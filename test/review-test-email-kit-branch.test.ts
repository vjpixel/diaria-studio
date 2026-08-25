/**
 * test/review-test-email-kit-branch.test.ts (#6113)
 *
 * Grep tests cobrindo o branch `platform: "kit"` do agent review-test-email —
 * item 4 (teste de regressão) da checklist da #6113. O branch em si foi
 * entregue na PR #6096 (#464); esta suíte garante que os invariantes dele
 * não desaparecem do spec do agent nem do wiring do orchestrator:
 *
 * - .claude/agents/review-test-email.md — Processo Kit completo
 *   (K1 busca Gmail pelo remetente oi@news.diar.ia.br, K2 subject com
 *   prefixo `[teste] `, K3 ressalvas de renderização NÃO reportadas como
 *   issue, output com platform "kit");
 * - .claude/agents/orchestrator-stage-5.md — loop §5f invoca o agent com
 *   platform "kit" quando publishing.newsletter.backend = kit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_AGENT = resolve(ROOT, ".claude/agents/review-test-email.md");
const ORCHESTRATOR_5 = resolve(ROOT, ".claude/agents/orchestrator-stage-5.md");

describe("review-test-email branch kit (#6113)", () => {
  const reviewAgent = readFileSync(REVIEW_AGENT, "utf8");
  const orchestrator = readFileSync(ORCHESTRATOR_5, "utf8");

  // Extrai só a seção "Processo Kit" pra as asserts não cruzarem com o
  // processo Beehiiv/Brevo do mesmo arquivo.
  const kitSection = () => {
    const start = reviewAgent.indexOf("## Processo Kit");
    assert.ok(start !== -1, "review-test-email.md deve ter seção '## Processo Kit'");
    const next = reviewAgent.indexOf("\n## ", start + 1);
    return reviewAgent.slice(start, next === -1 ? undefined : next);
  };

  it("union de platform documenta 'kit' além de beehiiv/brevo", () => {
    assert.match(
      reviewAgent,
      /`platform`.*"beehiiv".*"kit".*"brevo"|`platform`.*"kit"/s,
      "parâmetro platform deve aceitar 'kit' (#464/#6113)",
    );
  });

  it("platform = kit roda SÓ o Processo Kit (pula seções Beehiiv)", () => {
    assert.match(
      reviewAgent,
      /Se `platform = "kit"`.*Pular todo o processo Beehiiv/s,
      "dispatch por platform=kit deve pular o processo Beehiiv",
    );
  });

  it("K1: busca Gmail pelo remetente próprio oi@news.diar.ia.br (não beehiiv.com)", () => {
    assert.match(kitSection(), /oi@news\.diar\.ia\.br/,
      "Processo Kit deve buscar emails de teste do remetente do Kit confirmado ao vivo");
  });

  it("K2: subject do test-send Kit usa prefixo '[teste] ' minúsculo", () => {
    assert.match(kitSection(), /\[teste\]/,
      "K2 deve documentar o prefixo minúsculo aplicado pelo publish-newsletter-kit.ts");
  });

  it("K3: ressalvas de renderização do Kit são NÃO-reportáveis como issue", () => {
    assert.match(kitSection(), /NÃO reportar como issue/,
      "comportamento esperado do Kit (inlining, shell próprio) não pode virar falso-positivo");
  });

  it("#6115-do-corpo: links reescritos pelo Kit não podem virar link morto", () => {
    // Item medido ao vivo em 25/08 e registrado no corpo da #6113: todos os
    // links saem como click.kit-mail3.com/.../<base64> — checagem ingênua de
    // href quebra; o spec precisa tratar tracking-domain como ressalva.
    assert.match(
      kitSection(),
      /click\.|tracking|reescrit/i,
      "Processo Kit deve documentar reescrita de links pelo domínio de tracking do Kit",
    );
  });

  it("output JSON do processo Kit carrega platform: 'kit'", () => {
    assert.match(kitSection(), /"platform"\s*:\s*"kit"/);
  });

  it("orchestrator-stage-5 §5f passa platform 'kit' ao agent quando backend é kit", () => {
    assert.match(
      orchestrator,
      /review-test-email[\s\S]{0,400}platform[^\n]*"kit"|"kit"[^\n]*review-test-email|platform:\s*"kit"/i,
      "loop de review do Stage 5 deve invocar o agent com platform=kit no backend Kit (#6096)",
    );
  });
});
