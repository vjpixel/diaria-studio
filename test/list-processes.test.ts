/**
 * test/list-processes.test.ts (#8661)
 *
 * Regressão (#633) pra `scripts/lib/list-processes.ts`: parsing puro da
 * saída de `ps -eo pid=,ppid=,args=` e o comportamento fail-soft em
 * plataforma não suportada (Windows).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePsOutput, listAllProcesses } from "../scripts/lib/list-processes.ts";

test("parsePsOutput: extrai pid/ppid/cmd de cada linha bem-formada", () => {
  const raw = [
    "  1234     1 node --test-isolation=process --test test/foo.test.ts",
    "5678  1234 /usr/bin/bash -c sleep 10",
    "",
  ].join("\n");

  const result = parsePsOutput(raw);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    pid: 1234,
    ppid: 1,
    cmd: "node --test-isolation=process --test test/foo.test.ts",
  });
  assert.deepEqual(result[1], { pid: 5678, ppid: 1234, cmd: "/usr/bin/bash -c sleep 10" });
});

test("parsePsOutput: ignora linha vazia e linha que não bate o formato PID PPID ARGS", () => {
  const raw = ["", "   ", "não é uma linha de ps válida", "42 1 node script.js"].join("\n");
  const result = parsePsOutput(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].pid, 42);
});

test("parsePsOutput: cmdline com múltiplos espaços internos preservado como está (só o split inicial é limitado a 3 grupos)", () => {
  const raw = "100 1 node --require /a/b/c.cjs --import /a/b/loader.mjs --test test/x.test.ts";
  const result = parsePsOutput(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].cmd, "node --require /a/b/c.cjs --import /a/b/loader.mjs --test test/x.test.ts");
});

test("listAllProcesses: [] em win32, nunca chama execFileSync", () => {
  let called = false;
  const result = listAllProcesses({
    platform: "win32",
    execFileSync: (() => {
      called = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync,
  });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("listAllProcesses: em linux, chama `ps -eo pid=,ppid=,args=` e faz o parsing do retorno", () => {
  const calls: unknown[] = [];
  const result = listAllProcesses({
    platform: "linux",
    execFileSync: ((cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return "999 1 node --test-isolation=process --test test/orphan.test.ts\n";
    }) as unknown as typeof import("node:child_process").execFileSync,
  });
  assert.deepEqual(calls, [["ps", ["-eo", "pid=,ppid=,args="]]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].pid, 999);
});
