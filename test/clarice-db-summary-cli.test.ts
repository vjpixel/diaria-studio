/**
 * #10737 — regressão: `clarice-db-summary.ts --help` executava o script inteiro
 * e GRAVAVA `contacts:summary` no KV do dashboard. `--help`/`-h` tem que
 * imprimir o uso sem ler o banco nem gravar; flag desconhecida tem que abortar.
 *
 * Todos os pontos de efeito colateral (env, banco, upload KV) são injetados
 * como stubs que FALHAM se chamados — o teste nunca toca KV/banco real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  main,
  parseSummaryArgs,
  SummaryUsageError,
  USAGE,
  type SummaryDeps,
} from "../scripts/clarice-db-summary.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "../scripts/lib/clarice-db.ts";

function trapDeps() {
  const calls = { loadEnv: 0, openDb: 0, upload: 0 };
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<SummaryDeps> = {
    loadEnv: () => {
      calls.loadEnv++;
    },
    openDb: () => {
      calls.openDb++;
      throw new Error("openDb não deveria ser chamado");
    },
    upload: async () => {
      calls.upload++;
      throw new Error("upload KV não deveria ser chamado");
    },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  };
  return { deps, calls, out, err };
}

for (const flag of ["--help", "-h"]) {
  test(`#10737: ${flag} imprime o uso, sai 0 e não toca banco nem KV`, async () => {
    const t = trapDeps();
    const code = await main([flag], t.deps);
    assert.equal(code, 0);
    assert.deepEqual(t.calls, { loadEnv: 0, openDb: 0, upload: 0 });
    assert.equal(t.out.join("\n"), USAGE);
    assert.match(USAGE, /--dry-run/);
  });
}

test("#10737: --help vence mesmo combinado com outras flags válidas", async () => {
  const t = trapDeps();
  const code = await main(["--db", "/nao/existe.db", "--help"], t.deps);
  assert.equal(code, 0);
  assert.deepEqual(t.calls, { loadEnv: 0, openDb: 0, upload: 0 });
});

for (const argv of [["--bogus"], ["--dryrun"], ["--dry-run", "--force"], ["posicional"], ["--db"]]) {
  test(`#10737: argv inválido ${JSON.stringify(argv)} aborta com exit 2 sem tocar banco/KV`, async () => {
    const t = trapDeps();
    const code = await main(argv, t.deps);
    assert.equal(code, 2);
    assert.deepEqual(t.calls, { loadEnv: 0, openDb: 0, upload: 0 });
    assert.equal(t.out.length, 0);
    assert.match(t.err.join("\n"), /Uso: npx tsx scripts\/clarice-db-summary\.ts/);
  });
}

test("#10737: --dry-run continua computando e NÃO grava no KV", async () => {
  const t = trapDeps();
  let opened: string | undefined;
  const code = await main(["--dry-run", "--db", ":memory:"], {
    ...t.deps,
    openDb: (p) => {
      opened = p;
      return openClariceDb(":memory:");
    },
  });
  assert.equal(code, 0);
  assert.equal(opened, ":memory:");
  assert.equal(t.calls.upload, 0);
  const payload = JSON.parse(t.out.join("\n"));
  assert.equal(payload.total, 0);
  assert.ok(typeof payload.generated_at === "string");
  assert.match(t.err.join("\n"), /--dry-run: KV NÃO atualizado/);
});

test("#10737: execução normal (sem flags) ainda grava no KV — o fix não desligou a escrita", async () => {
  const t = trapDeps();
  const prevAcc = process.env.CLOUDFLARE_ACCOUNT_ID;
  const prevTok = process.env.CLOUDFLARE_WORKERS_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "acc-test";
  process.env.CLOUDFLARE_WORKERS_TOKEN = "tok-test";
  let uploadedKey: string | undefined;
  let openedPath: string | undefined;
  try {
    const code = await main([], {
      ...t.deps,
      openDb: (p) => {
        openedPath = p;
        return openClariceDb(":memory:");
      },
      upload: async (_body, key) => {
        uploadedKey = key;
      },
    });
    assert.equal(code, 0);
    assert.equal(openedPath, DEFAULT_DB_PATH);
    assert.equal(uploadedKey, "contacts:summary");
  } finally {
    if (prevAcc === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = prevAcc;
    if (prevTok === undefined) delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    else process.env.CLOUDFLARE_WORKERS_TOKEN = prevTok;
  }
});

test("#10737: parseSummaryArgs aceita --db=path e rejeita --db vazio", () => {
  assert.deepEqual(parseSummaryArgs(["--db=/tmp/x.db"]), {
    help: false,
    dryRun: false,
    dbPath: "/tmp/x.db",
  });
  assert.throws(() => parseSummaryArgs(["--db="]), SummaryUsageError);
  assert.throws(() => parseSummaryArgs(["--nope"]), SummaryUsageError);
});
