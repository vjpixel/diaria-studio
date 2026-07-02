import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Papa from "papaparse";
import { main } from "../scripts/merge-clarice-subscribers.ts";

/**
 * Integration test (#1021, cohorts #2857 fase C): valida output end-to-end do
 * merge-clarice-subscribers.
 *
 * Fluxo:
 *   1. Cria temp dir
 *   2. Copia fixture CSV (15 contatos cobrindo os 10 cohorts da taxonomia + 3 exclusões)
 *   3. Roda main(tempDir)
 *   4. Verifica:
 *      - 10 CSVs gerados (1 por cohort — stripe-export-assinantes-ativos.csv ... leads-2022h1.csv)
 *      - excluded.csv com 3 entradas (dispute, role, disposable)
 *      - Schema do CSV de cohort (3 colunas exatas)
 *      - Counts batem com cohort expectativa
 *      - Idempotência (rodar 2x → mesmo output)
 *      - Cleanup de órfãos legacy + slug-drift
 */

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/clarice-fixtures/stripe-customers-fixture.csv");

// `now` fixo (não `new Date()`) — os fixtures têm datas hardcoded e as
// asserções de score/verify_risk/open_probability dependem de estarem numa
// janela de recência estável relativa a `now`. Sem isso, o teste vira flaky em
// virada de ano/mês (quebrou de fato às 2026-07-01 — #2724 CI incident).
// Cohort NÃO depende mais de `now` desde a fase C (deriva do período ABSOLUTO
// de `created`) — só score/verify_risk/open_probability ainda usam `now`.
const FIXED_NOW = new Date("2026-05-01T12:00:00Z");

/**
 * Os 10 cohorts que a fixture `stripe-customers-fixture.csv` cobre 1-a-1 (2
 * assinantes-ativos, 2 ex-assinantes, 8 leads em semestres distintos — nenhum
 * cai em `leads-caudao`, que desde a fase C só é alcançável via fallback de
 * `created` ausente, não mais por distância-em-semestres — ver `cohortOf`).
 */
const FIXTURE_COHORTS = [
  "assinantes-ativos",
  "ex-assinantes",
  "leads-2026h1",
  "leads-2025h2",
  "leads-2025h1",
  "leads-2024h2",
  "leads-2024h1",
  "leads-2023h2",
  "leads-2023h1",
  "leads-2022h1",
];

