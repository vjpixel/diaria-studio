/**
 * #9419 — regressão: `overnight-session-marker.ts --end` precisa receber
 * `--session-id` do hook `.claude/hooks/inject-session-id.mjs`. Desde o #9347
 * o marker é POR SESSÃO (`.active-session-{tag}.{sid}.json`) e `endSession`
 * sem id só apaga o legado anônimo — sem a injeção, o `--end` da Fase 2 do
 * overnight saía "removido: nada" e o marker seguia com `phase:"autonomous"`
 * (AskUserQuestion negado na sessão por até 24h).
 *
 * Os testes de `overnight-session-marker.test.ts` chamam `endSession(root, sid)`
 * direto e por isso não pegavam o bug: este passa pelo caminho REAL — o hook
 * spawnado com payload via stdin, e o comando que ELE devolve executado de
 * verdade contra um repoRoot temporário.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeSessionPath, setPhase, startSession } from "../scripts/overnight-session-marker.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, "..");
const hookPath = join(repo, ".claude", "hooks", "inject-session-id.mjs");
const markerScript = join(repo, "scripts", "overnight-session-marker.ts");
const tsxLoader = import.meta.resolve("tsx");

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = join(tmpdir(), `marker-end-9419-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "data", "overnight"), { recursive: true });
  roots.push(root);
  return root;
}

function runHook(command: string, sessionId: string): string {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === "") return command; // hook não mexeu no comando
  return JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command;
}

/** Executa o comando (já processado pelo hook) contra `root` como repoRoot. */
function runMarker(command: string, root: string) {
  const prefix = "npx tsx scripts/overnight-session-marker.ts ";
  assert.ok(command.startsWith(prefix), `comando inesperado: ${command}`);
  // Converte os args do comando (aspas simples do shellSingleQuote) em argv.
  const args = [...command.slice(prefix.length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
  return spawnSync(process.execPath, ["--import", tsxLoader, markerScript, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("#9419 — --end via hook remove o marker por sessão", () => {
  it("hook injeta --session-id no --end e o script remove .active-session-{tag}.{sid}.json", () => {
    const root = freshRoot();
    const sid = "sess-9419-abc";
    startSession(root, new Date().toISOString(), sid);
    assert.ok(setPhase(root, "autonomous", sid));
    const markerPath = activeSessionPath(root, undefined, sid);
    assert.ok(existsSync(markerPath), "pré-condição: marker por sessão existe");

    const updated = runHook("npx tsx scripts/overnight-session-marker.ts --end", sid);
    assert.equal(updated, `npx tsx scripts/overnight-session-marker.ts --end --session-id '${sid}'`);

    const r = runMarker(updated, root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`session_id=${sid}`));
    assert.doesNotMatch(r.stdout, /nada — já ausente/);
    assert.equal(existsSync(markerPath), false, "marker por sessão deveria ter sido removido");
  });

  it("controle: o --end SEM a injeção (comportamento pré-fix) deixa o marker por sessão vivo", () => {
    const root = freshRoot();
    const sid = "sess-9419-ctrl";
    startSession(root, new Date().toISOString(), sid);
    const markerPath = activeSessionPath(root, undefined, sid);

    const r = runMarker("npx tsx scripts/overnight-session-marker.ts --end", root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nada — já ausente/);
    assert.ok(existsSync(markerPath), "sem --session-id o marker por sessão sobrevive — por isso a injeção é necessária");
  });

  it("--end de OUTRA sessão (id injetado diferente) não apaga o marker desta", () => {
    const root = freshRoot();
    startSession(root, new Date().toISOString(), "sess-A");
    const markerA = activeSessionPath(root, undefined, "sess-A");

    const updated = runHook("npx tsx scripts/overnight-session-marker.ts --end", "sess-B");
    const r = runMarker(updated, root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(markerA), "marker da sessão A deve sobreviver ao --end da sessão B");
  });
});
