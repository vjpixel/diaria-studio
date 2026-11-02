/**
 * test/apoio-sync-beehiiv-retired-11225.test.ts (#11225)
 *
 * Decisão do editor de 28/10/2026: os `sync-apoio-*-beehiiv.ts` saem, junto com
 * a dependência de skills e alarmes. O alarme e a skill leem e gravam no Kit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApoiosDiffAlarmEmail } from "../scripts/lib/apoios-diff-alarm.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("sync de apoio sem Beehiiv (#11225)", () => {
  it("scripts de escrita e leitura da Beehiiv foram aposentados", () => {
    for (const p of ["scripts/sync-apoio-nivel-beehiiv.ts", "scripts/sync-apoio-segments-beehiiv.ts", "scripts/lib/apoio-segments-canonical.ts"]) {
      assert.equal(existsSync(resolve(ROOT, p)), false, p);
    }
  });

  it("o alarme lê o estado atual do Kit, sem credencial Beehiiv", () => {
    const src = read("scripts/apoios-diff-alarm.ts");
    assert.match(src, /fetchCurrentKitState\(kitConfig\.config\)/);
    assert.doesNotMatch(src, /loadBeehiivConfig|beehiiv-config|fetchCurrentBeehiiv/);
  });

  it("kit-ramp-cohort normaliza os ativos da Beehiiv antes de comparar (a lib não normaliza)", () => {
    assert.match(read("scripts/kit-ramp-cohort.ts"), /activeBeehiivEmails: toNormalizedEmailSet\(activeBeehiivEmails\)/);
  });

  it("o e-mail do alarme manda aplicar pelo sync do Kit", () => {
    const { body } = buildApoiosDiffAlarmEmail({
      toApply: [{ email: "a@x.com", contactName: "A", fromLevel: null, toLevel: "amigo" }],
      toRemove: [],
    });
    assert.match(body, /sync-apoio-nivel-kit\.ts --push/);
    assert.match(body, /apoio_nivel no Kit/);
    assert.doesNotMatch(body, /Beehiiv|beehiiv/);
  });

  it("a skill /diaria-apoios-sync grava no Kit e não pede navegador nem MCP da Beehiiv", () => {
    const skill = read(".claude/skills/diaria-apoios-sync/SKILL.md");
    assert.match(skill, /sync-apoio-nivel-kit\.ts --push/);
    assert.doesNotMatch(skill, /mcp__claude_ai_Beehiiv|sync-apoio-nivel-beehiiv|browser-capability/);
  });

  it("a task do alarme segue agendada: migrou de fonte, não foi aposentada", () => {
    const src = read("scripts/lib/scheduled-tasks.ts");
    const retired = src.slice(src.indexOf("export const RETIRED_TASK_NAMES"), src.indexOf("export function isRetiredTaskName"));
    assert.doesNotMatch(retired, /Diaria-Apoios-Diff-Alarm/);
    assert.match(src, /name: "Diaria-Apoios-Diff-Alarm"/);
  });
});
