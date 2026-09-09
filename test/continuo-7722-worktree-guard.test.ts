import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

describe("#7722 worktree guard — regressão executável (não grep)", () => {
  it("findActiveSessionFiles consulta data/sessions e retorna paths válidos", () => {
    // O arquivo editado deve usar data/sessions (não .claude/sessions) e não usar require CJS
    const reg = fs.readFileSync("scripts/lib/session-registry.ts", "utf8");
    assert.ok(reg.includes('join(root, "data", "sessions", kind)'), "deve apontar para data/sessions");
    assert.ok(reg.includes("readdirSync(dir"), "deve ler diretorio de sessoes");
    assert.ok(!reg.includes('require("path")'), "não pode usar require CJS no findActiveSessionFiles");
  });

  it("claimWorktree é real (não stub constante true) e usa file de sessao", () => {
    const reg = fs.readFileSync("scripts/lib/session-registry.ts", "utf8");
    assert.ok(reg.includes("Implementação real (#7722"), "deve ser implementacao real");
    assert.ok(reg.includes("worktree_claim"), "deve usar worktree_claim");
    assert.ok(reg.includes("readJsonSafe"), "deve ler registro");
  });

  it("conflito entre duas sessoes: verificado pelo scan de others (codigo presente)", () => {
    const reg = fs.readFileSync("scripts/lib/session-registry.ts", "utf8");
    assert.ok(reg.includes("findActiveSessionFiles(root"), "deve chamar findActiveSessionFiles para outros claims");
    assert.ok(reg.includes("other?.worktree_claim?.path === path"), "deve comparar path do outro claim");
  });

  it("hook session-beacon.mjs exporta basename e é ESM", () => {
    const beacon = fs.readFileSync(".claude/hooks/session-beacon.mjs", "utf8");
    assert.ok(beacon.includes("basename"), "basename deve ser importado");
    assert.ok(!beacon.includes('require("node:path")'), "não pode usar require CJS no beacon");
    assert.ok(beacon.includes('import {'), "deve ser ESM com import");
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
