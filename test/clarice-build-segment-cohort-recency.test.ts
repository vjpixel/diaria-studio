/**
 * Testes de INTEGRAÇÃO de `--cohort` (#4622) e `--not-sent-within`/
 * `--not-sent-since` (#4719) — via `main()` do clarice-build-segment.ts,
 * contra um store SQLite temporário. Mesmo harness de
 * `test/clarice-build-segment-hold.test.ts` (captureLogs/captureExit/
 * semBrevoKey/comBrevoFake) — exercita o caminho real argv → CSV escrito, não
 * só os helpers puros isolados.
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
 * Escrita REAL (sem `--dry-run`) exige a checagem de campanhas comprometidas
 * na Brevo (o script aborta sem ela) — mesmo harness de
 * `test/clarice-build-segment.test.ts`/`clarice-build-segment-hold.test.ts`.
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

/**
 * Store com contatos ENGAJADOS (opens_count>0, sends_count>0, mv_bucket
 * verified — mesma forma comprovada de `storeComJuridicosNoTopo` em
 * clarice-build-segment-hold.test.ts) distribuídos em 2 safras, com
 * `last_sent_at` explícito por linha (não tocado por `recomputeDerived`, que
 * só escreve priority_optin/priority_points/send_eligible/ineligible_reason/
 * cohort — sobrevive intacto ao rebuild).
 */
function storeComCohortsELastSent(
  dir: string,
  rows: Array<{ email: string; cohort: string; lastSentAt: string | null }>,
): string {
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  const ins = db.prepare(
    "INSERT INTO clarice_users (email, name, cohort, opens_count, sends_count, last_sent_at, mv_bucket) VALUES (?,?,?,5,3,?,'verified')",
  );
  for (const r of rows) ins.run(r.email, r.email.split("@")[0], r.cohort, r.lastSentAt);
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

// ---------------------------------------------------------------------------
// --cohort (#4622)
// ---------------------------------------------------------------------------

test("main --cohort restringe o universo à safra pedida, reusável por qualquer grupo nomeado", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-int-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null },
    { email: "b@x.com", cohort: "leads-2024h2", lastSentAt: null },
    { email: "c@x.com", cohort: "leads-2025h1", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
        "--dry-run", "--data-root", dir, "--cohort", "leads-2024h2",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.cohort, "leads-2024h2");
  assert.equal(out.universe_total, 2, "só a safra 2024h2 entrou no SELECT");
  assert.equal(out.selected, 2);
});

// Formas pt-BR/YYYY-MM de --cohort já são unitariamente testadas em
// test/clarice-segment.test.ts (resolveCohortArg) — aqui só se prova que a
// WIRING (argv → SQL WHERE) funciona ponta a ponta com outro slug conhecido.
test("main --cohort com outro slug conhecido (assinantes-ativos) também restringe corretamente", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-canon-"));
  // #2817: cohort de assinante ativo é sempre 'assinantes-ativos' — slug
  // reconhecido, preservado por recomputeDerived independente de tier/created.
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "ativo@x.com", cohort: "assinantes-ativos", lastSentAt: null },
    { email: "lead@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
        "--dry-run", "--data-root", dir, "--cohort", "assinantes-ativos",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 1);
  assert.equal(out.cohort, "assinantes-ativos");
});

test("main --cohort desconhecido ABORTA — nunca resolve pra 'sem filtro' em silêncio", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-bad-"));
  const dbPath = storeComCohortsELastSent(dir, [{ email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null }]);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
          "--dry-run", "--data-root", dir, "--cohort", "não-existe",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --cohort sem NENHUM contato na safra ABORTA com mensagem específica", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-empty-"));
  const dbPath = storeComCohortsELastSent(dir, [{ email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null }]);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
          "--dry-run", "--data-root", dir, "--cohort", "leads-2023h1",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main SEM --cohort: comportamento inalterado, todas as safras entram", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cohort-off-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null },
    { email: "b@x.com", cohort: "leads-2025h1", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.cohort, undefined);
  assert.equal(out.selected, 2);
});

// ---------------------------------------------------------------------------
// --not-sent-within / --not-sent-since (#4719)
// ---------------------------------------------------------------------------

