/**
 * #9086 — Stage 2 spawnado concluiu que a edição "não existia em disco" e saiu
 * 0 sem sentinela: `data/` é junction pra fora do repo e `acceptEdits` negava
 * Write/Bash sobre ela. Trava: (1) `--add-dir` do alvo real de `data/` quando
 * fora do repo; (2) exit 0 sem sentinela = falha explícita, com as
 * `permission_denials` no failureTail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dataAddDirArgs,
  runEditionStages,
  summarizePermissionDenials,
} from "../scripts/lib/edition-stage-runner.ts";

const junction = (p: string) => (p === "/repo/data" ? "/onedrive/diaria/data" : p);

describe("#9086 dataAddDirArgs", () => {
  it("data/ junction pra fora do repo -> --add-dir alvo real", () => {
    assert.deepEqual(dataAddDirArgs("/repo", junction), ["--add-dir", "/onedrive/diaria/data"]);
  });
  it("data/ dentro do repo -> nenhum arg", () => {
    assert.deepEqual(dataAddDirArgs("/repo", (p) => p), []);
  });
  it("data/ ausente -> nenhum arg (não lança)", () => {
    assert.deepEqual(
      dataAddDirArgs("/repo", (p) => {
        if (p.endsWith("data")) throw new Error("ENOENT");
        return p;
      }),
      [],
    );
  });
});

describe("#9086 summarizePermissionDenials", () => {
  it("agrupa por ferramenta", () => {
    const raw = JSON.stringify({
      result: "x",
      permission_denials: [{ tool_name: "Write" }, { tool_name: "Bash" }, { tool_name: "Write" }],
    });
    assert.equal(summarizePermissionDenials(raw), "3 permission_denials (Write×2, Bash×1)");
  });
  it("sem negação / não-JSON -> null", () => {
    assert.equal(summarizePermissionDenials(JSON.stringify({ result: "ok" })), null);
    assert.equal(summarizePermissionDenials("texto"), null);
  });
});

describe("#9086 runEditionStages", () => {
  const base = {
    aammdd: "260930",
    editionDir: "/onedrive/diaria/data/editions/2609/260930",
    repoRootAbs: "/repo",
    resolveClaudeBin: () => "/bin/claude",
    env: {} as NodeJS.ProcessEnv,
    nowMs: () => 0,
    realpathFn: junction,
    plan: [{ stage: 2, skill: "diaria-2-escrita" }],
  };

  it("passa --add-dir do alvo real ao claude -p", () => {
    const calls: string[][] = [];
    const res = runEditionStages({
      ...base,
      execFn: ((_c: string, args: string[]) => {
        calls.push(args);
        return "{}";
      }) as never,
      // 1ª checagem (pré-spawn) ausente -> spawna; pós-spawn presente.
      assertSentinelFn: () =>
        (calls.length === 0
          ? { ok: false, reason: "sentinel_missing", missingOutputs: [] }
          : { ok: true }) as never,
    } as never);
    assert.equal(res.exitCode, 0);
    const i = calls[0].indexOf("--add-dir");
    assert.ok(i >= 0);
    assert.equal(calls[0][i + 1], "/onedrive/diaria/data");
    assert.ok(calls[0].at(-1)?.startsWith("/diaria-2-escrita 260930"));
  });

  it("exit 0 sem sentinela -> falha explícita com permission_denials no tail", () => {
    const stdout = JSON.stringify({
      result: "Edição 260930 não existe em disco",
      permission_denials: [{ tool_name: "Bash" }],
    });
    const res = runEditionStages({
      ...base,
      execFn: (() => stdout) as never,
      assertSentinelFn: () => ({ ok: false, reason: "sentinel_missing", missingOutputs: [] }) as never,
    } as never);
    assert.equal(res.exitCode, 1);
    assert.equal(res.failedStage, 2);
    const tail = res.outcomes[0].failureTail ?? "";
    assert.match(tail, /sentinela não foi escrita/);
    assert.match(tail, /1 permission_denials \(Bash×1\)/);
  });
});
