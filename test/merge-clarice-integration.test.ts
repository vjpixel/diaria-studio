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
 *      - 10 CSVs gerados (stripe-export-t01-assinantes-ativos.csv ... t10-leads-caudao.csv)
 *      - excluded.csv com 3 entradas (dispute, role, disposable)
 *      - Schema do CSV de tier (3 colunas exatas)
 *      - Counts batem com tier expectativa
 *      - Idempotência (rodar 2x → mesmo output)
 *      - Cleanup de órfãos legacy
 */

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/clarice-fixtures/stripe-customers-fixture.csv");

/**
 * Nomes de tier agora são descritivos (stripe-export-t{NN}-{slug}.csv, ex:
 * t01-assinantes-ativos, t03-leads-2026-jan-abr) e o slug dos leads é dinâmico
 * (acompanha `now`/dados). Os testes casam pelo prefixo ESTÁVEL `t{NN}-` em vez
 * do nome exato, pra não acoplar à data de execução.
 */
function tierFile(dir: string, tier: number): string {
  const nn = String(tier).padStart(2, "0");
  const f = readdirSync(dir).find((x) => x.startsWith(`stripe-export-t${nn}-`) && x.endsWith(".csv"));
  if (!f) throw new Error(`arquivo do tier t${nn} não encontrado em ${dir}`);
  return f;
}

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

    // Os 10 tiers (nome descritivo, achado por prefixo t{NN}-):
    for (let t = 1; t <= 10; t++) {
      assert.ok(
        existsSync(join(tmpDataDir, tierFile(tmpDataDir, t))),
        `Esperava arquivo do tier t${t} no tempDir após main()`,
      );
    }
    assert.ok(
      existsSync(join(tmpDataDir, "stripe-export-excluded.csv")),
      "Esperava stripe-export-excluded.csv no tempDir após main()",
    );
  });

  it("schema dos CSVs de tier é exatamente: email,NOME,OPEN_PROBABILITY", () => {
    for (let t = 1; t <= 10; t++) {
      const filename = tierFile(tmpDataDir, t);
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
    const content = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
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
    assert.equal(count(tierFile(tmpDataDir, 1)), 2, "T1 deve ter 2 contatos (active + trialing)");
    assert.equal(count(tierFile(tmpDataDir, 2)), 2, "T2 deve ter 2 contatos (canceled + unpaid, ambos paid)");
    assert.equal(count(tierFile(tmpDataDir, 3)), 1, "T3 deve ter 1 contato (lead 2026)");
    assert.equal(count(tierFile(tmpDataDir, 4)), 1, "T4 deve ter 1 (lead 2025-H2)");
    assert.equal(count(tierFile(tmpDataDir, 5)), 1, "T5 deve ter 1 (lead 2025-H1)");
    assert.equal(count(tierFile(tmpDataDir, 6)), 1, "T6 deve ter 1 (lead 2024-H2)");
    assert.equal(count(tierFile(tmpDataDir, 7)), 1, "T7 deve ter 1 (lead 2024-H1)");
    assert.equal(count(tierFile(tmpDataDir, 8)), 1, "T8 deve ter 1 (lead 2023-H2)");
    assert.equal(count(tierFile(tmpDataDir, 9)), 1, "T9 deve ter 1 (lead 2023-H1)");
    assert.equal(count(tierFile(tmpDataDir, 10)), 1, "T10 deve ter 1 (lead 2022)");

    // Excluded: 3 (dispute, role, disposable)
    assert.equal(count("stripe-export-excluded.csv"), 3, "Excluded deve ter 3 (dispute + role + disposable)");
  });

  it("excluded contém os 3 reasons corretos", () => {
    const content = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
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
      const filename = tierFile(tmpDataDir, t);
      beforeContent[filename] = readFileSync(join(tmpDataDir, filename), "utf8");
    }
    beforeContent["stripe-export-excluded.csv"] = readFileSync(
      join(tmpDataDir, "stripe-export-excluded.csv"),
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

  it("cleanup remove órfãos: legacy (kit-import-*, brevo-import-*) + slug-drift atual (stripe-export-)", () => {
    // Cria órfãos artificiais
    writeFileSync(join(tmpDataDir, "kit-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "kit-import-excluded.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier2.csv"), "stale\n", "utf8");
    // Legado pré-stripe-export (#1965): slug com H maiúsculo + numérico puro.
    writeFileSync(join(tmpDataDir, "brevo-import-t04-leads-2099H1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-t05.csv"), "stale\n", "utf8");
    // Atual (stripe-export-): slug-drift de outro run/semestre (H maiúsculo) — deve sumir tb.
    writeFileSync(join(tmpDataDir, "stripe-export-t04-leads-2099H1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "stripe-export-t05.csv"), "stale\n", "utf8");

    main(tmpDataDir);

    // Devem ter sido removidos
    assert.equal(existsSync(join(tmpDataDir, "kit-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "kit-import-excluded.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier2.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-t04-leads-2099H1.csv")), false, "legado: slug H maiúsculo deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-t05.csv")), false, "legado: numérico puro deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-t04-leads-2099H1.csv")), false, "stripe-export slug-drift deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-t05.csv")), false, "stripe-export numérico deve ser removido");

    // Over-deletion guard: o cleanup NÃO pode comer o input (stripe) nem o audit (excluded).
    assert.ok(existsSync(join(tmpDataDir, "stripe-customers-fixture.csv")), "input do Stripe não pode ser removido pelo cleanup");
    assert.ok(existsSync(join(tmpDataDir, "stripe-export-excluded.csv")), "excluded.csv (audit) não pode ser removido pelo cleanup");

    // Os t01–t10 e excluded continuam
    for (let t = 1; t <= 10; t++) {
      const filename = tierFile(tmpDataDir, t);
      assert.ok(existsSync(join(tmpDataDir, filename)), `${filename} foi removido por engano`);
    }
  });
});

// ─── Cross-CSV merge invariants (#1027) ────────────────────────────────────

describe("merge-clarice: invariantes de merge cross-CSV", () => {
  const COHORTS_DIR = resolve(import.meta.dirname, "fixtures/clarice-fixtures");
  let mergeDir: string;

  before(() => {
    mergeDir = mkdtempSync(join(tmpdir(), "merge-cross-csv-"));
    // Copia 3 cohorts pra mesmo dataDir — script faz merge entre eles
    copyFileSync(
      join(COHORTS_DIR, "stripe-fixture-cohort1-2023.csv"),
      join(mergeDir, "stripe-cohort1.csv"),
    );
    copyFileSync(
      join(COHORTS_DIR, "stripe-fixture-cohort2-2024.csv"),
      join(mergeDir, "stripe-cohort2.csv"),
    );
    copyFileSync(
      join(COHORTS_DIR, "stripe-fixture-cohort3-2026.csv"),
      join(mergeDir, "stripe-cohort3.csv"),
    );
    main(mergeDir);
  });

  after(() => {
    if (mergeDir) rmSync(mergeDir, { recursive: true, force: true });
  });

  function findContact(filename: string, email: string): { [k: string]: string } | undefined {
    const content = readFileSync(join(mergeDir, filename), "utf8");
    const rows = Papa.parse<{ [k: string]: string }>(content, {
      header: true,
      skipEmptyLines: true,
    }).data;
    return rows.find((r) => r.email === email);
  }

  it("contato duplicado em 3 cohorts: stripe_ids agregados (audit trail)", () => {
    // duplicated@clrctest.com.br aparece em cohort1 (cus_c1a), cohort2 (cus_c2a), cohort3 (cus_c3a)
    // Estará em algum tier; vou buscar em todos
    let found: { [k: string]: string } | undefined;
    for (let t = 1; t <= 10; t++) {
      const filename = tierFile(mergeDir, t);
      found = findContact(filename, "duplicated@clrctest.com.br");
      if (found) break;
    }
    assert.ok(found, "duplicated@clrctest.com.br deveria estar em algum tier");
    // Schema CSV minimal não inclui stripe_ids. Apenas validamos que email apareceu 1x (não 3x)
    let totalAppearances = 0;
    for (let t = 1; t <= 10; t++) {
      if (findContact(tierFile(mergeDir, t), "duplicated@clrctest.com.br")) {
        totalAppearances++;
      }
    }
    assert.equal(totalAppearances, 1, "Email duplicado deve aparecer em EXATAMENTE 1 tier (mergeado)");
  });

  it("duplicated: NOME do registro mais recente vence (cohort3, 2026)", () => {
    // cohort1: "Old Name", cohort2: "New Name 2024", cohort3: "Newest Name 2026"
    // Merge usa created mais recente — cohort3 vence
    let found: { [k: string]: string } | undefined;
    for (let t = 1; t <= 10; t++) {
      found = findContact(tierFile(mergeDir, t), "duplicated@clrctest.com.br");
      if (found) break;
    }
    assert.ok(found);
    // first_name = primeira palavra do name; "Newest Name 2026" → "Newest"
    assert.equal(found!.NOME, "Newest");
  });

  it("duplicated: paid (spend > 0) é detectado mesmo se o último cohort não tiver pagamento", () => {
    // duplicated tem total_spend = 200 + 100 + 50 = 350 (somado).
    // Vai pra T2 (ex-assinante) — não é active hoje.
    const found = findContact(tierFile(mergeDir, 2), "duplicated@clrctest.com.br");
    assert.ok(found, "duplicated deveria estar em T2 (paid alguma vez, não active hoje)");
  });

  it("delinquent@: status active de cohort2 vence canceled de cohort1 → vai pra T1", () => {
    // cohort1: canceled / cohort2: active. Merge mantém active.
    const found = findContact(tierFile(mergeDir, 1), "delinquent@clrctest.com.br");
    assert.ok(found, "delinquent@ deveria estar em T1 após status='active' vencer");
  });

  it("solo (1 cohort apenas) é tratado normalmente", () => {
    const solo2023 = findContact(tierFile(mergeDir, 2), "solo2023a@clrctest.com.br");
    assert.ok(solo2023, "solo2023a deveria estar em T2 (paid, antigo, não active)");

    const fresh2026 = findContact(tierFile(mergeDir, 3), "fresh2026@clrctest.com.br");
    assert.ok(fresh2026, "fresh2026 deveria estar em T3 (lead 2026, never paid)");
  });

  it("duplicated: OPEN_PROBABILITY reflete merge correto (payment_count somado + delinquent OR)", () => {
    // Decomposição do cálculo esperado:
    //   spend=350 (somado 200+100+50)  → base 40 (spend ≥100)
    //   created=2026-02-10 (mais recente vence) → +12 (<12mo)
    //   payment_count=7 (somado 4+2+1) → +4 (≥5)
    //   delinquent=true (OR de false/true/false) → −5
    //   status=canceled (entre canceled/unpaid/canceled, mais ativo não-vazio) → −3
    //   Total = 40 + 12 + 4 − 5 − 3 = 48
    //
    // Esse valor SÓ bate se merge funcionou corretamente:
    //   - Spend somado: sem soma, cohort3 sozinho teria spend=50 → base 30 (spend ≥10), não 40
    //   - Payment_count somado: sem soma, cohort3 sozinho teria pmt=1 → sem bonus +4
    //   - Delinquent OR: sem OR, cohort3 (false) ganharia → sem penalidade −5
    //   - Created mais recente: sem isso, cohort1 (2023) ganharia → recency seria 0 ou negativa
    const duplicated = findContact(tierFile(mergeDir, 2), "duplicated@clrctest.com.br");
    assert.ok(duplicated, "duplicated deveria estar em T2");
    assert.equal(
      duplicated!.OPEN_PROBABILITY,
      "48",
      "OPEN_PROB=48 lock-in reflete merge: spend+pmt somados, delinquent OR, recency cohort3",
    );
  });

  it("solo2024 vs duplicated: OPEN_PROBABILITY mostra impacto de delinquent + payment_count", () => {
    // solo2024@: spend=80 (single), payment_count=2, delinquent=false, canceled, 2024-09 → ~20mo
    //   base 30 (spend ≥10) + recency +6 (12-24mo) + 0 pmt mod − 3 canceled = 33
    // duplicated@: como acima = 48
    //
    // Diff = 48 − 33 = 15. Composição do diff (apenas atributos diferentes):
    //   +10 (spend 80 → 350: bumps de 30 base pra 40 base)
    //   +6 (recency: 20mo → 3mo, +6 vs +12)
    //   +4 (payment_count: 2 → 7, sem mod vs +4)
    //   −5 (delinquent: false vs true)
    //   = +10 +6 +4 −5 = +15 ✓
    const solo = findContact(tierFile(mergeDir, 2), "solo2024@clrctest.com.br");
    const dup = findContact(tierFile(mergeDir, 2), "duplicated@clrctest.com.br");
    assert.ok(solo && dup);
    const soloProb = parseInt(solo!.OPEN_PROBABILITY, 10);
    const dupProb = parseInt(dup!.OPEN_PROBABILITY, 10);
    assert.equal(dupProb - soloProb, 15, "Diff = 15 prova merge somou spend+pmt e aplicou delinquent");
  });
});
