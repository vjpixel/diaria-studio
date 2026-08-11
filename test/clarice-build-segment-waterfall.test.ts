/**
 * Testes do modo `--tiers` (waterfall multi-tier, #4979) — generaliza o
 * script one-off `clarice-build-wave-260812-especial.ts` (nunca commitado,
 * decisão do editor #4979: "vira feature — implementar") pra uma composição
 * declarativa (JSON) sobre `clarice-build-segment.ts`.
 *
 * Duas camadas, mesmo padrão dos irmãos (`clarice-segment.test.ts`,
 * `clarice-build-segment-hold.test.ts`):
 *   1. Unitários PUROS dos helpers novos em `clarice-segment.ts`
 *      (`matchesWaterfallTier`/`orderWaterfallTier`/`buildWaterfallSelection`/
 *      `validateWaterfallTiers`).
 *   2. Integração via `main()` de `clarice-build-segment.ts`, contra um store
 *      SQLite temporário — exercita o caminho real argv → CSV escrito, os
 *      guards (dedup por ciclo, recência, campanha comprometida, `--hold`) e
 *      as validações de CLI (mutual exclusão com --group, --key obrigatório,
 *      --cohort/--min-score incompatíveis, --exact-budget).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  matchesWaterfallTier,
  orderWaterfallTier,
  buildWaterfallSelection,
  validateWaterfallTiers,
  type WaterfallTierSpec,
  type StoreRow,
} from "../scripts/lib/clarice-segment.ts";
import { main } from "../scripts/clarice-build-segment.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

function mkRow(overrides: Partial<StoreRow> & { email: string }): StoreRow {
  return {
    tier: null,
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    cohort: null,
    created: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unitários — matchesWaterfallTier
// ---------------------------------------------------------------------------

test("matchesWaterfallTier: eixo omitido sempre casa", () => {
  const r = mkRow({ email: "a@gmail.com", cohort: "leads-2026-08", priority_points: 5 });
  assert.equal(matchesWaterfallTier(r, {}), true);
});

test("matchesWaterfallTier: juridico true/false", () => {
  const jur = mkRow({ email: "adv@escritorio.adv.br" });
  const comum = mkRow({ email: "comum@gmail.com" });
  assert.equal(matchesWaterfallTier(jur, { juridico: true }), true);
  assert.equal(matchesWaterfallTier(comum, { juridico: true }), false);
  assert.equal(matchesWaterfallTier(jur, { juridico: false }), false);
  assert.equal(matchesWaterfallTier(comum, { juridico: false }), true);
});

test("matchesWaterfallTier: cohort exato", () => {
  const r = mkRow({ email: "a@gmail.com", cohort: "leads-2026-08" });
  assert.equal(matchesWaterfallTier(r, { cohort: "leads-2026-08" }), true);
  assert.equal(matchesWaterfallTier(r, { cohort: "leads-2026-07" }), false);
  assert.equal(matchesWaterfallTier(mkRow({ email: "b@gmail.com", cohort: null }), { cohort: "leads-2026-08" }), false);
});

test("matchesWaterfallTier: score positive/zero", () => {
  const zero = mkRow({ email: "z@gmail.com", priority_points: 0 });
  const pos = mkRow({ email: "p@gmail.com", priority_points: 5 });
  assert.equal(matchesWaterfallTier(zero, { score: "zero" }), true);
  assert.equal(matchesWaterfallTier(zero, { score: "positive" }), false);
  assert.equal(matchesWaterfallTier(pos, { score: "positive" }), true);
  assert.equal(matchesWaterfallTier(pos, { score: "zero" }), false);
});

test("matchesWaterfallTier: eixos combinados (AND)", () => {
  const r = mkRow({ email: "adv@escritorio.adv.br", cohort: "leads-2026-08", priority_points: 0 });
  assert.equal(matchesWaterfallTier(r, { juridico: true, cohort: "leads-2026-08", score: "zero" }), true);
  assert.equal(matchesWaterfallTier(r, { juridico: false, cohort: "leads-2026-08", score: "zero" }), false);
});

// ---------------------------------------------------------------------------
// Unitários — orderWaterfallTier
// ---------------------------------------------------------------------------

test("orderWaterfallTier default: priority_points DESC, email ASC desempata", () => {
  const rows = [
    mkRow({ email: "b@gmail.com", priority_points: 5 }),
    mkRow({ email: "a@gmail.com", priority_points: 5 }),
    mkRow({ email: "c@gmail.com", priority_points: 10 }),
  ];
  const ordered = orderWaterfallTier(rows);
  assert.deepEqual(ordered.map((r) => r.email), ["c@gmail.com", "a@gmail.com", "b@gmail.com"]);
});

test("orderWaterfallTier created_desc: mais recente primeiro, email ASC desempata", () => {
  const rows = [
    mkRow({ email: "old@gmail.com", created: "2024-01-01" }),
    mkRow({ email: "new@gmail.com", created: "2024-06-01" }),
    mkRow({ email: "mid@gmail.com", created: "2024-03-01" }),
    mkRow({ email: "sem-data@gmail.com", created: null }),
  ];
  const ordered = orderWaterfallTier(rows, "created_desc");
  assert.deepEqual(
    ordered.map((r) => r.email),
    ["new@gmail.com", "mid@gmail.com", "old@gmail.com", "sem-data@gmail.com"],
  );
});

// ---------------------------------------------------------------------------
// Unitários — buildWaterfallSelection
// ---------------------------------------------------------------------------

test("buildWaterfallSelection: waterfall respeita a ORDEM dos tiers e o budget COMPARTILHADO", () => {
  const rows = [
    mkRow({ email: "jur1@escritorio.adv.br", priority_points: 100 }),
    mkRow({ email: "jur2@escritorio.adv.br", priority_points: 50 }),
    mkRow({ email: "comum1@gmail.com", priority_points: 30 }),
    mkRow({ email: "comum2@gmail.com", priority_points: 10 }),
  ];
  const tiers: WaterfallTierSpec[] = [
    { name: "juridico", juridico: true },
    { name: "outros", juridico: false },
  ];
  const result = buildWaterfallSelection(rows, tiers, 3);
  assert.equal(result.totalSelected, 3);
  assert.deepEqual(
    result.selected.map((r) => r.email),
    ["jur1@escritorio.adv.br", "jur2@escritorio.adv.br", "comum1@gmail.com"],
  );
  assert.deepEqual(result.tierStats, [
    { name: "juridico", available: 2, taken: 2 },
    { name: "outros", available: 2, taken: 1 },
  ]);
});

test("buildWaterfallSelection: budget<=0 = sem teto, cada tier entra inteiro", () => {
  const rows = [mkRow({ email: "a@gmail.com" }), mkRow({ email: "b@gmail.com" })];
  const tiers: WaterfallTierSpec[] = [{ name: "t1", juridico: false }];
  const result = buildWaterfallSelection(rows, tiers, 0);
  assert.equal(result.totalSelected, 2);
  assert.deepEqual(result.tierStats, [{ name: "t1", available: 2, taken: 2 }]);
});

test("buildWaterfallSelection: contato que casaria 2 tiers NUNCA é contado 2× (dedup defensivo)", () => {
  const rows = [mkRow({ email: "a@gmail.com", cohort: "leads-2026-08", priority_points: 0 })];
  const tiers: WaterfallTierSpec[] = [
    { name: "t1", cohort: "leads-2026-08" },
    { name: "t2", score: "zero" }, // também casaria 'a' se não fosse o dedup
  ];
  const result = buildWaterfallSelection(rows, tiers, 0);
  assert.equal(result.totalSelected, 1);
  assert.deepEqual(result.tierStats, [
    { name: "t1", available: 1, taken: 1 },
    { name: "t2", available: 1, taken: 0 },
  ]);
});

test("buildWaterfallSelection: budget exaurido nos tiers de cima zera os de baixo", () => {
  const rows = [
    mkRow({ email: "a@gmail.com", priority_points: 10 }),
    mkRow({ email: "b@gmail.com", priority_points: 5 }),
    mkRow({ email: "c@gmail.com", priority_points: 0 }),
  ];
  const tiers: WaterfallTierSpec[] = [
    { name: "top", score: "positive" },
    { name: "bottom", score: "zero" },
  ];
  const result = buildWaterfallSelection(rows, tiers, 2);
  assert.equal(result.totalSelected, 2);
  assert.deepEqual(result.tierStats, [
    { name: "top", available: 2, taken: 2 },
    { name: "bottom", available: 1, taken: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// Unitários — validateWaterfallTiers
// ---------------------------------------------------------------------------

test("validateWaterfallTiers: aceita plano válido", () => {
  const specs = validateWaterfallTiers([
    { name: "t1", juridico: true },
    { name: "t2", cohort: "leads-2026-08", score: "zero", orderBy: "created_desc" },
  ]);
  assert.equal(specs.length, 2);
  assert.equal(specs[1].orderBy, "created_desc");
});

test("validateWaterfallTiers: rejeita array vazio / não-array", () => {
  assert.throws(() => validateWaterfallTiers([]));
  assert.throws(() => validateWaterfallTiers(undefined));
  assert.throws(() => validateWaterfallTiers({}));
});

test("validateWaterfallTiers: rejeita nome ausente ou duplicado", () => {
  assert.throws(() => validateWaterfallTiers([{ juridico: true }]));
  assert.throws(() => validateWaterfallTiers([{ name: "t1" }, { name: "t1" }]));
});

test("validateWaterfallTiers: rejeita eixos com tipo/valor errado", () => {
  assert.throws(() => validateWaterfallTiers([{ name: "t1", juridico: "sim" }]));
  assert.throws(() => validateWaterfallTiers([{ name: "t1", cohort: 123 }]));
  assert.throws(() => validateWaterfallTiers([{ name: "t1", score: "positivo" }]));
  assert.throws(() => validateWaterfallTiers([{ name: "t1", orderBy: "asc" }]));
});

// ---------------------------------------------------------------------------
// Integração — `main()` (argv → CSV escrito), mesmo harness de
// clarice-build-segment-hold.test.ts / clarice-build-segment-cohort-recency.test.ts
// ---------------------------------------------------------------------------

async function captureLogs(fn: () => void | Promise<void>): Promise<string[]> {
  const linhas: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void linhas.push(a.join(" "));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return linhas;
}

async function captureExit(fn: () => void | Promise<void>): Promise<number | null> {
  const real = process.exit;
  let code: number | null = null;
  // @ts-expect-error — substituição deliberada só durante o teste.
  process.exit = (c?: number) => {
    code = c ?? 0;
    throw new Error("__exit__");
  };
  const err = console.error;
  console.error = () => {};
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    process.exit = real;
    console.error = err;
  }
  return code;
}

async function semBrevoKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.BREVO_CLARICE_API_KEY = prev;
  }
}

async function comBrevoFake<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ campaigns: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }
}

const emailsDoCsv = (csv: string): string[] =>
  csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(",")[0]);

/**
 * Store espelhando (em miniatura) a composição real do one-off #4979: 2
 * jurídicos (priority_points diferente, testa ordem DENTRO do tier), 1
 * engajado não-jurídico, 2 `assinantes-ativos` score 0, 3 `leads-2026-08`
 * score 0 (testa o corte de budget DENTRO de um tier). Universo total: 8.
 */
