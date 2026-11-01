/**
 * test/orchestrator-stage-6-wiring.test.ts (#4574, revisado #8205 e #11225)
 *
 * Grep tests do playbook da Etapa 6. Mesmo padrão de
 * `test/beehiiv-playbook-wiring.test.ts` (#1433): helpers/scripts órfãos no
 * prompt quebram em runtime sem esse guard falhar antes.
 *
 * #8205 (17/09/2026): a revisão visual do e-mail de teste pelo editor é a ÚNICA
 * parada de `/diaria-5-publicacao`. #11225: o guard de slug do bloco WhatsApp
 * (§6b-slug, Beehiiv) saiu da Etapa 6, junto com o §6d e o §6e; os testes dele
 * saíram junto. O passo vivo que estava dentro do §6e (`derive-stage6`) voltou
 * no §6b2.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_6 = resolve(ROOT, ".claude/agents/orchestrator-stage-6.md");

describe("orchestrator-stage-6.md — parada única do pipeline (#8205)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("o gate único (§6c) usa a wording ok/ok HH:MM/abortar (não mais sim/sim HH:MM)", () => {
    const sixC = stage6.slice(stage6.indexOf("### 6c."), stage6.indexOf("### 6d-kit."));
    assert.match(sixC, /ok\s+HH:MM/);
    assert.match(sixC, /\bok\b.*→ agenda/);
  });

  it("o gate único (§6c) pede explicitamente a revisão visual do e-mail de teste", () => {
    const sixC = stage6.slice(stage6.indexOf("### 6c."), stage6.indexOf("### 6d-kit."));
    assert.match(sixC, /Confira o e-mail de teste/i);
    assert.match(sixC, /test_email/);
  });

  it("#5731/#11225: derive-stage6 roda no §6b2, antes de ler a lista e do gate", () => {
    const idx6b2 = stage6.indexOf("### 6b2.");
    const idxDerive = stage6.indexOf("derive-editor-requests.ts derive-stage6 --edition {AAMMDD}");
    const idxRead = stage6.indexOf("Ler `{EDITION_DIR}/_internal/editor-requests.jsonl`");
    const idxGate = stage6.indexOf("### 6c.");
    assert.ok(idx6b2 !== -1 && idxDerive !== -1 && idxRead !== -1, "§6b2, derive-stage6 e a leitura da lista devem existir");
    assert.ok(idx6b2 < idxDerive && idxDerive < idxRead && idxRead < idxGate, "ordem: §6b2 → derive-stage6 → leitura → gate");
  });

  it("§6b2 (pedidos editoriais) não tem mais loop de confirmação interativa", () => {
    const idx6b2 = stage6.indexOf("### 6b2.");
    const idx6bSlug = stage6.indexOf("### 6b-site.");
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