/** `stripe-export-{cohort}.csv` — nome DIRETO (#2857 fase C: sem prefixo t{NN}-). */
function cohortFile(cohort: string): string {
  return `stripe-export-${cohort}.csv`;
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
  it("gera 1 CSV por cohort (10) + excluded ao rodar main(tempDir)", () => {
    main(tmpDataDir, FIXED_NOW);

    for (const cohort of FIXTURE_COHORTS) {
      assert.ok(
        existsSync(join(tmpDataDir, cohortFile(cohort))),
        `Esperava arquivo do cohort ${cohort} no tempDir após main()`,
      );
    }
    assert.ok(
      existsSync(join(tmpDataDir, "stripe-export-excluded.csv")),
      "Esperava stripe-export-excluded.csv no tempDir após main()",
    );
  });

  it("schema dos CSVs de cohort é exatamente: email,NOME,OPEN_PROBABILITY", () => {
    for (const cohort of FIXTURE_COHORTS) {
      const filename = cohortFile(cohort);
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

  it("conta correta de contatos por cohort (fixture tem 1 contato em cada cohort de lead, exceto assinantes-ativos/ex-assinantes com 2)", () => {
    function count(filename: string): number {
      const content = readFileSync(join(tmpDataDir, filename), "utf8");
      const rows = Papa.parse(content, { header: true, skipEmptyLines: true }).data;
      return rows.length;
    }

    // assinantes-ativos tem 2 (active + trialing); ex-assinantes tem 2 (canceled+paid + unpaid+paid); leads têm 1 cada
    assert.equal(count(cohortFile("assinantes-ativos")), 2, "assinantes-ativos deve ter 2 contatos (active + trialing)");
    assert.equal(count(cohortFile("ex-assinantes")), 2, "ex-assinantes deve ter 2 contatos (canceled + unpaid, ambos paid)");
    assert.equal(count(cohortFile("leads-2026h1")), 1, "leads-2026h1 deve ter 1 contato");
    assert.equal(count(cohortFile("leads-2025h2")), 1, "leads-2025h2 deve ter 1");
    assert.equal(count(cohortFile("leads-2025h1")), 1, "leads-2025h1 deve ter 1");
    assert.equal(count(cohortFile("leads-2024h2")), 1, "leads-2024h2 deve ter 1");
    assert.equal(count(cohortFile("leads-2024h1")), 1, "leads-2024h1 deve ter 1");
    assert.equal(count(cohortFile("leads-2023h2")), 1, "leads-2023h2 deve ter 1");
    assert.equal(count(cohortFile("leads-2023h1")), 1, "leads-2023h1 deve ter 1");
    assert.equal(count(cohortFile("leads-2022h1")), 1, "leads-2022h1 deve ter 1 (NÃO caudão — cutover fase C: só created ausente vira caudão)");

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
    for (const cohort of FIXTURE_COHORTS) {
      const filename = cohortFile(cohort);
      beforeContent[filename] = readFileSync(join(tmpDataDir, filename), "utf8");
    }
    beforeContent["stripe-export-excluded.csv"] = readFileSync(
      join(tmpDataDir, "stripe-export-excluded.csv"),
      "utf8",
    );

    // Roda de novo
    main(tmpDataDir, FIXED_NOW);

    // Compara
    for (const [filename, content] of Object.entries(beforeContent)) {
      const after = readFileSync(join(tmpDataDir, filename), "utf8");
      assert.equal(after, content, `${filename} mudou após segunda execução (deveria ser idempotente)`);
    }
  });

  it("cleanup remove órfãos: legacy (kit-import-*, brevo-import-*) + formato numérico pré-#2857-fase-C + slug-drift atual (stripe-export-{cohort})", () => {
    // Cria órfãos artificiais
    writeFileSync(join(tmpDataDir, "kit-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "kit-import-excluded.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-tier2.csv"), "stale\n", "utf8");
    // Legado pré-stripe-export (#1965): slug com H maiúsculo + numérico puro.
    writeFileSync(join(tmpDataDir, "brevo-import-t04-leads-2099H1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "brevo-import-t05.csv"), "stale\n", "utf8");
    // Formato numérico pré-#2857-fase-C (t{NN}-slug) — migração one-time do cutover.
    writeFileSync(join(tmpDataDir, "stripe-export-t04-leads-2099H1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "stripe-export-t05.csv"), "stale\n", "utf8");
    // Formato atual (cohort): slug-drift de outro run (cohort que não existe mais) — deve sumir tb.
    writeFileSync(join(tmpDataDir, "stripe-export-leads-2099h1.csv"), "stale\n", "utf8");

    main(tmpDataDir, FIXED_NOW);

    // Devem ter sido removidos
    assert.equal(existsSync(join(tmpDataDir, "kit-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "kit-import-excluded.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier1.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-tier2.csv")), false);
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-t04-leads-2099H1.csv")), false, "legado: slug H maiúsculo deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "brevo-import-t05.csv")), false, "legado: numérico puro deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-t04-leads-2099H1.csv")), false, "formato numérico pré-fase-C deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-t05.csv")), false, "formato numérico pré-fase-C deve ser removido");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-leads-2099h1.csv")), false, "cohort slug-drift (não presente neste run) deve ser removido");

    // Over-deletion guard: o cleanup NÃO pode comer o input (stripe) nem o audit (excluded).
    assert.ok(existsSync(join(tmpDataDir, "stripe-customers-fixture.csv")), "input do Stripe não pode ser removido pelo cleanup");
    assert.ok(existsSync(join(tmpDataDir, "stripe-export-excluded.csv")), "excluded.csv (audit) não pode ser removido pelo cleanup");

    // Os cohorts da fixture e excluded continuam
    for (const cohort of FIXTURE_COHORTS) {
      const filename = cohortFile(cohort);
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
    // Copia 3 cohorts (fontes Stripe, não confundir com o cohort da #2857) pra
    // mesmo dataDir — script faz merge entre eles.
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
    main(mergeDir, FIXED_NOW);
  });

  after(() => {
    if (mergeDir) rmSync(mergeDir, { recursive: true, force: true });
  });

  function findContact(filename: string, email: string): { [k: string]: string } | undefined {
    const path = join(mergeDir, filename);
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, "utf8");
    const rows = Papa.parse<{ [k: string]: string }>(content, {
      header: true,
      skipEmptyLines: true,
    }).data;
    return rows.find((r) => r.email === email);
  }

  it("contato duplicado em 3 fontes Stripe: stripe_ids agregados (audit trail)", () => {
    // duplicated@clrctest.com.br aparece em cohort1 (cus_c1a), cohort2 (cus_c2a), cohort3 (cus_c3a)
    // Merge: status="canceled" (vence unpaid, que não está no rank map) →
    // payment_count somado=7>0 → cohort "ex-assinantes".
    const found = findContact(cohortFile("ex-assinantes"), "duplicated@clrctest.com.br");
    assert.ok(found, "duplicated@clrctest.com.br deveria estar em ex-assinantes");
    // Schema CSV minimal não inclui stripe_ids. Validamos que o email aparece
    // em EXATAMENTE 1 cohort (mergeado, não triplicado).
    let totalAppearances = 0;
    for (const cohort of FIXTURE_COHORTS_CROSS) {
      if (findContact(cohortFile(cohort), "duplicated@clrctest.com.br")) totalAppearances++;
    }
    assert.equal(totalAppearances, 1, "Email duplicado deve aparecer em EXATAMENTE 1 cohort (mergeado)");
  });

  it("duplicated: NOME do registro mais recente vence (cohort3, 2026)", () => {
    // cohort1: "Old Name", cohort2: "New Name 2024", cohort3: "Newest Name 2026"
    // Merge usa created mais recente — cohort3 vence
    const found = findContact(cohortFile("ex-assinantes"), "duplicated@clrctest.com.br");
    assert.ok(found);
    // first_name = primeira palavra do name; "Newest Name 2026" → "Newest"
    assert.equal(found!.NOME, "Newest");
  });

  it("duplicated: paid (spend > 0) é detectado mesmo se o último cohort Stripe não tiver pagamento — vai pra ex-assinantes", () => {
    // duplicated tem total_spend = 200 + 100 + 50 = 350 (somado).
    // Vai pra ex-assinantes — não é active hoje.
    const found = findContact(cohortFile("ex-assinantes"), "duplicated@clrctest.com.br");
    assert.ok(found, "duplicated deveria estar em ex-assinantes (paid alguma vez, não active hoje)");
  });

  it("delinquent@: status active de cohort2 vence canceled de cohort1 → vai pra assinantes-ativos", () => {
    // cohort1: canceled / cohort2: active. Merge mantém active.
    const found = findContact(cohortFile("assinantes-ativos"), "delinquent@clrctest.com.br");
    assert.ok(found, "delinquent@ deveria estar em assinantes-ativos após status='active' vencer");
  });

  it("solo (1 fonte Stripe apenas) é tratado normalmente", () => {
    const solo2023 = findContact(cohortFile("ex-assinantes"), "solo2023a@clrctest.com.br");
    assert.ok(solo2023, "solo2023a deveria estar em ex-assinantes (paid, antigo, não active)");

    const fresh2026 = findContact(cohortFile("leads-2026h1"), "fresh2026@clrctest.com.br");
    assert.ok(fresh2026, "fresh2026 deveria estar em leads-2026h1 (never paid, created 2026-03)");
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
    const duplicated = findContact(cohortFile("ex-assinantes"), "duplicated@clrctest.com.br");
    assert.ok(duplicated, "duplicated deveria estar em ex-assinantes");
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
    const solo = findContact(cohortFile("ex-assinantes"), "solo2024@clrctest.com.br");
    const dup = findContact(cohortFile("ex-assinantes"), "duplicated@clrctest.com.br");
    assert.ok(solo && dup);
    const soloProb = parseInt(solo!.OPEN_PROBABILITY, 10);
    const dupProb = parseInt(dup!.OPEN_PROBABILITY, 10);
    assert.equal(dupProb - soloProb, 15, "Diff = 15 prova merge somou spend+pmt e aplicou delinquent");
  });
});

/** Cohorts alcançáveis pela fixture cross-CSV (subset — só os relevantes pro teste de dedup). */
const FIXTURE_COHORTS_CROSS = ["assinantes-ativos", "ex-assinantes", "leads-2026h1", "leads-2025h1"];

// ─── Regressão: main() propaga `now` até o cálculo de score/probability (#2724 CI incident) ─
//
// #2857 fase C: `cohort` deixou de depender de `now` (deriva do período
// ABSOLUTO de `created` — motivo original da fase B.1: o rótulo estático
// desalinhava do created real a cada virada de semestre). A regressão original
// media isso via o TIER do fresh2026 mudando entre 2 chamadas de `now`; agora
// mede via OPEN_PROBABILITY (que ainda depende de `now` — ver `openProbability`
// em merge-clarice-subscribers.ts), sobre o MESMO arquivo de cohort
// (leads-2026h1, idêntico nas 2 rodadas — prova em si que cohort não mudou).

describe("merge-clarice: main() respeita `now` explícito (não reintroduz new Date() interno)", () => {
  const COHORTS_DIR = resolve(import.meta.dirname, "fixtures/clarice-fixtures");

  function findContactIn(dir: string, filename: string, email: string): { [k: string]: string } | undefined {
    const content = readFileSync(join(dir, filename), "utf8");
    const rows = Papa.parse<{ [k: string]: string }>(content, {
      header: true,
      skipEmptyLines: true,
    }).data;
    return rows.find((r) => r.email === email);
  }

  it("mesmo fixture, `now` em janelas de recência diferentes → OPEN_PROBABILITY diferente p/ fresh2026 (cohort continua o mesmo)", () => {
    // fresh2026 (cohort3) criado em 2026-03-15, nunca pagou: openProbability
    // base=12 + modificador de recência. Com `now` ~1.5 meses depois (<12mo),
    // +12 (total 24). Com `now` ~14.5 meses depois (12-24mo), +6 (total 18).
    // Se um refactor futuro voltar a ignorar o parâmetro `now` (reintroduzindo
    // `new Date()` interno), as duas rodadas dariam o MESMO valor (o do
    // relógio real da máquina rodando o teste) e esta asserção pegaria.
    const dirNear = mkdtempSync(join(tmpdir(), "merge-now-near-"));
    const dirFar = mkdtempSync(join(tmpdir(), "merge-now-far-"));
    try {
      copyFileSync(
        join(COHORTS_DIR, "stripe-fixture-cohort3-2026.csv"),
        join(dirNear, "stripe-cohort3.csv"),
      );
      copyFileSync(
        join(COHORTS_DIR, "stripe-fixture-cohort3-2026.csv"),
        join(dirFar, "stripe-cohort3.csv"),
      );

      main(dirNear, new Date("2026-05-01T12:00:00Z")); // ~1.5mo depois → recency <12mo
      main(dirFar, new Date("2027-06-01T12:00:00Z")); // ~14.5mo depois → recency 12-24mo

      // Cohort é o MESMO nas duas rodadas (não depende de `now`) — mesmo
      // nome de arquivo nos dois dirs, prova a independência de `now`.
      const inNear = findContactIn(dirNear, cohortFile("leads-2026h1"), "fresh2026@clrctest.com.br");
      const inFar = findContactIn(dirFar, cohortFile("leads-2026h1"), "fresh2026@clrctest.com.br");
      assert.ok(inNear, "fresh2026 deveria estar em leads-2026h1 com now próximo");
      assert.ok(inFar, "fresh2026 deveria estar em leads-2026h1 com now distante — cohort NÃO muda com now (fase C)");

      // OPEN_PROBABILITY prova que `now` foi de fato propagado pro cálculo de
      // score/probability (que continuam now-dependentes).
      assert.equal(inNear!.OPEN_PROBABILITY, "24", "recency <12mo → 12 base + 12");
      assert.equal(inFar!.OPEN_PROBABILITY, "18", "recency 12-24mo → 12 base + 6 — prova que `now` foi propagado, não ignorado");
    } finally {
      rmSync(dirNear, { recursive: true, force: true });
      rmSync(dirFar, { recursive: true, force: true });
    }
  });
});
