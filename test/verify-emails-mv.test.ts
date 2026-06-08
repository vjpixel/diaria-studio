import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyResult,
  buildVerifyUrl,
  mvOutputBase,
  readInput,
  splitRows,
  parseArgs,
  type Bucket,
} from "../scripts/verify-emails-mv.ts";

describe("mvOutputBase (proveniência: stripe-export- → mv-export-)", () => {
  it("mapeia o prefixo stripe-export- pra mv-export- e tira o .csv", () => {
    assert.equal(mvOutputBase("stripe-export-t02-ex-assinantes.csv"), "mv-export-t02-ex-assinantes");
    assert.equal(mvOutputBase("stripe-export-maio.csv"), "mv-export-maio");
  });
  it("aceita caminho completo (usa basename)", () => {
    assert.equal(mvOutputBase("data/clarice-subscribers/stripe-export-maio.csv"), "mv-export-maio");
  });
  it("fallback: input sem o prefixo esperado mantém o basename (só tira .csv)", () => {
    assert.equal(mvOutputBase("custom-list.csv"), "custom-list");
  });
});

describe("classifyResult", () => {
  it("ok e catch_all → verified", () => {
    assert.equal(classifyResult("ok"), "verified");
    assert.equal(classifyResult("catch_all"), "verified");
  });

  it("invalid e disposable → rejected", () => {
    assert.equal(classifyResult("invalid"), "rejected");
    assert.equal(classifyResult("disposable"), "rejected");
  });

  it("unknown / reverify / vazio / null → unknown", () => {
    assert.equal(classifyResult("unknown"), "unknown");
    assert.equal(classifyResult("reverify"), "unknown");
    assert.equal(classifyResult("unverified"), "unknown");
    assert.equal(classifyResult("error"), "unknown");
    assert.equal(classifyResult(""), "unknown");
    assert.equal(classifyResult(null), "unknown");
    assert.equal(classifyResult(undefined), "unknown");
  });

  it("é case/whitespace-insensitive", () => {
    assert.equal(classifyResult("  OK "), "verified");
    assert.equal(classifyResult("Catch_All"), "verified");
    assert.equal(classifyResult("INVALID"), "rejected");
  });
});

describe("buildVerifyUrl", () => {
  it("monta a URL v3 com api, email, timeout", () => {
    const url = new URL(buildVerifyUrl("KEY123", "foo@bar.com", 30));
    assert.equal(url.origin + url.pathname, "https://api.millionverifier.com/api/v3");
    assert.equal(url.searchParams.get("api"), "KEY123");
    assert.equal(url.searchParams.get("email"), "foo@bar.com");
    assert.equal(url.searchParams.get("timeout"), "30");
  });

  it("default timeout = 20", () => {
    const url = new URL(buildVerifyUrl("K", "a@b.com"));
    assert.equal(url.searchParams.get("timeout"), "20");
  });

  it("encoda emails com caracteres especiais", () => {
    const url = new URL(buildVerifyUrl("K", "a+tag@b.com"));
    assert.equal(url.searchParams.get("email"), "a+tag@b.com");
  });
});

