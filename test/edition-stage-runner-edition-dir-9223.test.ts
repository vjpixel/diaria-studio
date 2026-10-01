/**
 * #9223 item 2 — edição 261001: a re-execução headless do Stage 2 respondeu
 * "No edition data exists for 261001 anywhere — 01-approved.json isn't
 * present", embora o arquivo existisse no layout aninhado
 * `data/editions/2610/261001/_internal/`. O driver já tem o diretório
 * resolvido; trava que ele chega ao prompt de todo stage spawnado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editionDirDirective, runEditionStages } from "../scripts/lib/edition-stage-runner.ts";

const REPO = "/repo";
const NESTED = "/repo/data/editions/2610/261001";
const junction = (p: string) =>
  p.startsWith("/repo/data") ? p.replace("/repo/data", "/onedrive/diaria/data") : p;

describe("#9223 editionDirDirective", () => {
  it("cita o path aninhado relativo ao repo", () => {
    const d = editionDirDirective(NESTED, REPO, (p) => p);
    assert.match(d, /data\/editions\/2610\/261001(?![/\w])/);
    assert.match(d, /data\/editions\/2610\/261001\/_internal\//);
    assert.ok(!d.includes("caminho real"), "sem junction não cita caminho real");
  });

  it("data/ junction -> cita também o caminho real (o mesmo do --add-dir)", () => {
    const d = editionDirDirective(NESTED, REPO, junction);
    assert.match(d, /caminho real: \/onedrive\/diaria\/data\/editions\/2610\/261001/);
  });

  it("edição ainda não criada (realpath lança) -> não lança, cita o path resolvido", () => {
    const d = editionDirDirective(NESTED, REPO, () => {
      throw new Error("ENOENT");
    });
    assert.match(d, /data\/editions\/2610\/261001/);
  });

  it("editionDir fora do repo -> cita o path absoluto", () => {
    const d = editionDirDirective("/onedrive/diaria/data/editions/2610/261001", REPO, (p) => p);
    assert.match(d, /\/onedrive\/diaria\/data\/editions\/2610\/261001/);
  });
});

describe("#9223 runEditionStages: prompt carrega o diretório da edição", () => {
  it("Stage 2 do cenário 261001 recebe o path aninhado no prompt", () => {
    const calls: string[][] = [];
    const res = runEditionStages({
      aammdd: "261001",
      editionDir: NESTED,
      repoRootAbs: REPO,
      resolveClaudeBin: () => "/bin/claude",
      env: {} as NodeJS.ProcessEnv,
      nowMs: () => 0,
      realpathFn: junction,
      plan: [{ stage: 2, skill: "diaria-2-escrita" }],
      execFn: ((_c: string, args: string[]) => {
        calls.push(args);
        return "{}";
      }) as never,
      assertSentinelFn: (() =>
        (calls.length === 0
          ? { ok: false, reason: "sentinel_missing", missingOutputs: [] }
          : { ok: true })) as never,
    });
    assert.equal(res.exitCode, 0);
    const prompt = calls[0].at(-1) ?? "";
    assert.ok(prompt.startsWith("/diaria-2-escrita 261001 "));
    assert.match(prompt, /data\/editions\/2610\/261001/);
    assert.match(prompt, /caminho real: \/onedrive\/diaria\/data\/editions\/2610\/261001/);
  });
});
