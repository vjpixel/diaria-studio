/**
 * test/session-registry-batch-claim-12010.test.ts (#12010)
 *
 * Rodada overnight 261103: o coordenador reivindicou as issues de uma onda com
 * vários `claim-issue` (em paralelo e, depois, em série), e o registro
 * reconstruiu a âncora a partir de cópias de conflito do OneDrive. Dentro da
 * máquina as escritas já se serializam (lock + CAS, #6952); o que dispara a
 * cópia de conflito é a rajada de write-then-rename na âncora sincronizada.
 * O fix é `claim-issue --issues A,B,C`: a onda numa escrita só.
 *
 * Cobre:
 *   - lote grava todas as issues numa escrita (`writes: 1`, um único
 *     `lastHeartbeat`/`claimed_issues_at` para o lote);
 *   - recusa de uma issue do lote não derruba as outras;
 *   - âncora ausente com cópia órfã viva: reconstrução UMA vez para o lote,
 *     claims anteriores preservadas;
 *   - CLI `--issues` (saída por issue, exit code) e `--issue` + `--issues`
 *     juntos recusados;
 *   - N `claim-issue` em PARALELO (processos distintos) não perdem claim — o
 *     cenário da issue, travado como regressão do merge determinístico.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  claimIssueCheckAndSet,
  claimIssuesAutoRegistering,
  claimIssuesCheckAndSet,
  registerSession,
  requireClaimIssueList,
  sessionFilePath,
  sessionsDir,
} from "../scripts/lib/session-registry.ts";

const NOW = Date.parse("2026-11-03T03:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const TAG = "300";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "registry-12010-"));
  roots.push(root);
  return root;
}

function readAnchor(root: string, kind: "overnight" | "develop", sessionId: string) {
  return JSON.parse(readFileSync(sessionFilePath(root, kind, TAG, sessionId), "utf8"));
}

describe("claimIssuesCheckAndSet — a onda inteira numa escrita da âncora (#12010)", () => {
  it("reivindica todas as issues do lote com UMA escrita", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "coord", { tag: TAG, startedAt: iso(NOW - 60_000) });

    const result = claimIssuesCheckAndSet(root, "overnight", "coord", [101, 102, 103, 104], TAG, iso(NOW));

    assert.equal(result.ok, true);
    assert.equal(result.writes, 1);
    assert.deepEqual(
      result.entries.map((e) => [e.label, e.reason]),
      [
        ["#101", "claimed"],
        ["#102", "claimed"],
        ["#103", "claimed"],
        ["#104", "claimed"],
      ],
    );
    const anchor = readAnchor(root, "overnight", "coord");
    assert.deepEqual(anchor.claimed_issues, [101, 102, 103, 104]);
    assert.equal(anchor.lastHeartbeat, iso(NOW));
    assert.deepEqual(
      new Set(Object.values(anchor.claimed_issues_at)),
      new Set([iso(NOW)]),
      "todas as claims do lote nascem na mesma escrita",
    );
  });

  it("issue repetida conta uma vez; já-minha é no-op e não força escrita", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "coord", { tag: TAG, startedAt: iso(NOW - 60_000) });
    claimIssueCheckAndSet(root, "overnight", "coord", 200, TAG, iso(NOW - 30_000));

    const onlyOwn = claimIssuesCheckAndSet(root, "overnight", "coord", [200, 200], TAG, iso(NOW));
    assert.equal(onlyOwn.ok, true);
    assert.equal(onlyOwn.writes, 0, "nada novo a gravar: zero renames na âncora");
    assert.equal(onlyOwn.entries.length, 1);
    assert.equal(onlyOwn.entries[0]!.reason, "already-own");

    const mixed = claimIssuesCheckAndSet(root, "overnight", "coord", [200, 201, 201], TAG, iso(NOW));
    assert.deepEqual(
      mixed.entries.map((e) => [e.label, e.reason]),
      [
        ["#200", "already-own"],
        ["#201", "claimed"],
      ],
    );
    assert.equal(mixed.writes, 1);
    assert.deepEqual(readAnchor(root, "overnight", "coord").claimed_issues, [200, 201]);
  });

  it("issue de outra sessão ativa é recusada sem derrubar as demais do lote", () => {
    const root = freshRoot();
    registerSession(root, "develop", "outra", { tag: TAG, startedAt: iso(NOW - 60_000) });
    claimIssueCheckAndSet(root, "develop", "outra", 302, TAG, iso(NOW - 30_000));
    registerSession(root, "overnight", "coord", { tag: TAG, startedAt: iso(NOW - 60_000) });

    const result = claimIssuesCheckAndSet(root, "overnight", "coord", [301, 302, 303], TAG, iso(NOW));

    assert.equal(result.ok, false);
    const byLabel = Object.fromEntries(result.entries.map((e) => [e.label, e]));
    assert.equal(byLabel["#301"]!.reason, "claimed");
    assert.equal(byLabel["#302"]!.reason, "blocked-by-other");
    assert.equal(byLabel["#302"]!.blockedBy?.sessionId, "outra");
    assert.equal(byLabel["#303"]!.reason, "claimed");
    assert.deepEqual(readAnchor(root, "overnight", "coord").claimed_issues, [301, 303]);

    const forced = claimIssuesCheckAndSet(root, "overnight", "coord", [302], TAG, iso(NOW), { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.entries[0]!.reason, "forced-override");
  });

  it("sessão sem âncora: sem auto-registro devolve no-op por issue, nunca escreve", () => {
    const root = freshRoot();
    const result = claimIssuesCheckAndSet(root, "overnight", "ninguem", [1, 2], TAG, iso(NOW));
    assert.equal(result.ok, false);
    assert.equal(result.writes, 0);
    assert.ok(result.entries.every((e) => e.reason === "no-op-session-missing"));
  });

  it("lista vazia é erro, não lote vazio de sucesso", () => {
    const root = freshRoot();
    registerSession(root, "overnight", "coord", { tag: TAG, startedAt: iso(NOW - 60_000) });
    assert.throws(() => claimIssuesCheckAndSet(root, "overnight", "coord", [], TAG, iso(NOW)), /vazia/);
  });
});

describe("claimIssuesAutoRegistering — âncora ausente resolvida uma vez para o lote (#12010)", () => {
  it("cenário da rodada 261103: âncora sumiu, cópia órfã viva com 11 claims — o lote reconstrói e soma as novas", () => {
    const root = freshRoot();
    const previas = [11001, 11002, 11003, 11004, 11005, 11006, 11007, 11008, 11009, 11010, 11011];
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(
      join(sessionsDir(root), `overnight-${TAG}-coord-${TAG}-safeBackup-0001.json`),
      JSON.stringify({
        kind: "overnight",
        machineTag: TAG,
        sessionId: "coord",
        startedAt: iso(NOW - 3 * 60 * 60 * 1000),
        lastHeartbeat: iso(NOW - 60_000),
        claimed_issues: previas,
      }),
    );

    const originalWrite = process.stderr.write;
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result;
    try {
      result = claimIssuesAutoRegistering(root, "overnight", "coord", [12010, 12011], TAG, iso(NOW));
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(result.ok, true);
    assert.equal(result.autoRegisterMode, "recovered-from-orphan-backups");
    assert.deepEqual(result.recoveredClaims, previas);
    assert.equal(stderr.match(/ATENÇÃO/g)?.length, 1, "um aviso de reconstrução para o lote, não um por issue");
    assert.deepEqual(readAnchor(root, "overnight", "coord").claimed_issues, [...previas, 12010, 12011]);
  });

  it("sessão nunca registrada: auto-registra e reivindica o lote", () => {
    const root = freshRoot();
    const result = claimIssuesAutoRegistering(root, "develop", "nova", [7, 8], TAG, iso(NOW));
    assert.equal(result.ok, true);
    assert.equal(result.autoRegisterMode, "fresh");
    assert.deepEqual(readAnchor(root, "develop", "nova").claimed_issues, [7, 8]);
  });
});

describe("requireClaimIssueList (#12010)", () => {
  it("separa por vírgula, ignora espaços e itens vazios", () => {
    assert.deepEqual(requireClaimIssueList({ issues: "1, 2,,3" }, new Set(), []), [1, 2, 3]);
  });
  it("--issue junto com --issues é recusado", () => {
    assert.throws(() => requireClaimIssueList({ issue: "1", issues: "2" }, new Set(), []), /nunca os dois/);
  });
  it("--issues sem itens é recusado", () => {
    assert.throws(() => requireClaimIssueList({ issues: " , " }, new Set(), []), /ao menos uma/);
  });
});

// ─── CLI ──────────────────────────────────────────────────────────────────

const CLI = fileURLToPath(new URL("../scripts/lib/session-registry.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))).href;

function freshCliRoot(): string {
  const root = freshRoot();
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "diaria-studio" }));
  return root;
}

function cli(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function cliAsync(root: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function anchorRecord(root: string, sessionId: string) {
  const dir = join(root, "data", "sessions");
  const name = readdirSync(dir).find((n) => n.endsWith(`-${sessionId}.json`) && !n.includes("safeBackup"));
  assert.ok(name, `âncora de ${sessionId} deveria existir`);
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

describe("CLI claim-issue --issues (#12010)", () => {
  it("lote reivindica tudo, imprime uma linha por issue e a contagem de escritas", () => {
    const root = freshCliRoot();
    const reg = cli(root, ["register", "--kind", "overnight", "--session-id", "coord-cli"]);
    assert.equal(reg.status, 0, reg.stderr);

    const res = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "coord-cli", "--issues", "501,502,503"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /claim-issue #501 ok \(claimed\)/);
    assert.match(res.stdout, /claim-issue #503 ok \(claimed\)/);
    assert.match(res.stdout, /3\/3 ok, 1 escrita\(s\) na âncora/);
    assert.deepEqual(anchorRecord(root, "coord-cli").claimed_issues, [501, 502, 503]);
  });

  it("issue de outra sessão no lote: as demais colam e o exit é 1", () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "develop", "--session-id", "outra-cli"]).status, 0);
    assert.equal(cli(root, ["claim-issue", "--kind", "develop", "--session-id", "outra-cli", "--issue", "602"]).status, 0);
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "coord-cli2"]).status, 0);

    const res = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "coord-cli2", "--issues", "601,602,603"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /#602 RECUSADO/);
    assert.match(res.stdout, /2\/3 ok/);
    assert.deepEqual(anchorRecord(root, "coord-cli2").claimed_issues, [601, 603]);
  });

  it("--issue e --issues juntos: recusa sem escrever nada", () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "coord-cli3"]).status, 0);
    const res = cli(root, ["claim-issue", "--kind", "overnight", "--session-id", "coord-cli3", "--issue", "1", "--issues", "2"]);
    assert.notEqual(res.status, 0);
    assert.deepEqual(anchorRecord(root, "coord-cli3").claimed_issues ?? [], []);
  });

  it("regressão do cenário da issue: 6 claim-issue em PARALELO na mesma sessão não perdem nenhuma claim", async () => {
    const root = freshCliRoot();
    assert.equal(cli(root, ["register", "--kind", "overnight", "--session-id", "coord-par"]).status, 0);

    const issues = [701, 702, 703, 704, 705, 706];
    const results = await Promise.all(
      issues.map((n) =>
        cliAsync(root, ["claim-issue", "--kind", "overnight", "--session-id", "coord-par", "--issue", String(n)]),
      ),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(anchorRecord(root, "coord-par").claimed_issues, issues);
  });
});
