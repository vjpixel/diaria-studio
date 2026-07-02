import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildWaveArtifacts,
  describeWave,
  main,
} from "../scripts/clarice-build-waves-store.ts";
import { CLARICE_SEED_EMAIL } from "../scripts/lib/clarice-seed.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";

type BR = {
  email: string;
  name: string | null;
  tier: number | null;
  priority_points: number;
  send_eligible: number;
  ineligible_reason: string | null;
  sends_count: number;
};

function brow(p: Partial<BR> & { email: string }): BR {
  return {
    name: "Fulano Sobrenome",
    tier: null,
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    ...p,
  };
}

const rows: BR[] = [
  brow({ email: "eng@x.com", sends_count: 3, priority_points: 60, name: "Engajado X" }),
  brow({ email: "fresh1@x.com", sends_count: 0, tier: 1 }),
  brow({ email: "fresh2@x.com", sends_count: 0, tier: 5 }),
  brow({ email: "decay@x.com", sends_count: 2, priority_points: -20 }),
  brow({ email: "cut@x.com", send_eligible: 0, ineligible_reason: "mv_rejected" }),
];

function emailsOf(csv: string): string[] {
  return (Papa.parse(csv, { header: true, skipEmptyLines: true }).data as any[]).map((r) => r.email);
}

test("buildWaveArtifacts: fila = engajado → 1º envio (tier) → decaído; corta inelegível", () => {
  const { manifest, csvByFile, seg } = buildWaveArtifacts(rows as any, 0, 1000);
  assert.equal(seg.excluded.length, 1); // cut@
  // 1 wave (1000 > 4 elegíveis). Ordem da fila (reais + seed ao fim, #2683):
  const order = emailsOf(csvByFile["w1-store.csv"]);
  assert.deepEqual(order, ["eng@x.com", "fresh1@x.com", "fresh2@x.com", "decay@x.com", CLARICE_SEED_EMAIL]);
  // manifest.count = assinantes reais (pré-seed); o CSV tem +1 row (seed)
  assert.equal(manifest[0].count, 4);
});

test("buildWaveArtifacts: --budget pega só o topo da fila", () => {
  const { manifest, csvByFile } = buildWaveArtifacts(rows as any, 2, 1000);
  // manifest.count é pré-seed (assinantes reais); seed é row extra no CSV
  assert.equal(manifest.reduce((s, m) => s + m.count, 0), 2);
  // CSV inclui seed ao fim (#2683)
  assert.deepEqual(emailsOf(csvByFile["w1-store.csv"]), ["eng@x.com", "fresh1@x.com", CLARICE_SEED_EMAIL]);
});

test("buildWaveArtifacts: fatia em waves de wave-size + CSV tem email,NOME (1º nome)", () => {
  const { manifest, csvByFile } = buildWaveArtifacts(rows as any, 0, 2);
  assert.equal(manifest.length, 2); // 4 elegíveis / 2
  assert.equal(manifest[0].count, 2);
  assert.equal(manifest[1].count, 2);
  // NOME = primeiro nome
  const parsed = Papa.parse(csvByFile["w1-store.csv"], { header: true, skipEmptyLines: true }).data as any[];
  const eng = parsed.find((r) => r.email === "eng@x.com");
  assert.equal(eng.NOME, "Engajado");
});

test("describeWave: engajado vs DECAÍDO (não rotular decaído como engajado)", () => {
  assert.equal(describeWave([{ sends_count: 3, priority_points: 60, tier: 2 } as any]), "re-envio (engajado)");
  assert.equal(describeWave([{ sends_count: 2, priority_points: -20, tier: 2 } as any]), "re-envio (decaído)");
  assert.equal(
    describeWave([{ sends_count: 3, priority_points: 60 } as any, { sends_count: 2, priority_points: -20 } as any]),
    "re-envio (engajado+decaído)",
  );
});

test("describeWave: 1º envio (tier range) / misto", () => {
  assert.equal(describeWave([{ sends_count: 0, tier: 1 } as any, { sends_count: 0, tier: 5 } as any]), "1º envio (T01–T05)");
  assert.equal(describeWave([{ sends_count: 0, tier: 3 } as any]), "1º envio (T03)");
  assert.equal(describeWave([{ sends_count: 3, priority_points: 9, tier: 1 } as any, { sends_count: 0, tier: 2 } as any]), "misto (re-envio + 1º)");
});

test("buildWaveArtifacts: 1º nome tira vírgula (Azevedo, Ana → Azevedo)", () => {
  const { csvByFile } = buildWaveArtifacts(
    [brow({ email: "x@x.com", name: "Azevedo, Ana", send_eligible: 1 })] as any,
    0,
    100,
  );
  const parsed = Papa.parse(csvByFile["w1-store.csv"], { header: true, skipEmptyLines: true }).data as any[];
  assert.equal(parsed[0].NOME, "Azevedo");
});

