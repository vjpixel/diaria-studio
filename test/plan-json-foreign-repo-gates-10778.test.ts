/**
 * #10778 — entrada de OUTRO repo no `plan.json` nunca vira número do
 * diaria-studio nos gates de fim de rodada.
 *
 * Desde a fatia 2 do #10618, `normalizeIssues` transforma a chave
 * `"vjpixel/diaria-design#21"` em `{ number: 21, ref: "vjpixel/diaria-design#21" }`.
 * Os gates que consultam o diaria-studio só por número (`gh issue view 21`
 * sem `-R`) passavam a dar veredito sobre a studio#21, em silêncio. Estes
 * testes reproduzem o cenário da issue com um plan DICT contendo a entrada
 * qualificada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeIssues, type IssuesBearing } from "../scripts/lib/plan-issues-normalize.ts";
import { partitionStudioPlanEntries } from "../scripts/lib/plan-issue-ref.ts";
import {
  checkDevelopLabelCleared,
  type DevelopGatePlanIssue,
} from "../scripts/lib/develop-label-gate.ts";
import {
  findStaleBlocks,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
} from "../scripts/lib/block-staleness.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** O plan.json do cenário da issue: `/diaria-develop --repos all`. */
function mixedPlan(): IssuesBearing<DevelopGatePlanIssue & BlockStalenessPlanIssue> {
  return {
    issues: {
      "vjpixel/diaria-design#21": { status: "mergeada" },
      "vjpixel/diaria-design#22": { status: "pulada", motivo: "claimed-por-outra-sessao" },
      "4800": { status: "mergeada" },
      "4801": { status: "pulada", motivo: "claimed-por-outra-sessao" },
    } as never,
  };
}

describe("#10778 — partitionStudioPlanEntries", () => {
  it("separa entrada qualificada de outro repo da do diaria-studio, com aviso nomeável", () => {
    const issues = normalizeIssues(mixedPlan());
    const { studio, skipped } = partitionStudioPlanEntries(issues);
    assert.deepEqual(
      studio.map((i) => i.number).sort((a, b) => a - b),
      [4800, 4801],
    );
    assert.deepEqual(skipped.sort(), ["vjpixel/diaria-design#21", "vjpixel/diaria-design#22"]);
  });

  it("entrada com `repo` ilegível não cai no default — fica de fora como identidade desconhecida", () => {
    const { studio, skipped } = partitionStudioPlanEntries([{ number: 5, repo: 42 }, { number: 6 }]);
    assert.deepEqual(studio, [{ number: 6 }]);
    assert.deepEqual(skipped, ["(identidade desconhecida)"]);
  });

  it("entrada qualificada do PRÓPRIO diaria-studio continua no gate", () => {
    const { studio, skipped } = partitionStudioPlanEntries([{ ref: "vjpixel/diaria-studio#7", number: 7 }]);
    assert.equal(studio.length, 1);
    assert.deepEqual(skipped, []);
  });
});

describe("#10778 — check-develop-label-cleared não julga a studio#21 pela design#21", () => {
  it("estado da studio#21 com label develop NÃO vira finding da entrada design#21", () => {
    const issues = normalizeIssues<DevelopGatePlanIssue>(mixedPlan());
    // Estado buscado por número — exatamente o que o `gh issue view 21` no
    // cwd devolveria: a studio#21, sem relação com a design#21.
    const r = checkDevelopLabelCleared(issues, [
      { number: 21, labels: ["windows"] },
      { number: 4800, labels: ["bug"] },
    ]);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.cleared, [4800], "a studio#21 nunca entra como 'limpa' em nome da design#21");
  });

  it("CLI: plan só com entrada de outro repo avisa em stderr e não consulta nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-10778-"));
    try {
      const planPath = join(dir, "plan.json");
      writeFileSync(planPath, JSON.stringify({ issues: { "vjpixel/diaria-design#21": { status: "mergeada" } } }));
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts/check-develop-label-cleared.ts"), "--plan", planPath],
        // `gh` fora do PATH: se o gate tentasse consultar a studio#21, a
        // falha apareceria como "não consultada" no stderr.
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: dir } },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /FORA deste gate.*vjpixel\/diaria-design#21/);
      assert.doesNotMatch(r.stderr, /não consultada|nenhuma issue pôde ser consultada/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10778 — todo gate de fim de rodada que consulta por número avisa e pula a entrada de outro repo", () => {
  // `check-block-staleness.ts` saiu desta lista na fatia 3 do #10618: passou a
  // consultar a entrada do diaria-design no repo dela (`-R`) em vez de pular —
  // coberto em `test/issue-key-10618-fatia3.test.ts`.
  const GATES = [
    "scripts/check-overnight-comment-coverage.ts",
    "scripts/check-decision-label-drift-gate.ts",
  ];
  for (const gate of GATES) {
    it(gate, () => {
      const dir = mkdtempSync(join(tmpdir(), "plan-10778-"));
      try {
        const planPath = join(dir, "plan.json");
        writeFileSync(
          planPath,
          JSON.stringify({
            issues: { "vjpixel/diaria-design#21": { status: "pulada", motivo: "claimed-por-outra-sessao" } },
          }),
        );
        const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, gate), "--plan", planPath], {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, PATH: dir },
        });
        assert.match(r.stderr, /FORA desta checagem.*vjpixel\/diaria-design#21/, r.stderr);
        assert.doesNotMatch(r.stderr, /(?<!diaria-design)#21\b/, "nenhuma menção à studio#21 crua");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("#10778 — findStaleBlocks não consulta a claim da studio#22 pela design#22", () => {
  it("entrada de outro repo nunca vira finding, mesmo com o consultor dizendo 'claim liberado'", () => {
    const issues = normalizeIssues<BlockStalenessPlanIssue>(mixedPlan());
    const asked: number[] = [];
    const consultor: BlockStalenessConsultor = {
      getPrState: () => "UNKNOWN",
      isIssueClaimedActive: (n) => {
        asked.push(n);
        return false;
      },
      hasLabel: () => null,
      getIssueState: () => "OPEN",
    };
    const findings = findStaleBlocks(issues, consultor);
    assert.deepEqual(findings.map((f) => f.number), [4801]);
    assert.deepEqual(asked, [4801], "a claim da studio#22 nem é consultada");
  });
});
