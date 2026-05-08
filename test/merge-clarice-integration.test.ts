import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Papa from "papaparse";
import { main } from "../scripts/merge-clarice-subscribers.ts";

/**
 * Integration test (#1021): valida output end-to-end do merge-clarice-subscribers.
 *
 * Fluxo:
 *   1. Cria temp dir
 *   2. Copia fixture CSV (15 contatos cobrindo T1–T10 + 3 exclusões)
 *   3. Roda main(tempDir)
 *   4. Verifica:
 *      - 10 CSVs gerados (brevo-import-t01.csv ... t10.csv)
 *      - excluded.csv com 3 entradas (dispute, role, disposable)
 *      - Schema do CSV de tier (3 colunas exatas)
 *      - Counts batem com tier expectativa
 *      - Idempotência (rodar 2x → mesmo output)
 *      - Cleanup de órfãos legacy
 */

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/clarice-fixtures/stripe-customers-fixture.csv");

let tmpDataDir: string;

before(() => {
  // Cria temp dir único pra esse run
  tmpDataDir = mkdtempSync(join(tmpdir(), "merge-clarice-test-"));
  // Copia fixture pra dentro
  copyFileSync(FIXTURE_PATH, join(tmpDataDir, "stripe-customers-fixture.csv"));
});

after(() => {
  // Cleanup
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("merge-clarice integration: outputs end-to-end", () => {
  it("gera 10 CSVs t01–t10 + excluded ao rodar main(tempDir)", () => {
    main(tmpDataDir);

    const expected = [
      "brevo-import-t01.csv",
      "brevo-import-t02.csv",
      "brevo-import-t03.csv",
      "brevo-import-t04.csv",
      "brevo-import-t05.csv",
      "brevo-import-t06.csv",
      "brevo-import-t07.csv",
      "brevo-import-t08.csv",
      "brevo-import-t09.csv",
      "brevo-import-t10.csv",
      "brevo-import-excluded.csv",
    ];
    for (const f of expected) {
      assert.ok(
        existsSync(join(tmpDataDir, f)),
        `Esperava arquivo ${f} no tempDir após main()`,
      );
    }
  });

  it("schema dos CSVs de tier é exatamente: email,NOME,OPEN_PROBABILITY", () => {
    for (let t = 1; t <= 10; t++) {
      const filename = `brevo-import-t${String(t).padStart(2, "0")}.csv`;
      const content = readFileSync(join(tmpDataDir, filename), "utf8");
      const firstLine = content.split("\n")[0].trim();
      assert.equal(
        firstLine,
        "email,NOME,OPEN_PROBABILITY",
        `Schema do ${filename} deve ser email,NOME,OPEN_PROBABILITY (achou: ${firstLine})`,
      );
    }
  });

  it("schema do excluded.csv tem coluna `reason`", () => {
    const content = readFileSync(join(tmpDataDir, "brevo-import-excluded.csv"), "utf8");
    const firstLine = content.split("\n")[0];
    assert.match(firstLine, /reason/, "excluded.csv deve ter coluna `reason`");
    assert.match(firstLine, /email/, "excluded.csv deve ter coluna `email`");
  });

  it("conta correta de contatos por tier (fixture tem 1 contato em cada T1–T10, exceto T1 com 2)", () => {
    function count(filename: string): number {
      const content = readFileSync(join(tmpDataDir, filename), "utf8");
      const rows = Papa.parse(content, { header: true, skipEmptyLines: true }).data;
      return rows.length;
    }

    // T1 tem 2 (active + trialing); T2 tem 2 (canceled+paid + unpaid+paid); T3-T10 têm 1 cada
    assert.equal(count("brevo-import-t01.csv"), 2, "T1 deve ter 2 contatos (active + trialing)");
    assert.equal(count("brevo-import-t02.csv"), 2, "T2 deve ter 2 contatos (canceled + unpaid, ambos paid)");
    assert.equal(count("brevo-import-t03.csv"), 1, "T3 deve ter 1 contato (lead 2026)");
    assert.equal(count("brevo-import-t04.csv"), 1, "T4 deve ter 1 (lead 2025-H2)");
    assert.equal(count("brevo-import-t05.csv"), 1, "T5 deve ter 1 (lead 2025-H1)");
    assert.equal(count("brevo-import-t06.csv"), 1, "T6 deve ter 1 (lead 2024-H2)");
    assert.equal(count("brevo-import-t07.csv"), 1, "T7 deve ter 1 (lead 2024-H1)");
    assert.equal(count("brevo-import-t08.csv"), 1, "T8 deve ter 1 (lead 2023-H2)");
    assert.equal(count("brevo-import-t09.csv"), 1, "T9 deve ter 1 (lead 2023-H1)");
    assert.equal(count("brevo-import-t10.csv"), 1, "T10 deve ter 1 (lead 2022)");

    // Excluded: 3 (dispute, role, disposable)
    assert.equal(count("brevo-import-excluded.csv"), 3, "Excluded deve ter 3 (dispute + role + disposable)");
  });

  it("excluded contém os 3 reasons corretos", () => {
    const content = readFileSync(join(tmpDataDir, "brevo-import-excluded.csv"), "utf8");
    const rows = Papa.parse<{ email: string; reason: string }>(content, {
      header: true,
      skipEmptyLines: true,
    }).data;
    const reasons = new Set(rows.map((r) => r.reason));
    assert.ok(reasons.has("dispute_losses"), "Esperava reason=dispute_losses");
    assert.ok(reasons.has("role_account"), "Esperava reason=role_account");
    assert.ok(reasons.has("disposable_domain"), "Esperava reason=disposable_domain");
  });

  it("idempotência: rodar 2x produz exatamente o mesmo output", () => {
    // Snapshot dos arquivos atuais
    const beforeContent: { [k: string]: string } = {};
    for (let t = 1; t <= 10; t++) {
      const filename = `brevo-import-t${String(t).padStart(2, "0")}.csv`;
      beforeContent[filename] = readFileSync(join(tmpDataDir, filename), "utf8");
    }
    beforeContent["brevo-import-excluded.csv"] = readFileSync(
      join(tmpDataDir, "brevo-import-excluded.csv"),
      "utf8",
    );

    // Roda de novo
    main(tmpDataDir);

    // Compara
    for (const [filename, content] of Object.entries(beforeContent)) {
      const after = readFileSync(join(tmpDataDir, filename), "utf8");
      assert.equal(after, content, `${filename} mudou após segunda execução (deveria ser idempotente)`);
    }
  });

  it("cleanup remove órfãos legacy (kit-import-* e brevo-import-tier{N}.csv)", () => {
    // Cria órfãos artificiais
    writeFileSync(join(tmpDataDir, "kit-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "kit-import-excluded.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier2.csv"), "stale\n", "utf8");

    main(tmpDataDir);

    // Devem ter sido removidos
    assert.equal(existsSync(join(tmpDataDir, "kit-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "kit-import-excluded.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier2.csv")), false);

    // Os t01–t10 e excluded continuam
    for (let t = 1; t <= 10; t++) {
      const filename = `brevo-import-t${String(t).padStart(2, "0")}.csv`;
      assert.ok(existsSync(join(tmpDataDir, filename)), `${filename} foi removido por engano`);
    }
  });
});
