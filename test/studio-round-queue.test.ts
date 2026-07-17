/**
 * test/studio-round-queue.test.ts (#3561, fatia 7 do epic "Studio UI" #3554)
 *
 * Cobertura das funções PURAS de `scripts/studio-ui/studio-round-queue.ts`:
 * classificação de issues de um `plan.json` overnight/develop em
 * entram/pendente/fora (com motivo), ordenação por prioridade, e derivação
 * de labels sintéticas pros filtros da UI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQueueRow,
  buildRoundQueue,
  deriveQueueLabels,
  type RawPlanIssue,
} from "../scripts/studio-ui/studio-round-queue.ts";

describe("classifyQueueRow (#3561)", () => {
  it("elegivel -> bucket 'entram', sem motivo", () => {
    const row = classifyQueueRow({ number: 1, priority: "P1", status: "elegivel" });
    assert.equal(row.bucket, "entram");
    assert.equal(row.reason, null);
  });

  it("precisa-resposta -> bucket 'entram'", () => {
    const row = classifyQueueRow({ number: 2, priority: "P2", status: "precisa-resposta" });
    assert.equal(row.bucket, "entram");
  });

  it("mergeada / draft-ci-vermelho (terminais da Fase 1) -> bucket 'entram'", () => {
    assert.equal(classifyQueueRow({ number: 3, status: "mergeada" }).bucket, "entram");
    assert.equal(classifyQueueRow({ number: 4, status: "draft-ci-vermelho" }).bucket, "entram");
  });

  it("pulada com motivo -> bucket 'fora', motivo repassado literal", () => {
    const row = classifyQueueRow({ number: 5, priority: "P2", status: "pulada", motivo: "bloqueio-externo" });
    assert.equal(row.bucket, "fora");
    assert.equal(row.reason, "bloqueio-externo");
  });

  it("pulada SEM motivo -> bucket 'fora', fallback 'pulada'", () => {
    const row = classifyQueueRow({ number: 6, status: "pulada" });
    assert.equal(row.bucket, "fora");
    assert.equal(row.reason, "pulada");
  });

  it("elegivel_especial (EPIC deferido, #3072) -> bucket 'fora' com rótulo fixo", () => {
    const row = classifyQueueRow({ number: 7, status: "elegivel_especial", in_round: false });
    assert.equal(row.bucket, "fora");
    assert.match(row.reason ?? "", /EPIC deferido/);
  });

  it("fechada externamente -> bucket 'fora'", () => {
    const row = classifyQueueRow({ number: 8, status: "fechada" });
    assert.equal(row.bucket, "fora");
    assert.equal(row.reason, "fechada externamente");
  });

  it("in_round === false explícito tem precedência sobre o status (#3131)", () => {
    const row = classifyQueueRow({ number: 9, status: "elegivel", in_round: false });
    assert.equal(row.bucket, "fora");
  });

  it("develop: status 'pendente' -> bucket 'pendente', motivo combina block_category + what_unblocks", () => {
    const row = classifyQueueRow({
      number: 10,
      status: "pendente",
      block_category: "A",
      what_unblocks: "editor gerar token Instagram no painel Meta",
    });
    assert.equal(row.bucket, "pendente");
    assert.equal(row.reason, "cat. A: editor gerar token Instagram no painel Meta");
  });

  it("develop: 'pendente' sem block_category/what_unblocks -> fallback genérico", () => {
    const row = classifyQueueRow({ number: 11, status: "pendente" });
    assert.equal(row.bucket, "pendente");
    assert.equal(row.reason, "aguardando desbloqueio (Gate 1)");
  });

  it("NUNCA expõe valor de secret — motivo de 'pendente' só usa block_category/what_unblocks/block_label, nunca um campo de valor", () => {
    // Simula o shape real: plan.json nunca grava o secret (SKILL.md
    // invariante), mas mesmo que uma entry malformada tivesse um campo
    // extra com um valor, classifyQueueRow só lê os campos documentados.
    const row = classifyQueueRow({
      number: 12,
      status: "pendente",
      block_category: "A",
      // campo hipotético que NÃO faz parte do contrato — não deve vazar
      secret_value: "ghp_shouldneverleak",
    } as RawPlanIssue);
    assert.ok(!JSON.stringify(row).includes("ghp_shouldneverleak"));
  });

  it("status desconhecido/ausente -> bucket 'entram' (fail-open, mesmo padrão de in_round ausente)", () => {
    const row = classifyQueueRow({ number: 13 });
    assert.equal(row.bucket, "entram");
    assert.equal(row.status, "unknown");
  });

  it("priority ausente -> '?' ", () => {
    const row = classifyQueueRow({ number: 14, status: "elegivel" });
    assert.equal(row.priority, "?");
  });

  it("repassa batch/pr quando presentes", () => {
    const row = classifyQueueRow({ number: 15, status: "mergeada", batch: "ds-email", pr: 3505 });
    assert.equal(row.batch, "ds-email");
    assert.equal(row.pr, 3505);
  });
});

describe("buildRoundQueue (#3561)", () => {
  it("separa issues nos 3 baldes e ordena por prioridade P0>P1>P2>P3", () => {
    const queue = buildRoundQueue({
      issues: [
        { number: 100, priority: "P2", status: "elegivel" },
        { number: 101, priority: "P0", status: "mergeada" },
        { number: 102, priority: "P1", status: "elegivel" },
        { number: 103, priority: "P2", status: "pulada", motivo: "not-this-week" },
        { number: 104, priority: "P0", status: "pendente", block_category: "B" },
      ],
    });
    assert.deepEqual(
      queue.entram.map((r) => r.number),
      [101, 102, 100],
    );
    assert.deepEqual(
      queue.pendente.map((r) => r.number),
      [104],
    );
    assert.deepEqual(
      queue.fora.map((r) => r.number),
      [103],
    );
  });

  it("empate de prioridade -> número menor (mais antiga) primeiro", () => {
    const queue = buildRoundQueue({
      issues: [
        { number: 200, priority: "P1", status: "elegivel" },
        { number: 150, priority: "P1", status: "elegivel" },
      ],
    });
    assert.deepEqual(
      queue.entram.map((r) => r.number),
      [150, 200],
    );
  });

  it("issues ausente/malformado -> 3 arrays vazios, sem lançar", () => {
    assert.deepEqual(buildRoundQueue({}), { entram: [], pendente: [], fora: [] });
    assert.deepEqual(buildRoundQueue({ issues: "não é array" } as never), {
      entram: [],
      pendente: [],
      fora: [],
    });
  });

  it("cenário real overnight (fixture 260716): mergeadas em 'entram', elegivel_especial + pulada em 'fora'", () => {
    const queue = buildRoundQueue({
      issues: [
        { number: 3212, priority: "P2", status: "mergeada", in_round: true },
        { number: 3379, priority: "P2", status: "elegivel_especial", in_round: false },
        { number: 3500, priority: "P2", status: "pulada", motivo: "bloqueio-externo", in_round: false },
      ],
    });
    assert.equal(queue.entram.length, 1);
    assert.equal(queue.fora.length, 2);
    assert.equal(queue.pendente.length, 0);
  });
});

describe("deriveQueueLabels (#3561)", () => {
  it("prioridade P0-P3 vira label", () => {
    assert.deepEqual(deriveQueueLabels({ number: 1, priority: "P0", status: "elegivel", bucket: "entram", reason: null, batch: null, pr: null }), [
      "P0",
    ]);
  });

  it("motivo 'requer-sessao-local' vira label 'local'", () => {
    const labels = deriveQueueLabels({
      number: 2,
      priority: "P3",
      status: "pulada",
      bucket: "fora",
      reason: "requer-sessao-local: junction data/ ausente em cloud",
      batch: null,
      pr: null,
    });
    assert.deepEqual(labels, ["P3", "local"]);
  });

  it("motivo 'bloqueio-externo' ou cat. A-E vira label 'external-blocker'", () => {
    const l1 = deriveQueueLabels({
      number: 3,
      priority: "P2",
      status: "pulada",
      bucket: "fora",
      reason: "bloqueio-externo",
      batch: null,
      pr: null,
    });
    assert.ok(l1.includes("external-blocker"));

    const l2 = deriveQueueLabels({
      number: 4,
      priority: "P1",
      status: "pendente",
      bucket: "pendente",
      reason: "cat. A: editor gerar token",
      batch: null,
      pr: null,
    });
    assert.ok(l2.includes("external-blocker"));
  });

  it("sem prioridade reconhecida nem motivo especial -> array vazio", () => {
    assert.deepEqual(
      deriveQueueLabels({ number: 5, priority: "?", status: "elegivel", bucket: "entram", reason: null, batch: null, pr: null }),
      [],
    );
  });
});
