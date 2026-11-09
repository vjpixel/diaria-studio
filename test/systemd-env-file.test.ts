/**
 * Tests de `scripts/lib/systemd-env-file.ts` (#12477) — parser do formato
 * `EnvironmentFile=` do systemd, usado pelo env-loader para reconhecer o mesmo
 * `.env` lido pelas units do 300.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSystemdEnvironmentFile } from "../scripts/lib/systemd-env-file.ts";

describe("#12477 parseSystemdEnvironmentFile", () => {
  it("valor simples, comentários e linhas em branco", () => {
    const out = parseSystemdEnvironmentFile("# comentário\n; outro\n\nA=1\nB = dois \n");
    assert.deepEqual(out, { A: "1", B: "dois" });
  });

  it("sem aspas: `\\x` vira `x` (é o que corrompe a private_key)", () => {
    const out = parseSystemdEnvironmentFile('K={"private_key":"-----BEGIN-----\\nABC\\n-----END-----\\n"}\n');
    assert.equal(out.K, '{"private_key":"-----BEGIN-----nABCn-----END-----n"}');
  });

  it("sem aspas: `#` no meio do valor é literal (diferente do dotenv)", () => {
    assert.equal(parseSystemdEnvironmentFile("K=a#b\n").K, "a#b");
  });

  it("aspas duplas: só \\\" \\\\ \\` \\$ são escapes; \\n fica como \\n", () => {
    const out = parseSystemdEnvironmentFile('K="a\\"b\\\\c\\nd"\n');
    assert.equal(out.K, 'a"b\\c\\nd');
  });

  it("aspas simples: tudo literal, inclusive quebra de linha", () => {
    assert.equal(parseSystemdEnvironmentFile("K='a\\nb\nc'\n").K, "a\\nb\nc");
  });

  it("barra + quebra de linha continua o valor sem aspas", () => {
    assert.equal(parseSystemdEnvironmentFile("K=abc\\\ndef\n").K, "abcdef");
  });

  it("valor continua depois de fechar aspas; última chave repetida vence", () => {
    const out = parseSystemdEnvironmentFile('K="a"b\nK=final');
    assert.equal(out.K, "final");
    assert.equal(parseSystemdEnvironmentFile('J="a"b\n').J, "ab");
  });

  it("CRLF e chave vazia", () => {
    assert.deepEqual(parseSystemdEnvironmentFile("A=1\r\nB=\r\n"), { A: "1", B: "" });
  });

  it("linha sem `=` é ignorada", () => {
    assert.deepEqual(parseSystemdEnvironmentFile("LIXO\nA=1\n"), { A: "1" });
  });
});
