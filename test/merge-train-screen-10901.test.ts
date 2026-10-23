/**
 * test/merge-train-screen-10901.test.ts (#10901, resíduo da fatia 4 da #10618)
 *
 * 1. `screenTrainPrs`: em `--prs` (lista explícita) PR de fora recusa o trem;
 *    em `--open` (descoberta) é só filtrado; PR fechado entre a composição e o
 *    trem é pulado nos dois modos, com mensagem que não fala em "outro repo".
 * 2. `checkStudioTrainPr` com payload `null`/array → `unreadable`.
 * 3. Ponta a ponta do CLI `run-merge-train.ts` com um `gh` falso no PATH:
 *    foreign em `--prs` → exit 2; `gh` falhando → exit 1; `--open` com só um
 *    PR de base `main` → exit 0 sem tocar nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkStudioTrainPr,
  screenTrainPrs,
  type TrainRunner,
  type ExecResult,
} from "../scripts/lib/merge-train-live.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const studio = (pr: number) => ({
  state: "OPEN",
  baseRefName: "master",
  url: `https://github.com/vjpixel/diaria-studio/pull/${pr}`,
  isCrossRepository: false,
});

function runnerFor(views: Record<number, unknown | "fail">): TrainRunner {
  return {
    exec(cmd: string, args: string[]): ExecResult {
      assert.equal(cmd, "gh");
      const pr = Number(args[2]);
      const v = views[pr];
      if (v === "fail") return { ok: false, stdout: "", stderr: "HTTP 502" };
      return { ok: true, stdout: JSON.stringify(v), stderr: "" };
    },
    sleep: async () => {},
    now: () => 0,
    mkTempDir: (p) => p,
    warn: () => {},
  };
}

describe("#10901 — screenTrainPrs", () => {
  const views = {
    1: studio(1),
    2: { ...studio(2), baseRefName: "release" },
    3: { ...studio(3), isCrossRepository: true },
    4: { ...studio(4), state: "CLOSED" },
    5: "fail" as const,
  };

  it("--open: PR de base diferente ou de fork é filtrado, nunca recusa o trem", () => {
    const r = screenTrainPrs(runnerFor(views), [1, 2, 3, 4], true);
    assert.deepEqual(r.admitted, [1]);
    assert.equal(r.refused.length, 0);
    assert.equal(r.skipped.length, 3);
    assert.equal(r.unreadable.length, 0);
  });

  it("--prs: PR de fora recusa; PR fechado só é pulado", () => {
    const r = screenTrainPrs(runnerFor(views), [1, 2, 4], false);
    assert.deepEqual(r.admitted, [1]);
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0], /#2/);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /#4/);
    assert.doesNotMatch(r.skipped[0], /outro repo/);
  });

  it("ilegível continua fail-closed nos dois modos", () => {
    for (const discovered of [true, false]) {
      const r = screenTrainPrs(runnerFor(views), [1, 5], discovered);
      assert.deepEqual(r.admitted, [1]);
      assert.equal(r.unreadable.length, 1);
    }
  });

  it("PR de base diferente que também está fechado é foreign (base vem antes do state)", () => {
    const r = checkStudioTrainPr(runnerFor({ 7: { ...studio(7), state: "MERGED", baseRefName: "main" } }), 7);
    assert.equal(r.verdict, "foreign");
  });
});

describe("#10901 — checkStudioTrainPr com payload null/array", () => {
  it("null → unreadable", () => {
    assert.equal(checkStudioTrainPr(runnerFor({ 9: null }), 9).verdict, "unreadable");
  });
  it("array → unreadable", () => {
    assert.equal(checkStudioTrainPr(runnerFor({ 9: [studio(9)] }), 9).verdict, "unreadable");
  });
});

/** `gh` falso: `pr list` devolve `LIST`, `pr view N` devolve `VIEW_N` (ou falha
 * se `GH_FAIL=1`). Tudo via env, sem tocar a rede. */
const FAKE_GH = `#!/usr/bin/env bash
if [ "$GH_FAIL" = "1" ]; then echo "HTTP 502" >&2; exit 1; fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' "$FAKE_LIST"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then v="FAKE_VIEW_$3"; printf '%s' "\${!v}"; exit 0; fi
echo "gh falso: chamada inesperada: $*" >&2; exit 99
`;

function runCli(args: string[], env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-10901-"));
  try {
    const gh = join(bin, "gh");
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    return spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "run-merge-train.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ...env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("#10901 — run-merge-train ponta a ponta (gh falso)", { skip: process.platform === "win32" }, () => {
  const base = ["--session-id", "teste-10901", "--kind", "overnight"];

  it("--prs com PR do design (url de outro repo) → exit 2", () => {
    const r = runCli([...base, "--prs", "23"], {
      FAKE_VIEW_23: JSON.stringify({ ...studio(23), url: "https://github.com/vjpixel/diaria-design/pull/23", baseRefName: "main" }),
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /RECUSADO/);
  });

  it("gh ilegível → exit 1", () => {
    const r = runCli([...base, "--prs", "23"], { GH_FAIL: "1" });
    assert.equal(r.status, 1, r.stderr);
  });

  it("--open com só um PR de base main → filtrado, exit 0, nada a fazer", () => {
    const r = runCli([...base, "--open"], {
      FAKE_LIST: JSON.stringify([{ number: 31 }]),
      // `--open` só lista PR com Gate 1 verde: o mesmo `gh pr view` serve as
      // duas leituras (statusCheckRollup e a triagem só-studio).
      FAKE_VIEW_31: JSON.stringify({
        ...studio(31),
        baseRefName: "main",
        statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS", status: "COMPLETED" }],
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PULADO/);
    assert.match(r.stdout, /nada a fazer/);
  });

  it("--prs com PR fechado → pulado, exit 0 (não recusa o trem)", () => {
    const r = runCli([...base, "--prs", "40"], {
      FAKE_VIEW_40: JSON.stringify({ ...studio(40), state: "MERGED" }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PULADO/);
  });
});
