/**
 * test/windowshide-exec-types-13592.test.ts (#13592 item 6)
 *
 * Os dois tipos injetáveis de `execFileSync` que carregam `windowsHide`:
 *  - eram homônimos (`ExecFileSyncFn`) com rigor diferente: `exec-mode.ts`
 *    exigia `windowsHide: true` literal, `publish-edition-site-page.ts`
 *    aceitava `boolean`;
 *  - o default de `commandExistsSync` era `execFileSync as unknown as
 *    ExecFileSyncFn`, cast que apagava a checagem de tipo.
 * Agora são `CommandProbeExecFn` e `LockRunnerExecFn`, os dois com o
 * literal `true`, e o default é um wrapper tipado (`realCommandProbeExec`).
 *
 * As asserções de tipo (`@ts-expect-error`) valem no typecheck de `test/**`
 * (`npx tsc -p tsconfig.test.json --noEmit`, job "Typecheck ratchet"); as de
 * runtime, no `node --test`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { commandExistsSync, realCommandProbeExec, type CommandProbeExecFn } from "../scripts/lib/exec-mode.ts";
import type { LockRunnerExecFn } from "../scripts/publish-edition-site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Nunca chamada: só o typecheck lê. `windowsHide: false` tem de ser erro. */
export function typeOnlyWindowsHideIsLiteralTrue(probe: CommandProbeExecFn, lock: LockRunnerExecFn): void {
  // @ts-expect-error windowsHide precisa ser o literal true (#13592)
  probe("schtasks", [], { stdio: "ignore", windowsHide: false });
  // @ts-expect-error windowsHide precisa ser o literal true (#13592); antes era boolean
  lock("npx", [], { cwd: "/", stdio: ["ignore", "pipe", "pipe"], timeout: 1, windowsHide: false });
  const flag: boolean = Math.random() > 2;
  // @ts-expect-error um boolean qualquer também não serve
  lock("npx", [], { cwd: "/", stdio: ["ignore", "pipe", "pipe"], timeout: 1, windowsHide: flag });
}

describe("#13592 item 6 — tipos de exec com windowsHide", () => {
  it("o default real de commandExistsSync (wrapper tipado) responde: binário inexistente -> false", () => {
    assert.equal(commandExistsSync("diaria-binario-que-nao-existe-13592", realCommandProbeExec, () => {}), false);
    assert.equal(commandExistsSync("diaria-binario-que-nao-existe-13592"), false);
  });

  it("realCommandProbeExec repassa windowsHide: true ao execFileSync (texto da chamada, que o guard lê)", () => {
    const src = readFileSync(resolve(ROOT, "scripts/lib/exec-mode.ts"), "utf8");
    assert.doesNotMatch(src, /as unknown as \w*ExecFn/, "o cast que apagava a checagem de tipo voltou");
    assert.match(src, /execFileSync\(cmd, args, \{ \.\.\.opts, windowsHide: true \}\)/);
  });

  it("nenhum `type ExecFileSyncFn` sobrou nos dois módulos (nome ambíguo)", () => {
    for (const rel of ["scripts/lib/exec-mode.ts", "scripts/publish-edition-site-page.ts"]) {
      assert.doesNotMatch(readFileSync(resolve(ROOT, rel), "utf8"), /\btype ExecFileSyncFn\b/, rel);
    }
  });
});
