/**
 * test/check-surfaced-live.test.ts (#5925 fix)
 *
 * Cobre a camada de I/O de `scripts/check-surfaced-live.ts` (o entrypoint),
 * separado de `test/surfaced-live-gate.test.ts` (lógica pura). Foco: o bug
 * crítico encontrado no review do PR #5925 — `plan.json.issues` aceita dois
 * shapes (array, overnight; dict chaveado por número, develop — ver
 * `scripts/lib/plan-issues-normalize.ts`), e o entrypoint só tratava array,
 * quebrando com `TypeError: ... is not iterable` no shape dict, que É o
 * shape real de vários `plan.json` de `/diaria-develop` (260808, 260808b,
 * 260809, 260809b, 260809c, 260811, 260817b — não hipotético).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/check-surfaced-live.ts");

function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, ...args],
    { encoding: "utf8", cwd: ROOT, env: { ...process.env } },
  );
}

describe("check-surfaced-live.ts (entrypoint, #5925 fix)", () => {
  it("plan.json com issues DICT-shaped (formato real do develop) não crasha — falha limpo com exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-surfaced-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(
        planPath,
        JSON.stringify({
          issues: {
            "5878": {
              status: "pendente",
              what_unblocks: "editor logar na conta Microsoft Advertising neste Chrome",
              // sem surfaced_live — deve virar failure, não crash
            },
          },
        }),
      );
      const r = run(["--plan", planPath]);
      assert.equal(r.status, 1, `esperava exit 1, veio ${r.status}; stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /TypeError|is not iterable|not a function/);
      assert.match(r.stderr, /#5878/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan.json com issues DICT-shaped, tudo surfaceado => exit 0, sem crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-surfaced-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(
        planPath,
        JSON.stringify({
          issues: {
            "5808": {
              what_unblocks: "decisão de ativação na Beehiiv",
              surfaced_live: true,
              surfaced_live_at: "2026-08-22T00:10:00Z",
            },
          },
        }),
      );
      const r = run(["--plan", planPath]);
      assert.equal(r.status, 0, `esperava exit 0, veio ${r.status}; stderr: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan.json com issues ARRAY-shaped (formato overnight) continua funcionando", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-surfaced-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(
        planPath,
        JSON.stringify({
          issues: [
            { number: 100, what_unblocks: "token X", surfaced_live: false },
          ],
        }),
      );
      const r = run(["--plan", planPath]);
      assert.equal(r.status, 0, `false é warning, não failure — esperava exit 0; stderr: ${r.stderr}`);
      assert.match(r.stderr, /HANDOFF/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--strict promove false explícito a failure (exit 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-surfaced-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(
        planPath,
        JSON.stringify({
          issues: [{ number: 200, what_unblocks: "conta terceiro", surfaced_live: false }],
        }),
      );
      const semStrict = run(["--plan", planPath]);
      assert.equal(semStrict.status, 0, "sem --strict, false explícito é warning");

      const comStrict = run(["--plan", planPath, "--strict"]);
      assert.equal(comStrict.status, 1, "com --strict, false explícito vira failure");
      assert.match(comStrict.stderr, /--strict/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan.json ausente em disco => exit 2 (erro duro, não fail-soft)", () => {
    const r = run(["--plan", "data/develop/nao-existe-260822z/plan.json"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /não encontrado/);
  });

  it("plan.json malformado (JSON inválido) => exit 2, sem crash cru", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-surfaced-"));
    const planPath = join(dir, "plan.json");
    try {
      writeFileSync(planPath, "{ isso não é json válido");
      const r = run(["--plan", planPath]);
      assert.equal(r.status, 2);
      assert.doesNotMatch(r.stderr, /TypeError|is not iterable/);
      assert.match(r.stderr, /ilegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
