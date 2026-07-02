import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  validateSendPlan,
  allBlocks,
  planByBlock,
  parseBlocksArg,
  loadSendPlan,
  loadSendsSummary,
  sendPlanPath,
  sendsSummaryPath,
  type SendPlanEntry,
} from "../scripts/lib/send-plan.ts";

function entry(p: Partial<SendPlanEntry> & { n: number }): SendPlanEntry {
  return {
    date: `d${p.n}`,
    day: "qua",
    block: 1,
    volume: 100,
    scheduledAt: "2026-06-10T09:00:00.000Z",
    ...p,
  };
}

describe("validateSendPlan (#2775)", () => {
  it("aceita um plano válido e retorna ordenado por n", () => {
    const raw = [entry({ n: 2 }), entry({ n: 1 })];
    const out = validateSendPlan(raw);
    assert.deepEqual(out.map((e) => e.n), [1, 2]);
  });

  it("rejeita não-array", () => {
    assert.throws(() => validateSendPlan({ not: "array" }), /esperado array/);
  });

  it("rejeita array vazio", () => {
    assert.throws(() => validateSendPlan([]), /plano vazio/);
  });

  it("rejeita entrada sem n válido", () => {
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), n: 0 }]), /\.n deve ser inteiro/);
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), n: 1.5 }]), /\.n deve ser inteiro/);
  });

  it("rejeita date/day ausentes", () => {
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), date: "" }]), /\.date ausente/);
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), day: undefined as any }]), /\.day ausente/);
  });

  it("rejeita block inválido", () => {
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), block: 0 }]), /\.block deve ser inteiro/);
  });

  it("rejeita volume <= 0", () => {
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), volume: 0 }]), /\.volume deve ser número/);
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), volume: -5 }]), /\.volume deve ser número/);
  });

  it("rejeita scheduledAt não-ISO", () => {
    assert.throws(() => validateSendPlan([{ ...entry({ n: 1 }), scheduledAt: "não é data" }]), /scheduledAt não é ISO/);
  });

  it("rejeita n duplicado", () => {
    assert.throws(() => validateSendPlan([entry({ n: 1 }), entry({ n: 1 })]), /n=1 duplicado/);
  });

  it("rejeita gap na sequência de n (1,3 sem 2)", () => {
    assert.throws(() => validateSendPlan([entry({ n: 1 }), entry({ n: 3 })]), /esperado n=2/);
  });
});

describe("allBlocks / planByBlock (#2775 — generaliza ALL_WEEKS/planWeeks)", () => {
  const plan: SendPlanEntry[] = [
    entry({ n: 1, block: 1, volume: 100 }),
    entry({ n: 2, block: 1, volume: 200 }),
    entry({ n: 3, block: 2, volume: 300 }),
    entry({ n: 4, block: 3, volume: 400 }),
    entry({ n: 5, block: 3, volume: 500 }),
  ];

  it("allBlocks retorna blocos únicos ordenados", () => {
    assert.deepEqual(allBlocks(plan), [1, 2, 3]);
  });

  it("planByBlock agrupa por bloco com total correto", () => {
    const grouped = planByBlock(plan);
    assert.equal(grouped.length, 3);
    assert.deepEqual(grouped[0].sends.map((s) => s.n), [1, 2]);
    assert.equal(grouped[0].total, 300);
    assert.deepEqual(grouped[1].sends.map((s) => s.n), [3]);
    assert.equal(grouped[1].total, 300);
    assert.deepEqual(grouped[2].sends.map((s) => s.n), [4, 5]);
    assert.equal(grouped[2].total, 900);
  });
});

