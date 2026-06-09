import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendListName, toImportCsv, parseArgs } from "../scripts/clarice-import-sends.ts";

describe("sendListName", () => {
  it("nome determinístico: dNN zero-padded + dia planejado", () => {
    assert.equal(sendListName(1, "qua", "Jun/2026"), "Clarice Jun/2026 d01 (qua)");
    assert.equal(sendListName(21, "ter", "Jun/2026"), "Clarice Jun/2026 d21 (ter)");
  });
});

describe("toImportCsv", () => {
  it("reduz a email+NOME (descarta TIER) e normaliza header -> EMAIL", () => {
    const { csv, count } = toImportCsv("email,NOME,TIER\na@b.com,Ana,maio\nc@d.com,Caio,T2\n");
    assert.ok(csv.startsWith("EMAIL,NOME"), `header: ${csv.split("\n")[0]}`);
    assert.ok(!/TIER/.test(csv), "TIER não deve ir pro Brevo");
    assert.ok(csv.includes("a@b.com,Ana"));
    assert.equal(count, 2);
  });

  it("aceita variação 'E-mail' e trim no email", () => {
    const { csv, count } = toImportCsv("Nome,E-mail\nZé,  x@y.com \n");
    assert.equal(csv.split("\n")[0], "EMAIL,NOME");
    assert.ok(csv.includes("x@y.com"));
    assert.equal(count, 1);
  });
});

describe("parseArgs", () => {
  it("defaults: dry-run, label Jun/2026, folder 1, only null", () => {
    const a = parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.folderId, 1);
    assert.equal(a.only, null);
  });

  it("--execute, --label, --folder-id, --only", () => {
    const a = parseArgs(["--execute", "--label", "Mai→Jun", "--folder-id", "4", "--only", "1,2,3"]);
    assert.equal(a.execute, true);
    assert.equal(a.label, "Mai→Jun");
    assert.equal(a.folderId, 4);
    assert.deepEqual(a.only, [1, 2, 3]);
  });

  it("--label não engole a flag seguinte", () => {
    const a = parseArgs(["--label", "--execute"]);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.execute, true);
  });

  it("--folder-id inválido cai no default 1", () => {
    assert.equal(parseArgs(["--folder-id", "abc"]).folderId, 1);
    assert.equal(parseArgs(["--folder-id", "0"]).folderId, 1);
  });
});
