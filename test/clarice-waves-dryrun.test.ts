import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWavesDryrun,
  renderDryrunMarkdown,
  type DryrunRow,
} from "../scripts/lib/clarice-waves-dryrun.ts";

function row(p: Partial<DryrunRow> & { email: string }): DryrunRow {
  return {
    tier: null,
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    opens_count: 0,
    email_blacklisted: 0,
    ...p,
  };
}

const sample: DryrunRow[] = [
  // blacklisted → atual corta, store corta (unsubscribed). NÃO é divergência.
  row({ email: "a@x.com", email_blacklisted: 1, send_eligible: 0, ineligible_reason: "unsubscribed" }),
  // elegível com histórico → ambos enviam (re-envio)
  row({ email: "b@x.com", send_eligible: 1, sends_count: 3, priority_points: 60 }),
  // elegível sem histórico → ambos enviam (1º envio)
  row({ email: "c@x.com", send_eligible: 1, sends_count: 0, tier: 1 }),
  // mv_rejected, NÃO blacklisted → atual ENVIA, store CORTA (ganho de segurança)
  row({ email: "d@x.com", email_blacklisted: 0, send_eligible: 0, ineligible_reason: "mv_rejected" }),
  // unsub via lista (não blacklisted) → atual ENVIA, store CORTA
  row({ email: "e@x.com", email_blacklisted: 0, send_eligible: 0, ineligible_reason: "unsubscribed" }),
];

test("computeWavesDryrun: pools (blast / pipeline / store)", () => {
  const r = computeWavesDryrun(sample);
  assert.equal(r.total, 5);
  // blast (blacklist-only): envia b,c,d,e; corta a
  assert.equal(r.blast.send_pool, 4);
  assert.equal(r.blast.suppressed, 1);
  // pipeline atual (+ mv_rejected + dispute): envia b,c,e; corta a,d
  assert.equal(r.current_pipeline.send_pool, 3);
  assert.equal(r.current_pipeline.suppressed, 2);
  // store: b,c elegíveis; a,d,e cortados
  assert.equal(r.store.eligible, 2);
  assert.equal(r.store.ineligible, 3);
  assert.equal(r.store.re_send, 1); // b
  assert.equal(r.store.first_send, 1); // c
});

test("computeWavesDryrun: vs_pipeline isola a supressão GENUÍNA (unsub via lista)", () => {
  const r = computeWavesDryrun(sample);
  // vs blast: d (mv_rejected) + e (unsub) = 2 — sobrestima
  assert.equal(r.divergence.vs_blast.newly_suppressed, 2);
  // vs pipeline: só e (unsub via lista, não-blacklisted) — d já é cortado pelo pipeline
  assert.equal(r.divergence.vs_pipeline.newly_suppressed, 1);
  assert.equal(r.divergence.vs_pipeline.newly_suppressed_by_reason["unsubscribed"], 1);
  assert.equal(r.divergence.vs_pipeline.newly_suppressed_by_reason["mv_rejected"], undefined);
  // sem regressão em nenhum dos dois
  assert.equal(r.divergence.vs_blast.newly_sent, 0);
  assert.equal(r.divergence.vs_pipeline.newly_sent, 0);
});

test("computeWavesDryrun: newly_sent>0 se store envia um blacklisted (sanidade)", () => {
  const r = computeWavesDryrun([
    row({ email: "z@x.com", email_blacklisted: 1, send_eligible: 1 }),
  ]);
  assert.equal(r.divergence.vs_blast.newly_sent, 1);
  assert.equal(r.divergence.vs_pipeline.newly_sent, 1);
});

test("computeWavesDryrun: amostra respeita sampleSize", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    row({ email: `s${i}@x.com`, email_blacklisted: 0, send_eligible: 0, ineligible_reason: "unsubscribed" }),
  );
  const r = computeWavesDryrun(many, 10);
  assert.equal(r.divergence.vs_pipeline.sample_newly_suppressed.length, 10);
});

test("renderDryrunMarkdown: contém as seções-chave", () => {
  const md = renderDryrunMarkdown(computeWavesDryrun(sample));
  assert.match(md, /Dry-run cutover de waves/);
  assert.match(md, /vs PIPELINE ATUAL/);
  assert.match(md, /Supressão genuinamente nova/);
  assert.match(md, /Regressão/);
  assert.match(md, /spot-check/);
});
