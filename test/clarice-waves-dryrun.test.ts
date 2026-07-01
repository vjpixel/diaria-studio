import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeWavesDryrun,
  renderDryrunMarkdown,
  type DryrunRow,
} from "../scripts/lib/clarice-waves-dryrun.ts";
import { openClariceDb, recomputeDerived } from "../scripts/lib/clarice-db.ts";
import { main } from "../scripts/clarice-waves-dryrun.ts";

function row(p: Partial<DryrunRow> & { email: string }): DryrunRow {
  return {
    tier: null,
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    opens_count: 0,
    email_blacklisted: 0,
    in_brevo: 1,
    ...p,
  };
}

const sample: DryrunRow[] = [
  row({ email: "a@x.com", email_blacklisted: 1, send_eligible: 0, ineligible_reason: "unsubscribed" }),
  row({ email: "b@x.com", send_eligible: 1, sends_count: 3, priority_points: 60 }),
  row({ email: "c@x.com", send_eligible: 1, sends_count: 0, tier: 1 }),
  row({ email: "d@x.com", send_eligible: 0, ineligible_reason: "mv_rejected" }),
  row({ email: "e@x.com", send_eligible: 0, ineligible_reason: "unsubscribed" }), // unsub via lista (não-blacklisted)
];

test("computeWavesDryrun: pools (blast / pipeline / store via segmentFromStore)", () => {
  const r = computeWavesDryrun(sample);
  assert.equal(r.total, 5);
  assert.equal(r.blast.send_pool, 4);
  assert.equal(r.blast.suppressed, 1);
  assert.equal(r.current_pipeline.send_pool, 3); // b,c,e
  assert.equal(r.current_pipeline.suppressed, 2); // a,d
  assert.equal(r.store.eligible, 2); // b,c
  assert.equal(r.store.ineligible, 3); // a,d,e
  assert.equal(r.store.re_send, 1); // b (sends>0)
  assert.equal(r.store.first_send, 1); // c
});

test("computeWavesDryrun: separa unsubscribed em blacklist vs só-lista", () => {
  const r = computeWavesDryrun(sample);
  assert.equal(r.store.unsubscribed_blacklist, 1); // a
  assert.equal(r.store.unsubscribed_lista, 1); // e
});

test("computeWavesDryrun: vs_pipeline isola a supressão genuína (unsub via lista)", () => {
  const r = computeWavesDryrun(sample);
  assert.equal(r.divergence.vs_blast.newly_suppressed, 2); // d, e
  assert.equal(r.divergence.vs_pipeline.newly_suppressed, 1); // só e
  assert.equal(r.divergence.vs_pipeline.newly_suppressed_by_reason["unsubscribed"], 1);
  assert.equal(r.divergence.vs_pipeline.newly_sent, 0);
});

test("computeWavesDryrun: eligible_not_in_brevo (informativo) + breakdown por tier", () => {
  const r = computeWavesDryrun([
    row({ email: "novo@x.com", send_eligible: 1, in_brevo: 0, tier: 5 }), // elegível, ainda não no Brevo
    row({ email: "t1@x.com", send_eligible: 1, in_brevo: 0, tier: 1 }), // T1 ativo faltando (curioso)
    row({ email: "vet@x.com", send_eligible: 1, in_brevo: 1, tier: 2 }),
  ]);
  assert.equal(r.store.eligible, 3);
  assert.equal(r.store.eligible_not_in_brevo, 2); // novo@, t1@
  assert.equal(r.store.eligible_not_in_brevo_by_tier["T05"], 1);
  assert.equal(r.store.eligible_not_in_brevo_by_tier["T01"], 1);
});

test("computeWavesDryrun: caso real esperado — store == pipeline na supressão (sem divergência)", () => {
  // sem unsub-via-lista nem soft/hard/complaint: o store corta exatamente o que o pipeline corta
  const r = computeWavesDryrun([
    row({ email: "ok@x.com", send_eligible: 1 }),
    row({ email: "bl@x.com", email_blacklisted: 1, send_eligible: 0, ineligible_reason: "unsubscribed" }),
    row({ email: "mv@x.com", send_eligible: 0, ineligible_reason: "mv_rejected" }),
    row({ email: "dp@x.com", send_eligible: 0, ineligible_reason: "dispute" }),
  ]);
  assert.equal(r.current_pipeline.send_pool, r.store.eligible); // mesma quantidade
  assert.equal(r.divergence.vs_pipeline.newly_suppressed, 0);
  assert.equal(r.divergence.vs_pipeline.newly_sent, 0);
});

test("computeWavesDryrun: mv_unverified NÃO conta como divergência nova (#2656) — pipeline atual já só trabalha com *-verified.csv", () => {
  const r = computeWavesDryrun([
    row({ email: "ok@x.com", send_eligible: 1 }),
    row({ email: "nv@x.com", send_eligible: 0, ineligible_reason: "mv_unverified" }),
  ]);
  assert.equal(r.current_pipeline.send_pool, r.store.eligible);
  assert.equal(r.divergence.vs_pipeline.newly_suppressed, 0);
  assert.equal(r.divergence.vs_pipeline.newly_sent, 0);
});

test("computeWavesDryrun: warning de derivados stale (blacklisted mas elegível)", () => {
  const r = computeWavesDryrun([
    row({ email: "stale@x.com", email_blacklisted: 1, send_eligible: 1 }), // recompute não rodou
  ]);
  assert.equal(r.warnings.stale_derived, 1);
});

test("renderDryrunMarkdown: contém as seções-chave + caveats", () => {
  const md = renderDryrunMarkdown(computeWavesDryrun(sample));
  assert.match(md, /Limites do modelo/);
  assert.match(md, /ainda NÃO no Brevo/);
  assert.match(md, /estado normal/);
  assert.match(md, /vs pipeline atual/i);
  assert.match(md, /PII/);
});

test("CLI main: --json sobre store seedado (smoke do wiring + query in_brevo)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "dryrun-cli-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  db.prepare("INSERT INTO clarice_users (email, status, tier, brevo_list_ids) VALUES ('a@x.com','active',1,'[1]')").run();
  db.prepare("INSERT INTO clarice_users (email, tier, unsubscribed, sends_count) VALUES ('u@x.com',2,1,2)").run();
  recomputeDerived(db);
  db.close();

  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    main(["--db", dbPath, "--json"]);
  } finally {
    console.log = orig;
  }
  const out = JSON.parse(logs.join("\n"));
  assert.equal(out.total, 2);
  assert.equal(out.store.eligible, 1); // a@ elegível, u@ cortado
  assert.equal(out.store.ineligible, 1);
});
