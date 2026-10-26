/**
 * #11113 — concessão de merge entre máquinas não sincronizava a partir do 2º
 * merge seguido.
 *
 * Cenário real (25/10/2026): overnight no Zenbook concede janelas, uma PR por
 * vez, a uma sessão interativa no Neo. O hook de consumo, rodando no Neo,
 * gravava `consumedAt` no arquivo da COORDENADORA (`overnight-Zenbook-….json`).
 * Pelo OneDrive esse write concorria com o heartbeat/`grant-merge` do Zenbook,
 * virava cópia de conflito a cada merge, e a cópia local parava de receber as
 * concessões seguintes — a 3ª nunca chegou ao Neo.
 *
 * O conserto: consumo de concessão de OUTRA máquina vai para o registro da
 * própria beneficiária (`data/sessions/.merge-grant-consumed-{sessão}.json`),
 * e todos os leitores o consultam. Estes testes reproduzem a sequência de
 * merges seguidos e provam que (1) o arquivo da coordenadora nunca é tocado
 * pela beneficiária de outra máquina, (2) a concessão consumida morre para
 * todos os leitores, e (3) a coordenadora consegue emitir a próxima concessão
 * para a mesma beneficiária sem `--force`.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  MERGE_GRANT_LEDGER_PREFIX,
  MERGE_GRANT_LEDGER_RETENTION_MS,
  consumeMergeGrant,
  findLiveMergeGrant,
  grantMergeWindow,
  machineTag,
  mergeGrantIdentityKey,
  mergeGrantLedgerPath,
  readMergeGrantConsumptions,
  recordMergeGrantConsumption,
  registerSession,
  sessionFilePath,
} from "../scripts/lib/session-registry.ts";
import * as ledgerLib from "../.claude/hooks/lib/merge-grant-ledger.mjs";
import { withIsolatedGhConfig } from "./helpers/isolated-gh-config.ts";

const HOOKS_DIR = join(import.meta.dirname, "..", ".claude", "hooks");
const CONSUME_HOOK_PATH = join(HOOKS_DIR, "consume-merge-grant-on-merge.mjs");
interface ConsumerHook {
  consumeGrantUnderLock(
    repoRoot: string, sessionId: string, nowIso?: string, attempts?: number, lockTimeoutMs?: number,
    targetPr?: number, opts?: { localTag?: string },
  ): boolean;
  findLiveMergeGrantFile(repoRoot: string, sessionId: string, now?: number, includeBackups?: boolean, targetPr?: number): unknown;
}
interface GuardHook {
  readLiveMergeGrantFor(repoRoot: string, sessionId: string, now?: number): { pr?: number } | null;
  readConsumedGrantFor(repoRoot: string, sessionId: string, now?: number): { pr?: number; consumedAt?: string } | null;
}
const consumer = (await import(pathToFileURL(CONSUME_HOOK_PATH).href)) as ConsumerHook;
const guard = (await import(pathToFileURL(join(HOOKS_DIR, "block-gh-pr-merge-subagent.mjs")).href)) as GuardHook;

const LOCAL = machineTag();
// Garante uma tag de máquina DIFERENTE da local, rode o teste onde rodar.
const REMOTE = LOCAL === "Zenbook" ? "Zenbook2" : "Zenbook";
const COORD = "coord-11113";
const BENEF = "interativa-11113";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "grant-ledger-11113-"));
  roots.push(root);
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  return root;
}

/** Coordenadora registrada como se o arquivo tivesse chegado do Zenbook pelo OneDrive. */
function remoteCoordinator(root: string): string {
  registerSession(root, "overnight", COORD, { tag: REMOTE });
  return sessionFilePath(root, "overnight", REMOTE, COORD);
}

function sessionDirNames(root: string): string[] {
  return readdirSync(join(root, "data", "sessions")).sort();
}

