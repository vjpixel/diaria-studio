/**
 * test/sync-code-stage6-standalone-8786.test.ts (#8786)
 *
 * O bug real por trás do #8786: `publish-edition-site-page.ts` já ganhou o
 * fallback de worktree temporário a partir de `origin/master` no #8636
 * (refetch em #8684) — isso já é o mecanismo que a issue pedia como
 * "direção 1". A ocorrência descrita na issue (edição 260925, exit 3,
 * mesmo texto de erro do guard legado do #7287) só é possível se a SESSÃO
 * que rodou o script estava executando código de disco anterior a esse
 * fix — e a única porta que nunca sincroniza o código antes de rodar
 * `§6b-site` é `/diaria-6-agendamento` invocada de forma STANDALONE (porta
 * de retomada, #7983): `/diaria-5-publicacao` já ganhou o Passo -3
 * (sync-code.ts, #8684), mas a retomada nunca passa por ele quando a
 * sessão anterior morreu antes do gate.
 *
 * Este teste garante 2 coisas em código (não só em prosa):
 *   1. `.claude/skills/diaria-6-agendamento/SKILL.md` referencia
 *      `sync-code.ts` explicitamente, na trilha standalone.
 *   2. `STAGE_6_RULES` inclui a regra `sync-code-ran` — sem isso, uma
 *      sessão standalone que pular o Passo -1 novo não teria NENHUM sinal
 *      determinístico (nem sequer warning) de que rodou com código
 *      defasado, ao contrário do Stage 5 (que já tinha isso desde #8690).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE_6_RULES } from "../scripts/lib/invariant-checks/stage-6.ts";
import { checkSyncCodeMarker } from "../scripts/lib/sync-code-marker.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = resolve(ROOT, ".claude/skills/diaria-6-agendamento/SKILL.md");

describe("diaria-6-agendamento standalone roda sync-code (#8786)", () => {
  const skill = readFileSync(SKILL_MD, "utf8");

  it("referencia scripts/sync-code.ts", () => {
    assert.match(skill, /npx tsx scripts\/sync-code\.ts/);
  });

  it("referencia a issue de origem (#8786) e o fix já mergeado que a issue supunha ausente (#8636)", () => {
    assert.match(skill, /#8786/);
    assert.match(skill, /#8636/);
  });

  it("o passo de sync roda antes da seção 'Pre-requisitos'", () => {
    const syncIdx = skill.indexOf("npx tsx scripts/sync-code.ts");
    const prereqIdx = skill.indexOf("## Pre-requisitos");
    assert.ok(syncIdx !== -1 && prereqIdx !== -1);
    assert.ok(syncIdx < prereqIdx, "sync-code deve rodar antes dos pré-requisitos de conteúdo do stage");
  });
});

describe("STAGE_6_RULES inclui sync-code-ran (#8786)", () => {
  it("regra registrada com stage: 6", () => {
    const rule = STAGE_6_RULES.find((r) => r.id === "sync-code-ran");
    assert.ok(rule, "sync-code-ran deve estar em STAGE_6_RULES");
    assert.equal(rule?.stage, 6);
    assert.equal(rule?.run, checkSyncCodeMarker, "deve reusar o mesmo checker do Stage 5 (#8690), não uma cópia");
  });
});
