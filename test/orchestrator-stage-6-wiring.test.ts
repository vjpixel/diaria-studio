/**
 * test/orchestrator-stage-6-wiring.test.ts (#4574)
 *
 * Grep tests pra garantir que orchestrator-stage-6.md referencia
 * corretamente o guard determinístico de slug do bloco WhatsApp (#4570) e o
 * backstop determinístico que o fecha (#4574) — sem isso, o mecanismo
 * GATE-BLOCKING mais crítico do Stage 6 dependia 100% de prosa lida por um
 * agente LLM, sem nenhuma verificação em código de que o guard rodou, rodou
 * corretamente, ou passou antes do pipeline marcar o Stage 6 como concluído
 * (achado convergente pr-test-analyzer + silent-failure-hunter, review
 * consolidado da PR #4574). Mesmo padrão de `test/beehiiv-playbook-wiring.test.ts`
 * (#1433) — helpers/scripts órfãos no prompt quebram em runtime sem esse
 * guard falhar antes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_6 = resolve(ROOT, ".claude/agents/orchestrator-stage-6.md");

describe("orchestrator-stage-6.md wiring do guard de slug WhatsApp (#4570, backstop #4574)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("referencia check-whatsapp-slug-guard.ts", () => {
    assert.match(stage6, /check-whatsapp-slug-guard\.ts/);
  });

  it("marca o guard como GATE-BLOCKING", () => {
    assert.match(stage6, /GATE-BLOCKING/);
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

  it("#4574: o halt banner de slug divergente usa o comando exato render-halt-banner.ts (não só prosa)", () => {
    const haltIdx = stage6.indexOf("render-halt-banner.ts");
    assert.ok(haltIdx !== -1, "stage-6 deve referenciar render-halt-banner.ts explicitamente");
    const haltBlock = stage6.slice(haltIdx - 20, haltIdx + 300);
    assert.match(haltBlock, /--stage\s+"6/);
    assert.match(haltBlock, /--reason\s+"slug do post diverge/);
    assert.match(haltBlock, /--action\s+"corrigir manualmente/);
  });

  it("#4574: §6g (check-invariants --stage 6) referencia a regra whatsapp-slug-guard-ok", () => {
    const section6g = stage6.slice(stage6.indexOf("### 6g."), stage6.indexOf("### 6h."));
    assert.ok(section6g.length > 0, "§6g não encontrada");
    assert.match(section6g, /whatsapp-slug-guard-ok/);
  });
});
