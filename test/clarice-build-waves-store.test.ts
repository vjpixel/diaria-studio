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
  // 1 wave (1000 > 4 elegíveis). Ordem da fila:
  const order = emailsOf(csvByFile["w1-store.csv"]);
  assert.deepEqual(order, ["eng@x.com", "fresh1@x.com", "fresh2@x.com", "decay@x.com"]);
  assert.equal(manifest[0].count, 4);
});

test("buildWaveArtifacts: --budget pega só o topo da fila", () => {
  const { manifest, csvByFile } = buildWaveArtifacts(rows as any, 2, 1000);
  assert.equal(manifest.reduce((s, m) => s + m.count, 0), 2);
  assert.deepEqual(emailsOf(csvByFile["w1-store.csv"]), ["eng@x.com", "fresh1@x.com"]);
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
  db.prepare("INSERT INTO clarice_users (email, name, status, tier, opens_count, sends_count) VALUES ('e@x.com','Eng',NULL,2,3,3)").run();
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
  assert.equal(out.selected, 2);
  assert.equal(out.re_send, 1); // e@ (sends>0)
  assert.equal(out.first_send, 1); // f@
});