test("main --not-sent-since exclui quem recebeu na/depois da data, ANTES do --budget", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-since-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "recente@x.com", cohort: "leads-2024h2", lastSentAt: "2026-08-02T09:00:00.000Z" }, // dentro da janela — excluído
    { email: "antigo@x.com", cohort: "leads-2024h2", lastSentAt: "2026-07-01T09:00:00.000Z" }, // fora — mantido
    { email: "nunca@x.com", cohort: "leads-2024h2", lastSentAt: null }, // nunca recebeu — mantido
  ]);

  const logs = await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
        "--data-root", dir, "--not-sent-since", "2026-08-01",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.excluded_by_recency, 1);
  assert.equal(out.selected, 2);

  const csv = readFileSync(resolve(clariceSegmentsDir("2607-08", dir), "engajados.csv"), "utf8");
  const emails = emailsDoCsv(csv);
  assert.ok(!emails.includes("recente@x.com"), "quem recebeu depois do cutoff não entra no CSV");
  assert.ok(emails.includes("antigo@x.com"));
  assert.ok(emails.includes("nunca@x.com"));
});

test("main --not-sent-within Nd calcula o cutoff relativo a agora e exclui a mesma forma", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-within-"));
  const hoje = new Date();
  const ha2Dias = new Date(hoje.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const ha60Dias = new Date(hoje.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "recente@x.com", cohort: "leads-2024h2", lastSentAt: ha2Dias },
    { email: "antigo@x.com", cohort: "leads-2024h2", lastSentAt: ha60Dias },
  ]);

  const logs = await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
        "--data-root", dir, "--not-sent-within", "30d",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.excluded_by_recency, 1);
  assert.equal(out.selected, 1);
});

test("main --not-sent-within e --not-sent-since JUNTOS ABORTA — mutuamente exclusivos", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-both-"));
  const dbPath = storeComCohortsELastSent(dir, [{ email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null }]);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir,
          "--not-sent-within", "30d", "--not-sent-since", "2026-08-01",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

test("main --not-sent-within com formato inválido ABORTA", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-badfmt-"));
  const dbPath = storeComCohortsELastSent(dir, [{ email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null }]);

  const code = await captureExit(() =>
    semBrevoKey(() =>
      captureLogs(() =>
        main([
          "--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir,
          "--not-sent-within", "1mês",
        ]),
      ),
    ),
  );
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// #4765 — default automático (início do mês de ENVIO do ciclo) quando o
// operador NÃO passa --not-sent-within/--not-sent-since. Substitui o teste
// antigo "comportamento inalterado" (pré-#4765 o filtro ficava desligado por
// omissão da flag — exatamente a lacuna que a issue corrigiu).
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4765): mesmo com sent-or-queued.json AUSENTE/sem rastro do envio, o cutoff automático ainda pega quem já recebeu via last_sent_at", async () => {
  // Replica o cenário real da issue: um contato foi de fato enviado (o sync
  // da Brevo grava `last_sent_at`), mas `sent-or-queued.json` — por qualquer
  // motivo (não fechado ao vivo, ver docstring de main() no topo do arquivo)
  // — não tem rastro dele neste ciclo. Este teste nem sequer cria
  // sent-or-queued.json (equivalente a "0 tracked" — o pior caso), pra provar
  // que o guard novo NÃO depende daquele arquivo estar correto.
  const dir = mkdtempSync(resolve(tmpdir(), "recency-auto-"));
  const dbPath = storeComCohortsELastSent(dir, [
    // Ciclo 2607-08 → mês de ENVIO é agosto/2026 — recebido em 06/08 cai
    // DENTRO do default automático (início de agosto) e é excluído, mesmo
    // sem nenhuma flag --not-sent-* passada e sem sent-or-queued.json algum.
    { email: "recebeu-em-agosto@x.com", cohort: "leads-2024h2", lastSentAt: "2026-08-06T09:00:00.000Z" },
    // Recebido ANTES do início do mês de envio (julho) — fora da janela do
    // default automático, mantido.
    { email: "recebeu-em-julho@x.com", cohort: "leads-2024h2", lastSentAt: "2026-07-15T09:00:00.000Z" },
    { email: "nunca-recebeu@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.already_sent_or_queued, undefined, "sent-or-queued.json não tinha nada rastreado (o cenário do bug)");
  assert.equal(out.excluded_by_recency, 1, "ainda assim excluído — pelo cutoff automático contra last_sent_at, não pelo dedup por ciclo");
  assert.equal(out.not_sent_cutoff, "2026-08-01T00:00:00.000Z");
  assert.equal(out.recency_cutoff_source, "auto");
  assert.equal(out.selected, 2);
});

test("main --not-sent-since EXPLÍCITO sobrescreve o default automático (#4765) — vence mesmo sendo mais largo que o início do mês de envio", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-override-"));
  const dbPath = storeComCohortsELastSent(dir, [
    // Recebido em julho: o default automático (início de agosto, ciclo
    // 2607-08) MANTERIA este contato — mas o operador pede explicitamente
    // uma janela mais larga (desde 01/07), que deve vencer e excluí-lo.
    { email: "recebeu-em-julho@x.com", cohort: "leads-2024h2", lastSentAt: "2026-07-15T09:00:00.000Z" },
    { email: "recebeu-em-junho@x.com", cohort: "leads-2024h2", lastSentAt: "2026-06-01T09:00:00.000Z" },
  ]);

  const logs = await comBrevoFake(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados",
        "--data-root", dir, "--not-sent-since", "2026-07-01",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.recency_cutoff_source, "explicit");
  assert.equal(out.not_sent_cutoff, "2026-07-01T00:00:00.000Z");
  assert.equal(out.excluded_by_recency, 1, "só quem recebeu em julho (dentro da janela explícita) é excluído");
  assert.equal(out.selected, 1);
});

// ---------------------------------------------------------------------------
// #7234 — --send-date: o cutoff automático passa a derivar da DATA DE ENVIO.
// É o RESET do 1º dia do mês: a onda montada em 31/ago e entregue em 1º/set
// tem que voltar ao topo da fila por score, não herdar a janela de agosto.
// ---------------------------------------------------------------------------

test("REGRESSÃO (#7234): --send-date no mês SEGUINTE reseta a janela — quem recebeu em agosto volta a ser elegível no envio de 1º/set", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-senddate-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "recebeu-em-agosto@x.com", cohort: "leads-2024h2", lastSentAt: "2026-08-06T09:00:00.000Z" },
    { email: "recebeu-em-julho@x.com", cohort: "leads-2024h2", lastSentAt: "2026-07-15T09:00:00.000Z" },
    { email: "nunca-recebeu@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  // Mesmo CICLO do teste do #4765 acima (2607-08, mês de envio = agosto), mas
  // a onda SAI em 1º/set — o caso real da rodada das 19:00 de 31/ago.
  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run",
        "--data-root", dir, "--send-date", "2026-09-01",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(
    out.not_sent_cutoff,
    "2026-09-01T00:00:00.000Z",
    "cutoff vem do mês da DATA DE ENVIO (setembro), não do mês de envio do ciclo (agosto)",
  );
  assert.equal(out.recency_cutoff_source, "auto", "continua sendo o default automático, não uma flag explícita");
  // O summary omite o campo quando é 0 (padrão `valor || undefined` deste
  // arquivo) — `?? 0` normaliza pra asserção ler o que ela quer dizer.
  assert.equal(
    out.excluded_by_recency ?? 0,
    0,
    "ninguém excluído: a virada do mês devolve TODOS à fila — é exatamente o reset do dia 1º",
  );
  assert.equal(out.selected, 3);
});