test("main: --dry-run sobre store seedado não escreve, imprime summary correto", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare("INSERT INTO clarice_users (email, name, status, tier, opens_count, sends_count, mv_bucket) VALUES ('e@x.com','Eng',NULL,2,3,3,'verified')").run();
  db.prepare("INSERT INTO clarice_users (email, name, status, tier) VALUES ('f@x.com','Fre','active',1)").run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run"]);
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.eligible_total, 2);
  assert.equal(out.selected, 2); // pre-seed (assinantes reais)
  assert.equal(out.re_send, 1); // e@ (sends>0)
  assert.equal(out.first_send, 1); // f@
  // seed_email é auditável no summary (#2683)
  assert.equal(out.seed_email, CLARICE_SEED_EMAIL);
});

// --- Testes de regressão para seed address (#2683) ---

test("buildWaveArtifacts: seed presente exatamente 1× em TODA wave", () => {
  // 4 elegíveis, wave-size=2 → 2 waves. Seed deve aparecer 1× em cada.
  const { csvByFile } = buildWaveArtifacts(rows as any, 0, 2);
  for (const key of ["w1-store.csv", "w2-store.csv"]) {
    const emails = emailsOf(csvByFile[key]);
    assert.equal(
      emails.filter((e) => e === CLARICE_SEED_EMAIL).length,
      1,
      `${key}: seed deve aparecer exatamente 1×`,
    );
  }
});

test("buildWaveArtifacts: seed marcado IS_SEED='true' em toda wave", () => {
  const { csvByFile } = buildWaveArtifacts(rows as any, 0, 1000);
  const parsed = Papa.parse(csvByFile["w1-store.csv"], { header: true, skipEmptyLines: true }).data as any[];
  const seedRow = parsed.find((r) => r.email === CLARICE_SEED_EMAIL);
  assert.ok(seedRow, "seed deve estar na wave");
  assert.equal(seedRow.IS_SEED, "true");
});

test("buildWaveArtifacts: seed NÃO duplica quando editor já é assinante elegível", () => {
  // Editor (vjpixel@gmail.com) é assinante com sends_count=1 → cai em re-send
  const rowsWithEditor = [
    ...rows,
    brow({ email: CLARICE_SEED_EMAIL, name: "Pixel Vjpixel", sends_count: 1, priority_points: 10, send_eligible: 1 }),
  ];
  const { csvByFile } = buildWaveArtifacts(rowsWithEditor as any, 0, 1000);
  const emails = emailsOf(csvByFile["w1-store.csv"]);
  assert.equal(
    emails.filter((e) => e === CLARICE_SEED_EMAIL).length,
    1,
    "editor assinante não deve ser duplicado na wave",
  );
});

// ---------------------------------------------------------------------------
// --cohort (#2817) — filtro opcional restringe a segmentação a uma safra
// ---------------------------------------------------------------------------

test("main: --cohort filtra o store pra uma safra ANTES de segmentar", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-cohort-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('mai@x.com','Mai','active',1,'2026-05-10T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('jun@x.com','Jun','active',1,'2026-06-10T00:00:00Z')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run", "--cohort", "junho"]);
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.eligible_total, 1, "só jun@x.com (cohort 2026-06) deve entrar no universo");
  assert.equal(out.cohort, "2026-06", "cohort resolvido (rótulo pt-BR → canônico) fica auditável no summary");
});

test("main: sem --cohort roda sobre a base inteira (sem regressão, cohort ausente no summary)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-cohort-off-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('mai@x.com','Mai','active',1,'2026-05-10T00:00:00Z')",
  ).run();
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('jun@x.com','Jun','active',1,'2026-06-10T00:00:00Z')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run"]);
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.eligible_total, 2, "sem filtro, os dois contatos entram");
  assert.equal(out.cohort, undefined, "cohort não aparece no summary quando a flag não foi usada");
});

test("main: --cohort com forma canônica 'YYYY-MM' funciona igual ao rótulo pt-BR", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "bws-cohort-canon-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare(
    "INSERT INTO clarice_users (email, name, status, tier, created) VALUES ('jun@x.com','Jun','active',1,'2026-06-10T00:00:00Z')",
  ).run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    main(["--cycle", "2606-07", "--db", dbPath, "--budget", "10", "--dry-run", "--cohort", "2026-06"]);
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.eligible_total, 1);
});

test("buildWaveArtifacts: IS_SEED='true' mesmo quando editor já é assinante elegível", () => {
  const rowsWithEditor = [
    brow({ email: CLARICE_SEED_EMAIL, name: "Pixel Vjpixel", sends_count: 1, priority_points: 10, send_eligible: 1 }),
    brow({ email: "a@x.com" }),
  ];
  const { csvByFile } = buildWaveArtifacts(rowsWithEditor as any, 0, 1000);
  const parsed = Papa.parse(csvByFile["w1-store.csv"], { header: true, skipEmptyLines: true }).data as any[];
  const seedRow = parsed.find((r) => r.email === CLARICE_SEED_EMAIL);
  assert.ok(seedRow, "seed/editor deve aparecer na wave");
  assert.equal(seedRow.IS_SEED, "true", "IS_SEED deve ser 'true' mesmo sendo assinante");
});
