/**
 * test/use-melhor-beginner-minimum.test.ts (#3213)
 *
 * Cobre `checkUseMelhorBeginnerMinimum` (scripts/lib/lint-checks/use-melhor-beginner-minimum.ts)
 * e o wiring do invariant Stage 2 `use-melhor-beginner-minimum`
 * (scripts/lib/invariant-checks/stage-2.ts).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkUseMelhorBeginnerMinimum,
  isBeginnerFriendlyClass,
} from "../scripts/lib/lint-checks/use-melhor-beginner-minimum.ts";
import { checkUseMelhorHasBeginnerMinimum } from "../scripts/lib/invariant-checks/stage-2.ts";

// Fixtures espelhando os sinais de test/use-melhor-curation.test.ts (#2339) —
// mesma fonte de verdade do classificador, não reinventa critério.
const CASUAL_ITEM = {
  url: "https://canaltech.com.br/ia/chatgpt-curriculo",
  title: "Como usar ChatGPT para criar currículo passo a passo",
  audience_affinity: { matched: ["howto_br:true"] },
};

const DEV_BEGINNER_ITEM = {
  url: "https://learn.deeplearning.ai/courses/prompt-engineering",
  title: "Prompt Engineering for Developers — getting started",
  audience_affinity: { matched: ["academy:true"] },
};

const DEV_ADVANCED_ITEM_1 = {
  url: "https://example.com/orchestration-frameworks",
  title: "LangGraph multi-agent orchestration deep dive",
};

const DEV_ADVANCED_ITEM_2 = {
  url: "https://example.com/nemotron-tuning",
  title: "Fine-tuning Nemotron 3 Ultra: a hands-on RAG pipeline guide",
};

describe("isBeginnerFriendlyClass (#3213)", () => {
  it("casual e dev-iniciante são beginner-friendly", () => {
    assert.equal(isBeginnerFriendlyClass("casual"), true);
    assert.equal(isBeginnerFriendlyClass("dev-iniciante"), true);
  });

  it("dev-avancado NÃO é beginner-friendly", () => {
    assert.equal(isBeginnerFriendlyClass("dev-avancado"), false);
  });
});

describe("checkUseMelhorBeginnerMinimum (#3213)", () => {
  it("ok quando 2 itens beginner-friendly (1 casual + 1 dev-iniciante)", () => {
    const report = checkUseMelhorBeginnerMinimum([CASUAL_ITEM, DEV_BEGINNER_ITEM]);
    assert.equal(report.ok, true);
    assert.equal(report.beginnerCount, 2);
    assert.equal(report.total, 2);
    assert.equal(report.min, 2);
  });

  it("ok quando 2 itens casual (sem dev-iniciante)", () => {
    const report = checkUseMelhorBeginnerMinimum([CASUAL_ITEM, CASUAL_ITEM]);
    assert.equal(report.ok, true);
    assert.equal(report.beginnerCount, 2);
  });

  // Caso real 260710: 2 itens em USE MELHOR, ambos dev-avancado.
  it("falha (caso real 260710): 2 itens, ambos dev-avancado", () => {
    const report = checkUseMelhorBeginnerMinimum([DEV_ADVANCED_ITEM_1, DEV_ADVANCED_ITEM_2]);
    assert.equal(report.ok, false);
    assert.equal(report.beginnerCount, 0);
    assert.equal(report.total, 2);
    assert.equal(report.breakdown.length, 2);
    assert.ok(report.breakdown.every((b) => b.class === "dev-avancado"));
  });

  it("falha quando só 1 beginner-friendly de 4 itens (min=2 não atingido)", () => {
    const report = checkUseMelhorBeginnerMinimum([
      CASUAL_ITEM,
      DEV_ADVANCED_ITEM_1,
      DEV_ADVANCED_ITEM_2,
      DEV_ADVANCED_ITEM_1,
    ]);
    assert.equal(report.ok, false);
    assert.equal(report.beginnerCount, 1);
  });

  it("bucket vazio → falha (0 < min)", () => {
    const report = checkUseMelhorBeginnerMinimum([]);
    assert.equal(report.ok, false);
    assert.equal(report.beginnerCount, 0);
    assert.equal(report.total, 0);
  });

  it("respeita min customizado", () => {
    const report = checkUseMelhorBeginnerMinimum([CASUAL_ITEM], 1);
    assert.equal(report.ok, true);
    assert.equal(report.min, 1);
  });
});

describe("checkUseMelhorHasBeginnerMinimum invariant Stage 2 (#3213)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "diaria-use-melhor-beginner-"));
    mkdirSync(join(fixture, "_internal"), { recursive: true });
  });

  it("sem violation quando 01-approved-capped.json ausente", () => {
    const v = checkUseMelhorHasBeginnerMinimum(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("warning quando composição pós-caps é 100% dev-avancado (caso real 260710)", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved-capped.json"),
      JSON.stringify({ use_melhor: [DEV_ADVANCED_ITEM_1, DEV_ADVANCED_ITEM_2] }),
    );
    const v = checkUseMelhorHasBeginnerMinimum(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "use-melhor-beginner-minimum");
    assert.equal(v[0].severity, "warning");
    assert.equal(v[0].source_issue, "#3213");
    assert.match(v[0].message, /0\/2/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("sem violation quando composição pós-caps tem ≥2 beginner-friendly", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved-capped.json"),
      JSON.stringify({ use_melhor: [CASUAL_ITEM, DEV_BEGINNER_ITEM, DEV_ADVANCED_ITEM_1] }),
    );
    const v = checkUseMelhorHasBeginnerMinimum(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("sem violation quando use_melhor ausente no JSON (bucket vazio/opcional)", () => {
    writeFileSync(join(fixture, "_internal", "01-approved-capped.json"), JSON.stringify({}));
    const v = checkUseMelhorHasBeginnerMinimum(fixture);
    // Bucket vazio == 0 beginner-friendly < 2 → violation (warn), não crash.
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("warning de parse-error quando JSON malformado (não crasha)", () => {
    writeFileSync(join(fixture, "_internal", "01-approved-capped.json"), "{ not valid json");
    const v = checkUseMelhorHasBeginnerMinimum(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "use-melhor-beginner-minimum-parse-error");
    assert.equal(v[0].severity, "warning");
    rmSync(fixture, { recursive: true, force: true });
  });
});
