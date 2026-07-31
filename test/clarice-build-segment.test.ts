/**
 * test/clarice-build-segment.test.ts (#2885)
 *
 * Regressão pro CLI `clarice-build-segment.ts` — grupos de envio NOMEADOS
 * derivados do store (engajados/reativacao/ramp-warm). Os predicados/ordem em
 * si (entra/sai por condição, ordenação, internos) são testados em
 * `test/clarice-segment.test.ts` — aqui cobrimos a MONTAGEM do artefato
 * (CSV+manifest, corte por --budget) e a integração ponta-a-ponta com o store
 * SQLite via `main()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildSegmentArtifact,
  main,
  loadSentOrQueuedEmails,
  excludeSentOrQueued,
  appendSentOrQueuedEmails,
  sentOrQueuedFilePath,
  checkRoundSizeCap,
  NOVOS_ROUND_SIZE_CAP,
  type SegmentRow,
  type SentOrQueuedFile,
} from "../scripts/clarice-build-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { cohortFromTier, INTERNAL_EMAILS, COHORT_ASSINANTES_ATIVOS } from "../scripts/lib/cohorts.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

function row(p: Partial<SegmentRow> & { email: string }): SegmentRow {
  const tier = p.tier ?? null;
  return {
    name: "Fulano Sobrenome",
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    opens_count: 0,
    last_sent_at: null,
    mv_bucket: null,
    ...p,
  };
}

function emailsOf(csv: string): string[] {
  return (Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[]).map((r) => r.email);
}

// ---------------------------------------------------------------------------
// buildSegmentArtifact — puro
// ---------------------------------------------------------------------------

test("buildSegmentArtifact: grupo 'engajados' filtra+ordena+monta CSV email,NOME", () => {
  const rows: SegmentRow[] = [
    row({ email: "b@x.com", sends_count: 2, priority_points: 20, name: "Beatriz Silva" }),
    row({ email: "a@x.com", sends_count: 3, priority_points: 60, name: "Ana Costa" }),
    row({ email: "fresh@x.com", sends_count: 0, priority_points: 999 }), // não é engajados
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "engajados", 0);
  assert.equal(manifestEntry.key, "engajados");
  assert.equal(manifestEntry.file, "engajados.csv");
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // priority_points DESC
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[];
  assert.equal(parsed[0].NOME, "Ana"); // 1º nome
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["NOME", "email"]); // shape email,NOME
});

test("buildSegmentArtifact: --budget corta o TOPO pós-ordenação (não fatia arbitrária)", () => {
  const rows: SegmentRow[] = [
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }),
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 50 }),
  ];
  const { manifestEntry, csv } = buildSegmentArtifact(rows, "engajados", 2);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // topo: 90, 50 — nunca "c" (10, o mais frio)
});

test("buildSegmentArtifact: budget=0 (omitido) não corta — grupo inteiro", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 10 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 20 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 30 }),
  ];
  const { manifestEntry } = buildSegmentArtifact(rows, "engajados", 0);
  assert.equal(manifestEntry.count, 3);
});

test("buildSegmentArtifact: grupo 'reativacao' — CSV reflete a ordem last_sent_at DESC", () => {
  const rows: SegmentRow[] = [
    row({ email: "old@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-01-01T00:00:00Z" }),
    row({ email: "new@x.com", sends_count: 1, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }),
    row({ email: "abriu@x.com", sends_count: 1, opens_count: 2, last_sent_at: "2026-12-01T00:00:00Z" }), // fora
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "reativacao", 0);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["new@x.com", "old@x.com"]);
});

test("buildSegmentArtifact: grupo 'ramp-warm' — mv_bucket='verified' OU cohort MV-isento (#3826), sempre nunca-enviado", () => {
  const rows: SegmentRow[] = [
    row({ email: "warm@x.com", sends_count: 0, tier: 1, mv_bucket: "verified" }),
    row({ email: "cold@x.com", sends_count: 0, tier: 8, mv_bucket: "verified" }),
    // #3826: tier 1 → cohort assinantes-ativos → MV-isento → mv_bucket='unknown'
    // (ou null/ausente) já não barra mais — cenário real da issue (pagante
    // novo, nunca submetido ao MV por ser isento).
    row({ email: "pagante-sem-mv@x.com", sends_count: 0, tier: 1, mv_bucket: "unknown" }),
    row({ email: "jaenviado@x.com", sends_count: 5, tier: 1, mv_bucket: "verified" }), // fora
    row({ email: "leadnaoverificado@x.com", sends_count: 0, tier: 8, mv_bucket: "unknown" }), // fora: cohort NÃO isento (leads), sem regressão
  ];
  const { csv, manifestEntry } = buildSegmentArtifact(rows, "ramp-warm", 0);
  assert.equal(manifestEntry.count, 3);
  assert.deepEqual(
    emailsOf(csv),
    // warm/pagante-sem-mv empatam (T01, cohort assinantes-ativos, rank 0) → email ASC; cold (T08) por último.
    ["pagante-sem-mv@x.com", "warm@x.com", "cold@x.com"],
  );
});

test("buildSegmentArtifact: 1º nome tira vírgula (Azevedo, Ana → Azevedo)", () => {
  const rows: SegmentRow[] = [row({ email: "x@x.com", sends_count: 2, priority_points: 10, name: "Azevedo, Ana" })];
  const { csv } = buildSegmentArtifact(rows, "engajados", 0);
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[];
  assert.equal(parsed[0].NOME, "Azevedo");
});

test("buildSegmentArtifact: internos (#2809) nunca aparecem em 'engajados'/'reativacao'", () => {
  const rows: SegmentRow[] = INTERNAL_EMAILS.map((email) =>
    row({ email, sends_count: 5, priority_points: 999, opens_count: 0, last_sent_at: "2026-06-01T00:00:00Z" }),
  );
  assert.equal(buildSegmentArtifact(rows, "engajados", 0).manifestEntry.count, 0);
  assert.equal(buildSegmentArtifact(rows, "reativacao", 0).manifestEntry.count, 0);
});

test("buildSegmentArtifact: --min-score exclui priority_points abaixo do piso ANTES do budget (#2973)", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "b@x.com", sends_count: 2, priority_points: 50 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }), // abaixo do piso
  ];
  const { manifestEntry, csv } = buildSegmentArtifact(rows, "engajados", 0, 20);
  assert.equal(manifestEntry.count, 2);
  assert.deepEqual(emailsOf(csv), ["a@x.com", "b@x.com"]); // "c" (10) fica de fora do piso 20
});

test("buildSegmentArtifact: --min-score=0 (omitido) não corta nada — comportamento inalterado", () => {
  const rows: SegmentRow[] = [
    row({ email: "a@x.com", sends_count: 2, priority_points: 90 }),
    row({ email: "c@x.com", sends_count: 2, priority_points: 10 }),
  ];
  const { manifestEntry } = buildSegmentArtifact(rows, "engajados", 0, 0);
  assert.equal(manifestEntry.count, 2);
});

// ---------------------------------------------------------------------------
// main() — integração ponta-a-ponta com o store SQLite
// ---------------------------------------------------------------------------

async function captureLogs(fn: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

// #4347: main() agora é async e faz uma checagem AO VIVO na Brevo
// (fetchCommittedCampaignListIds) antes de qualquer escrita real — nunca
// deve bater na rede de verdade num teste. `withoutBrevoKey`/`withFakeBrevoFetch`
// isolam esse comportamento de qualquer `BREVO_CLARICE_API_KEY` real que
// `loadProjectEnv()` possa ter carregado de `.env.local` na máquina do editor.
async function withoutBrevoKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.BREVO_CLARICE_API_KEY = prev;
  }
}

async function withFakeBrevoFetch<T>(fn: () => Promise<T>): Promise<T> {
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

test("main: --dry-run não escreve nada, imprime summary correto", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-"));
  const dbPath = resolve(dir, "store.db");
  const segDir = clariceSegmentsDir("2606-07", dir);
  const db = openClariceDb(dbPath);
  // priority_points é recomputado por recomputeDerived (opens_count/sends_count) —
  // não precisa inseri-lo diretamente.
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('eng@x.com','Eng',2,3,3,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, mv_bucket) VALUES ('fresh@x.com','Fresh','active',1,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = await withoutBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.cycle, "2606-07");
  assert.equal(out.group, "engajados");
  assert.equal(out.selected, 1); // só eng@x.com (sends_count>0 e priority_points>0)

  assert.equal(existsSync(resolve(segDir, "engajados.csv")), false, "dry-run não deve escrever CSV");
});

test("main: SEM --dry-run escreve CSV+manifest+sent-or-queued.json de fato, isolado em tmpdir via --data-root (#4207)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-real-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('real@x.com','Real',2,3,3,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = await withFakeBrevoFetch(() =>
    captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--data-root", dir])),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 1);

  // `clariceSegmentsDir(cycle, dir)` — mesmo root injetado via --data-root
  // (#4207) que main() usou por dentro; NUNCA sob CLARICE_BASE (raiz fixa de
  // produção) — o branch `if (!dryRun)` (escrita real) fica, pela 1ª vez,
  // coberto ponta-a-ponta via main() sem tocar o disco real do editor.
  const segDir = clariceSegmentsDir("2606-07", dir);
  assert.ok(segDir.startsWith(dir), "segDir resolvido sob o tmpdir injetado, não CLARICE_BASE");
  assert.ok(existsSync(resolve(segDir, "engajados.csv")), "escreve o CSV de fato (sem --dry-run)");
  assert.ok(existsSync(resolve(segDir, "engajados-manifest.json")), "escreve o manifest de fato");
  assert.ok(existsSync(sentOrQueuedFilePath(segDir)), "escreve sent-or-queued.json de fato");

  const csv = readFileSync(resolve(segDir, "engajados.csv"), "utf8");
  assert.ok(csv.includes("real@x.com"), "CSV contém o contato selecionado");
});

// NOTA (#4207, generaliza o `--segments-dir` pontual do #4176): os testes de
// `main()` abaixo passam `--data-root` apontando pra um tmpdir isolado — sem a
// flag, `clariceSegmentsDir`/`clariceCycleDir` resolveriam a partir de
// `CLARICE_BASE` (raiz FIXA do repo, `data/clarice-subscribers/…`), que pode
// ter artefatos REAIS de invocações passadas do editor no mesmo ciclo de
// produção (ex: `sent-or-queued.json`), fazendo a asserção de ausência
// (`existsSync(...) === false`) falhar em qualquer máquina local que já tenha
// rodado um `--group` real nesse ciclo — só passa em CI (clone novo sem a
// junction `data/`). O teste logo acima já cobre o branch `if (!dryRun)`
// (escrita real) ponta-a-ponta via `main()`; os testes abaixo continuam sob
// `--dry-run` porque o que verificam é justamente o comportamento de
// NÃO-escrita.

test("main: --budget corta o grupo antes de escrever", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-budget-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // priority_points é RECOMPUTADO por recomputeDerived a partir de
  // opens_count/sends_count (computePriorityPoints, +20/abertura -10/não-aberto)
  // — não adianta inserir o literal direto, precisa dos counts corretos pra
  // obter 3 valores positivos e distintos (100 > 60 > 20).
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,5,5,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('b@x.com','B',2,3,3,'verified')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('c@x.com','C',2,1,1,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = await withoutBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--budget", "2", "--dry-run",
        "--data-root", dir,
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 2);
  assert.equal(out.budget, 2);
});

test("main: --score é alias de --min-score (#2973) — CLI aceita o vocabulário do editor", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-score-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,5,5,'verified')",
  ).run(); // priority_points alto
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('b@x.com','B',2,1,1,'verified')",
  ).run(); // priority_points baixo
  recomputeDerived(db);
  db.close();

  const logs = await withoutBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--score", "50", "--dry-run",
        "--data-root", dir,
      ]),
    ),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.min_score, 50);
  assert.equal(out.selected, 1); // só quem bate o piso 50 (a@x.com)
});

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#3227) — sent-or-queued.json
// ---------------------------------------------------------------------------
//
// `main()` aceita `--data-root` (#4207, generaliza `--segments-dir` do #4176)
// pra isolar testes do disco real de produção — ver a NOTA acima. Aqui abaixo
// testamos as funções PURAS/injetáveis (`loadSentOrQueuedEmails`,
// `excludeSentOrQueued`, `appendSentOrQueuedEmails`) diretamente contra um
// `segmentsDir` de tmpdir — o mesmo padrão de `collectPriorCycleEmails`/
// `excludeAlreadySentEmails` em test/clarice-build-edition-sends.test.ts.

test("loadSentOrQueuedEmails: arquivo ausente -> Set vazio (1ª invocação do ciclo)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-empty-"));
  assert.deepEqual(loadSentOrQueuedEmails(dir), new Set());
});

test("loadSentOrQueuedEmails: JSON corrompido -> Set vazio (tolerante, nunca lança)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-corrupt-"));
  writeFileSync(sentOrQueuedFilePath(dir), "{ isto não é json válido", "utf8");
  assert.deepEqual(loadSentOrQueuedEmails(dir), new Set());
});

test("excludeSentOrQueued: filtra por email normalizado (trim+lowercase), preserva ordem", () => {
  const rows = [{ email: "A@X.com " }, { email: "b@x.com" }, { email: "c@x.com" }];
  const out = excludeSentOrQueued(rows, new Set(["a@x.com"]));
  assert.deepEqual(out.map((r) => r.email), ["b@x.com", "c@x.com"]);
});

test("excludeSentOrQueued: Set vazio -> devolve rows sem filtrar", () => {
  const rows = [{ email: "a@x.com" }];
  assert.equal(excludeSentOrQueued(rows, new Set()), rows);
});

test("appendSentOrQueuedEmails: 1ª chamada cria o arquivo com emails normalizados + history", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-append-"));
  appendSentOrQueuedEmails(dir, "2606-07", "ramp-warm", ["B@X.com", "a@x.com"]);
  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(dir), "utf8")) as SentOrQueuedFile;
  assert.equal(parsed.cycle, "2606-07");
  assert.deepEqual(parsed.emails, ["a@x.com", "b@x.com"]); // normalizado + ordenado
  assert.equal(parsed.history.length, 1);
  assert.equal(parsed.history[0].group, "ramp-warm");
  assert.equal(parsed.history[0].count, 2);
  assert.ok(parsed.history[0].at); // timestamp presente
});

test("appendSentOrQueuedEmails: chamadas subsequentes ACUMULAM (união, nunca substituem) e registram nova entrada de history", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-accum-"));
  appendSentOrQueuedEmails(dir, "2606-07", "ramp-warm", ["a@x.com"]);
  appendSentOrQueuedEmails(dir, "2606-07", "engajados", ["b@x.com", "a@x.com"]); // "a" repetido, não duplica
  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(dir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["a@x.com", "b@x.com"]);
  assert.equal(parsed.history.length, 2);
  assert.deepEqual(
    parsed.history.map((h) => [h.group, h.count]),
    [["ramp-warm", 1], ["engajados", 2]],
  );
});

test("appendSentOrQueuedEmails: cross-group — email selecionado por 'engajados' é excluído numa build subsequente de 'ramp-warm' (tracking CICLO-WIDE, não por-grupo)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-crossgroup-"));
  appendSentOrQueuedEmails(dir, "2606-07", "engajados", ["shared@x.com"]);

  const rampWarmCandidates: SegmentRow[] = [
    row({ email: "shared@x.com", sends_count: 0, mv_bucket: "verified" }),
    row({ email: "fresh@x.com", sends_count: 0, mv_bucket: "verified" }),
  ];
  const sentOrQueued = loadSentOrQueuedEmails(dir);
  const universe = excludeSentOrQueued(rampWarmCandidates, sentOrQueued);
  const { manifestEntry, csv } = buildSegmentArtifact(universe, "ramp-warm", 0);
  assert.equal(manifestEntry.count, 1);
  assert.deepEqual(emailsOf(csv), ["fresh@x.com"]); // "shared@x.com" já contava como usado por 'engajados'
});

test("REGRESSÃO (#3227): rodar 'ramp-warm' 3x no mesmo ciclo (incidente 260710, cycle 2606-07) produz ZERO sobreposição entre as 3 seleções", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-incident-"));
  const cycle = "2606-07";

  // Universo fixo de 7 candidatos elegíveis a 'ramp-warm' (send_eligible=1,
  // sends_count=0, mv_bucket='verified') — mesma fila determinística
  // (cohortSendRank) que o incidente real reportou re-selecionar sem o guard.
  const universeAll: SegmentRow[] = Array.from({ length: 7 }, (_, i) =>
    row({ email: `contato${i + 1}@x.com`, sends_count: 0, mv_bucket: "verified", tier: 1 }),
  );

  function runInvocation(budget: number): string[] {
    const sentOrQueued = loadSentOrQueuedEmails(dir);
    const universe = excludeSentOrQueued(universeAll, sentOrQueued);
    const { manifestEntry, selected } = buildSegmentArtifact(universe, "ramp-warm", budget);
    const emails = selected.map((r) => r.email);
    appendSentOrQueuedEmails(dir, cycle, "ramp-warm", emails);
    return emails.slice(0, manifestEntry.count);
  }

  // 3 envios sucessivos (proporção do incidente real: 3 waves consumindo o
  // universo inteiro em vez de re-selecionar o topo da fila a cada vez).
  const wave1 = runInvocation(3);
  const wave2 = runInvocation(3);
  const wave3 = runInvocation(3); // só sobram 1 candidato após wave1+wave2 consumirem 6

  assert.equal(wave1.length, 3);
  assert.equal(wave2.length, 3);
  assert.equal(wave3.length, 1); // universo esgotado — não re-seleciona ninguém de wave1/wave2

  const allSelected = [...wave1, ...wave2, ...wave3];
  assert.equal(new Set(allSelected).size, allSelected.length, "zero sobreposição entre as 3 seleções");
  assert.deepEqual([...new Set(allSelected)].sort(), universeAll.map((r) => r.email).sort()); // cobre o universo inteiro, sem duplicar

  const tracked = JSON.parse(readFileSync(sentOrQueuedFilePath(dir), "utf8")) as SentOrQueuedFile;
  assert.equal(tracked.emails.length, 7);
  assert.equal(tracked.history.length, 3);
});

test("REGRESSÃO (#3227): --dry-run NÃO escreve sent-or-queued.json e não afeta builds reais subsequentes", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-soq-dryrun-"));
  const cycle = "2606-07";
  const universeAll: SegmentRow[] = Array.from({ length: 4 }, (_, i) =>
    row({ email: `dry${i + 1}@x.com`, sends_count: 0, mv_bucket: "verified", tier: 1 }),
  );

  // Simula uma invocação --dry-run: lê (vazio) + filtra + monta, mas NÃO chama
  // appendSentOrQueuedEmails (mesma responsabilidade de main() sob --dry-run).
  const sentOrQueued = loadSentOrQueuedEmails(dir);
  const universe = excludeSentOrQueued(universeAll, sentOrQueued);
  const { selected } = buildSegmentArtifact(universe, "ramp-warm", 2);
  assert.equal(selected.length, 2);
  assert.equal(existsSync(sentOrQueuedFilePath(dir)), false, "dry-run não deve criar sent-or-queued.json");

  // Um build REAL subsequente no mesmo diretório enxerga o universo completo
  // (o dry-run anterior não consumiu ninguém).
  const sentOrQueued2 = loadSentOrQueuedEmails(dir);
  assert.equal(sentOrQueued2.size, 0);
  const universe2 = excludeSentOrQueued(universeAll, sentOrQueued2);
  const { selected: selected2 } = buildSegmentArtifact(universe2, "ramp-warm", 4);
  assert.equal(selected2.length, 4); // todos os 4 — dry-run anterior não tirou ninguém da fila
});

test("main: --dry-run também não escreve sent-or-queued.json (integração)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-main-dryrun-"));
  const dbPath = resolve(dir, "store.db");
  // #4207 (generaliza #4176): segDir ISOLADO sob o tmpdir via --data-root,
  // nunca sob a raiz fixa de produção (CLARICE_BASE) — que pode ter
  // sent-or-queued.json de um --group REAL já rodado nesse ciclo em qualquer
  // máquina local, o que faria a asserção de ausência abaixo falhar por
  // motivo alheio ao dry-run sob teste.
  const segDir = clariceSegmentsDir("2606-07", dir);
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket) VALUES ('warm@x.com','Warm',1,0,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  await withoutBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbPath, "--group", "ramp-warm", "--dry-run", "--data-root", dir]),
    ),
  );

  assert.equal(existsSync(sentOrQueuedFilePath(segDir)), false, "dry-run não deve escrever sent-or-queued.json");
});

// ---------------------------------------------------------------------------
// #4347 — guard queued/sent (fetchCommittedCampaignListIds) wired em main()
// ---------------------------------------------------------------------------

async function withMockedExit<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T | undefined; exitCode: number | undefined; errors: string[] }> {
  const origExit = process.exit;
  const origErr = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  let exitCode: number | undefined;
  // @ts-expect-error — stub de process.exit pra capturar sem matar o test runner
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error(`__mock_exit__:${code}`), { __mockExit: true });
  };
  let result: T | undefined;
  try {
    result = await fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { result, exitCode, errors };
}

/** Mocka `BREVO_CLARICE_API_KEY` + `fetch` global com um handler custom —
 *  usado pra simular respostas específicas de `GET /emailCampaigns?status=X`. */
