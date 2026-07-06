import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  classifyResult,
  buildVerifyUrl,
  mvOutputBase,
  readStoreCandidates,
  cohortMemberCount,
  hasLegacyInputFlag,
  splitRows,
  parseArgs,
  type Bucket,
} from "../scripts/verify-emails-mv.ts";
import { SCHEMA } from "../scripts/lib/clarice-db.ts";
import { isMvExemptCohort, COHORT_ASSINANTES_ATIVOS } from "../scripts/lib/cohorts.ts";

describe("mvOutputBase (proveniência: cohort → mv-export-{cohort}, #2886 PR3)", () => {
  it("prefixa mv-export- ao slug de cohort", () => {
    assert.equal(mvOutputBase("ex-assinantes"), "mv-export-ex-assinantes");
    assert.equal(mvOutputBase("leads-2026-06"), "mv-export-leads-2026-06");
  });
});

/** Helper: abre um store in-memory seedado com linhas de teste. */
function seedDb(rows: Array<{
  email: string;
  name?: string | null;
  cohort: string | null;
  mv_bucket?: string | null;
  mv_cycle?: string | null;
}>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO clarice_users (email, name, cohort, mv_bucket, mv_cycle) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.email, r.name ?? null, r.cohort, r.mv_bucket ?? null, r.mv_cycle ?? null);
  }
  return db;
}

describe("readStoreCandidates (#2886 PR3 — fonte = store, não CSV)", () => {
  it("retorna só contatos do cohort com mv_bucket IS NULL", () => {
    const db = seedDb([
      { email: "a@b.com", name: "A", cohort: "ex-assinantes", mv_bucket: null },
      { email: "b@b.com", name: "B", cohort: "ex-assinantes", mv_bucket: "verified", mv_cycle: "2605-06" },
      { email: "c@b.com", name: "C", cohort: "ex-assinantes", mv_bucket: "rejected", mv_cycle: "2604-05" },
      { email: "d@b.com", name: "D", cohort: "leads-2026-06", mv_bucket: null },
    ]);
    try {
      const { rows, emailKey } = readStoreCandidates(db, "ex-assinantes");
      assert.equal(emailKey, "email");
      assert.deepEqual(rows.map((r) => r.email).sort(), ["a@b.com"]);
    } finally {
      db.close();
    }
  });

  it('semântica "skip forever": contato verificado em QUALQUER ciclo anterior nunca reaparece, mesmo pra outro --cycle', () => {
    // b@b.com foi verificado no ciclo 2605-06; mesmo consultando pro cohort em
    // outro momento (ciclo novo), mv_bucket continua preenchido → nunca reentra.
    const db = seedDb([
      { email: "b@b.com", name: "B", cohort: "ex-assinantes", mv_bucket: "verified", mv_cycle: "2605-06" },
    ]);
    try {
      const { rows } = readStoreCandidates(db, "ex-assinantes");
      assert.equal(rows.length, 0);
    } finally {
      db.close();
    }
  });

  it("contato adicionado ao store DEPOIS de um ciclo anterior (mv_bucket NULL) é corretamente elegível", () => {
    const db = seedDb([
      { email: "old@b.com", cohort: "ex-assinantes", mv_bucket: "verified", mv_cycle: "2605-06" },
      { email: "new@b.com", cohort: "ex-assinantes", mv_bucket: null }, // entrou depois do ciclo 2605-06
    ]);
    try {
      const { rows } = readStoreCandidates(db, "ex-assinantes");
      assert.deepEqual(rows.map((r) => r.email), ["new@b.com"]);
    } finally {
      db.close();
    }
  });

  it("normaliza email (trim/lowercase) e ignora linhas com email vazio", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    db.prepare(
      `INSERT INTO clarice_users (email, name, cohort, mv_bucket) VALUES (?, ?, ?, ?)`,
    ).run("  Foo@Bar.com ", "F", "ex-assinantes", null);
    try {
      const { rows } = readStoreCandidates(db, "ex-assinantes");
      assert.deepEqual(rows, [{ email: "foo@bar.com", name: "F" }]);
    } finally {
      db.close();
    }
  });

  it("cohort diferente não vaza candidatos", () => {
    const db = seedDb([
      { email: "a@b.com", cohort: "ex-assinantes", mv_bucket: null },
    ]);
    try {
      const { rows } = readStoreCandidates(db, "leads-2026-06");
      assert.equal(rows.length, 0);
    } finally {
      db.close();
    }
  });

  it("mv_bucket='' (string vazia) é tratado como nunca-verificado, igual a NULL (review #2886 PR3 — mesma convenção de classifyEligibility)", () => {
    const db = seedDb([
      { email: "empty@b.com", cohort: "ex-assinantes", mv_bucket: "" },
      { email: "null@b.com", cohort: "ex-assinantes", mv_bucket: null },
      { email: "verified@b.com", cohort: "ex-assinantes", mv_bucket: "verified" },
    ]);
    try {
      const { rows } = readStoreCandidates(db, "ex-assinantes");
      assert.deepEqual(rows.map((r) => r.email).sort(), ["empty@b.com", "null@b.com"]);
    } finally {
      db.close();
    }
  });
});

