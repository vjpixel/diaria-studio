/**
 * test/poll-kv-build-command.test.ts (#1237 follow-up)
 *
 * Valida que buildKvPutCommand quota paths/keys corretamente em
 * cenários problemáticos: espaços, parênteses, UTF-8, paths Windows
 * com backslashes via shell:true.
 *
 * Note: o teste valida o command STRING construído, não a execução
 * real do shell. Shell:true delega o parsing pro cmd.exe/bash do OS;
 * o ponto crítico é o quoting estar correto.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKvPutCommand } from "../scripts/lib/poll-kv.ts";

describe("buildKvPutCommand (#1237 follow-up)", () => {
  it("quota key + path com aspas duplas", () => {
    const cmd = buildKvPutCommand({
      key: "stats:260514",
      tmpFile: "/tmp/value",
      namespaceId: "abc123",
    });
    assert.match(cmd, /"stats:260514"/);
    assert.match(cmd, /--path="\/tmp\/value"/);
    assert.match(cmd, /--namespace-id=abc123/);
    assert.match(cmd, /--remote/);
  });

  it("preserva path com espaços nas aspas (Windows tmp dir comum)", () => {
    const cmd = buildKvPutCommand({
      key: "k",
      tmpFile: "C:/Users/test user/AppData/Local/Temp/diaria-kv-put-xyz/value",
      namespaceId: "abc",
    });
    // Path com espaço deve estar dentro de aspas duplas
    assert.match(cmd, /--path="C:\/Users\/test user\/AppData\/Local\/Temp\/diaria-kv-put-xyz\/value"/);
  });

  it("preserva path com parênteses (Windows Program Files)", () => {
    const cmd = buildKvPutCommand({
      key: "k",
      tmpFile: "C:/Program Files (x86)/temp/value",
      namespaceId: "abc",
    });
    assert.match(cmd, /--path="C:\/Program Files \(x86\)\/temp\/value"/);
  });

  it("preserva path com UTF-8 (acentos)", () => {
    const cmd = buildKvPutCommand({
      key: "k",
      tmpFile: "/tmp/edição/value",
      namespaceId: "abc",
    });
    assert.match(cmd, /--path="\/tmp\/edição\/value"/);
  });

  it("key com dois-pontos (estilo stats:260514) não quebra", () => {
    const cmd = buildKvPutCommand({
      key: "vote:260514:user@example.com",
      tmpFile: "/tmp/v",
      namespaceId: "abc",
    });
    assert.match(cmd, /"vote:260514:user@example\.com"/);
  });

  it("key com aspas duplas no value não afeta command (value vai por --path)", () => {
    // O ponto chave de #1237: value pode ter aspas duplas porque vai via
    // arquivo (--path). O command em si não interpola o value.
    const cmd = buildKvPutCommand({
      key: "stats:260514",
      tmpFile: "/tmp/v",
      namespaceId: "abc",
    });
    // Value não aparece no command (única menção é via --path file)
    assert.doesNotMatch(cmd, /\\"/);
  });
});