test("REGRESSÃO (#7234): sem --send-date, o default histórico pelo CICLO segue valendo (invocação manual avulsa não muda)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-senddate-off-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "recebeu-em-agosto@x.com", cohort: "leads-2024h2", lastSentAt: "2026-08-06T09:00:00.000Z" },
    { email: "nunca-recebeu@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.not_sent_cutoff, "2026-08-01T00:00:00.000Z");
  assert.equal(out.excluded_by_recency, 1);
});

test("REGRESSÃO (#7234): --not-sent-since EXPLÍCITO continua vencendo --send-date", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-senddate-explicit-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "recebeu-em-agosto@x.com", cohort: "leads-2024h2", lastSentAt: "2026-08-06T09:00:00.000Z" },
    { email: "nunca-recebeu@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  const logs = await semBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run",
        "--data-root", dir, "--send-date", "2026-09-01", "--not-sent-since", "2026-07-01",
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));

  assert.equal(out.not_sent_cutoff, "2026-07-01T00:00:00.000Z", "a flag explícita manda");
  assert.equal(out.recency_cutoff_source, "explicit");
  assert.equal(out.excluded_by_recency, 1);
});

test("REGRESSÃO (#7234): --send-date malformado ABORTA em vez de cair em cutoff silencioso", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "recency-senddate-bad-"));
  const dbPath = storeComCohortsELastSent(dir, [
    { email: "a@x.com", cohort: "leads-2024h2", lastSentAt: null },
  ]);

  const code = await semBrevoKey(() =>
    captureExit(() =>
      main([
        "--cycle", "2607-08", "--db", dbPath, "--group", "engajados", "--dry-run",
        "--data-root", dir, "--send-date", "01/09/2026",
      ]),
    ),
  );
  assert.equal(code, 1);
});
