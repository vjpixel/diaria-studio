/**
 * test/google-ads-enhanced-conversions-7770.test.ts (#7770)
 *
 * Cobre `scripts/lib/google-ads-enhanced-conversions.ts` e o CLI
 * `scripts/upload-google-ads-enhanced-conversions.ts`:
 *   - normalização/hash de e-mail (SHA-256, valor conhecido);
 *   - filtro de e-mail de teste do editor (`vjpixel+...@gmail.com`,
 *     inclusive o exemplo `vjpixel+gtm-teste*` citado na própria issue);
 *   - rejeição de timestamp pós-corte (lote inteiro, salvo
 *     `--allow-past-cutoff`);
 *   - exigência de `--conversion-action-id`;
 *   - dry-run (default) não faz NENHUMA chamada de rede.
 *
 * Nunca chama a API real do Google Ads — todo `fetch` é injetado/mockado.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeEmailForHashing,
  hashEmailForEnhancedConversions,
  isEditorTestEmail,
  formatConversionDateTime,
  validateSignupRecords,
  resolveConversionActionResourceName,
  buildUploadClickConversionsPayload,
  parseSignupJson,
  ENHANCED_CONVERSIONS_CUTOFF_ISO,
  type SignupRecordInput,
  type ValidatedConversion,
} from "../scripts/lib/google-ads-enhanced-conversions.ts";
import { main as uploadMain, loadSignupRecords } from "../scripts/upload-google-ads-enhanced-conversions.ts";

// ---------------------------------------------------------------------------
// Normalização + hash de e-mail
// ---------------------------------------------------------------------------

describe("#7770 — normalização/hash de e-mail", () => {
  it("normaliza lowercase + trim antes de hashear", () => {
    assert.equal(normalizeEmailForHashing("  Leitor@Example.COM  "), "leitor@example.com");
  });

  it("hashEmailForEnhancedConversions produz o SHA-256 hex do e-mail normalizado", () => {
    const expected = createHash("sha256").update("leitor@example.com", "utf8").digest("hex");
    assert.equal(hashEmailForEnhancedConversions("  Leitor@Example.COM  "), expected);
    assert.equal(hashEmailForEnhancedConversions("leitor@example.com"), expected);
  });

  it("e-mails equivalentes (case/espaço) produzem o MESMO hash", () => {
    assert.equal(
      hashEmailForEnhancedConversions("Leitor@Example.com"),
      hashEmailForEnhancedConversions("leitor@example.com "),
    );
  });
});

// ---------------------------------------------------------------------------
// Filtro de e-mail de teste do editor
// ---------------------------------------------------------------------------

describe("#7770 — isEditorTestEmail", () => {
  it("casa qualquer plus-address sob vjpixel@gmail.com, inclusive o exemplo da issue", () => {
    assert.equal(isEditorTestEmail("vjpixel+gtm-teste1@gmail.com"), true);
    assert.equal(isEditorTestEmail("vjpixel+test2@gmail.com"), true);
    assert.equal(isEditorTestEmail("VJPIXEL+ANYTHING@GMAIL.COM"), true);
  });

  it("NÃO casa o e-mail interno real (sem +) nem e-mails de terceiros", () => {
    assert.equal(isEditorTestEmail("vjpixel@gmail.com"), false);
    assert.equal(isEditorTestEmail("leitor@example.com"), false);
    assert.equal(isEditorTestEmail("outra+pessoa@gmail.com"), false);
  });
});

// ---------------------------------------------------------------------------
// formatConversionDateTime
// ---------------------------------------------------------------------------

describe("#7770 — formatConversionDateTime", () => {
  it("converte ISO com offset explícito pro formato da API (espaço, offset preservado)", () => {
    assert.equal(formatConversionDateTime("2026-09-05T14:30:00-03:00"), "2026-09-05 14:30:00-03:00");
  });

  it("converte Z pra +00:00 explícito", () => {
    assert.equal(formatConversionDateTime("2026-09-05T14:30:00Z"), "2026-09-05 14:30:00+00:00");
  });

  it("descarta milissegundos", () => {
    assert.equal(formatConversionDateTime("2026-09-05T14:30:00.123-03:00"), "2026-09-05 14:30:00-03:00");
  });

  it("retorna null (nunca lança) para formato inválido", () => {
    assert.equal(formatConversionDateTime("não é uma data"), null);
    assert.equal(formatConversionDateTime("2026-09-05 14:30:00"), null); // sem offset
    assert.equal(formatConversionDateTime(""), null);
  });
});

// ---------------------------------------------------------------------------
// validateSignupRecords
// ---------------------------------------------------------------------------

const BEFORE_CUTOFF = "2026-09-05T14:30:00-03:00";
const AFTER_CUTOFF = "2026-09-06T15:00:00-03:00"; // depois de 12:27 do dia 06

describe("#7770 — validateSignupRecords", () => {
  it("aceita lote inteiramente anterior ao corte", () => {
    const records: SignupRecordInput[] = [
      { email: "leitor1@example.com", signupTimestamp: BEFORE_CUTOFF },
      { email: "leitor2@example.com", signupTimestamp: "2026-09-06T10:00:00-03:00" },
    ];
    const result = validateSignupRecords(records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conversions.length, 2);
    assert.equal(result.pastCutoffCount, 0);
    assert.deepEqual(result.skippedTestEmails, []);
    assert.deepEqual(result.skippedMalformed, []);
  });

  it("descarta e-mail de teste do editor sem contar como violação de corte", () => {
    const records: SignupRecordInput[] = [
      { email: "vjpixel+gtm-teste1@gmail.com", signupTimestamp: BEFORE_CUTOFF },
      { email: "leitor@example.com", signupTimestamp: BEFORE_CUTOFF },
    ];
    const result = validateSignupRecords(records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conversions.length, 1);
    assert.equal(result.conversions[0].email, "leitor@example.com");
    assert.equal(result.skippedTestEmails.length, 1);
    assert.equal(result.skippedTestEmails[0].email, "vjpixel+gtm-teste1@gmail.com");
  });

  it("descarta timestamp malformado sem abortar o resto do lote", () => {
    const records: SignupRecordInput[] = [
      { email: "leitor1@example.com", signupTimestamp: "não é uma data" },
      { email: "leitor2@example.com", signupTimestamp: BEFORE_CUTOFF },
    ];
    const result = validateSignupRecords(records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conversions.length, 1);
    assert.equal(result.conversions[0].email, "leitor2@example.com");
    assert.equal(result.skippedMalformed.length, 1);
    assert.equal(result.skippedMalformed[0].email, "leitor1@example.com");
  });

  it("REJEITA O LOTE INTEIRO quando há timestamp pós-corte, sem --allow-past-cutoff", () => {
    const records: SignupRecordInput[] = [
      { email: "leitor1@example.com", signupTimestamp: BEFORE_CUTOFF },
      { email: "leitor2@example.com", signupTimestamp: AFTER_CUTOFF },
    ];
    const result = validateSignupRecords(records);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.violatingRows.length, 1);
    assert.equal(result.violatingRows[0].email, "leitor2@example.com");
    assert.match(result.reason, new RegExp(ENHANCED_CONVERSIONS_CUTOFF_ISO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("aceita registros pós-corte com --allow-past-cutoff, marcando pastCutoff:true", () => {
    const records: SignupRecordInput[] = [
      { email: "leitor1@example.com", signupTimestamp: BEFORE_CUTOFF },
      { email: "leitor2@example.com", signupTimestamp: AFTER_CUTOFF },
    ];
    const result = validateSignupRecords(records, { allowPastCutoff: true });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conversions.length, 2);
    assert.equal(result.pastCutoffCount, 1);
    const flagged = result.conversions.find((c) => c.email === "leitor2@example.com");
    assert.equal(flagged?.pastCutoff, true);
    const notFlagged = result.conversions.find((c) => c.email === "leitor1@example.com");
    assert.equal(notFlagged?.pastCutoff, false);
  });

  it("e-mail de teste pós-corte não dispara abort do lote (filtro de teste roda antes)", () => {
    const records: SignupRecordInput[] = [
      { email: "vjpixel+gtm-teste2@gmail.com", signupTimestamp: AFTER_CUTOFF },
      { email: "leitor@example.com", signupTimestamp: BEFORE_CUTOFF },
    ];
    const result = validateSignupRecords(records);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.conversions.length, 1);
    assert.equal(result.conversions[0].email, "leitor@example.com");
  });

  it("cutoffMs injetável permite teste determinístico sem depender do relógio real", () => {
    const customCutoff = Date.parse("2020-01-01T00:00:00-03:00");
    const records: SignupRecordInput[] = [{ email: "leitor@example.com", signupTimestamp: BEFORE_CUTOFF }];
    const result = validateSignupRecords(records, { cutoffMs: customCutoff });
    assert.equal(result.ok, false); // BEFORE_CUTOFF (2026) é posterior ao cutoff injetado (2020)
  });
});

// ---------------------------------------------------------------------------
// resolveConversionActionResourceName / buildUploadClickConversionsPayload
// ---------------------------------------------------------------------------

describe("#7770 — payload de upload", () => {
  it("resolveConversionActionResourceName monta o resource name a partir de um id cru", () => {
    assert.equal(
      resolveConversionActionResourceName("236-921-9639", "999999999"),
      "customers/2369219639/conversionActions/999999999",
    );
  });

  it("resolveConversionActionResourceName preserva um resource name já completo", () => {
    const full = "customers/2369219639/conversionActions/999999999";
    assert.equal(resolveConversionActionResourceName("2369219639", full), full);
  });

  it("buildUploadClickConversionsPayload monta conversions com hashedEmail, sem gclid", () => {
    const conversions: ValidatedConversion[] = [
      {
        email: "leitor@example.com",
        hashedEmail: hashEmailForEnhancedConversions("leitor@example.com"),
        conversionDateTime: "2026-09-05 14:30:00-03:00",
        pastCutoff: false,
      },
    ];
    const payload = buildUploadClickConversionsPayload(conversions, {
      conversionActionResourceName: "customers/2369219639/conversionActions/999999999",
    });
    assert.equal(payload.partialFailure, true);
    assert.equal(payload.validateOnly, false);
    assert.equal(payload.conversions.length, 1);
    assert.equal(payload.conversions[0].conversionAction, "customers/2369219639/conversionActions/999999999");
    assert.equal(payload.conversions[0].conversionDateTime, "2026-09-05 14:30:00-03:00");
    assert.deepEqual(payload.conversions[0].userIdentifiers, [{ hashedEmail: conversions[0].hashedEmail }]);
    assert.equal("gclid" in payload.conversions[0], false);
  });
});

// ---------------------------------------------------------------------------
// parseSignupJson
// ---------------------------------------------------------------------------

describe("#7770 — parseSignupJson", () => {
  it("aceita signupTimestamp e signup_timestamp", () => {
    const records = parseSignupJson(
      JSON.stringify([
        { email: "a@example.com", signupTimestamp: BEFORE_CUTOFF },
        { email: "b@example.com", signup_timestamp: BEFORE_CUTOFF },
      ]),
    );
    assert.equal(records.length, 2);
    assert.equal(records[0].signupTimestamp, BEFORE_CUTOFF);
    assert.equal(records[1].signupTimestamp, BEFORE_CUTOFF);
  });

  it("lança em JSON que não é array", () => {
    assert.throws(() => parseSignupJson(JSON.stringify({ email: "a@example.com" })));
  });
});

// ---------------------------------------------------------------------------
// CLI (scripts/upload-google-ads-enhanced-conversions.ts)
// ---------------------------------------------------------------------------

function withTempFile(content: string, ext: string, fn: (path: string) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), "diaria-eca-test-"));
  const path = join(dir, `input${ext}`);
  writeFileSync(path, content, "utf8");
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#7770 — CLI upload-google-ads-enhanced-conversions", () => {
  it("exige --conversion-action-id (exit 1, sem chamar rede)", async () => {
    await withTempFile(JSON.stringify([{ email: "a@example.com", signupTimestamp: BEFORE_CUTOFF }]), ".json", async (path) => {
      const fetchMock = mock.fn(async () => {
        throw new Error("fetch NÃO deveria ser chamado");
      });
      const code = await uploadMain(["--input", path], fetchMock as unknown as typeof fetch);
      assert.equal(code, 1);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  it("exige --input (exit 1, sem chamar rede)", async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error("fetch NÃO deveria ser chamado");
    });
    const code = await uploadMain(["--conversion-action-id", "999"], fetchMock as unknown as typeof fetch);
    assert.equal(code, 1);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("dry-run (default) NÃO faz nenhuma chamada de rede e sai 0", async () => {
    await withTempFile(
      JSON.stringify([{ email: "leitor@example.com", signupTimestamp: BEFORE_CUTOFF }]),
      ".json",
      async (path) => {
        const fetchMock = mock.fn(async () => {
          throw new Error("fetch NÃO deveria ser chamado em dry-run");
        });
        const code = await uploadMain(
          ["--input", path, "--conversion-action-id", "999999999", "--customer-id", "2369219639"],
          fetchMock as unknown as typeof fetch,
        );
        assert.equal(code, 0);
        assert.equal(fetchMock.mock.callCount(), 0);
      },
    );
  });

  it("lote com timestamp pós-corte sai 1, sem chamar rede, mesmo em modo --send", async () => {
    await withTempFile(
      JSON.stringify([{ email: "leitor@example.com", signupTimestamp: AFTER_CUTOFF }]),
      ".json",
      async (path) => {
        const fetchMock = mock.fn(async () => {
          throw new Error("fetch NÃO deveria ser chamado quando o corte rejeita o lote");
        });
        const code = await uploadMain(
          ["--input", path, "--conversion-action-id", "999999999", "--customer-id", "2369219639", "--send"],
          fetchMock as unknown as typeof fetch,
        );
        assert.equal(code, 1);
        assert.equal(fetchMock.mock.callCount(), 0);
      },
    );
  });

  it("--send sem env vars sai 1 antes de chamar rede", async () => {
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    try {
      await withTempFile(
        JSON.stringify([{ email: "leitor@example.com", signupTimestamp: BEFORE_CUTOFF }]),
        ".json",
        async (path) => {
          const fetchMock = mock.fn(async () => {
            throw new Error("fetch NÃO deveria ser chamado sem credenciais");
          });
          const code = await uploadMain(
            ["--input", path, "--conversion-action-id", "999999999", "--customer-id", "2369219639", "--send"],
            fetchMock as unknown as typeof fetch,
          );
          assert.equal(code, 1);
          assert.equal(fetchMock.mock.callCount(), 0);
        },
      );
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("loadSignupRecords lê CSV com cabeçalho email,signup_timestamp", () => {
    const csv = "email,signup_timestamp\nleitor@example.com,2026-09-05T14:30:00-03:00\n";
    const records = loadSignupRecords("input.csv", csv);
    assert.equal(records.length, 1);
    assert.equal(records[0].email, "leitor@example.com");
    assert.equal(records[0].signupTimestamp, "2026-09-05T14:30:00-03:00");
  });

  it("loadSignupRecords lança em extensão não reconhecida", () => {
    assert.throws(() => loadSignupRecords("input.txt", "qualquer coisa"));
  });
});
