import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Papa from "papaparse";
import {
  classifyResult,
  classifyResultWithSubresult,
  buildVerifyUrl,
  mvOutputBase,
  readStoreCandidates,
  readStoreCandidatesSince,
  readAllCohortRows,
  cohortMemberCount,
  hasLegacyInputFlag,
  splitRows,
  buildOutputRows,
  buildErrorRows,
  verifyCohortList,
  TRANSIENT_ERROR_RESULT,
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
  /** #5169: opcional (default null) — só os testes de ORDER BY populam. */
  created?: string | null;
}>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO clarice_users (email, name, cohort, mv_bucket, mv_cycle, created) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(r.email, r.name ?? null, r.cohort, r.mv_bucket ?? null, r.mv_cycle ?? null, r.created ?? null);
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

  it("REGRESSÃO #5169: ORDER BY created DESC — antes desta mudança a query não tinha ORDER BY nenhum (ordem de rowid arbitrária); pra um cohort GIGANTE só parcialmente coberto pelo déficit diário, isso decidia quem entrava na fatia de hoje sem relação com recência", () => {
    const db = seedDb([
      // Inseridos FORA de ordem de created de propósito — se a query não tiver
      // ORDER BY, `rows` sai na ordem de inserção/rowid (meio, antigo, novo),
      // não na ordem de recência esperada (novo, meio, antigo).
      { email: "meio@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-09-15T00:00:00Z" },
      { email: "antigo@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-07-02T00:00:00Z" },
      { email: "novo@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-12-30T00:00:00Z" },
    ]);
    try {
      const { rows } = readStoreCandidates(db, "leads-2023h2");
      assert.deepEqual(
        rows.map((r) => r.email),
        ["novo@b.com", "meio@b.com", "antigo@b.com"],
        "cadastro mais recente primeiro — quem `verifyCohortList` corta com `.slice(0, limit)` precisa ser o mais novo do cohort, não o de rowid menor",
      );
    } finally {
      db.close();
    }
  });

  it("REGRESSÃO #5169: created NULL fica por último em ORDER BY ... DESC (semântica padrão do SQLite) — nunca fura a frente de quem tem data conhecida", () => {
    const db = seedDb([
      { email: "sem-data@b.com", cohort: "leads-2023h2", mv_bucket: null, created: null },
      { email: "com-data@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-08-01T00:00:00Z" },
    ]);
    try {
      const { rows } = readStoreCandidates(db, "leads-2023h2");
      assert.deepEqual(rows.map((r) => r.email), ["com-data@b.com", "sem-data@b.com"]);
    } finally {
      db.close();
    }
  });
});

