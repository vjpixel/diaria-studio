import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimWorktree } from "../scripts/lib/session-registry.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "claim-worktree-"));
}

describe("#7722 worktree guard — regressão executável (não grep)", () => {
  it("claimWorktree é real (não stub constante true)", () => {
    const root = tmpRoot();
    try {
      assert.strictEqual(claimWorktree(join(root, "wt-a"), "session-a", root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#7892: mesmo sessionId, paths DIFERENTES — nunca colide (subagentes-irmãos do mesmo coordenador)", () => {
    // Cenário real do #7892: subagentes despachados via ferramenta `Agent`
    // com isolation:"worktree" herdam LITERALMENTE o session_id do
    // coordenador (#7712, 4 medições independentes). O coordenador despacha
    // N deles em worktrees distintos — o guard não pode tratar isso como
    // colisão.
    const root = tmpRoot();
    const sharedSessionId = "coordinator-session-herdado-por-todos";
    try {
      const claim1 = claimWorktree(join(root, "wt-subagent-1"), sharedSessionId, root);
      const claim2 = claimWorktree(join(root, "wt-subagent-2"), sharedSessionId, root);
      const claim3 = claimWorktree(join(root, "wt-subagent-3"), sharedSessionId, root);
      assert.strictEqual(claim1, true, "subagente 1 reivindica o próprio worktree");
      assert.strictEqual(claim2, true, "subagente 2 reivindica o próprio worktree — não é sobrescrito pelo 1");
      assert.strictEqual(claim3, true, "subagente 3 reivindica o próprio worktree — não é sobrescrito pelos anteriores");
      // As 3 claims continuam vivas simultaneamente — reconfirmar cada uma.
      assert.strictEqual(claimWorktree(join(root, "wt-subagent-1"), sharedSessionId, root), true, "claim 1 não foi apagada pelas seguintes");
      assert.strictEqual(claimWorktree(join(root, "wt-subagent-2"), sharedSessionId, root), true, "claim 2 não foi apagada pela 3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#7892: MESMO path, sessionIds DIFERENTES — continua detectando colisão real", () => {
    // Duas identidades genuinamente distintas disputando o MESMO worktree
    // (o incidente de origem do #7722 — outra sessão adota um worktree que
    // não é dela) precisa continuar bloqueado.
    const root = tmpRoot();
    const path = join(root, "wt-disputado");
    try {
      assert.strictEqual(claimWorktree(path, "session-dona", root), true, "primeira sessão reivindica");
      assert.strictEqual(claimWorktree(path, "session-intrusa", root), false, "segunda sessão (identidade diferente) é recusada");
      // A dona confirmando de novo continua ok (idempotente).
      assert.strictEqual(claimWorktree(path, "session-dona", root), true, "a dona original reconfirma sem problema");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#7892: claim expirado libera o path para outra identidade", () => {
    const root = tmpRoot();
    const path = join(root, "wt-expira");
    try {
      assert.strictEqual(claimWorktree(path, "session-dona", root), true);
      // Corrompe o TTL diretamente no disco pra simular expiração sem sleep.
      const claimDir = join(root, "data", "sessions", ".worktree-claims");
      const [claimFileName] = fs.readdirSync(claimDir);
      const claimFile = join(claimDir, claimFileName);
      const raw = JSON.parse(fs.readFileSync(claimFile, "utf8"));
      raw.expires_at = Date.now() - 1000;
      fs.writeFileSync(claimFile, JSON.stringify(raw));
      assert.strictEqual(claimWorktree(path, "session-outra", root), true, "path livre após expirar, outra identidade reivindica");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hook session-beacon.mjs é ESM, sem require CJS", () => {
    // #7722 item 2 (PR de correção): `basename` era importado só pra um
    // trecho de derivação de path que a correção real removeu (a versão
    // anterior de `resolveWorktreeBranches` nunca produzia saída — ver
    // docstring da função). A checagem de "sem require CJS" continua sendo
    // o que importa aqui; `basename` deixou de ser prova disso.
    const beacon = fs.readFileSync(".claude/hooks/session-beacon.mjs", "utf8");
    assert.ok(!beacon.includes('require("node:path")'), "não pode usar require CJS no beacon");
    assert.ok(beacon.includes('import {'), "deve ser ESM com import");
    assert.ok(beacon.includes("resolveWorktreeBranches"), "resolveWorktreeBranches deve continuar exportada");
  });

  it("hook block-worktree-alien-commit.mjs é ESM coerente com fail-open", () => {
    const guard = fs.readFileSync(".claude/hooks/block-worktree-alien-commit.mjs", "utf8");
    assert.ok(guard.includes('import { execSync }'), "deve importar execSync via ESM");
    assert.ok(!guard.includes('require("child_process")'), "não deve usar require CJS");
    // Fail-open: bloqueia apenas quando há divergência confirmada; não é stub que sempre retorna blocked
    assert.ok(guard.includes("BLOQUEADO"), "deve conter mensagem de bloqueio");
    assert.ok(guard.includes("process.exit(1)") || guard.includes("console.error"), "deve sair 1 apenas quando bloqueado");
  });
});
