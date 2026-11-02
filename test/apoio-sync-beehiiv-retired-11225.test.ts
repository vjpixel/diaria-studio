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
import { toAlarmFinding } from "../scripts/apoios-diff-alarm.ts";
import { segmentsCachePath, vinculoCachePath } from "../scripts/studio-ui/studio-apoios.ts";

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

  it("o e-mail do alarme manda aplicar pela skill, que também atualiza as tags", () => {
    const { body } = buildApoiosDiffAlarmEmail({
      toApply: [{ email: "a@x.com", contactName: "A", fromLevel: null, toLevel: "amigo" }],
      toRemove: [],
    });
    assert.match(body, /Rode \/diaria-apoios-sync/);
    assert.match(body, /não atualiza/);
    assert.match(body, /apoio_nivel no Kit/);
    assert.doesNotMatch(body, /Beehiiv|beehiiv/);
  });

  it("o corpo da issue do alarme também manda pela skill, com e-mail mascarado", () => {
    const { body } = toAlarmFinding({
      toApply: [{ email: "fulano@x.com", contactName: "F", fromLevel: null, toLevel: "amigo" }],
      toRemove: [],
    });
    assert.match(body, /Rode \/diaria-apoios-sync/);
    assert.doesNotMatch(body, /fulano@x\.com|Beehiiv|beehiiv/);
  });

  it("os caches do painel têm os caminhos do Kit", () => {
    assert.match(segmentsCachePath("/r").replaceAll("\\", "/"), /data\/apoia-se\/kit-segments\.json$/);
    assert.match(vinculoCachePath("/r").replaceAll("\\", "/"), /data\/apoia-se\/kit-vinculo\.json$/);
  });

  it("a skill grava o nível, espera convergir, projeta as tags e só depois atualiza o painel", () => {
    const skill = read(".claude/skills/diaria-apoios-sync/SKILL.md");
    const nivel = skill.indexOf("sync-apoio-nivel-kit.ts --push");
    const converge = skill.indexOf("## Passo 3");
    const tags = skill.indexOf("sync-apoio-mensal-tag-kit.ts");
    const painel = skill.indexOf("npx tsx scripts/sync-apoio-segments-kit.ts");
    assert.ok(nivel > 0 && nivel < converge && converge < tags && tags < painel);
    assert.match(skill.slice(converge, tags), /repetir o dry-run/i);
    assert.match(skill, /Não aplicar\*\* → pular para o Passo 5/);
    assert.match(skill, /recusa o `--push` inteiro/);
  });

  it("o resumo do painel separa não consultados de não assinantes", () => {
    const js = read("scripts/studio-ui/public/apoios.js");
    assert.match(js, /não são assinantes ativos no Kit, \$\{naoConsultados\} não consultados/);
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