describe("readInput", () => {
  it("detecta coluna email e preserva todas as colunas", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-"));
    try {
      const p = join(dir, "t.csv");
      writeFileSync(p, "email,NOME,OPEN_PROBABILITY\na@b.com,Ana,24\nc@d.com,Caio,30\n");
      const { rows, emailKey } = readInput(p);
      assert.equal(emailKey, "email");
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0], { email: "a@b.com", NOME: "Ana", OPEN_PROBABILITY: "24" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta variação 'E-mail' (case/hífen-insensitive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-"));
    try {
      const p = join(dir, "t.csv");
      writeFileSync(p, "Nome,E-mail\nX,x@y.com\n");
      const { emailKey, fields } = readInput(p);
      assert.equal(emailKey, "E-mail");
      assert.deepEqual(fields, ["Nome", "E-mail"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lança erro quando não há coluna de email (não manda nomes pro MV)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-"));
    try {
      const p = join(dir, "t.csv");
      writeFileSync(p, "endereco,nome\nx@y.com,X\n");
      assert.throws(() => readInput(p), /sem coluna de email/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("splitRows", () => {
  const rows = [
    { email: "ok@b.com", NOME: "A" },
    { email: " catch@b.com ", NOME: "B" }, // whitespace + uppercase é normalizado
    { email: "BAD@b.com", NOME: "C" },
    { email: "disp@b.com", NOME: "D" },
    { email: "huh@b.com", NOME: "E" },
    { email: "naoverificado@b.com", NOME: "F" }, // ausente do checkpoint
  ];
  const results = {
    "ok@b.com": { result: "ok", resultcode: 1, quality: "good" },
    "catch@b.com": { result: "catch_all", resultcode: 2, quality: "risky" },
    "bad@b.com": { result: "invalid", resultcode: 6, quality: "bad" },
    "disp@b.com": { result: "disposable", resultcode: 4, quality: "bad" },
    "huh@b.com": { result: "unknown", resultcode: 5, quality: "" },
  };

  it("separa nos 3 buckets corretamente", () => {
    const out = splitRows(rows, "email", results);
    assert.deepEqual(out.verified.map((r) => r.NOME), ["A", "B"]);
    assert.deepEqual(out.rejected.map((r) => r.NOME), ["C", "D"]);
    // huh (unknown) + naoverificado (ausente) → unknown
    assert.deepEqual(out.unknown.map((r) => r.NOME), ["E", "F"]);
  });

  it("anexa MV_RESULT / MV_QUALITY / MV_CODE preservando colunas originais", () => {
    const out = splitRows(rows, "email", results);
    assert.deepEqual(out.verified[0], {
      email: "ok@b.com",
      NOME: "A",
      MV_RESULT: "ok",
      MV_QUALITY: "good",
      MV_CODE: "1",
    });
  });

  it("email ausente do checkpoint vira unknown com colunas MV vazias", () => {
    const out = splitRows(rows, "email", results);
    const f = out.unknown.find((r) => r.NOME === "F")!;
    assert.equal(f.MV_RESULT, "");
    assert.equal(f.MV_QUALITY, "");
    assert.equal(f.MV_CODE, "");
  });

  it("nenhuma linha é perdida", () => {
    const out = splitRows(rows, "email", results);
    const total = (["verified", "rejected", "unknown"] as Bucket[]).reduce(
      (s, b) => s + out[b].length,
      0,
    );
    assert.equal(total, rows.length);
  });
});

describe("parseArgs", () => {
  it("defaults", () => {
    const a = parseArgs([]);
    assert.equal(a.input, "stripe-export-t02-ex-assinantes.csv");
    assert.equal(a.concurrency, 12);
    assert.equal(a.timeout, 20);
    assert.equal(a.limit, null);
    assert.equal(a.single, null);
  });

  it("flags customizadas", () => {
    const a = parseArgs([
      "--input", "stripe-export-t03.csv",
      "--concurrency", "20",
      "--timeout", "30",
      "--limit", "50",
    ]);
    assert.equal(a.input, "stripe-export-t03.csv");
    assert.equal(a.concurrency, 20);
    assert.equal(a.timeout, 30);
    assert.equal(a.limit, 50);
  });

  it("--single", () => {
    assert.equal(parseArgs(["--single", "x@y.com"]).single, "x@y.com");
  });

  it("concurrency/timeout inválidos caem no default (nunca 0/NaN)", () => {
    const a = parseArgs(["--concurrency", "abc", "--timeout", "0"]);
    assert.equal(a.concurrency, 12); // NaN → default
    assert.equal(a.timeout, 20); // 0 não é >0 → default
  });

  it("--limit 0 é preservado (no-op proposital); inválido vira null", () => {
    assert.equal(parseArgs(["--limit", "0"]).limit, 0);
    assert.equal(parseArgs(["--limit", "xyz"]).limit, null);
    assert.equal(parseArgs(["--limit", "-5"]).limit, null);
  });
});