describe("parseBlocksArg (#2775 — generaliza parseWeeksArg, --weeks retrocompat)", () => {
  const validBlocks = [1, 2, 3];

  it("sem flag: default = validBlocks quando fallback omitido", () => {
    assert.deepEqual(parseBlocksArg([], validBlocks), [1, 2, 3]);
  });

  it("sem flag: default = fallback quando fornecido", () => {
    assert.deepEqual(parseBlocksArg([], validBlocks, [1]), [1]);
  });

  it("--blocks 2,3 retorna [2,3]", () => {
    assert.deepEqual(parseBlocksArg(["--blocks", "2,3"], validBlocks), [2, 3]);
  });

  it("--weeks funciona como alias retrocompat de --blocks", () => {
    assert.deepEqual(parseBlocksArg(["--weeks", "1,2"], validBlocks), [1, 2]);
  });

  it("--blocks tem prioridade sobre --weeks se ambos presentes", () => {
    assert.deepEqual(parseBlocksArg(["--weeks", "1", "--blocks", "3"], validBlocks), [3]);
  });

  it("--blocks sem valor lança erro explícito", () => {
    assert.throws(() => parseBlocksArg(["--blocks"], validBlocks), /--blocks requer um valor/);
  });

  it("--weeks seguido de outra flag (sem valor) lança erro explícito", () => {
    assert.throws(() => parseBlocksArg(["--weeks", "--dry-run"], validBlocks), /--weeks requer um valor/);
  });

  it("valor fora de validBlocks é filtrado; todos fora → erro", () => {
    assert.throws(() => parseBlocksArg(["--blocks", "9,10"], validBlocks), /não contém blocos válidos/);
  });

  it("mistura válido+inválido: mantém só os válidos", () => {
    assert.deepEqual(parseBlocksArg(["--blocks", "2,9"], validBlocks), [2]);
  });

  // Regressão (self-review #2775): fallback desalinhado com o plano (ex: caller
  // passa --cell-block 5 como fallback [5], mas o plano só tem blocos 1-3) não
  // pode produzir um `blocks` silenciosamente inválido — sem este guard, a
  // invocação processaria 0 dias sem nenhum erro.
  it("fallback fora de validBlocks lança erro explícito (não retorna silenciosamente inválido)", () => {
    assert.throws(
      () => parseBlocksArg([], validBlocks, [5]),
      /bloco padrão \[5\] não existe no plano/,
    );
  });

  it("fallback parcialmente válido: filtra e mantém só o(s) válido(s)", () => {
    assert.deepEqual(parseBlocksArg([], validBlocks, [2, 9]), [2]);
  });
});

describe("loadSendPlan / loadSendsSummary (#2775 — I/O com cycleDir explícito)", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "send-plan-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("loadSendPlan lê e valida send-plan.json do cycleDir", () => {
    withTmpDir((dir) => {
      const plan = [entry({ n: 1 }), entry({ n: 2 })];
      writeFileSync(sendPlanPath(dir), JSON.stringify(plan));
      const loaded = loadSendPlan(dir);
      assert.equal(loaded.length, 2);
    });
  });

  it("loadSendPlan lança mensagem clara quando o arquivo não existe", () => {
    withTmpDir((dir) => {
      assert.throws(() => loadSendPlan(dir), /send-plan\.json não existe/);
    });
  });

  it("loadSendPlan lança mensagem clara em JSON corrompido", () => {
    withTmpDir((dir) => {
      writeFileSync(sendPlanPath(dir), "{not valid json");
      assert.throws(() => loadSendPlan(dir), /send-plan\.json corrompido/);
    });
  });

  it("loadSendsSummary lê sends-summary.json de {cycleDir}/sends/", () => {
    withTmpDir((dir) => {
      const summaryPath = sendsSummaryPath(dir);
      mkdirSync(resolve(dir, "sends"), { recursive: true });
      writeFileSync(summaryPath, JSON.stringify({ cycle: "2605-06", total: 1, sends: [{ n: 1 }] }));
      const summary = loadSendsSummary(dir);
      assert.equal(summary.cycle, "2605-06");
      assert.equal(summary.sends.length, 1);
    });
  });

  it("loadSendsSummary lança mensagem clara quando ausente", () => {
    withTmpDir((dir) => {
      assert.throws(() => loadSendsSummary(dir), /sends-summary\.json não existe/);
    });
  });

  it("loadSendsSummary lança mensagem clara em JSON corrompido", () => {
    withTmpDir((dir) => {
      mkdirSync(resolve(dir, "sends"), { recursive: true });
      writeFileSync(sendsSummaryPath(dir), "{ broken");
      assert.throws(() => loadSendsSummary(dir), /sends-summary\.json corrompido/);
    });
  });

  it("loadSendsSummary lança quando shape não tem array 'sends'", () => {
    withTmpDir((dir) => {
      mkdirSync(resolve(dir, "sends"), { recursive: true });
      writeFileSync(sendsSummaryPath(dir), JSON.stringify({ cycle: "x" }));
      assert.throws(() => loadSendsSummary(dir), /shape inesperado/);
    });
  });
});
