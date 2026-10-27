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

describe("#11225 Stage 6 sem ramo Beehiiv", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");
  it("agenda Kit e preserva o gate humano", () => {
    assert.match(stage6, /schedule-newsletter-kit\.ts/);
    assert.match(stage6, /### 6c\. GATE HUMANO/);
    assert.match(stage6, /newsletter-kit-published\.json/);
  });
  it("não consulta MCP Beehiiv nem agenda pelo playbook antigo", () => {
    assert.doesNotMatch(stage6, /mcp__claude_ai_Beehiiv__get_post/);
    assert.doesNotMatch(stage6, /### 6d\. Executar Schedule do Beehiiv/);
    assert.doesNotMatch(stage6, /npx tsx scripts\/schedule-kit-diaria\.ts/);
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

describe("orchestrator-stage-6.md §6b-replies — ledger só com as replies tratadas (#9813)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("todo bloco de código que chama --record-processed passa --thread-ids", () => {
    const blocks = [...stage6.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    const recordBlocks = blocks.filter((b) => b.includes("--record-processed"));
    assert.ok(recordBlocks.length >= 1, "esperava ao menos 1 bloco com --record-processed em §6b-replies");
    for (const b of recordBlocks) {
      // Sem --thread-ids o script grava a passada inteira: a reply cujo
      // create_draft falhou entraria no ledger e sumiria na retomada.
      assert.match(b, /--thread-ids \S+/, `bloco sem --thread-ids:\n${b}`);
    }
  });
});

describe("orchestrator-stage-6.md §6h — pré-check da purga pelos 2 backends de KV (#11253)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");
  const start = stage6.indexOf("### 6h.");
  const section6h = stage6.slice(start, stage6.indexOf("\n---", start));
  const summaryStart = stage6.indexOf("## Resumo final");
  const summary = stage6.slice(summaryStart);
  const skill = readFileSync(resolve(ROOT, ".claude/skills/diaria-remover-votos-pixel/SKILL.md"), "utf8");

  it("§6h existe e o pré-check é purge-leaderboard.ts --check-auth", () => {
    assert.ok(start !== -1 && summaryStart !== -1);
    assert.match(section6h, /npx tsx scripts\/purge-leaderboard\.ts --check-auth/);
  });

  it("§6h não manda rodar scripts/check-wrangler-auth.ts como pré-check (reprovaria o 300)", () => {
    assert.doesNotMatch(section6h, /npx tsx scripts\/check-wrangler-auth\.ts/);
  });

  it("§6h loga o warn com reason neutro purge_precheck_failed e a causa em detail (1a linha [purge])", () => {
    assert.match(section6h, /"reason":"purge_precheck_failed"/);
    assert.doesNotMatch(section6h, /kv_backend_unavailable/, "a falha pode ser ADMIN_SECRET, não só backend");
    assert.match(section6h, /"detail":"\{1a linha \[purge\] do stderr/);
  });

  it("Resumo final reporta a purga como PENDENTE quando §6h não conclui", () => {
    assert.match(summary, /Purga de votos do editor: PENDENTE/);
  });

  it("skill /diaria-remover-votos-pixel documenta o --check-auth", () => {
    assert.match(skill, /purge-leaderboard\.ts --check-auth/);
  });
});