async function withBrevoFetch<T>(
  handler: (url: string) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const prevKey = process.env.BREVO_CLARICE_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.BREVO_CLARICE_API_KEY = "test-fake-key";
  globalThis.fetch = (async (url: string | URL) => handler(String(url))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey !== undefined) process.env.BREVO_CLARICE_API_KEY = prevKey;
    else delete process.env.BREVO_CLARICE_API_KEY;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("main: contato em lista com campanha 'queued' sai do grupo", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-committed-queued-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket, brevo_list_ids) VALUES ('committed@x.com','C',2,3,3,'verified','[\"68\"]')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket, brevo_list_ids) VALUES ('fresh@x.com','F',2,3,3,'verified','[\"99\"]')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = await withBrevoFetch(
    (url) => {
      if (url.includes("status=queued")) return jsonResponse({ campaigns: [{ id: 1, recipients: { lists: [68] } }] });
      return jsonResponse({ campaigns: [] });
    },
    () => captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir])),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 1);
  assert.equal(out.already_committed_brevo, 1);
});

test("main: contato em lista com campanha 'sent' sai do grupo mesmo com sends_count=0 no store (defasagem do sync)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-committed-sent-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  // ramp-warm: elegível, sends_count=0 (a defasagem real do incidente #3682 —
  // o contato JÁ recebeu, mas o sync do Brevo, 1×/dia, ainda não propagou o
  // incremento de sends_count). Sem o guard queued/sent, este contato
  // reapareceria em 'ramp-warm' e seria re-enviado.
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket, brevo_list_ids) VALUES ('ja-enviado-defasado@x.com','D',1,0,'verified','[\"70\"]')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket, brevo_list_ids) VALUES ('fresh@x.com','F',1,0,'verified','[\"99\"]')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs = await withBrevoFetch(
    (url) => {
      if (url.includes("status=sent")) return jsonResponse({ campaigns: [{ id: 2, recipients: { lists: [70] } }] });
      return jsonResponse({ campaigns: [] });
    },
    () => captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--group", "ramp-warm", "--dry-run", "--data-root", dir])),
  );
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 1);
  assert.equal(out.already_committed_brevo, 1);
});

