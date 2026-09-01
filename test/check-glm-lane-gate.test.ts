import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGlmLaneUnits, fetchMergedPrNumbers, type GhExec } from "../scripts/check-glm-lane-gate.ts";

const dirs: string[] = [];
function tmpFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "glm-lane-gate-test-"));
  dirs.push(dir);
  const path = join(dir, "units.jsonl");
  if (content !== null) writeFileSync(path, content, "utf8");
  return path;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const VALID_LINE = '{"issue":1,"startedAt":"2026-09-01T00:00:00Z","endedAt":null,"durationSec":null,"costUsd":null,"prNumber":null,"reviewRounds":null,"status":"completed"}';

describe("readGlmLaneUnits (#6930/#6941)", () => {
  it("arquivo ausente → lista vazia (estado inicial legítimo do piloto), malformedCount=0", () => {
    const path = join(tmpdir(), "glm-lane-gate-test-nonexistent", "units.jsonl");
    const result = readGlmLaneUnits(path);
    assert.deepEqual(result.records, []);
    assert.equal(result.malformedCount, 0);
  });

  it("arquivo com N linhas válidas → N registros, na ordem, malformedCount=0", () => {
    const path = tmpFile(`${VALID_LINE}\n${VALID_LINE.replace('"issue":1', '"issue":2')}\n`);
    const result = readGlmLaneUnits(path);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].issue, 1);
    assert.equal(result.records[1].issue, 2);
    assert.equal(result.malformedCount, 0);
  });

  it("linhas em branco são ignoradas silenciosamente (não contam como malformadas)", () => {
    const path = tmpFile(`${VALID_LINE}\n\n\n${VALID_LINE}\n`);
    const result = readGlmLaneUnits(path);
    assert.equal(result.records.length, 2);
    assert.equal(result.malformedCount, 0);
  });

  it("linha com JSON inválido é IGNORADA e contada em malformedCount, não derruba a leitura das demais", () => {
    const path = tmpFile(`${VALID_LINE}\nnão é json{{{\n${VALID_LINE}\n`);
    const result = readGlmLaneUnits(path);
    assert.equal(result.records.length, 2);
    assert.equal(result.malformedCount, 1);
  });

  it("arquivo vazio → lista vazia, malformedCount=0", () => {
    const path = tmpFile("");
    const result = readGlmLaneUnits(path);
    assert.deepEqual(result.records, []);
    assert.equal(result.malformedCount, 0);
  });

  // #6941 (P1/P2, achado de review por 2 agentes independentes): JSON
  // sintaticamente válido mas com shape ERRADO tem que ser rejeitado —
  // um campo ausente (`undefined`) não pode colar como "válido" e virar
  // `undefined !== null` em computeGlmLaneState, invertendo o critério
  // de morte "zero PRs".
  describe("shape inválido é rejeitado (JSON válido, campo errado/ausente)", () => {
    it("objeto vazio {} → rejeitado, contado em malformedCount", () => {
      const path = tmpFile("{}\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 0);
      assert.equal(result.malformedCount, 1);
    });

    it("prNumber como STRING em vez de number/null → rejeitado", () => {
      const path = tmpFile(VALID_LINE.replace('"prNumber":null', '"prNumber":"6941"') + "\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 0);
      assert.equal(result.malformedCount, 1);
    });

    it("status ausente → rejeitado (campo obrigatório desde #6941)", () => {
      const withoutStatus = JSON.parse(VALID_LINE);
      delete withoutStatus.status;
      const path = tmpFile(JSON.stringify(withoutStatus) + "\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 0);
      assert.equal(result.malformedCount, 1);
    });

    it("status com valor não reconhecido ('pending') → rejeitado", () => {
      const path = tmpFile(VALID_LINE.replace('"status":"completed"', '"status":"pending"') + "\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 0);
      assert.equal(result.malformedCount, 1);
    });

    it("status:'infra-error' válido → aceito normalmente", () => {
      const path = tmpFile(VALID_LINE.replace('"status":"completed"', '"status":"infra-error"') + "\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].status, "infra-error");
    });

    it("array em vez de objeto → rejeitado", () => {
      const path = tmpFile("[1,2,3]\n");
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 0);
      assert.equal(result.malformedCount, 1);
    });

    it("mistura de linhas válidas e com shape inválido → só as válidas entram, malformedCount reflete o resto", () => {
      const path = tmpFile(`${VALID_LINE}\n{}\n${VALID_LINE}\n`);
      const result = readGlmLaneUnits(path);
      assert.equal(result.records.length, 2);
      assert.equal(result.malformedCount, 1);
    });
  });
});

describe("fetchMergedPrNumbers (#6954)", () => {
  it("lista vazia de PRs → Set vazio, nunca chama gh", () => {
    let calls = 0;
    const fakeGh: GhExec = () => {
      calls++;
      return "";
    };
    const result = fetchMergedPrNumbers([], fakeGh);
    assert.deepEqual(result, new Set());
    assert.equal(calls, 0);
  });

  it("PR MERGED entra no Set, PR OPEN/CLOSED não", () => {
    const fakeGh: GhExec = (args) => {
      const pr = args[2];
      if (pr === "100") return "MERGED\n";
      if (pr === "101") return "OPEN\n";
      return "CLOSED\n";
    };
    const result = fetchMergedPrNumbers([100, 101, 102], fakeGh);
    assert.deepEqual(result, new Set([100]));
  });

  it("gh falhando numa PR individual não derruba as demais — a que falhou fica de fora do Set (conservador)", () => {
    const fakeGh: GhExec = (args) => {
      const pr = args[2];
      if (pr === "200") throw new Error("gh: rate limited");
      return "MERGED\n";
    };
    const result = fetchMergedPrNumbers([200, 201], fakeGh);
    assert.deepEqual(result, new Set([201]));
  });

  it("chama gh exatamente 1x por pr number, com o comando esperado", () => {
    const calls: string[][] = [];
    const fakeGh: GhExec = (args) => {
      calls.push(args);
      return "MERGED\n";
    };
    fetchMergedPrNumbers([42], fakeGh);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["pr", "view", "42", "--json", "state", "-q", ".state"]);
  });
});
