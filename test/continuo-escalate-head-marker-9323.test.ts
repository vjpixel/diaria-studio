/**
 * test/continuo-escalate-head-marker-9323.test.ts (#9323)
 *
 * `check-continuo-escalate-label.ts` gravava no marcador
 * `<!-- continuo-escalate: head=<sha> -->` o `headRefOid` RELIDO no momento
 * da escrita, não o SHA que o merge gate julgou. Corrida: gate escala A,
 * push de B, marcador grava B — e `watch-continuo-health.sh` passava a
 * excluir do alarme de fila uma PR cujo head B nunca foi escalado.
 *
 * Roda o CLI de verdade com um `gh` falso no PATH cujo `headRefOid` é B
 * (o push que entrou depois do gate) e checa o corpo do comentário POSTado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/check-continuo-escalate-label.ts";
const JUDGED = "a".repeat(40); // head que o gate julgou
const PUSHED = "b".repeat(40); // head que entrou depois do veredito

function makeFakeGh(): { dir: string; postLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-9323-"));
  const postLog = join(dir, "posts.log");
  const fakeJs = [
    'import { appendFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    "const joined = argv.join(' ');",
    "if (argv[0] === 'pr' && argv[1] === 'view') {",
    "  if (joined.includes('headRefOid')) { process.stdout.write(" + JSON.stringify(PUSHED) + " + '\\n'); process.exit(0); }",
    "  process.stdout.write(JSON.stringify(['continuo-escalado'])); process.exit(0);",
    "}",
    "if (argv[0] === 'api' && joined.includes('POST')) {",
    "  appendFileSync(process.env.FAKE_GH_POSTS, joined + '\\n');",
    "  process.stdout.write('{}'); process.exit(0);",
    "}",
    "if (argv[0] === 'api' && joined.includes('/comments')) { process.exit(0); }",
    "process.stderr.write('fake gh: nao previsto: ' + joined + '\\n'); process.exit(1);",
  ].join("\n");
  const fakeJsPath = join(dir, "fake-gh.mjs");
  writeFileSync(fakeJsPath, fakeJs, "utf8");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env bash\nexec node "${fakeJsPath}" "$@"\n`, "utf8");
  chmodSync(bin, 0o755);
  return { dir, postLog };
}

function run(args: string[], dir: string, postLog: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, FAKE_GH_POSTS: postLog, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

describe("marcador de head escalado grava o SHA julgado pelo gate (#9323)", () => {
  it("--head A com head atual B (push pós-gate) → marcador grava A, nunca B", () => {
    const { dir, postLog } = makeFakeGh();
    try {
      const { status } = run(["--pr", "9204", "--head", JUDGED], dir, postLog);
      assert.equal(status, 0);
      const posts = existsSync(postLog) ? readFileSync(postLog, "utf8") : "";
      assert.match(posts, new RegExp(`continuo-escalate: head=${JUDGED}`));
      assert.doesNotMatch(posts, new RegExp(PUSHED), "releu o head em vez de usar o julgado pelo gate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --head → não grava marcador nenhum (fail-open na direção do alarme), label segue", () => {
    const { dir, postLog } = makeFakeGh();
    try {
      const { stdout, status } = run(["--pr", "9204"], dir, postLog);
      assert.equal(status, 0);
      assert.equal(JSON.parse(stdout.trim()).labelApplied, true);
      const posts = existsSync(postLog) ? readFileSync(postLog, "utf8") : "";
      assert.doesNotMatch(posts, /continuo-escalate: head=/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--head inválido → uso inválido (exit 2)", () => {
    const { dir, postLog } = makeFakeGh();
    try {
      assert.equal(run(["--pr", "9204", "--head", "nao-e-sha"], dir, postLog).status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