function storeParaWaterfall(dir: string): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    "INSERT INTO clarice_users (email, name, cohort, priority_points, sends_count) VALUES (?,?,?,?,0)",
  );
  ins.run("jur1@escritorio.adv.br", "Jur1", null, 50);
  ins.run("jur2@escritorio.adv.br", "Jur2", null, 10);
  ins.run("eng1@gmail.com", "Eng1", "leads-2026-07", 20);
  ins.run("ativo1@gmail.com", "Ativo1", "assinantes-ativos", 0);
  ins.run("ativo2@gmail.com", "Ativo2", "assinantes-ativos", 0);
  ins.run("ago1@gmail.com", "Ago1", "leads-2026-08", 0);
  ins.run("ago2@gmail.com", "Ago2", "leads-2026-08", 0);
  ins.run("ago3@gmail.com", "Ago3", "leads-2026-08", 0);
  db.close();
  return dbPath;
}

function writeTiersPlan(dir: string): string {
  const file = resolve(dir, "tiers.json");
  writeFileSync(
    file,
    JSON.stringify({
      tiers: [
        { name: "juridico", juridico: true },
        { name: "outros_engajados", juridico: false, score: "positive" },
        { name: "ativos_score0", juridico: false, cohort: "assinantes-ativos", score: "zero" },
        { name: "ago26_score0", juridico: false, cohort: "leads-2026-08", score: "zero" },
      ],
    }),
    "utf8",
  );
  return file;
}

