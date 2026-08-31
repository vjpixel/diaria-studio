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
  it("diaria-studio nasce enabled; hermes-agent e dot-hermes nascem DESLIGADAS por padrão", () => {
    const roots = defaultWorkdirRoots(HOME, DIARIA);
    const byName = Object.fromEntries(roots.map((r) => [r.name, r]));
    assert.equal(byName["diaria-studio"].enabled, true);
    assert.equal(byName["hermes-agent"].enabled, false);
    assert.equal(byName["dot-hermes"].enabled, false);
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

  it("path dentro de hermes-agent (raiz desabilitada por padrão) -> denied, motivo cita 'desabilitada'", () => {
    const r = isPathAllowed(`${HOME}/hermes-agent/foo.py`, "write", roots);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /desabilitada/);
    assert.equal(r.root, "hermes-agent");
  });

  it("path dentro de ~/.hermes (raiz desabilitada por padrão) -> denied", () => {
    const r = isPathAllowed(`${HOME}/.hermes/config.yaml`, "write", roots);
    assert.equal(r.allowed, false);
    assert.equal(r.root, "dot-hermes");
  });

  it("~/.hermes/auth.json -> SEMPRE denied, mesmo se a raiz dot-hermes estivesse enabled (hard-deny vence)", () => {
    const enabledRoots: WorkdirRoot[] = roots.map((r) => (r.name === "dot-hermes" ? { ...r, enabled: true } : r));
    const r = isPathAllowed(`${HOME}/.hermes/auth.json`, "read", enabledRoots);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /NEGADO permanentemente/);
    assert.equal(r.root, undefined, "hard-deny não atribui root — precede qualquer match de raiz");
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
