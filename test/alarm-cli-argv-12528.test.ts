/**
 * #12528 — os 12 scripts que ficaram fora da #12503 agora validam o argv
 * antes de qualquer I/O. Processo real (não só o regex da catraca em
 * `alarm-cli-guard-12503.test.ts`): `--help` sai 0 com o uso e um typo de
 * flag sai ≠ 0 sem imprimir nada do modo REAL. Antes, os dois caíam no
 * caminho normal (e-mail, issue, chamada paga, escrita no GitHub).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

interface Caso {
  script: string;
  /** Exit de argv inválido: 1 pelo helper, 2 onde o script já usava 2 pra uso inválido. */
  erro: 1 | 2;
}

const CASOS: Caso[] = [
  { script: "aquisicao-reconcile-daily.ts", erro: 1 },
  { script: "check-alarm-retirement-candidates.ts", erro: 1 },
  { script: "geo-citation-monitor.ts", erro: 2 },
  { script: "hubs-weekly-regen.ts", erro: 1 },
  { script: "kit-subscriber-state-transition-alarm.ts", erro: 1 },
  { script: "overnight-watchdog.ts", erro: 1 },
  { script: "publish-circle-stack.ts", erro: 1 },
  { script: "reconcile-send-audiences.ts", erro: 1 },
  { script: "register-pending-data-writes.ts", erro: 2 },
  { script: "round-diff-stats-report.ts", erro: 1 },
  { script: "route-issue.ts", erro: 1 },
  { script: "sync-kit-frio.ts", erro: 2 },
];

function run(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      ["--import", "tsx", join("scripts", script), ...args],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } },
      (err, stdout, stderr) => {
        const code: unknown = err ? (err as { code?: unknown }).code : 0;
        resolveRun({ code: typeof code === "number" ? code : null, stdout, stderr });
      },
    );
  });
}

describe("argv validado antes do I/O nos 12 scripts da #12528 (processo real)", () => {
  test("--help sai 0 com o uso; typo de flag sai com o código de uso inválido", async () => {
    const resultados = await Promise.all(
      CASOS.map(async (c) => ({
        c,
        help: await run(c.script, ["--help"]),
        typo: await run(c.script, ["--dryrun-12528"]),
      })),
    );
    for (const { c, help, typo } of resultados) {
      assert.equal(help.code, 0, `${c.script} --help: exit ${help.code}\n${help.stderr}`);
      assert.match(help.stdout, new RegExp(`uso: npx tsx scripts/${c.script.replace(/\./g, "\\.")}`, "i"), `${c.script} --help sem uso`);
      assert.equal(typo.code, c.erro, `${c.script} --dryrun-12528: exit ${typo.code}\n${typo.stderr}`);
      assert.match(typo.stderr, /--dryrun-12528/, `${c.script}: a mensagem não cita a flag recusada`);
      assert.equal(typo.stdout, "", `${c.script}: imprimiu no stdout antes de recusar o argv:\n${typo.stdout}`);
    }
  });

  test("flag de valor sem valor também é recusada (route-issue --reason, register --pr)", async () => {
    const [route, register] = await Promise.all([
      run("route-issue.ts", ["--issue", "1", "--track", "overnight", "--reason"]),
      run("register-pending-data-writes.ts", ["--pr"]),
    ]);
    assert.equal(route.code, 1, route.stderr);
    assert.match(route.stderr, /--reason exige um valor/);
    assert.equal(register.code, 2, register.stderr);
    assert.match(register.stderr, /--pr exige um valor/);
  });
});
