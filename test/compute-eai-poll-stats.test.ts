import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeStats,
  filterResponses,
  findPreviousEdition,
  type PollResponse,
} from "../scripts/compute-eai-poll-stats.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("computeStats", () => {
  const base = {
    threshold: 5,
    previousEdition: "260423",
  };

  it("100% correto: todos escolheram a opção certa", () => {
    const responses: PollResponse[] = Array.from({ length: 10 }, () => ({
      choice: "A",
    }));
    const r = computeStats({ ...base, responses, correctChoice: "A" });
    assert.equal(r.total_responses, 10);
    assert.equal(r.correct_responses, 10);
    assert.equal(r.pct_correct, 100);
    assert.equal(r.below_threshold, false);
  });

  it("50% correto: metade escolheu errado", () => {
    const responses: PollResponse[] = [
      { choice: "A" },
      { choice: "A" },
      { choice: "A" },
      { choice: "B" },
      { choice: "B" },
      { choice: "B" },
    ];
    const r = computeStats({ ...base, responses, correctChoice: "A" });
    assert.equal(r.total_responses, 6);
    assert.equal(r.correct_responses, 3);
    assert.equal(r.pct_correct, 50);
  });

  it("threshold: total < threshold marca below_threshold + pct=null", () => {
    const responses: PollResponse[] = [
      { choice: "A" },
      { choice: "B" },
    ];
    const r = computeStats({
      ...base,
      responses,
      correctChoice: "A",
      threshold: 5,
    });
    assert.equal(r.total_responses, 2);
    assert.equal(r.correct_responses, 1);
    assert.equal(r.pct_correct, null);
    assert.equal(r.below_threshold, true);
  });

  it("zero respostas: below_threshold + pct=null", () => {
    const r = computeStats({ ...base, responses: [], correctChoice: "A" });
    assert.equal(r.total_responses, 0);
    assert.equal(r.pct_correct, null);
    assert.equal(r.below_threshold, true);
  });

  it("correctChoice null: pct=null mas total ainda contado", () => {
    const responses: PollResponse[] = [
      { choice: "A" },
      { choice: "B" },
    ];
    const r = computeStats({ ...base, responses, correctChoice: null });
    assert.equal(r.total_responses, 2);
    assert.equal(r.correct_responses, 0);
    assert.equal(r.pct_correct, null);
  });

  it("arredonda pct corretamente (50.5% → 51)", () => {
    // 5/10 = 50%; usar 51/100 pra forçar arredondamento
    const responses: PollResponse[] = [
      ...Array.from({ length: 51 }, () => ({ choice: "A" } as PollResponse)),
      ...Array.from({ length: 49 }, () => ({ choice: "B" } as PollResponse)),
    ];
    const r = computeStats({ ...base, responses, correctChoice: "A" });
    assert.equal(r.pct_correct, 51);
  });
});

describe("filterResponses", () => {
  const responses: PollResponse[] = [
    { choice: "A", responded_at: "2026-04-22T10:00:00Z" },
    { choice: "B", responded_at: "2026-04-23T10:00:00Z" },
    { choice: "A", responded_at: "2026-04-24T10:00:00Z" },
    { choice: "B" }, // sem responded_at
  ];

  it("sem since: retorna tudo", () => {
    assert.equal(filterResponses(responses).length, 4);
  });

  it("filtra por responded_at >= since", () => {
    const r = filterResponses(responses, "2026-04-23T00:00:00Z");
    // Mantém: 2 com data >= since + 1 sem data (não filtra sem timestamp)
    assert.equal(r.length, 3);
  });

  it("since inválido: retorna tudo", () => {
    assert.equal(filterResponses(responses, "not-a-date").length, 4);
  });
});

describe("findPreviousEdition", () => {
  it("encontra edição imediatamente anterior", () => {
    const tmp = mkdtempSync(join(tmpdir(), "eai-poll-"));
    mkdirSync(join(tmp, "260420"));
    mkdirSync(join(tmp, "260422"));
    mkdirSync(join(tmp, "260423"));
    mkdirSync(join(tmp, "260425"));
    assert.equal(findPreviousEdition(tmp, "260424"), "260423");
    assert.equal(findPreviousEdition(tmp, "260425"), "260423");
    assert.equal(findPreviousEdition(tmp, "260420"), null);
  });

  it("ignora diretórios fora do padrão AAMMDD", () => {
    const tmp = mkdtempSync(join(tmpdir(), "eai-poll-"));
    mkdirSync(join(tmp, "260423"));
    mkdirSync(join(tmp, "_internal"));
    mkdirSync(join(tmp, "test-dir"));
    writeFileSync(join(tmp, "file.txt"), "x");
    assert.equal(findPreviousEdition(tmp, "260424"), "260423");
  });

  it("retorna null se diretório não existe", () => {
    assert.equal(findPreviousEdition("/tmp/nao-existe-xyz-123", "260424"), null);
  });
});
