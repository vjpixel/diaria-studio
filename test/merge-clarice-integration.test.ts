import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import Papa from "papaparse";
import { main, buildUniverse, type Scored } from "../scripts/merge-clarice-subscribers.ts";

/**
 * Integration test (#1021, cohorts #2857 fase C, CSV-as-source eliminado
 * #2886 PR4): valida o pipeline read→merge→filter→score→cohort de
 * merge-clarice-subscribers end-to-end.
 *
 * Desde #2886 PR4, `main()` NÃO escreve mais 1 CSV por cohort — o universo
 * pontuado/classificado é validado aqui via `buildUniverse()` (a mesma função
 * que alimenta o store único, `scripts/clarice-build-db.ts`). `main()`
 * continua escrevendo só `stripe-export-excluded.csv` (audit trail distinto,
 * mantido) + fazendo cleanup de outputs órfãos de runs antigos.
 *
 * Fluxo:
 *   1. Cria temp dir
 *   2. Copia fixture CSV (15 contatos cobrindo os 10 cohorts da taxonomia + 3 exclusões)
 *   3. Roda buildUniverse(tempDir) e/ou main(tempDir)
 *   4. Verifica:
 *      - buildUniverse classifica os 10 cohorts corretamente (kept)
 *      - excluded.csv com 3 entradas (dispute, role, disposable)
 *      - main() NÃO escreve mais stripe-export-{cohort}.csv (write side morto)
 *      - Idempotência (rodar 2x → mesmo universo)
 *      - Cleanup de órfãos legacy + slug-drift (incl. stripe-export-{cohort}
 *        de runs ANTIGOS, que agora são sempre órfãos)
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

/** Filtra o `kept` de um `buildUniverse()` pelos contatos de 1 cohort. */
function byCohort(kept: Scored[], cohort: string): Scored[] {
  return kept.filter((r) => r.cohort === cohort);
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

describe("merge-clarice integration: buildUniverse classifica os 10 cohorts + main() escreve só o audit trail", () => {
  it("buildUniverse classifica todos os 10 cohorts da fixture", () => {
    const { kept } = buildUniverse(tmpDataDir, FIXED_NOW);

    for (const cohort of FIXTURE_COHORTS) {
      assert.ok(
        byCohort(kept, cohort).length > 0,
        `Esperava pelo menos 1 contato no cohort ${cohort}`,
      );
    }
  });

  it("conta correta de contatos por cohort (fixture tem 1 contato em cada cohort de lead, exceto assinantes-ativos/ex-assinantes com 2)", () => {
    const { kept } = buildUniverse(tmpDataDir, FIXED_NOW);

    // assinantes-ativos tem 2 (active + trialing); ex-assinantes tem 2 (canceled+paid + unpaid+paid); leads têm 1 cada
    assert.equal(byCohort(kept, "assinantes-ativos").length, 2, "assinantes-ativos deve ter 2 contatos (active + trialing)");
    assert.equal(byCohort(kept, "ex-assinantes").length, 2, "ex-assinantes deve ter 2 contatos (canceled + unpaid, ambos paid)");
    assert.equal(byCohort(kept, "leads-2026h1").length, 1, "leads-2026h1 deve ter 1 contato");
    assert.equal(byCohort(kept, "leads-2025h2").length, 1, "leads-2025h2 deve ter 1");
    assert.equal(byCohort(kept, "leads-2025h1").length, 1, "leads-2025h1 deve ter 1");
    assert.equal(byCohort(kept, "leads-2024h2").length, 1, "leads-2024h2 deve ter 1");
    assert.equal(byCohort(kept, "leads-2024h1").length, 1, "leads-2024h1 deve ter 1");
    assert.equal(byCohort(kept, "leads-2023h2").length, 1, "leads-2023h2 deve ter 1");
    assert.equal(byCohort(kept, "leads-2023h1").length, 1, "leads-2023h1 deve ter 1");
    assert.equal(byCohort(kept, "leads-2022h1").length, 1, "leads-2022h1 deve ter 1 (NÃO caudão — cutover fase C: só created ausente vira caudão)");
  });

  it("main() escreve stripe-export-excluded.csv com 3 entradas (dispute, role, disposable) e NADA MAIS de stripe-export-*", () => {
    main(tmpDataDir, FIXED_NOW);

    assert.ok(
      existsSync(join(tmpDataDir, "stripe-export-excluded.csv")),
      "Esperava stripe-export-excluded.csv no tempDir após main()",
    );

    const content = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
    const rows = Papa.parse(content, { header: true, skipEmptyLines: true }).data;
    assert.equal(rows.length, 3, "Excluded deve ter 3 (dispute + role + disposable)");

    // #2886 PR4: main() não escreve mais 1 CSV por cohort — write side morto.
    for (const cohort of FIXTURE_COHORTS) {
      assert.equal(
        existsSync(join(tmpDataDir, `stripe-export-${cohort}.csv`)),
        false,
        `main() não deve mais escrever stripe-export-${cohort}.csv (write side eliminado em #2886 PR4)`,
      );
    }
  });

  it("schema do excluded.csv tem coluna `reason`", () => {
    const content = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
    const firstLine = content.split("\n")[0];
    assert.match(firstLine, /reason/, "excluded.csv deve ter coluna `reason`");
    assert.match(firstLine, /email/, "excluded.csv deve ter coluna `email`");
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

  it("idempotência: rodar main() 2x produz exatamente o mesmo excluded.csv, e buildUniverse() 2x produz o mesmo universo", () => {
    const before = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
    const { kept: keptBefore } = buildUniverse(tmpDataDir, FIXED_NOW);

    // Roda de novo
    main(tmpDataDir, FIXED_NOW);

    const after = readFileSync(join(tmpDataDir, "stripe-export-excluded.csv"), "utf8");
    assert.equal(after, before, "stripe-export-excluded.csv mudou após segunda execução (deveria ser idempotente)");

    const { kept: keptAfter } = buildUniverse(tmpDataDir, FIXED_NOW);
    const normalize = (rows: Scored[]) =>
      rows
        .map((r) => `${r.email}|${r.cohort}|${r.open_probability}`)
        .sort();
    assert.deepEqual(
      normalize(keptAfter),
      normalize(keptBefore),
      "buildUniverse() deveria produzir o mesmo universo (email/cohort/open_probability) em rodadas repetidas",
    );
  });

  it("cleanup remove órfãos: legacy (kit-import-*, brevo-import-*) + formato numérico pré-#2857-fase-C + stripe-export-{cohort} (sempre órfão desde #2886 PR4)", () => {
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
    // Formato de cohort (atual) — desde #2886 PR4, main() nunca escreve isso,
    // então qualquer arquivo assim é SEMPRE de um run antigo → sempre órfão.
    writeFileSync(join(tmpDataDir, "stripe-export-leads-2099h1.csv"), "stale\n", "utf8");
    writeFileSync(join(tmpDataDir, "stripe-export-assinantes-ativos.csv"), "stale\n", "utf8");

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
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-leads-2099h1.csv")), false, "cohort não-mais-escrito deve ser removido (sempre órfão pós-#2886 PR4)");
    assert.equal(existsSync(join(tmpDataDir, "stripe-export-assinantes-ativos.csv")), false, "cohort não-mais-escrito deve ser removido (sempre órfão pós-#2886 PR4)");

    // Over-deletion guard: o cleanup NÃO pode comer o input (stripe) nem o audit (excluded).
    assert.ok(existsSync(join(tmpDataDir, "stripe-customers-fixture.csv")), "input do Stripe não pode ser removido pelo cleanup");
    assert.ok(existsSync(join(tmpDataDir, "stripe-export-excluded.csv")), "excluded.csv (audit) não pode ser removido pelo cleanup");
  });
});

// ─── Cross-CSV merge invariants (#1027) ────────────────────────────────────

describe("merge-clarice: invariantes de merge cross-CSV", () => {
  const COHORTS_DIR = resolve(import.meta.dirname, "fixtures/clarice-fixtures");
  let mergeDir: string;
  let universe: ReturnType<typeof buildUniverse>;

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
    universe = buildUniverse(mergeDir, FIXED_NOW);
  });

  after(() => {
    if (mergeDir) rmSync(mergeDir, { recursive: true, force: true });
  });

  function findContact(cohort: string, email: string): Scored | undefined {
    return byCohort(universe.kept, cohort).find((r) => r.email === email);
  }

  it("contato duplicado em 3 fontes Stripe: aparece em EXATAMENTE 1 cohort (mergeado, não triplicado)", () => {
    // duplicated@clrctest.com.br aparece em cohort1 (cus_c1a), cohort2 (cus_c2a), cohort3 (cus_c3a)
    // Merge: status="canceled" (vence unpaid, que não está no rank map) →
    // payment_count somado=7>0 → cohort "ex-assinantes".
    const found = findContact("ex-assinantes", "duplicated@clrctest.com.br");
    assert.ok(found, "duplicated@clrctest.com.br deveria estar em ex-assinantes");
    let totalAppearances = 0;
    for (const cohort of FIXTURE_COHORTS_CROSS) {
      if (findContact(cohort, "duplicated@clrctest.com.br")) totalAppearances++;
    }
    assert.equal(totalAppearances, 1, "Email duplicado deve aparecer em EXATAMENTE 1 cohort (mergeado)");
  });

  it("duplicated: nome do registro mais recente vence (cohort3, 2026)", () => {
    // cohort1: "Old Name", cohort2: "New Name 2024", cohort3: "Newest Name 2026"
    // Merge usa created mais recente — cohort3 vence
    const found = findContact("ex-assinantes", "duplicated@clrctest.com.br");
    assert.ok(found);
    assert.equal(found!.name, "Newest Name 2026");
  });

  it("duplicated: paid (spend > 0) é detectado mesmo se o último cohort Stripe não tiver pagamento — vai pra ex-assinantes", () => {
    // duplicated tem total_spend = 200 + 100 + 50 = 350 (somado).
    // Vai pra ex-assinantes — não é active hoje.
    const found = findContact("ex-assinantes", "duplicated@clrctest.com.br");
    assert.ok(found, "duplicated deveria estar em ex-assinantes (paid alguma vez, não active hoje)");
    assert.equal(found!.total_spend, 350);
  });

  it("delinquent@: status active de cohort2 vence canceled de cohort1 → vai pra assinantes-ativos", () => {
    // cohort1: canceled / cohort2: active. Merge mantém active.
    const found = findContact("assinantes-ativos", "delinquent@clrctest.com.br");
    assert.ok(found, "delinquent@ deveria estar em assinantes-ativos após status='active' vencer");
  });

  it("solo (1 fonte Stripe apenas) é tratado normalmente", () => {
    const solo2023 = findContact("ex-assinantes", "solo2023a@clrctest.com.br");
    assert.ok(solo2023, "solo2023a deveria estar em ex-assinantes (paid, antigo, não active)");

    const fresh2026 = findContact("leads-2026h1", "fresh2026@clrctest.com.br");
    assert.ok(fresh2026, "fresh2026 deveria estar em leads-2026h1 (never paid, created 2026-03)");
  });

  it("duplicated: open_probability reflete merge correto (payment_count somado + delinquent OR)", () => {
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
    const duplicated = findContact("ex-assinantes", "duplicated@clrctest.com.br");
    assert.ok(duplicated, "duplicated deveria estar em ex-assinantes");
    assert.equal(
      duplicated!.open_probability,
      48,
      "OPEN_PROB=48 lock-in reflete merge: spend+pmt somados, delinquent OR, recency cohort3",
    );
  });

  it("solo2024 vs duplicated: open_probability mostra impacto de delinquent + payment_count", () => {
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
    const solo = findContact("ex-assinantes", "solo2024@clrctest.com.br");
    const dup = findContact("ex-assinantes", "duplicated@clrctest.com.br");
    assert.ok(solo && dup);
    assert.equal(dup!.open_probability - solo!.open_probability, 15, "Diff = 15 prova merge somou spend+pmt e aplicou delinquent");
  });
});

/** Cohorts alcançáveis pela fixture cross-CSV (subset — só os relevantes pro teste de dedup). */
const FIXTURE_COHORTS_CROSS = ["assinantes-ativos", "ex-assinantes", "leads-2026h1", "leads-2025h1"];

// ─── Regressão: main()/buildUniverse propagam `now` até o cálculo de score/probability (#2724 CI incident) ─
//
// #2857 fase C: `cohort` deixou de depender de `now` (deriva do período
// ABSOLUTO de `created` — motivo original da fase B.1: o rótulo estático
// desalinhava do created real a cada virada de semestre). A regressão original
// media isso via o TIER do fresh2026 mudando entre 2 chamadas de `now`; agora
// mede via open_probability (que ainda depende de `now` — ver
// `openProbability` em merge-clarice-subscribers.ts), sobre o MESMO cohort
// (leads-2026h1, idêntico nas 2 rodadas — prova em si que cohort não mudou).

describe("merge-clarice: buildUniverse() respeita `now` explícito (não reintroduz new Date() interno)", () => {
  const COHORTS_DIR = resolve(import.meta.dirname, "fixtures/clarice-fixtures");

  it("mesmo fixture, `now` em janelas de recência diferentes → open_probability diferente p/ fresh2026 (cohort continua o mesmo)", () => {
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

      const { kept: keptNear } = buildUniverse(dirNear, new Date("2026-05-01T12:00:00Z")); // ~1.5mo depois → recency <12mo
      const { kept: keptFar } = buildUniverse(dirFar, new Date("2027-06-01T12:00:00Z")); // ~14.5mo depois → recency 12-24mo

      // Cohort é o MESMO nas duas rodadas (não depende de `now`).
      const inNear = byCohort(keptNear, "leads-2026h1").find((r) => r.email === "fresh2026@clrctest.com.br");
      const inFar = byCohort(keptFar, "leads-2026h1").find((r) => r.email === "fresh2026@clrctest.com.br");
      assert.ok(inNear, "fresh2026 deveria estar em leads-2026h1 com now próximo");
      assert.ok(inFar, "fresh2026 deveria estar em leads-2026h1 com now distante — cohort NÃO muda com now (fase C)");

      // open_probability prova que `now` foi de fato propagado pro cálculo de
      // score/probability (que continuam now-dependentes).
      assert.equal(inNear!.open_probability, 24, "recency <12mo → 12 base + 12");
      assert.equal(inFar!.open_probability, 18, "recency 12-24mo → 12 base + 6 — prova que `now` foi propagado, não ignorado");
    } finally {
      rmSync(dirNear, { recursive: true, force: true });
      rmSync(dirFar, { recursive: true, force: true });
    }
  });
});