test("main --tiers: waterfall respeita ordem + corta por budget DENTRO de um tier", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "d12-especial", "--budget", "6", "--dry-run",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.mode, "waterfall-tiers");
  assert.equal(out.tiers_key, "d12-especial");
  assert.equal(out.selected, 6);
  assert.deepEqual(out.tier_stats, [
    { name: "juridico", available: 2, taken: 2 },
    { name: "outros_engajados", available: 1, taken: 1 },
    { name: "ativos_score0", available: 2, taken: 2 },
    { name: "ago26_score0", available: 3, taken: 1 },
  ]);
});

test("main --tiers (escrita real): CSV em disco tem os emails certos, na ordem do waterfall", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-write-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "d12-especial", "--budget", "6",
      ]),
    ),
  );

  const csv = readFileSync(resolve(clariceSegmentsDir("2607-08", dir), "d12-especial.csv"), "utf8");
  assert.deepEqual(emailsDoCsv(csv), [
    "jur1@escritorio.adv.br",
    "jur2@escritorio.adv.br",
    "eng1@gmail.com",
    "ativo1@gmail.com",
    "ativo2@gmail.com",
    "ago1@gmail.com",
  ]);

  const manifest = JSON.parse(
    readFileSync(resolve(clariceSegmentsDir("2607-08", dir), "d12-especial-manifest.json"), "utf8"),
  );
  assert.equal(manifest[0].count, 6);
  assert.equal(manifest[0].key, "d12-especial");
});

