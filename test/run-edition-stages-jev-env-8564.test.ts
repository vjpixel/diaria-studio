/**
 * test/run-edition-stages-jev-env-8564.test.ts (#8564)
 *
 * `--diaria-edicao-jev` traduzia SÓ `JEV_FORCE_ACTOR_BRAZIL=1` no ambiente
 * dos subprocessos `claude -p` spawnados pelo laço (`scripts/run-edition-stages.ts`
 * → `runEditionStages` → `execFn`) — o perfil completo do braço B exige
 * também `DIARIA_JEV_PROFILE=all` (`JEV_PROFILE_ENV`, `jev-profile.ts`),
 * senão features como `dedup_grayzone` (`isJevFeatureOn`) nunca ligam,
 * mesmo com o marcador `.jev-profile.json` dizendo `profile:"all"`.
 *
 * Este teste chama `main()` de ponta a ponta com `execFn` injetado (nunca
 * spawna um `claude` real) e confere o `env` que chegaria ao subprocesso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../scripts/run-edition-stages.ts";
import { JEV_PROFILE_ENV } from "../scripts/lib/jev-profile.ts";

/** 1ª chamada (pré-spawn) = "faltando" (deixa o laço spawnar); 2ª (pós-spawn) = "ok" (satisfaz a pós-condição sem I/O real de disco). */
function fakeAssertSentinelFn(): () => { ok: true } | { ok: false; reason: "sentinel_missing" } {
  let calls = 0;
  return () => {
    calls++;
    return calls === 1 ? { ok: false, reason: "sentinel_missing" } : { ok: true };
  };
}

function fakeExecFn(capturedEnvs: NodeJS.ProcessEnv[]) {
  return ((_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    capturedEnvs.push(options.env ?? {});
    // `--output-format json` espera um objeto parseável no stdout — o
    // suficiente pra `runEditionStages` seguir sem lançar antes de chegar à
    // pós-condição de sentinela (que este teste também stuba).
    return JSON.stringify({ result: "ok", total_cost_usd: 0, usage: {} });
  }) as unknown as typeof import("node:child_process").execFileSync;
}

describe("#8564: --diaria-edicao-jev propaga DIARIA_JEV_PROFILE=all ao subprocesso claude", () => {
  it("com --diaria-edicao-jev, o env do subprocesso do Stage 1 carrega JEV_FORCE_ACTOR_BRAZIL=1 E DIARIA_JEV_PROFILE=all", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-"));
    try {
      const capturedEnvs: NodeJS.ProcessEnv[] = [];
      const exitCode = main(
        ["--edition", "260921", "--through", "1", "--diaria-edicao-jev"],
        {
          execFn: fakeExecFn(capturedEnvs),
          resolveClaudeBinFn: () => "claude",
          assertSentinelFn: fakeAssertSentinelFn(),
          env: {},
          stdout: () => {},
          stderr: () => {},
          repoRootAbs,
        },
      );
      assert.equal(exitCode, 0);
      assert.equal(capturedEnvs.length, 1, "esperava exatamente 1 spawn (Stage 1, --through 1)");
      assert.equal(capturedEnvs[0].JEV_FORCE_ACTOR_BRAZIL, "1");
      assert.equal(capturedEnvs[0][JEV_PROFILE_ENV], "all", "DIARIA_JEV_PROFILE=all precisa chegar ao subprocesso — sem isso dedup_grayzone nunca liga (#8564)");
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  it("SEM --diaria-edicao-jev, nenhuma das 2 vars aparece no env do subprocesso (comportamento pré-#8504/#8564 intocado)", () => {
    const repoRootAbs = mkdtempSync(join(tmpdir(), "diaria-run-edition-stages-"));
    try {
      const capturedEnvs: NodeJS.ProcessEnv[] = [];
      const exitCode = main(
        ["--edition", "260921", "--through", "1"],
        {
          execFn: fakeExecFn(capturedEnvs),
          resolveClaudeBinFn: () => "claude",
          assertSentinelFn: fakeAssertSentinelFn(),
          env: {},
          stdout: () => {},
          stderr: () => {},
          repoRootAbs,
        },
      );
      assert.equal(exitCode, 0);
      assert.equal(capturedEnvs.length, 1);
      assert.equal(capturedEnvs[0].JEV_FORCE_ACTOR_BRAZIL, undefined);
      assert.equal(capturedEnvs[0][JEV_PROFILE_ENV], undefined);
    } finally {
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });
});
