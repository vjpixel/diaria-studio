/**
 * Testes de INTEGRAÇÃO da reserva `--hold` (#4542) — via `main()` do
 * clarice-build-segment.ts, contra um store SQLite temporário.
 *
 * Por que separado dos unitários de `clarice-hold.ts`: o review da PR #4564
 * apontou que testar só o helper puro não demonstra a regressão. O bug era a
 * AUSÊNCIA de fiação entre a flag e a fila — `parseHoldArg`/`applyHolds`
 * poderiam ser código morto do ponto de vista do `main()` e os unitários
 * passariam igual. Estes testes exercitam o caminho real: argv → CSV escrito.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-build-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

/** Captura o stdout do summary JSON sem deixá-lo poluir a saída do runner. */
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

/** Captura `process.exit(N)` como exceção, pra testar os aborts. */
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

/**
 * Escrita REAL exige a checagem de campanhas comprometidas na Brevo (o script
 * aborta sem ela) — mesmo harness de `test/clarice-build-segment.test.ts`.
 */
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

async function semBrevoKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.BREVO_CLARICE_API_KEY = prev;
  }
}

/**
 * Store com N engajados jurídicos NA FRENTE da fila (mais opens ⇒ mais
 * priority_points ⇒ topo de `segmentEngajados`, que ordena DESC) e M comuns
 * atrás — a mesma forma do incidente que motivou a issue: 117 dos 124
 * elegíveis eram jurídico e sairiam PRIMEIRO.
 */
function storeComJuridicosNoTopo(dir: string, nJur: number, nComum: number): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES (?,?,2,?,3,'verified')",
  );
  for (let i = 0; i < nJur; i++) ins.run(`adv.jur${i}@gmail.com`, `Jur${i}`, 9);
  for (let i = 0; i < nComum; i++) ins.run(`comum${i}@gmail.com`, `Comum${i}`, 3);
  recomputeDerived(db);
  db.close();
  return dbPath;
}

const emailsDoCsv = (csv: string): string[] =>
  csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(",")[0]);

test("main --hold juridico: jurídico NÃO chega ao CSV escrito; os comuns chegam", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "hold-int-"));
  const dbPath = storeComJuridicosNoTopo(dir, 5, 3);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir, "--hold", "juridico"]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.selected, 3, "só os 3 comuns sobram");
  assert.equal(out.hold, "juridico");
  assert.equal(out.held_from_selection, 5, "os 5 jurídicos saíram DESTA seleção");
  assert.equal(out.held_in_universe, 5);
});

test("main --hold juridico (escrita real): nenhum jurídico no CSV em disco", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "hold-write-"));
  const dbPath = storeComJuridicosNoTopo(dir, 4, 2);

  await comBrevoFake(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--data-root", dir, "--hold", "juridico"]),
    ),
  );

  const csv = readFileSync(resolve(clariceSegmentsDir("2606-07", dir), "engajados.csv"), "utf8");
  const emails = emailsDoCsv(csv);
  assert.equal(emails.filter((e) => e.includes("jur")).length, 0, "nenhum jurídico no artefato");
  assert.equal(emails.length, 2);
});

test("main --hold + --budget: a reserva NÃO encolhe a onda — o budget recompõe com os próximos da fila", async () => {
  // O jurídico está no topo por priority_points; com budget 3 e reserva ativa,
  // a onda tem de continuar com 3 contatos (os comuns), não com 0.
  const dir = mkdtempSync(resolve(tmpdir(), "hold-budget-"));
  const dbPath = storeComJuridicosNoTopo(dir, 3, 4);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir, "--budget", "3", "--hold", "juridico"]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.selected, 3, "onda mantém o volume pedido");
  assert.equal(
    out.held_from_selection,
    0,
    "0 legítimo (o budget recompôs) — precisa aparecer no JSON, não sumir",
  );
  assert.equal(out.held_in_universe, 3, "os 3 jurídicos seguem contados no universo");
  assert.equal(out.hold, "juridico", "a flag ativa aparece mesmo com held_from_selection 0");
});

test("main --hold SEM valor ABORTA — nunca degrada pra 'nenhuma reserva pedida'", async () => {
  // O modo de falha do review: `--hold` no fim do argv virava [] em silêncio e
  // o script escrevia o cohort inteiro com exit 0.
  const dir = mkdtempSync(resolve(tmpdir(), "hold-noval-"));
  const dbPath = storeComJuridicosNoTopo(dir, 2, 2);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir, "--hold"]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --hold com nome inválido ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "hold-bad-"));
  const dbPath = storeComJuridicosNoTopo(dir, 2, 2);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir, "--hold", "legal"]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main SEM --hold: comportamento inalterado, jurídico entra normalmente", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "hold-off-"));
  const dbPath = storeComJuridicosNoTopo(dir, 3, 2);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 5, "sem a flag, os 5 seguem elegíveis");
  assert.equal(out.hold, undefined);
  assert.equal(out.held_from_selection, undefined);
});
