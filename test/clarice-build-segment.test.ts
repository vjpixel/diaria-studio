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
  type SegmentRow,
  type SentOrQueuedFile,
} from "../scripts/clarice-build-segment.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { cohortFromTier, INTERNAL_EMAILS } from "../scripts/lib/cohorts.ts";

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

function captureLogs(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test("main: --dry-run não escreve nada, imprime summary correto", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-"));
  const dbPath = resolve(dir, "store.db");
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

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.cycle, "2606-07");
  assert.equal(out.group, "engajados");
  assert.equal(out.selected, 1); // só eng@x.com (sends_count>0 e priority_points>0)

  const segDir = clariceSegmentsDir("2606-07");
  assert.equal(existsSync(resolve(segDir, "engajados.csv")), false, "dry-run não deve escrever CSV");
});

// NOTA (segue o padrão de test/clarice-build-waves-store.test.ts): os testes
// de `main()` abaixo usam sempre `--dry-run` — `clariceSegmentsDir`/
// `clariceCycleDir` resolvem a partir da raiz FIXA do repo (não injetável),
// então escrever de fato exercitaria o disco real do editor (`data/`, fora do
// tmpdir de teste). O branch `if (!dryRun)` (escrita real) e o SHAPE do
// CSV/manifest já são cobertos pelos testes puros de `buildSegmentArtifact`
// acima — aqui só validamos a integração main()+store+summary.

test("main: --budget corta o grupo antes de escrever", () => {
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

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--budget", "2", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.selected, 2);
  assert.equal(out.budget, 2);
});

test("main: --score é alias de --min-score (#2973) — CLI aceita o vocabulário do editor", () => {
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

  const logs = captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "engajados", "--score", "50", "--dry-run"]);
  });
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.min_score, 50);
  assert.equal(out.selected, 1); // só quem bate o piso 50 (a@x.com)
});

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#3227) — sent-or-queued.json
// ---------------------------------------------------------------------------
//
// `main()` resolve `clariceSegmentsDir(cycle)` a partir da raiz FIXA do repo
// (não injetável — mesma limitação documentada na NOTA acima), então os
// testes de main() continuam SEMPRE --dry-run (nunca tocam o disco real).
// Aqui abaixo testamos as funções PURAS/injetáveis (`loadSentOrQueuedEmails`,
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

test("main: --dry-run também não escreve sent-or-queued.json (integração)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bseg-main-dryrun-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, tier, sends_count, mv_bucket) VALUES ('warm@x.com','Warm',1,0,'verified')",
  ).run();
  recomputeDerived(db);
  db.close();

  captureLogs(() => {
    main(["--cycle", "2606-07", "--db", dbPath, "--group", "ramp-warm", "--dry-run"]);
  });

  const segDir = clariceSegmentsDir("2606-07");
  assert.equal(existsSync(sentOrQueuedFilePath(segDir)), false, "dry-run não deve escrever sent-or-queued.json");
});
