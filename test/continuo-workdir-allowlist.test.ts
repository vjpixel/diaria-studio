import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultWorkdirRoots,
  isPathAllowed,
  isSelfModification,
  HARD_DENIED_SUFFIXES,
  type WorkdirRoot,
} from "../scripts/lib/continuo-workdir-allowlist.ts";

const HOME = "/home/vjpixel";
const DIARIA = "/home/vjpixel/diaria-studio";

describe("defaultWorkdirRoots (#6817)", () => {
  it("as 3 raízes nascem enabled (ativação de 04/09/2026 — decisão do editor)", () => {
    const roots = defaultWorkdirRoots(HOME, DIARIA);
    const byName = Object.fromEntries(roots.map((r) => [r.name, r]));
    assert.equal(byName["diaria-studio"].enabled, true);
    assert.equal(byName["hermes-agent"].enabled, true);
    assert.equal(byName["dot-hermes"].enabled, true);
  });

  it("paths das 2 raízes novas resolvem sob $HOME, sem hardcode de usuário", () => {
    const roots = defaultWorkdirRoots("/home/outrouser", "/home/outrouser/diaria-studio");
    const byName = Object.fromEntries(roots.map((r) => [r.name, r]));
    assert.equal(byName["hermes-agent"].path, "/home/outrouser/hermes-agent");
    assert.equal(byName["dot-hermes"].path, "/home/outrouser/.hermes");
  });
});

describe("isPathAllowed (#6817)", () => {
  const roots = defaultWorkdirRoots(HOME, DIARIA);

  it("path dentro de diaria-studio, write -> allowed", () => {
    const r = isPathAllowed(`${DIARIA}/scripts/foo.ts`, "write", roots);
    assert.equal(r.allowed, true);
    assert.equal(r.root, "diaria-studio");
  });

  it("path dentro de hermes-agent (raiz ativada em 04/09/2026) -> allowed", () => {
    const r = isPathAllowed(`${HOME}/hermes-agent/foo.py`, "write", roots);
    assert.equal(r.allowed, true);
    assert.equal(r.root, "hermes-agent");
  });

  it("path dentro de ~/.hermes (raiz ativada em 04/09/2026) -> allowed (exceto sufixos hard-denied)", () => {
    const r = isPathAllowed(`${HOME}/.hermes/config.yaml`, "write", roots);
    assert.equal(r.allowed, true);
    assert.equal(r.root, "dot-hermes");
  });

  it("raiz explicitamente desabilitada (não é mais o default, mas o mecanismo continua suportando) -> denied, motivo cita 'desabilitada'", () => {
    const disabledRoots: WorkdirRoot[] = roots.map((r) => (r.name === "hermes-agent" ? { ...r, enabled: false } : r));
    const r = isPathAllowed(`${HOME}/hermes-agent/foo.py`, "write", disabledRoots);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /desabilitada/);
    assert.equal(r.root, "hermes-agent");
  });

  it("~/.hermes/auth.json -> SEMPRE denied, mesmo com a raiz dot-hermes enabled (hard-deny vence, #6817 item 2)", () => {
    const r = isPathAllowed(`${HOME}/.hermes/auth.json`, "read", roots);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /NEGADO permanentemente/);
    assert.equal(r.root, undefined, "hard-deny não atribui root — precede qualquer match de raiz");
  });

  it("~/.hermes/auth.json -> denied também para write, e mesmo se dot-hermes fosse read-only", () => {
    const readOnlyDotHermes: WorkdirRoot[] = roots.map((r) => (r.name === "dot-hermes" ? { ...r, mode: "read-only" as const } : r));
    assert.equal(isPathAllowed(`${HOME}/.hermes/auth.json`, "write", roots).allowed, false);
    assert.equal(isPathAllowed(`${HOME}/.hermes/auth.json`, "read", readOnlyDotHermes).allowed, false);
  });

  it("path fora de qualquer raiz -> denied, sem root", () => {
    const r = isPathAllowed("/tmp/random-file.txt", "read", roots);
    assert.equal(r.allowed, false);
    assert.equal(r.root, undefined);
  });

  it("path com prefixo de string parecido mas fora da raiz de verdade (diaria-studio-old) -> denied (guard contra prefixo cru)", () => {
    const r = isPathAllowed(`${DIARIA}-old/scripts/foo.ts`, "write", roots);
    assert.equal(r.allowed, false);
  });

  it("mode read-only + intent write -> denied", () => {
    const readOnlyRoots: WorkdirRoot[] = [{ name: "ro-root", path: "/x", enabled: true, mode: "read-only" }];
    const r = isPathAllowed("/x/foo.ts", "write", readOnlyRoots);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /read-only/);
  });

  it("mode read-only + intent read -> allowed", () => {
    const readOnlyRoots: WorkdirRoot[] = [{ name: "ro-root", path: "/x", enabled: true, mode: "read-only" }];
    const r = isPathAllowed("/x/foo.ts", "read", readOnlyRoots);
    assert.equal(r.allowed, true);
  });

  it("mode denied -> nunca allowed, independente de intent", () => {
    const deniedRoots: WorkdirRoot[] = [{ name: "denied-root", path: "/x", enabled: true, mode: "denied" }];
    assert.equal(isPathAllowed("/x/foo.ts", "read", deniedRoots).allowed, false);
    assert.equal(isPathAllowed("/x/foo.ts", "write", deniedRoots).allowed, false);
  });

  it("HARD_DENIED_SUFFIXES é a lista real consultada — não hardcoded duas vezes", () => {
    assert.deepEqual([...HARD_DENIED_SUFFIXES], [".hermes/auth.json"]);
  });
});

describe("isSelfModification (#6817 item 4)", () => {
  it("path é um dos arquivos ativos do tick corrente -> true", () => {
    const active = ["/x/SKILL.md", "/x/claude-openrouter.sh"];
    assert.equal(isSelfModification("/x/SKILL.md", active), true);
  });

  it("path fora da lista de ativos -> false", () => {
    const active = ["/x/SKILL.md"];
    assert.equal(isSelfModification("/x/outro-arquivo.ts", active), false);
  });

  it("lista de ativos vazia -> sempre false, nunca lança", () => {
    assert.equal(isSelfModification("/x/qualquer.ts", []), false);
  });
});
