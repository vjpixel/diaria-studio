/**
 * #9597 item 3 (edição 261005): o log do Stage 2 trouxe
 * `[claude-code:unrecognized_model] claude-sonnet-5-5` (agent `title-picker`)
 * e isso foi lido como ID de modelo inválido. O ID está no mix aprovado — é
 * ruído do CLI. No failureTail esse ruído empurrava a causa real para fora
 * das últimas FAILURE_TAIL_LINES linhas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEditionStages,
  summarizeFailure,
  isCliNoiseLine,
  FAILURE_TAIL_LINES,
  STAGE_PLAN,
} from "../scripts/lib/edition-stage-runner.ts";

const NOISE = '[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5"}';

describe("#9597 item 3 — ruído unrecognized_model fora do failureTail", () => {
  it("isCliNoiseLine reconhece a linha real e não casa erro comum", () => {
    assert.equal(isCliNoiseLine(NOISE), true);
    assert.equal(isCliNoiseLine("claude-sonnet-5-5 is not a model this version supports"), true);
    assert.equal(isCliNoiseLine("Error: ENOENT 02-reviewed.md"), false);
    assert.equal(isCliNoiseLine("unrecognized option --foo"), false);
  });

  it("summarizeFailure: causa real sobrevive a mais de FAILURE_TAIL_LINES linhas de ruído depois dela", () => {
    const raw = ["Error: lint titles-per-highlight falhou", ...Array(FAILURE_TAIL_LINES + 5).fill(NOISE)].join("\n");
    const tail = summarizeFailure(raw);
    assert.match(tail, /lint titles-per-highlight falhou/);
    assert.doesNotMatch(tail, /unrecognized_model/);
  });

  it("summarizeFailure: só ruído → mantém o ruído (não cai no placeholder 'sem stdout')", () => {
    const tail = summarizeFailure([NOISE, NOISE].join("\n"));
    assert.match(tail, /unrecognized_model/);
    assert.doesNotMatch(tail, /sem stdout/);
  });

  it("cenário 261005 Stage 2 via runEditionStages: stderr cheio de ruído não esconde o stdout", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "9597-noise-"));
    const editionDir = join(tmpRepo, "editions", "261005");
    mkdirSync(editionDir, { recursive: true });
    try {
      const r = runEditionStages({
        aammdd: "261005",
        editionDir,
        repoRootAbs: tmpRepo,
        resolveClaudeBin: () => "echo",
        env: {},
        plan: STAGE_PLAN.slice(1, 2),
        execFn: (() => {
          throw Object.assign(new Error("exit 1"), {
            status: 1,
            stdout: "title-picker falhou: 02-reviewed.md sem seção D2",
            stderr: Array(FAILURE_TAIL_LINES + 3).fill(NOISE).join("\n"),
          });
        }) as never,
        assertSentinelFn: (() => ({ ok: false, reason: "sentinel_missing" })) as never,
      });
      assert.equal(r.exitCode, 1);
      const tail = r.outcomes[0].failureTail ?? "";
      assert.match(tail, /02-reviewed\.md sem seção D2/);
      assert.doesNotMatch(tail, /unrecognized_model/);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("title-picker usa um ID do mix aprovado (o aviso não é defeito de frontmatter)", () => {
    const fm = readFileSync(new URL("../.claude/agents/title-picker.md", import.meta.url), "utf8");
    assert.match(fm, /^model:\s*claude-sonnet-5-5\s*$/m);
  });
});
