/**
 * test/stage5-youtube-consent-gate-guard.test.ts (#10659, PR #11079)
 *
 * O gate do §5b-youtube é prosa de playbook (o orquestrador lê
 * `05-publish-consent.json` e decide). `youtubeUploadEnabled` só fixa a regra
 * em código; este teste trava que a prosa continue apontando pra ela e não
 * volte ao `!== "manual"`, que deixava `"skipped"` (`none`) subir o vídeo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "..", p), "utf8");

describe("§5b-youtube: gate de consentimento no playbook", () => {
  const stage5 = read(".claude/agents/orchestrator-stage-5.md");
  const line = stage5.split("\n").find((l) => l.includes("consent.youtube")) ?? "";

  it("cita youtubeUploadEnabled e desliga com \"skipped\"", () => {
    assert.ok(line, "linha do gate consent.youtube não encontrada no Stage 5");
    assert.match(line, /youtubeUploadEnabled/);
    assert.match(line, /"skipped"/);
  });

  it("não volta ao gate !== \"manual\"", () => {
    assert.doesNotMatch(stage5, /youtube\s*!==\s*"manual"/);
  });
});