test("main --tiers: guard de dedup por ciclo (#3227) exclui quem já foi selecionado (mesmo por outro --key)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-dedup-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "primeira-onda", "--budget", "6",
      ]),
    ),
  );

  const logs2 = await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "segunda-onda",
      ]),
    ),
  );
  const out2 = JSON.parse(logs2.join("\n"));
  // universo total 8, 6 já tomados pela 1ª invocação — sobram 2 (os 2 ago26 restantes).
  assert.equal(out2.already_sent_or_queued, 6);
  assert.equal(out2.selected, 2);
});

test("main --tiers + --hold juridico: reserva se aplica ANTES do waterfall (guards compostos)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-hold-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "d12-sem-jur", "--dry-run", "--hold", "juridico",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.hold, "juridico");
  assert.equal(out.held_in_universe, 2);
  // tier 'juridico' fica vazio — a reserva já tirou os 2 jurídicos do universo
  // antes do waterfall ver qualquer tier.
  assert.deepEqual(out.tier_stats[0], { name: "juridico", available: 0, taken: 0 });
  assert.equal(out.selected, 6, "os 6 não-jurídicos do universo (1 eng + 2 ativos + 3 ago26) seguem elegíveis");
});

test("main --tiers --exact-budget: aborta sem escrever se o total não fechar o budget pedido", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-exact-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", tiersFile, "--key", "d12-exato", "--budget", "999", "--exact-budget", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers SEM --exact-budget: budget vira TETO — escreve o que der, mesmo menor que o pedido", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-teto-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
        "--tiers", tiersFile, "--key", "d12-teto", "--budget", "999", "--dry-run",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 8, "universo inteiro (8) — budget 999 nunca corta, sem --exact-budget não aborta");
});

test("main: --group e --tiers são mutuamente exclusivos", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-excl-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--group", "engajados", "--tiers", tiersFile, "--key", "x", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main: nem --group nem --tiers passado ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-nenhum-"));
  const dbPath = storeParaWaterfall(dir);

  const code = await captureExit(() =>
    semBrevoKey(() => captureLogs(() => main(["--cycle", "2607-08", "--db", dbPath, "--data-root", dir, "--dry-run"]))),
  );
  assert.equal(code, 1);
});

test("main --tiers SEM --key ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-semkey-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main(["--cycle", "2607-08", "--db", dbPath, "--data-root", dir, "--tiers", tiersFile, "--dry-run"]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers + --cohort ABORTA (declare cohort DENTRO do tier)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-cohort-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", tiersFile, "--key", "x", "--cohort", "agosto", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers + --min-score ABORTA (declare score DENTRO do tier)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-minscore-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", tiersFile, "--key", "x", "--min-score", "5", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers com --key inválido (maiúscula) ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-keybad-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", tiersFile, "--key", "D12 Especial", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers com arquivo JSON malformado ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-badjson-"));
  const dbPath = storeParaWaterfall(dir);
  const badFile = resolve(dir, "bad.json");
  writeFileSync(badFile, "{ isso nao é json", "utf8");

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", badFile, "--key", "x", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --tiers com --guard-scope inválido ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "waterfall-scope-"));
  const dbPath = storeParaWaterfall(dir);
  const tiersFile = writeTiersPlan(dir);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--data-root", dir,
          "--tiers", tiersFile, "--key", "x", "--guard-scope", "sla", "--dry-run",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});
