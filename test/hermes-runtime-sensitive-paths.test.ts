/**
 * test/hermes-runtime-sensitive-paths.test.ts (#6817 item 5)
 *
 * Hygiene própria (fixtures explícitas contra os paths REAIS nomeados na
 * issue), não `git ls-files` — ver docstring de `scripts/lib/hermes-
 * runtime-sensitive-paths.ts` pra por que este módulo não vive dentro de
 * `sensitive-path-guard.ts`/`SENSITIVE_RULES`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  HERMES_RUNTIME_SENSITIVE_RULES,
  homeRelative,
  isHermesRuntimeSensitivePath,
  matchingHermesRuntimeRules,
} from "../scripts/lib/hermes-runtime-sensitive-paths.ts";

const HOME = "/home/vjpixel";

describe("homeRelative", () => {
  it("path sob HOME vira relativo sem barra inicial", () => {
    assert.equal(homeRelative(`${HOME}/.hermes/config.yaml`, HOME), ".hermes/config.yaml");
  });
  it("o próprio HOME vira string vazia", () => {
    assert.equal(homeRelative(HOME, HOME), "");
  });
  it("path fora de HOME retorna intacto", () => {
    assert.equal(homeRelative("/etc/passwd", HOME), "/etc/passwd");
  });
});

describe("isHermesRuntimeSensitivePath — cada regra casa com o path REAL nomeado na issue #6817", () => {
  it("~/.hermes/config.yaml -> sensível", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/.hermes/config.yaml`, HOME), true);
  });
  it("~/.hermes/cron/jobs.json -> sensível", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/.hermes/cron/jobs.json`, HOME), true);
  });
  it("~/.hermes/profiles/coding/config.yaml -> sensível (** cruza /)", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/.hermes/profiles/coding/config.yaml`, HOME), true);
  });
  it("~/.hermes/profiles (diretório em si, sem sub-caminho) -> NÃO casa (** exige algo depois)", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/.hermes/profiles`, HOME), false);
  });

  it("arquivo comum dentro de hermes-agent (não é config de runtime) -> não sensível por este critério", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/hermes-agent/scripts/foo.py`, HOME), false);
  });
  it("~/.hermes/sessions/sessions.json -> não sensível por ESTE módulo (é o item 2, leitor dedicado, não o item 5)", () => {
    assert.equal(isHermesRuntimeSensitivePath(`${HOME}/.hermes/sessions/sessions.json`, HOME), false);
  });
  it("path totalmente fora de ~/.hermes -> não sensível", () => {
    assert.equal(isHermesRuntimeSensitivePath("/tmp/random.yaml", HOME), false);
  });
});

describe("matchingHermesRuntimeRules", () => {
  it("devolve a(s) regra(s) que casaram com id + reason", () => {
    const rules = matchingHermesRuntimeRules(`${HOME}/.hermes/config.yaml`, HOME);
    assert.deepEqual(rules.map((r) => r.id), ["hermes-runtime-config"]);
    assert.ok(rules[0].reason.length > 20);
  });
  it("path limpo -> array vazio", () => {
    assert.deepEqual(matchingHermesRuntimeRules("/tmp/x.yaml", HOME), []);
  });
});

describe("higiene das regras", () => {
  it("ids únicos e não-vazios, reason substantivo", () => {
    const ids = HERMES_RUNTIME_SENSITIVE_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const rule of HERMES_RUNTIME_SENSITIVE_RULES) {
      assert.ok(rule.id.length > 0);
      assert.ok(rule.pattern.length > 0);
      assert.ok(rule.reason.length > 20, `regra "${rule.id}" precisa de razão real`);
    }
  });
});

describe("CLI check-continuo-workdir.ts --check-runtime-sensitive", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const script = resolve(repoRoot, "scripts/check-continuo-workdir.ts");

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { cwd: repoRoot, encoding: "utf8" });
  }

  it("--check-runtime-sensitive --path ~/.hermes/config.yaml -> exit 1", () => {
    const r = runCli(["--check-runtime-sensitive", "--path", "~/.hermes/config.yaml"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /runtime-sensitive/);
    assert.match(r.stderr, /write-hermes-config\.ts/);
  });

  it("--check-runtime-sensitive --path ~/hermes-agent/foo.py -> exit 0 (não é config de runtime)", () => {
    const r = runCli(["--check-runtime-sensitive", "--path", "~/hermes-agent/foo.py"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /não é runtime-sensitive/);
  });
});