test("main: falha na consulta de campanhas comprometidas ABORTA a escrita real (nunca prossegue silenciosamente)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-committed-failure-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,3,3,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();
  const segDir = clariceSegmentsDir("2606-07", dir);

  const { exitCode } = await withBrevoFetch(
    () => { throw new Error("network down"); },
    () =>
      withMockedExit(() =>
        main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--data-root", dir]), // SEM --dry-run
      ),
  );
  assert.equal(exitCode, 1);
  assert.equal(existsSync(resolve(segDir, "engajados.csv")), false, "nada deve ser escrito quando a checagem falha em modo de escrita real");
});

test("main: falha na consulta de campanhas comprometidas PROSSEGUE (com aviso) em --dry-run", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-committed-failure-dryrun-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, opens_count, sends_count, mv_bucket) VALUES ('a@x.com','A',2,3,3,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  const { exitCode, result } = await withBrevoFetch(
    () => { throw new Error("network down"); },
    () =>
      withMockedExit(() =>
        captureLogs(() => main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run", "--data-root", dir])),
      ),
  );
  assert.equal(exitCode, undefined, "dry-run não deve abortar por falha na consulta");
  const out = JSON.parse((result ?? []).join("\n"));
  assert.equal(out.selected, 1);
});

// ---------------------------------------------------------------------------
// #4347 D13 — teto de tamanho da rodada `novos`
// ---------------------------------------------------------------------------