describe("#11113 — consumo cross-máquina não escreve no arquivo da coordenadora", () => {
  it("hook: 3 merges seguidos — arquivo da coordenadora intocado pela beneficiária, cada concessão morre e a próxima é emitida sem --force", () => {
    const root = freshRoot();
    const coordPath = remoteCoordinator(root);

    for (const pr of [11055, 11021, 10975]) {
      const granted = grantMergeWindow(root, "overnight", COORD, BENEF, { pr, tag: REMOTE });
      assert.equal(
        granted.ok,
        true,
        `a coordenadora não conseguiu conceder a PR ${pr} (${granted.reason}) — a concessão anterior, já consumida, ainda parecia viva`,
      );
      assert.equal(guard.readLiveMergeGrantFor(root, BENEF)?.pr, pr, "a beneficiária deveria ver a concessão nova");

      const before = readFileSync(coordPath, "utf8");
      assert.equal(consumer.consumeGrantUnderLock(root, BENEF, new Date().toISOString(), 3, 2_000, pr), true);
      assert.equal(
        readFileSync(coordPath, "utf8"),
        before,
        "a beneficiária escreveu no arquivo da coordenadora de outra máquina — é esse write que vira cópia de conflito no OneDrive",
      );

      assert.equal(guard.readLiveMergeGrantFor(root, BENEF), null, `concessão da PR ${pr} continua viva para o guard`);
      assert.equal(consumer.findLiveMergeGrantFile(root, BENEF, Date.now(), true, pr), null);
      assert.equal(findLiveMergeGrant(root, BENEF), null, "session-registry ainda vê a concessão viva");
      const consumed = guard.readConsumedGrantFor(root, BENEF);
      assert.equal(consumed?.pr, pr, "o diagnóstico do guard deveria reconhecer a concessão como consumida");
      assert.ok(consumed?.consumedAt);
    }

    // Nada de cópia de conflito e nada além do registro da beneficiária.
    assert.deepEqual(
      sessionDirNames(root).filter((n) => !n.endsWith(".lock")),
      [`${MERGE_GRANT_LEDGER_PREFIX}${BENEF}.json`, `overnight-${REMOTE}-${COORD}.json`].sort(),
    );
  });

  it("CLI (consumeMergeGrant): coordenadora remota → grava no registro da beneficiária, não no arquivo dela", () => {
    const root = freshRoot();
    const coordPath = remoteCoordinator(root);
    assert.equal(grantMergeWindow(root, "overnight", COORD, BENEF, { pr: 1, tag: REMOTE }).ok, true);
    const before = readFileSync(coordPath, "utf8");

    assert.equal(consumeMergeGrant(root, BENEF, Date.now(), { localTag: LOCAL }), true);
    assert.equal(readFileSync(coordPath, "utf8"), before);
    assert.ok(existsSync(mergeGrantLedgerPath(root, BENEF)));
    assert.equal(findLiveMergeGrant(root, BENEF), null);
    assert.equal(consumeMergeGrant(root, BENEF, Date.now(), { localTag: LOCAL }), false, "uso único");

    assert.equal(grantMergeWindow(root, "overnight", COORD, BENEF, { pr: 2, tag: REMOTE }).ok, true);
  });

  it("e2e: hook spawnado com coordenadora remota não toca o arquivo dela", () => {
    const root = freshRoot();
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/vjpixel/diaria-studio.git"], { cwd: root });
    const coordPath = remoteCoordinator(root);
    assert.equal(grantMergeWindow(root, "overnight", COORD, BENEF, { pr: 11113, tag: REMOTE }).ok, true);
    const before = readFileSync(coordPath, "utf8");

    const payload = { session_id: BENEF, tool_name: "Bash", tool_input: { command: "gh pr merge 11113 --squash" }, cwd: root };
    const result = spawnSync(process.execPath, [CONSUME_HOOK_PATH], {
      cwd: root,
      env: { ...withIsolatedGhConfig(), GH_REPO: "", GH_HOST: "github.invalid" },
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(coordPath, "utf8"), before);
    assert.equal(guard.readLiveMergeGrantFor(root, BENEF), null);
  });
});

describe("#11113 — mesma máquina segue como antes", () => {
  it("coordenadora local: consumedAt continua gravado no arquivo dela, sem registro da beneficiária", () => {
    const root = freshRoot();
    registerSession(root, "overnight", COORD, { tag: LOCAL });
    assert.equal(grantMergeWindow(root, "overnight", COORD, BENEF, { pr: 7 }).ok, true);
    assert.equal(consumer.consumeGrantUnderLock(root, BENEF, new Date().toISOString(), 3, 2_000, 7), true);
    const rec = JSON.parse(readFileSync(sessionFilePath(root, "overnight", LOCAL, COORD), "utf8"));
    assert.ok(rec.merge_grant.consumedAt);
    assert.equal(existsSync(mergeGrantLedgerPath(root, BENEF)), false);
  });
});

describe("#11113 — paridade TS × hook do registro de consumo", () => {
  const grant = { grantedBy: COORD, grantedTo: BENEF, grantedAt: new Date().toISOString(), pr: 9 };

  it("mesmo prefixo, mesma chave, mesmo caminho", () => {
    assert.equal(MERGE_GRANT_LEDGER_PREFIX, ledgerLib.MERGE_GRANT_LEDGER_PREFIX);
    assert.equal(MERGE_GRANT_LEDGER_RETENTION_MS, ledgerLib.MERGE_GRANT_LEDGER_RETENTION_MS);
    assert.equal(mergeGrantIdentityKey(grant), ledgerLib.mergeGrantIdentityKey(grant));
    assert.equal(mergeGrantLedgerPath("/r", "a/b c"), ledgerLib.mergeGrantLedgerPath("/r", "a/b c"));
  });

  it("o que o TS grava o hook lê, e vice-versa", () => {
    const root = freshRoot();
    const t1 = "2026-10-25T21:00:00.000Z";
    assert.equal(recordMergeGrantConsumption(root, grant, t1), true);
    assert.equal(ledgerLib.readMergeGrantConsumptions(root).get(ledgerLib.mergeGrantIdentityKey(grant)!), t1);

    const other = { ...grant, grantedAt: new Date(Date.now() + 1).toISOString(), pr: 10 };
    const t2 = "2026-10-25T21:05:00.000Z";
    assert.equal(ledgerLib.recordMergeGrantConsumption(root, other, t2), true);
    const ts = readMergeGrantConsumptions(root);
    assert.equal(ts.get(mergeGrantIdentityKey(other)!), t2);
    assert.equal(ts.get(mergeGrantIdentityKey(grant)!), t1, "a 2ª escrita não pode apagar a 1ª entrada");
  });

  it("poda entradas além da retenção e ignora lixo", () => {
    const root = freshRoot();
    const path = mergeGrantLedgerPath(root, BENEF);
    const old = { ...grant, grantedAt: new Date(Date.now() - MERGE_GRANT_LEDGER_RETENTION_MS - 60_000).toISOString(), consumedAt: "2026-01-01T00:00:00.000Z" };
    writeFileSync(path, JSON.stringify({ grantee: BENEF, entries: [old, { lixo: true }] }), "utf8");
    assert.equal(recordMergeGrantConsumption(root, grant, "2026-10-25T21:00:00.000Z"), true);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].grantedAt, grant.grantedAt);
  });

  it("sessionFileIsLocal decide pelo nome do arquivo", () => {
    assert.equal(ledgerLib.sessionFileIsLocal("overnight-Neo-x.json", "overnight", "Neo"), true);
    assert.equal(ledgerLib.sessionFileIsLocal("overnight-Neo-x-safeBackup-0001.json", "overnight", "Neo"), true);
    assert.equal(ledgerLib.sessionFileIsLocal("overnight-Zenbook-x.json", "overnight", "Neo"), false);
  });
});
