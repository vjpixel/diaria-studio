/**
 * test/check-invariants-stage-6.test.ts (#4574)
 *
 * Cobertura dedicada do Stage 6 (#1007 Fase 1, `scripts/lib/invariant-checks/stage-6.ts`)
 * — nenhum teste direto existia antes desta PR (`check-invariants-stage.test.ts`
 * cobre stages 0-5). Foco principal: a regra nova `whatsapp-slug-guard-ok`
 * (#4570 fechado com backstop determinístico em #4574) — sem ela, o guard
 * GATE-BLOCKING de slug do bloco WhatsApp dependia 100% de um agente LLM ler
 * e seguir a prosa do orchestrator, sem nenhuma verificação em código de que
 * o guard rodou, rodou corretamente, ou passou (achado convergente
 * pr-test-analyzer + silent-failure-hunter no review consolidado da PR #4574).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGE_6_RULES,
  checkStep5Sentinel,
  checkScheduledAt,
  checkEditionReport,
  checkWhatsappSlugGuard,
  checkStep6Sentinel,
} from "../scripts/lib/invariant-checks/stage-6.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-invariants-stage6-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("STAGE_6_RULES registry (#4574)", () => {
  it("contém a entry whatsapp-slug-guard-ok, stage 6, source_issue #4574", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "whatsapp-slug-guard-ok");
    assert.ok(entry !== undefined, "STAGE_6_RULES deve conter 'whatsapp-slug-guard-ok'");
    assert.equal(entry!.stage, 6);
    assert.equal(entry!.source_issue, "#4574");
  });

  it("getRulesForStage(6) inclui whatsapp-slug-guard-ok junto das demais 4 regras pré-existentes", () => {
    const rules = getRulesForStage(6);
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes("step-5-sentinel-exists"));
    assert.ok(ids.includes("scheduled-at-present"));
    assert.ok(ids.includes("edition-report-exists"));
    assert.ok(ids.includes("whatsapp-slug-guard-ok"));
    assert.ok(ids.includes("step-6-sentinel-exists"));
    assert.equal(ids.length, 5, `esperava 5 regras no Stage 6, achei: ${JSON.stringify(ids)}`);
  });
});

describe("checkWhatsappSlugGuard (#4574)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("falha quando whatsapp-slug-check.json ausente — guard não rodou (silêncio ≠ passou)", () => {
    const v = checkWhatsappSlugGuard(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#4574");
    assert.match(v[0].message, /não rodou/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa quando whatsapp-slug-check.json existe com ok:true", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({
        ok: true,
        expectedSlug: "titulo-do-d1",
        actualSlug: "titulo-do-d1",
        checkedAt: new Date().toISOString(),
      }),
    );
    const v = checkWhatsappSlugGuard(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando whatsapp-slug-check.json existe com ok:false (guard rodou e detectou divergência)", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({
        ok: false,
        expectedSlug: "hacker-chines-usa-deepseek",
        actualSlug: "hacker-chin-s-usa-deepseek",
        checkedAt: new Date().toISOString(),
      }),
    );
    const v = checkWhatsappSlugGuard(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /hacker-chines-usa-deepseek/);
    assert.match(v[0].message, /hacker-chin-s-usa-deepseek/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando o arquivo existe mas não é JSON parseável", () => {
    writeFileSync(join(fixture, "_internal", "whatsapp-slug-check.json"), "{ not valid json");
    const v = checkWhatsappSlugGuard(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-parseable");
    assert.equal(v[0].severity, "error");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando ok está ausente do JSON (shape inesperado — não confundir com true)", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({ expectedSlug: "foo" }),
    );
    const v = checkWhatsappSlugGuard(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("demais regras do Stage 6 — cobertura básica (nenhum teste direto existia antes do #4574)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("checkStep5Sentinel falha quando .step-5-done.json ausente", () => {
    const v = checkStep5Sentinel(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "step-5-sentinel-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkStep5Sentinel passa quando presente", () => {
    writeFileSync(join(fixture, "_internal", ".step-5-done.json"), JSON.stringify({ done: true }));
    const v = checkStep5Sentinel(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkScheduledAt falha quando 05-published.json ausente", () => {
    const v = checkScheduledAt(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkScheduledAt falha quando 05-published.json não tem scheduled_at nem status=published", () => {
    writeFileSync(join(fixture, "_internal", "05-published.json"), JSON.stringify({ post_id: "x" }));
    const v = checkScheduledAt(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkScheduledAt passa com scheduled_at presente", () => {
    writeFileSync(
      join(fixture, "_internal", "05-published.json"),
      JSON.stringify({ scheduled_at: "2026-08-05T09:00:00Z" }),
    );
    const v = checkScheduledAt(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkEditionReport falha quando edition-report.html ausente", () => {
    const v = checkEditionReport(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "edition-report-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkStep6Sentinel falha quando .step-6-done.json ausente", () => {
    const v = checkStep6Sentinel(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "step-6-sentinel-exists");
    rmSync(fixture, { recursive: true, force: true });
  });
});