describe("readStoreCandidatesSince (#4347 Etapa 2d — mesmo ORDER BY do #5169, impacto menor por causa da janela `created >= sinceIso`, mas mesma garantia)", () => {
  it("REGRESSÃO #5169: ORDER BY created DESC — mesma disciplina de readStoreCandidates, aplicada aqui também", () => {
    const db = seedDb([
      { email: "meio@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-09-15T00:00:00Z" },
      { email: "antigo@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-07-02T00:00:00Z" },
      { email: "novo@b.com", cohort: "leads-2023h2", mv_bucket: null, created: "2023-12-30T00:00:00Z" },
    ]);
    try {
      const { rows } = readStoreCandidatesSince(db, "leads-2023h2", "2023-01-01T00:00:00Z");
      assert.deepEqual(rows.map((r) => r.email), ["novo@b.com", "meio@b.com", "antigo@b.com"]);
    } finally {
      db.close();
    }
  });

  it("continua respeitando o filtro created >= sinceIso (janela) — ORDER BY não vaza quem está fora da janela", () => {
    const db = seedDb([
      { email: "dentro@b.com", cohort: "leads-2026h1", mv_bucket: null, created: "2026-03-01T00:00:00Z" },
      { email: "fora@b.com", cohort: "leads-2026h1", mv_bucket: null, created: "2026-01-01T00:00:00Z" },
    ]);
    try {
      const { rows } = readStoreCandidatesSince(db, "leads-2026h1", "2026-02-01T00:00:00Z");
      assert.deepEqual(rows.map((r) => r.email), ["dentro@b.com"]);
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
    "ok@b.com": { result: "ok", resultcode: 1, quality: "good", subresult: "" },
    "catch@b.com": { result: "catch_all", resultcode: 2, quality: "risky", subresult: "" },
    "bad@b.com": { result: "invalid", resultcode: 6, quality: "bad", subresult: "no_mailbox" },
    "disp@b.com": { result: "disposable", resultcode: 4, quality: "bad", subresult: "" },
    "huh@b.com": { result: "unknown", resultcode: 5, quality: "", subresult: "" },
  };

  it("separa nos 3 buckets corretamente", () => {
    const out = splitRows(rows, "email", results);
    assert.deepEqual(out.verified.map((r) => r.NOME), ["A", "B"]);
    assert.deepEqual(out.rejected.map((r) => r.NOME), ["C", "D"]);
    // huh (unknown) + naoverificado (ausente) → unknown
    assert.deepEqual(out.unknown.map((r) => r.NOME), ["E", "F"]);
  });

  it("anexa MV_RESULT / MV_QUALITY / MV_CODE / MV_SUBRESULT preservando colunas originais", () => {
    const out = splitRows(rows, "email", results);
    assert.deepEqual(out.verified[0], {
      email: "ok@b.com",
      NOME: "A",
      MV_RESULT: "ok",
      MV_QUALITY: "good",
      MV_CODE: "1",
      MV_SUBRESULT: "",
    });
  });

  it("email ausente do checkpoint vira unknown com colunas MV vazias", () => {
    const out = splitRows(rows, "email", results);
    const f = out.unknown.find((r) => r.NOME === "F")!;
    assert.equal(f.MV_RESULT, "");
    assert.equal(f.MV_QUALITY, "");
    assert.equal(f.MV_CODE, "");
    assert.equal(f.MV_SUBRESULT, "");
  });

  it("nenhuma linha é perdida", () => {
    const out = splitRows(rows, "email", results);
    const total = (["verified", "rejected", "unknown"] as Bucket[]).reduce(
      (s, b) => s + out[b].length,
      0,
    );
    assert.equal(total, rows.length);
  });

  it("#5850: preserva MV_SUBRESULT — no_mailbox (permanente) distinto de mailbox_full (transitório), ambos rejected", () => {
    const subresultRows = [
      { email: "nomailbox@b.com", NOME: "A" },
      { email: "mailboxfull@b.com", NOME: "B" },
    ];
    const subresultResults = {
      "nomailbox@b.com": { result: "invalid", resultcode: 6, quality: "bad", subresult: "no_mailbox" },
      "mailboxfull@b.com": { result: "invalid", resultcode: 6, quality: "bad", subresult: "mailbox_full" },
    };
    const out = splitRows(subresultRows, "email", subresultResults);
    // Comportamento de bucket NÃO muda (#5850 é só sobre não perder o dado) —
    // os dois continuam "rejected" hoje.
    assert.deepEqual(out.rejected.map((r) => r.NOME), ["A", "B"]);
    const nomailbox = out.rejected.find((r) => r.NOME === "A")!;
    const mailboxfull = out.rejected.find((r) => r.NOME === "B")!;
    assert.equal(nomailbox.MV_SUBRESULT, "no_mailbox");
    assert.equal(mailboxfull.MV_SUBRESULT, "mailbox_full");
    assert.notEqual(nomailbox.MV_SUBRESULT, mailboxfull.MV_SUBRESULT);
  });
});

describe("classifyResultWithSubresult (#5850 — preserva subresult sem afetar bucket)", () => {
  it("invalid+no_mailbox vs invalid+mailbox_full: mesmo bucket 'rejected', subresult distinto", () => {
    const noMailbox = classifyResultWithSubresult("invalid", "no_mailbox");
    const mailboxFull = classifyResultWithSubresult("invalid", "mailbox_full");
    assert.equal(noMailbox.bucket, "rejected");
    assert.equal(mailboxFull.bucket, "rejected");
    assert.equal(noMailbox.subresult, "no_mailbox");
    assert.equal(mailboxFull.subresult, "mailbox_full");
    assert.notEqual(noMailbox.subresult, mailboxFull.subresult);
  });

  it("subresult ausente/nulo → string vazia, nunca lança", () => {
    assert.equal(classifyResultWithSubresult("ok", undefined).subresult, "");
    assert.equal(classifyResultWithSubresult("ok", null).subresult, "");
  });

  it("subresult é trimado", () => {
    assert.equal(classifyResultWithSubresult("invalid", "  no_mailbox  ").subresult, "no_mailbox");
  });
});

describe("readAllCohortRows (#4071 — snapshot de TODO o cohort, verificado ou não)", () => {
  it("retorna todos os membros do cohort, mesmo com mv_bucket preenchido", () => {
    const db = seedDb([
      { email: "a@b.com", name: "A", cohort: "leads-2026-07", mv_bucket: null },
      { email: "b@b.com", name: "B", cohort: "leads-2026-07", mv_bucket: "verified", mv_cycle: "2607-08" },
      { email: "c@b.com", name: "C", cohort: "outro-cohort", mv_bucket: null },
    ]);
    try {
      const { rows } = readAllCohortRows(db, "leads-2026-07");
      assert.deepEqual(rows.map((r) => r.email).sort(), ["a@b.com", "b@b.com"]);
    } finally {
      db.close();
    }
  });
});

describe("buildOutputRows (#4071 — CSV final materializa o CHECKPOINT COMPLETO, não só a rodada atual)", () => {
  it("regressão exata do incidente 260726: 2ª rodada com candidatos novos preserva os da 1ª", () => {
    // Rodada 1: cohort tinha 2 candidatos (nenhum verificado ainda no store).
    const round1Candidates = [
      { email: "old1@b.com", name: "Old1" },
      { email: "old2@b.com", name: "Old2" },
    ];
    const checkpointAfterRound1: Record<string, { result: string; resultcode: number; quality: string }> = {
      "old1@b.com": { result: "ok", resultcode: 1, quality: "good" },
      "old2@b.com": { result: "invalid", resultcode: 6, quality: "bad" },
    };

    // Entre as rodadas, clarice-build-db.ts ingeriu o CSV da rodada 1 → o
    // store agora marca old1/old2 com mv_bucket preenchido, então eles NÃO
    // aparecem mais como candidatos de readStoreCandidates (saíram do
    // candidate-set) — só o resto do cohort permanece.
    const allCohortAfterIngest = [
      { email: "old1@b.com", name: "Old1" },
      { email: "old2@b.com", name: "Old2" },
      { email: "new1@b.com", name: "New1" },
    ];
    // Rodada 2: só o candidato novo aparece (comportamento real de
    // readStoreCandidates pós-ingestão).
    const round2Candidates = [{ email: "new1@b.com", name: "New1" }];
    // Checkpoint do CICLO acumula os 2 antigos + o novo — é o que estava
    // certo mesmo antes do fix (#4071 confirma isso ao vivo: 1960 = 1628+332).
    const checkpointAfterRound2 = {
      ...checkpointAfterRound1,
      "new1@b.com": { result: "catch_all", resultcode: 2, quality: "risky" },
    };

    // Antes do fix, o bug era: splitRows(round2Candidates, ...) — old1/old2 SOMEM
    // do CSV final porque round2Candidates só tem o candidato novo da 2ª rodada.
    const buggyOutput = splitRows(round2Candidates, "email", checkpointAfterRound2);
    assert.deepEqual(buggyOutput.verified.map((r) => r.email), ["new1@b.com"]); // old1 sumiu
    assert.deepEqual(buggyOutput.rejected.map((r) => r.email), []); // old2 sumiu

    // Fix: materializar o checkpoint completo, usando o snapshot de cohort
    // pra recuperar `name` de quem já saiu do candidate-set.
    const outputRows = buildOutputRows(
      checkpointAfterRound2,
      round2Candidates,
      allCohortAfterIngest,
      "email",
    );
    const fixedOutput = splitRows(outputRows, "email", checkpointAfterRound2);

    assert.deepEqual(fixedOutput.verified.map((r) => r.email).sort(), ["new1@b.com", "old1@b.com"]);
    assert.deepEqual(fixedOutput.rejected.map((r) => r.email), ["old2@b.com"]);
    // `name` foi corretamente recuperado do snapshot de cohort pros antigos.
    assert.equal(fixedOutput.verified.find((r) => r.email === "old1@b.com")!.name, "Old1");
    assert.equal(fixedOutput.rejected.find((r) => r.email === "old2@b.com")!.name, "Old2");

    // União completa: nenhuma linha do checkpoint foi perdida.
    const total =
      fixedOutput.verified.length + fixedOutput.rejected.length + fixedOutput.unknown.length;
    assert.equal(total, Object.keys(checkpointAfterRound2).length);
  });

  it("email do checkpoint ausente de currentRows E de allCohortRows ainda aparece, com name vazio", () => {
    const checkpoint = { "ghost@b.com": { result: "ok", resultcode: 1, quality: "good" } };
    const rows = buildOutputRows(checkpoint, [], [], "email");
    assert.deepEqual(rows, [{ email: "ghost@b.com", name: "" }]);
  });

  it("currentRows tem prioridade sobre allCohortRows pro name (dado mais fresco)", () => {
    const checkpoint = { "a@b.com": { result: "ok", resultcode: 1, quality: "good" } };
    const rows = buildOutputRows(
      checkpoint,
      [{ email: "a@b.com", name: "Fresh" }],
      [{ email: "a@b.com", name: "Stale" }],
      "email",
    );
    assert.deepEqual(rows, [{ email: "a@b.com", name: "Fresh" }]);
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

  it("--limit 0 é preservado (no-op proposital); ausente vira null", () => {
    assert.equal(parseArgs(["--limit", "0"]).limit, 0);
    assert.equal(parseArgs([]).limit, null);
  });

  it("--limit inválido (typo de valor) LANÇA — nunca degrada silenciosamente pra null (#4497)", () => {
    // Antes de getIntArg: Number("xyz")===NaN e Number("-5")<0 caíam no mesmo
    // `null` de "ausente" — indistinguível de "sem --limit" (mesma classe do
    // incidente #4476/#4496, onde isso fez uma rodada real processar 0 e-mails
    // em vez de 625, sem erro nenhum).
    assert.throws(() => parseArgs(["--limit", "xyz"]), /inteiro/);
    assert.throws(() => parseArgs(["--limit", "-5"]), /não-negativo/);
    assert.throws(() => parseArgs(["--limit="]), /vazio/);
  });
});

describe("buildErrorRows (#4353 — falhas transitórias materializadas SEM tocar o checkpoint)", () => {
  it("monta linhas a partir de failures[], resolvendo name de currentRows > allCohortRows > vazio", () => {
    const rows = buildErrorRows(
      ["bad@b.com", "ghost@b.com"],
      [{ email: "bad@b.com", name: "Fresh" }],
      [{ email: "bad@b.com", name: "Stale" }, { email: "ghost@b.com", name: "Ghost" }],
      "email",
    );
    assert.deepEqual(rows, [
      { email: "bad@b.com", name: "Fresh" }, // fresh > stale
      { email: "ghost@b.com", name: "Ghost" },
    ]);
  });

  it("email sem name em nenhuma das duas fontes vira string vazia (nunca undefined)", () => {
    const rows = buildErrorRows(["unknown@b.com"], [], [], "email");
    assert.deepEqual(rows, [{ email: "unknown@b.com", name: "" }]);
  });

  it("failures vazio retorna array vazio", () => {
    assert.deepEqual(buildErrorRows([], [{ email: "a@b.com", name: "A" }], [], "email"), []);
  });
});

describe(
  "verifyCohortList — REGRESSÃO #4353: falha transitória (retries esgotados) some dos 3 CSVs, log mentia 'ficam em unknown'",
  () => {
    /** Mock de fetch: `okEmail` sempre sucede; `badEmail` sempre devolve 500
     *  (transitório, retry) até os 4 attempts (inicial + 3 retries) se
     *  esgotarem — replica fielmente o cenário real de "falha transitória
     *  esgotada" descrito na issue. */
    function mockFetch(okEmail: string, badEmail: string): { fetch: typeof fetch; callsByEmail: Map<string, number> } {
      const callsByEmail = new Map<string, number>();
      const fetchFn = (async (input: string | URL) => {
        const url = new URL(String(input));
        const email = url.searchParams.get("email") ?? "";
        callsByEmail.set(email, (callsByEmail.get(email) ?? 0) + 1);
        if (email === badEmail) {
          return new Response(null, { status: 500 });
        }
        if (email === okEmail) {
          return new Response(
            JSON.stringify({ email, result: "ok", resultcode: 1, quality: "good", credits: 100 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`email inesperado no mock: ${email}`);
      }) as typeof fetch;
      return { fetch: fetchFn, callsByEmail };
    }

    const okEmail = "ok@b.com";
    const badEmail = "bad@b.com";
    const rows = [
      { email: okEmail, name: "OK" },
      { email: badEmail, name: "Bad" },
    ];

    it("(a) email com falha transitória NÃO aparece em verified/rejected; (b) aparece em error.csv rotulado; (c) summary reconcilia", async () => {
      const cycleDir = mkdtempSync(resolve(tmpdir(), "mv-4353-"));
      const { fetch: fetchMock } = mockFetch(okEmail, badEmail);
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock;
      try {
        const summary = await verifyCohortList({
          apiKey: "fake-key",
          cohort: "t-4353",
          cycleDir,
          rows,
          fields: ["email", "name"],
          emailKey: "email",
          allCohortRows: rows,
          concurrency: 2,
          timeout: 5,
          limit: null,
          _sleep: async () => {}, // #4353: retries instantâneos no teste (produção usa RETRYABLE_DELAYS_MS de verdade)
        });

        // (c) summary reconcilia e nomeia a falha explicitamente
        assert.equal(summary.transient_errors, 1);
        assert.equal(summary.failed_this_run, 1);
        assert.equal(summary.reconciled, true, "verified+rejected+unknown+transient_errors deve bater com cached+todo");
        assert.equal(summary.buckets.verified, 1);
        assert.equal(summary.buckets.rejected, 0);
        assert.equal(summary.buckets.unknown, 0);
        assert.equal(summary.outputs.error, `mv-export-t-4353-error.csv`);

        const base = mvOutputBase("t-4353");
        const readCsv = (bucket: string) =>
          Papa.parse<Record<string, string>>(readFileSync(resolve(cycleDir, `${base}-${bucket}.csv`), "utf-8"), {
            header: true,
            skipEmptyLines: true,
          }).data;

        // (a) bad@b.com NUNCA aparece em verified/rejected/unknown — o bug
        // original (#4353) fazia o email sumir SILENCIOSAMENTE dos 3.
        const verified = readCsv("verified");
        const rejected = readCsv("rejected");
        const unknown = readCsv("unknown");
        assert.deepEqual(verified.map((r) => r.email), [okEmail]);
        assert.equal(rejected.length, 0);
        assert.equal(unknown.length, 0, "bug original: bad@b.com caía aqui só na alegação do log, nunca na prática — aqui deve ficar 0");

        // (b) aparece no 4º arquivo, rotulado com o sentinela de erro transitório.
        const errorRows = readCsv("error");
        assert.equal(errorRows.length, 1);
        assert.equal(errorRows[0].email, badEmail);
        assert.equal(errorRows[0].MV_RESULT, TRANSIENT_ERROR_RESULT);

        // (d) checkpoint em disco NÃO tem entrada pro email falho — condição
        // pra retry-forever no próximo run (semântica #2886 preservada).
        const checkpointPath = resolve(cycleDir, `.mv-cache-${base}.json`);
        const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf-8")) as Record<string, unknown>;
        assert.ok(okEmail in checkpoint, "email verificado com sucesso deve estar no checkpoint");
        assert.ok(!(badEmail in checkpoint), "email com falha transitória NUNCA deve entrar no checkpoint (retry-forever, #2886)");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("(e) 2ª invocação com o MESMO checkpoint ainda tenta o email que falhou (retry preservado) — e desta vez sucede", async () => {
      const cycleDir = mkdtempSync(resolve(tmpdir(), "mv-4353-retry-"));

      // Rodada 1: bad@b.com falha transitoriamente.
      const round1 = mockFetch(okEmail, badEmail);
      const origFetch = globalThis.fetch;
      globalThis.fetch = round1.fetch;
      try {
        await verifyCohortList({
          apiKey: "fake-key",
          cohort: "t-4353-retry",
          cycleDir,
          rows,
          fields: ["email", "name"],
          emailKey: "email",
          allCohortRows: rows,
          concurrency: 2,
          timeout: 5,
          limit: null,
          _sleep: async () => {},
        });
      } finally {
        globalThis.fetch = origFetch;
      }
      // bad@b.com foi de fato tentado (não pulado) na rodada 1 — 1 attempt + 3 retries = 4 chamadas.
      assert.equal(round1.callsByEmail.get(badEmail), 4);

      // Rodada 2: MESMO cycleDir (mesmo checkpoint em disco); desta vez bad@b.com sucede.
      let round2Calls = 0;
      globalThis.fetch = (async (input: string | URL) => {
        const url = new URL(String(input));
        const email = url.searchParams.get("email") ?? "";
        round2Calls++;
        return new Response(
          JSON.stringify({ email, result: "ok", resultcode: 1, quality: "good", credits: 99 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const summary2 = await verifyCohortList({
          apiKey: "fake-key",
          cohort: "t-4353-retry",
          cycleDir,
          rows,
          fields: ["email", "name"],
          emailKey: "email",
          allCohortRows: rows,
          concurrency: 2,
          timeout: 5,
          limit: null,
          _sleep: async () => {},
        });
        // Prova de retry-on-next-run: bad@b.com foi re-tentado (senão
        // round2Calls seria 0, já que okEmail já estava no checkpoint da
        // rodada 1 e não entraria em `todo` de novo) e desta vez sucedeu.
        assert.equal(round2Calls, 1, "só bad@b.com deveria estar em todo() na rodada 2 — ok@b.com já está no checkpoint");
        assert.equal(summary2.buckets.verified, 2, "verified agora inclui ok@b.com (rodada 1) + bad@b.com (rodada 2, retentado com sucesso)");
        assert.equal(summary2.transient_errors, 0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  },
);