test("checkRoundSizeCap: dentro do teto passa", () => {
  assert.deepEqual(checkRoundSizeCap(NOVOS_ROUND_SIZE_CAP, NOVOS_ROUND_SIZE_CAP, false), { ok: true });
});

test("checkRoundSizeCap: acima do teto sem --force aborta", () => {
  const result = checkRoundSizeCap(NOVOS_ROUND_SIZE_CAP + 1, NOVOS_ROUND_SIZE_CAP, false);
  assert.equal(result.ok, false);
});

test("checkRoundSizeCap: acima do teto COM --force passa", () => {
  assert.deepEqual(checkRoundSizeCap(NOVOS_ROUND_SIZE_CAP + 1, NOVOS_ROUND_SIZE_CAP, true), { ok: true });
});

function insertNovosRows(db: ReturnType<typeof openClariceDb>, count: number): void {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO clarice_users (email, name, tier, cohort, status, created, sends_count, mv_bucket)
       VALUES (?, ?, 1, 'assinantes-ativos', 'active', '2026-07-15T00:00:00Z', 0, NULL)`,
    ).run(`novo${i}@x.com`, `Novo ${i}`);
  }
}

test("REGRESSÃO (#4347): grupo 'novos' com 0 contatos elegíveis é uma RODADA VAZIA (exit 0), não um erro — outros 3 grupos continuam exit 1", async () => {
  // Store NÃO vazio (senão cai no guard anterior "store vazio", genérico a
  // qualquer grupo) — mas nenhum contato bate o predicado de 'novos' (created
  // antes do --since). Isola o branch sob teste: manifestEntry.count === 0,
  // não rows.length === 0.
  const dirNovos = mkdtempSync(resolve(tmpdir(), "bseg-novos-empty-"));
  const dbNovos = resolve(dirNovos, "store.db");
  const db1 = openClariceDb(dbNovos);
  db1.prepare(
    `INSERT INTO clarice_users (email, name, tier, cohort, status, created, sends_count, mv_bucket)
     VALUES ('velho@x.com', 'Velho', 1, 'assinantes-ativos', 'active', '2026-06-01T00:00:00Z', 0, NULL)`,
  ).run();
  recomputeDerived(db1);
  db1.close();

  const { exitCode: exitNovos, result: logsNovos } = await withoutBrevoKey(() =>
    withMockedExit(() =>
      captureLogs(() =>
        main(["--cycle", "2606-07", "--db", dbNovos, "--group", "novos", "--since", "2026-07-01", "--dry-run", "--data-root", dirNovos]),
      ),
    ),
  );
  assert.equal(exitNovos, undefined, "grupo 'novos' vazio NÃO deve chamar process.exit — é uma rodada válida, não erro");
  const outNovos = JSON.parse((logsNovos ?? []).join("\n"));
  assert.equal(outNovos.selected, 0);
  assert.equal(outNovos.group, "novos");

  // Mesmo cenário (store sem candidatos), mas grupo 'engajados' — continua
  // sinalizando erro (exit 1): 0 contatos ali É tipicamente sintoma de bug
  // (predicado errado, store vazio), diferente de 'novos' (dia calmo é normal).
  const dirEng = mkdtempSync(resolve(tmpdir(), "bseg-engajados-empty-"));
  const dbEng = resolve(dirEng, "store.db");
  const db2 = openClariceDb(dbEng);
  // sends_count=0 nunca bate isEngajados (exige sends_count>0) — store
  // não-vazio, mas 0 contatos no grupo 'engajados' especificamente.
  db2.prepare(
    "INSERT INTO clarice_users (email, name, tier, sends_count, opens_count) VALUES ('fresh@x.com','Fresh',2,0,0)",
  ).run();
  recomputeDerived(db2);
  db2.close();

  const { exitCode: exitEng } = await withoutBrevoKey(() =>
    withMockedExit(() => main(["--cycle", "2606-07", "--db", dbEng, "--group", "engajados", "--dry-run", "--data-root", dirEng])),
  );
  assert.equal(exitEng, 1, "outros grupos continuam tratando 0 contatos como erro (comportamento pré-existente, sem regressão)");
});

test("main: --group novos requer --since (aborta sem ele)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-novos-noSince-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  insertNovosRows(db, 1);
  recomputeDerived(db);
  db.close();

  const { exitCode } = await withoutBrevoKey(() =>
    withMockedExit(() => main(["--cycle", "2606-07", "--db", dbPath, "--group", "novos", "--dry-run", "--data-root", dir])),
  );
  assert.equal(exitCode, 1);
});

test("REGRESSÃO (#4347 D13): 501 contatos no grupo 'novos' ABORTA sem criar lista/manifest; 500 passa; --force com 501 passa", async () => {
  const dirOver = mkdtempSync(resolve(tmpdir(), "bseg-novos-cap-over-"));
  const dbOver = resolve(dirOver, "store.db");
  const db1 = openClariceDb(dbOver);
  insertNovosRows(db1, NOVOS_ROUND_SIZE_CAP + 1);
  recomputeDerived(db1);
  db1.close();
  const segDirOver = clariceSegmentsDir("2606-07", dirOver);

  const { exitCode, errors } = await withBrevoFetch(
    () => jsonResponse({ campaigns: [] }), // nenhuma campanha comprometida — isola o teste no teto D13
    () =>
      withMockedExit(() =>
        main([
          "--cycle", "2606-07", "--db", dbOver, "--group", "novos", "--since", "2026-07-01", "--data-root", dirOver,
        ]), // SEM --dry-run: prova que nada é escrito
      ),
  );
  assert.equal(exitCode, 1, "501 contatos sem --force deve abortar");
  assert.ok(errors.some((e) => /D13|teto/i.test(e)), `esperava erro do teto D13, recebeu: ${JSON.stringify(errors)}`);
  assert.equal(existsSync(resolve(segDirOver, "novos.csv")), false, "nada deve ser escrito quando o teto abortar");
  assert.equal(existsSync(resolve(segDirOver, "novos-manifest.json")), false);

  // --force destrava (501 passa)
  const dirForce = mkdtempSync(resolve(tmpdir(), "bseg-novos-cap-force-"));
  const dbForce = resolve(dirForce, "store.db");
  const db2 = openClariceDb(dbForce);
  insertNovosRows(db2, NOVOS_ROUND_SIZE_CAP + 1);
  recomputeDerived(db2);
  db2.close();
  const logsForce = await withoutBrevoKey(() =>
    captureLogs(() =>
      main([
        "--cycle", "2606-07", "--db", dbForce, "--group", "novos", "--since", "2026-07-01", "--force",
        "--dry-run", "--data-root", dirForce,
      ]),
    ),
  );
  const outForce = JSON.parse(logsForce.join("\n"));
  assert.equal(outForce.selected, NOVOS_ROUND_SIZE_CAP + 1);

  // 500 (exatamente o teto) passa sem --force
  const dirAt = mkdtempSync(resolve(tmpdir(), "bseg-novos-cap-at-"));
  const dbAt = resolve(dirAt, "store.db");
  const db3 = openClariceDb(dbAt);
  insertNovosRows(db3, NOVOS_ROUND_SIZE_CAP);
  recomputeDerived(db3);
  db3.close();
  const logsAt = await withoutBrevoKey(() =>
    captureLogs(() =>
      main(["--cycle", "2606-07", "--db", dbAt, "--group", "novos", "--since", "2026-07-01", "--dry-run", "--data-root", dirAt]),
    ),
  );
  const outAt = JSON.parse(logsAt.join("\n"));
  assert.equal(outAt.selected, NOVOS_ROUND_SIZE_CAP);
});