describe("cohortMemberCount (#2886 PR3 review — distingue '0 já verificado' de '0 membros no store')", () => {
  it("conta todos os membros do cohort, verificados ou não", () => {
    const db = seedDb([
      { email: "a@b.com", cohort: "ex-assinantes", mv_bucket: null },
      { email: "b@b.com", cohort: "ex-assinantes", mv_bucket: "verified" },
      { email: "c@b.com", cohort: "leads-2026-06", mv_bucket: null },
    ]);
    try {
      assert.equal(cohortMemberCount(db, "ex-assinantes"), 2);
      assert.equal(cohortMemberCount(db, "leads-2026-06"), 1);
    } finally {
      db.close();
    }
  });

  it("cohort sem NENHUM membro no store retorna 0 (sinal de provável typo)", () => {
    const db = seedDb([{ email: "a@b.com", cohort: "ex-assinantes", mv_bucket: null }]);
    try {
      assert.equal(cohortMemberCount(db, "leads-2026-07"), 0);
    } finally {
      db.close();
    }
  });
});

describe("hasLegacyInputFlag (#2886 PR3 review — --input removido não pode cair silenciosamente no --cohort default)", () => {
  it("detecta --input em qualquer posição do argv", () => {
    assert.equal(hasLegacyInputFlag(["--cycle", "2605-06", "--input", "stripe-export-ex-assinantes.csv"]), true);
    assert.equal(hasLegacyInputFlag(["--input", "x.csv"]), true);
  });

  it("argv sem --input retorna false", () => {
    assert.equal(hasLegacyInputFlag(["--cycle", "2605-06", "--cohort", "ex-assinantes"]), false);
    assert.equal(hasLegacyInputFlag([]), false);
  });
});

describe("isMvExemptCohort (cohorts.ts — predicado compartilhado com classifyEligibility, #2886 PR3 review)", () => {
  it("assinantes-ativos é isento", () => {
    assert.equal(isMvExemptCohort(COHORT_ASSINANTES_ATIVOS), true);
    assert.equal(isMvExemptCohort("assinantes-ativos"), true);
  });

  it("qualquer outro cohort (ou null/undefined) não é isento", () => {
    assert.equal(isMvExemptCohort("ex-assinantes"), false);
    assert.equal(isMvExemptCohort("leads-2026-06"), false);
    assert.equal(isMvExemptCohort(null), false);
    assert.equal(isMvExemptCohort(undefined), false);
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
    assert.equal(a.cohort, "ex-assinantes");
    assert.equal(a.concurrency, 12);
    assert.equal(a.timeout, 20);
    assert.equal(a.limit, null);
    assert.equal(a.single, null);
  });

  it("flags customizadas", () => {
    const a = parseArgs([
      "--cohort", "leads-2026-06",
      "--concurrency", "20",
      "--timeout", "30",
      "--limit", "50",
    ]);
    assert.equal(a.cohort, "leads-2026-06");
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
