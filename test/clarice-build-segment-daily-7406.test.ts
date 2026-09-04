/**
 * Testes de integração do modo `--daily` (#7406) em
 * `scripts/clarice-build-segment.ts` — substitui `--group ramp-warm` +
 * `--group engajados` (duas tasks agendadas) por uma fila única ordenada
 * por score. Mesmo padrão de `test/clarice-build-segment-waterfall.test.ts`:
 * exercita `main()` contra um store SQLite temporário, sem rede real
 * (BREVO_CLARICE_API_KEY ausente → guard segue com aviso, comportamento
 * fail-soft em dry-run já coberto pelos outros modos).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-build-segment.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

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
  const errFn = console.error;
  console.error = () => {};
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    process.exit = real;
    console.error = errFn;
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
 * 2 engajados (score>0, já receberam) + 2 ramp-warm (score=0, MV verificado,
 * nunca receberam) + 1 decaído (score=0 mas já recebeu — território
 * reativação, fica fora dos dois) + 1 não-elegível.
 */
function storeParaDaily(dir: string): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    `INSERT INTO clarice_users
       (email, name, cohort, priority_points, sends_count, send_eligible, mv_bucket, created)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run("engajado-alto@gmail.com", "EngajadoAlto", null, 80, 3, 1, null, "2026-01-01T00:00:00Z");
  ins.run("engajado-baixo@gmail.com", "EngajadoBaixo", null, 10, 2, 1, null, "2026-01-01T00:00:00Z");
  ins.run("ramp-recente@gmail.com", "RampRecente", "leads-2026-08", 0, 0, 1, "verified", "2026-08-20T00:00:00Z");
  ins.run("ramp-antigo@gmail.com", "RampAntigo", "leads-2026-01", 0, 0, 1, "verified", "2026-01-05T00:00:00Z");
  ins.run("decaido@gmail.com", "Decaido", null, 0, 4, 1, null, "2026-01-01T00:00:00Z");
  ins.run("inelegivel@gmail.com", "Inelegivel", null, 50, 3, 0, null, "2026-01-01T00:00:00Z");
  db.close();
  return dbPath;
}

test("main --daily: une engajados+ramp-warm numa fila só, ordenada por score DESC, sem grupo escolhido", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-"));
  const dbPath = storeParaDaily(dir);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2608-09", "--db", dbPath, "--data-root", dir,
        "--daily", "--send-date", "2026-09-05", "--dry-run",
      ]),
    ),
  );
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.mode, "daily-queue");
  assert.equal(summary.selected, 4, "2 engajados + 2 ramp-warm — decaído e inelegível ficam fora");
  assert.equal(summary.guard_scope, "per-contact (#7406)");
  assert.equal(summary.label, "Fila única do envio diário (#7406)");
});

test("main --daily: CSV sai na ordem certa (score alto→baixo, depois recência dentro do score 0)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-order-"));
  const dbPath = storeParaDaily(dir);
  const segDir = clariceSegmentsDir("2608-09", dir);

  await comBrevoFake(() =>
    main(["--cycle", "2608-09", "--db", dbPath, "--data-root", dir, "--daily", "--send-date", "2026-09-05"]),
  );
  const csv = readFileSync(resolve(segDir, "daily.csv"), "utf8");
  assert.deepEqual(emailsDoCsv(csv), [
    "engajado-alto@gmail.com",
    "engajado-baixo@gmail.com",
    "ramp-recente@gmail.com",
    "ramp-antigo@gmail.com",
  ]);
});

test("main --daily: --budget corta o TOPO da fila (engajados nunca perdem espaço pra ramp-warm dentro do budget)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-budget-"));
  const dbPath = storeParaDaily(dir);
  const segDir = clariceSegmentsDir("2608-09", dir);

  await comBrevoFake(() =>
    main([
      "--cycle", "2608-09", "--db", dbPath, "--data-root", dir,
      "--daily", "--send-date", "2026-09-05", "--budget", "3",
    ]),
  );
  const csv = readFileSync(resolve(segDir, "daily.csv"), "utf8");
  assert.deepEqual(emailsDoCsv(csv), ["engajado-alto@gmail.com", "engajado-baixo@gmail.com", "ramp-recente@gmail.com"]);
});

test("main: --daily é mutuamente exclusivo com --group e com --tiers", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-excl-"));
  const dbPath = storeParaDaily(dir);

  const codeGroup = await captureExit(() =>
    main(["--cycle", "2608-09", "--db", dbPath, "--daily", "--group", "engajados"]),
  );
  assert.equal(codeGroup, 1);

  const codeTiers = await captureExit(() =>
    main(["--cycle", "2608-09", "--db", dbPath, "--daily", "--tiers", "plano.json", "--key", "x"]),
  );
  assert.equal(codeTiers, 1);
});

test("main: --daily rejeita --cohort/--min-score/--score/--guard-scope/--since (não são escolhas nesse modo)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-flags-"));
  const dbPath = storeParaDaily(dir);

  for (const flags of [
    ["--cohort", "junho"],
    ["--min-score", "10"],
    ["--score", "10"],
    ["--guard-scope", "queued"],
    ["--since", "2026-08-01"],
  ]) {
    const code = await captureExit(() => main(["--cycle", "2608-09", "--db", dbPath, "--daily", ...flags]));
    assert.equal(code, 1, `--daily deveria rejeitar ${flags.join(" ")}`);
  }
});

test("main --daily: --hold juridico continua funcionando (guard genérico, não específico de modo)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-hold-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    `INSERT INTO clarice_users
       (email, name, cohort, priority_points, sends_count, send_eligible, mv_bucket, created)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run("jur@escritorio.adv.br", "Jur", null, 60, 2, 1, null, "2026-01-01T00:00:00Z");
  ins.run("comum@gmail.com", "Comum", null, 40, 2, 1, null, "2026-01-01T00:00:00Z");
  db.close();
  const segDir = clariceSegmentsDir("2608-09", dir);

  await comBrevoFake(() =>
    main([
      "--cycle", "2608-09", "--db", dbPath, "--data-root", dir,
      "--daily", "--send-date", "2026-09-05", "--hold", "juridico",
    ]),
  );
  const csv = readFileSync(resolve(segDir, "daily.csv"), "utf8");
  assert.deepEqual(emailsDoCsv(csv), ["comum@gmail.com"], "reserva jurídica retira o advogado da fila única igual nos outros modos");
});

test("main --daily: 0 selecionados aborta com exit 1 e mensagem citando 'daily'", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "daily-empty-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    `INSERT INTO clarice_users (email, name, priority_points, sends_count, send_eligible) VALUES (?,?,?,?,?)`,
  ).run("ninguem@gmail.com", "Ninguem", 0, 0, 0);
  db.close();

  const code = await comBrevoFake(() =>
    captureExit(() => main(["--cycle", "2608-09", "--db", dbPath, "--data-root", dir, "--daily", "--send-date", "2026-09-05"])),
  );
  assert.equal(code, 1);
});
