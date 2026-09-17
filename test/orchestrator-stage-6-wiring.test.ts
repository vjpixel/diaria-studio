/**
 * test/orchestrator-stage-6-wiring.test.ts (#4574, revisado #8205)
 *
 * Grep tests pra garantir que orchestrator-stage-6.md referencia
 * corretamente o guard determinístico de slug do bloco WhatsApp (#4570) e o
 * backstop determinístico que o fecha (#4574) — sem isso, o mecanismo
 * mais crítico do Stage 6 dependia 100% de prosa lida por um agente LLM,
 * sem nenhuma verificação em código de que o guard rodou, rodou
 * corretamente, ou passou antes do pipeline marcar o Stage 6 como concluído
 * (achado convergente pr-test-analyzer + silent-failure-hunter, review
 * consolidado da PR #4574). Mesmo padrão de `test/beehiiv-playbook-wiring.test.ts`
 * (#1433) — helpers/scripts órfãos no prompt quebram em runtime sem esse
 * guard falhar antes.
 *
 * #8205 (17/09/2026): a issue tornou a revisão visual do e-mail de teste
 * pelo editor a ÚNICA parada de `/diaria-5-publicacao`. O guard de slug
 * deixou de ser um 2º ponto de parada (halt banner + "responda 'corrigido'")
 * — agora roda ANTES do gate único (§6b-slug) e, se divergir, vira aviso
 * destacado dentro do gate, nunca um halt separado. Este arquivo foi
 * atualizado para refletir esse comportamento; os testes que checavam a
 * antiga semântica "GATE-BLOCKING com halt banner" foram substituídos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_6 = resolve(ROOT, ".claude/agents/orchestrator-stage-6.md");

describe("orchestrator-stage-6.md wiring do guard de slug WhatsApp (#4570, backstop #4574, não-bloqueante desde #8205)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("referencia check-whatsapp-slug-guard.ts", () => {
    assert.match(stage6, /check-whatsapp-slug-guard\.ts/);
  });

  it("referencia a issue #4570 (origem do guard)", () => {
    assert.match(stage6, /#4570/);
  });

  it("#4574: referencia a issue #4574 (backstop determinístico)", () => {
    assert.match(stage6, /#4574/);
  });

  it("#4574: a chamada do guard passa --out apontando pra _internal/whatsapp-slug-check.json", () => {
    assert.match(stage6, /check-whatsapp-slug-guard\.ts[\s\S]*?--out\s+\{EDITION_DIR\}\/_internal\/whatsapp-slug-check\.json/);
  });

  it("#4574: o resultado do guard é logado via scripts/log-event.ts", () => {
    const guardIdx = stage6.indexOf("check-whatsapp-slug-guard.ts");
    assert.ok(guardIdx !== -1);
    const afterGuard = stage6.slice(guardIdx, guardIdx + 1500);
    assert.match(
      afterGuard,
      /npx tsx scripts\/log-event\.ts/,
      "chamada a check-whatsapp-slug-guard.ts deve ser seguida de um log-event.ts registrando o resultado",
    );
  });

  it("#4574: falha do get_post é tratada explicitamente como falha de MCP (#738), fail-closed", () => {
    const getPostIdx = stage6.indexOf("mcp__claude_ai_Beehiiv__get_post");
    assert.ok(getPostIdx !== -1, "stage-6 deve chamar get_post pra buscar o slug real");
    const aroundGetPost = stage6.slice(getPostIdx, getPostIdx + 600);
    assert.match(
      aroundGetPost,
      /falhar.*erroar|falha de MCP/i,
      "deve instruir explicitamente o que fazer se get_post falhar (não só retornar slug ausente)",
    );
    assert.match(aroundGetPost, /#738/);
  });

  it("#4574: §6g (check-invariants --stage 6) referencia a regra whatsapp-slug-guard-ok", () => {
    const section6g = stage6.slice(stage6.indexOf("### 6g."), stage6.indexOf("### 6h."));
    assert.ok(section6g.length > 0, "§6g não encontrada");
    assert.match(section6g, /whatsapp-slug-guard-ok/);
  });

  it("#8205: o guard de slug (§6b-slug) roda ANTES do gate único (§6c) no arquivo", () => {
    const slugIdx = stage6.indexOf("### 6b-slug.");
    const gateIdx = stage6.indexOf("### 6c.");
    assert.ok(slugIdx !== -1, "§6b-slug não encontrada");
    assert.ok(gateIdx !== -1, "§6c não encontrada");
    assert.ok(slugIdx < gateIdx, "§6b-slug deve vir ANTES de §6c — o resultado precisa alimentar o gate único");
  });

  it("#8205: o guard de slug NÃO renderiza mais halt banner pedindo confirmação de divergência", () => {
    const slugIdx = stage6.indexOf("### 6b-slug.");
    const gateIdx = stage6.indexOf("### 6c.");
    const slugSection = stage6.slice(slugIdx, gateIdx);
    assert.ok(!/responda 'corrigido'/.test(slugSection), "§6b-slug não deve mais pedir 'corrigido' — divergência é aviso, não gate");
    assert.match(
      slugSection,
      /aviso destacado/,
      "§6b-slug deve documentar que a divergência vira aviso dentro do gate único, não um halt separado",
    );
  });

  it("#8205: o único halt banner dentro de §6b-slug é para falha de MCP (#738), não para divergência de slug", () => {
    const slugIdx = stage6.indexOf("### 6b-slug.");
    const gateIdx = stage6.indexOf("### 6c.");
    const slugSection = stage6.slice(slugIdx, gateIdx);
    const haltIdx = slugSection.indexOf("render-halt-banner.ts");
    assert.ok(haltIdx !== -1, "§6b-slug deve manter o halt banner de falha de MCP (#738)");
    const haltBlock = slugSection.slice(haltIdx - 20, haltIdx + 400);
    assert.match(haltBlock, /--reason\s+"mcp__claude_ai_Beehiiv desconectado/);
    assert.ok(!/--reason\s+"slug do post diverge/.test(slugSection), "não deve haver halt banner com --reason de slug divergente");
  });

  it("#8205: §6d referencia o resultado já computado em §6b-slug, sem re-rodar o guard nem repetir o loop de confirmação", () => {
    const sixDIdx = stage6.indexOf("### 6d.");
    const sixDKitIdx = stage6.indexOf("### 6d-kit.");
    assert.ok(sixDIdx !== -1 && sixDKitIdx !== -1);
    const sixD = stage6.slice(sixDIdx, sixDKitIdx);
    assert.match(sixD, /já conferido em §6b-slug/);
    assert.ok(!/responda 'corrigido'/.test(sixD));
  });

  it("#8205: o gate único (§6c) usa a wording ok/ok HH:MM/abortar (não mais sim/sim HH:MM)", () => {
    const sixCIdx = stage6.indexOf("### 6c.");
    const sixDIdx = stage6.indexOf("### 6d.");
    const sixC = stage6.slice(sixCIdx, sixDIdx);
    assert.match(sixC, /ok\s+HH:MM/);
    assert.match(sixC, /\bok\b.*→ agenda/);
  });

  it("#8205: o gate único (§6c) pede explicitamente a revisão visual do e-mail de teste", () => {
    const sixCIdx = stage6.indexOf("### 6c.");
    const sixDIdx = stage6.indexOf("### 6d.");
    const sixC = stage6.slice(sixCIdx, sixDIdx);
    assert.match(sixC, /Confira o e-mail de teste/i);
    assert.match(sixC, /test_email/);
  });
});

describe("orchestrator-stage-6.md — parada única do pipeline (#8205)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("§6b2 (pedidos editoriais) não tem mais loop de confirmação interativa", () => {
    const idx6b2 = stage6.indexOf("### 6b2.");
    const idx6bSlug = stage6.indexOf("### 6b-slug.");
    assert.ok(idx6b2 !== -1 && idx6bSlug !== -1);
    const section = stage6.slice(idx6b2, idx6bSlug);
    assert.ok(!/confirmar\s+corrigir\s+N/i.test(section));
    assert.ok(!section.includes("Confirmar tudo, corrigir uma entrada"));
    assert.match(section, /sem gate/);
  });

  it("§6b-3 (auto-reporter) documenta execução sem gate", () => {
    const idx = stage6.indexOf("### 6b-3.");
    assert.ok(idx !== -1);
    const section = stage6.slice(idx, idx + 600);
    assert.match(section, /sem gate/i);
  });

  it("count total de headers que descrevem uma parada interativa aguardando resposta do editor é exatamente 1 (§6c)", () => {
    // Heurística: "Aguardar resposta do editor" (ou equivalente) só deve
    // aparecer associado ao gate único de §6c — qualquer outra ocorrência
    // reintroduziria uma 2ª parada.
    const matches = stage6.match(/Aguardar resposta do editor/g) ?? [];
    assert.equal(matches.length, 1, `esperava exatamente 1 ocorrência de "Aguardar resposta do editor" (o gate único de §6c), achei ${matches.length}`);
  });
});
