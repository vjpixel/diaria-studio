/**
 * test/ads-confirmation-phase2-report.test.ts (#8543, fase 2)
 *
 * Relatório somente leitura: cadastro × /confirmada × import × confirmados
 * por canal. Fixtures sintéticas em dir temporário; nada de rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPhase2Report,
  classifyPhase2Channel,
  extractConfirmadaFromGa4Cache,
  renderPhase2ReportText,
  type Phase2RosterEntry,
} from "../scripts/lib/ads-confirmation-phase2-report.ts";
import { runPhase2Report } from "../scripts/ads-confirmation-phase2-report.ts";

const roster: Phase2RosterEntry[] = [
  { id: 1, state: "active", created_at: "2026-10-01T15:00:00Z", fields: { origem_paga: "google-ads", origem_click_id: "gclid:a" } },
  { id: 2, state: "inactive", created_at: "2026-10-01T15:00:00Z", fields: { origem_paga: "google-ads", origem_click_id: null } },
  { id: 3, state: "active", created_at: "2026-10-02T15:00:00Z", fields: { origem_paga: null, origem_click_id: "fbclid:b" } },
  { id: 4, state: "cancelled", created_at: "2026-10-02T15:00:00Z", fields: { origem_paga: "meta-ads", origem_click_id: "fbclid:c" } },
  { id: 5, state: "active", created_at: "2026-10-03T15:00:00Z", fields: { utm_source: "diaria-apex" } },
  // Fora da janela (antes do since) — não conta.
  { id: 6, state: "active", created_at: "2026-09-01T15:00:00Z", fields: { origem_paga: "google-ads" } },
  // 02:00Z de 27/09 é 26/09 em BRT — fora da janela que começa em 27/09.
  { id: 7, state: "active", created_at: "2026-09-27T02:00:00Z", fields: { origem_paga: "meta-ads" } },
];
const googleIndex = { "kit-1": { status: "submitted" }, "kit-3": { status: "submitted" }, "kit-6": { status: "submitted" } };
const metaIndex = {
  "kit-1": { status: "skipped-other-channel" },
  "kit-3": { status: "sent" },
  "kit-4": { status: "skipped-out-of-window" },
  "kit-5": { status: "sent" },
};

describe("#8543 fase 2 — classificação de canal", () => {
  it("origem_paga vence; sem ela, prefixo do click id; senão outros", () => {
    assert.deepEqual(classifyPhase2Channel({ origem_paga: "google-ads", origem_click_id: "fbclid:x" }), {
      channel: "google",
      viaClickIdOnly: false,
      clickIdChannel: "meta",
    });
    assert.equal(classifyPhase2Channel({ origem_click_id: "fbclid:x" }).viaClickIdOnly, true);
    assert.equal(classifyPhase2Channel({ origem_click_id: "msclkid:x" }).channel, "outros");
    assert.equal(classifyPhase2Channel(null).channel, "outros");
  });
});

describe("#8543 fase 2 — buildPhase2Report", () => {
  const r = buildPhase2Report({
    roster,
    googleIndex,
    metaIndex,
    ga4: { pageviews: 297, windowDays: 30, fetchedAt: "2026-10-17T13:50:08Z" },
    since: "2026-09-27",
    until: "2026-10-18",
  });
  const g = r.rows.find((x) => x.channel === "google")!;
  const m = r.rows.find((x) => x.channel === "meta")!;
  const o = r.rows.find((x) => x.channel === "outros")!;

  it("cadastros e confirmados por canal, janela por dia BRT", () => {
    assert.equal(g.cadastros, 2);
    assert.equal(g.confirmados, 1);
    assert.equal(g.pendentes, 1);
    assert.equal(g.taxaConfirmacao, 0.5);
    assert.equal(m.cadastros, 2);
    assert.equal(m.viaClickIdOnly, 1);
    assert.equal(m.confirmados, 1);
    assert.equal(m.saiu, 1);
    assert.equal(o.cadastros, 1);
  });

  it("import por canal a partir dos dois índices; perdas da Meta contadas", () => {
    assert.equal(g.importGoogle, 1);
    assert.equal(g.coberturaImportCanal, 1);
    assert.equal(m.importMeta, 1);
    assert.equal(m.importGoogle, 1); // o Google importa por e-mail também quem veio da Meta
    assert.equal(m.metaForaDaJanela, 1);
    assert.equal(o.importMeta, 1);
    assert.equal(o.coberturaImportCanal, null);
  });

  it("texto declara somente leitura, a janela do GA4 e não vaza e-mail", () => {
    const t = renderPhase2ReportText(r);
    assert.match(t, /Somente leitura/);
    assert.match(t, /\/confirmada.*297/);
    assert.doesNotMatch(t, /@/);
  });

  it("índice ausente vira n/d, nunca zero", () => {
    const r2 = buildPhase2Report({ roster, googleIndex: null, metaIndex: null, ga4: null, since: "2026-09-27", until: "2026-10-18" });
    assert.equal(r2.rows[0].importGoogle, null);
    assert.match(renderPhase2ReportText(r2), /n\/d/);
    assert.match(renderPhase2ReportText(r2), /\/confirmada: indisponível/);
  });

  it("janela inválida lança", () => {
    assert.throws(() => buildPhase2Report({ roster, googleIndex, metaIndex, ga4: null, since: "2026-10-18", until: "2026-09-27" }));
  });
});

describe("#8543 fase 2 — GA4 cache", () => {
  it("pega /confirmada (com ou sem barra final) em top_pages", () => {
    const c = { window_days: 30, fetched_at: "x", top_pages: [{ pagePath: "/", screenPageViews: "10" }, { pagePath: "/confirmada/", screenPageViews: "7" }] };
    assert.deepEqual(extractConfirmadaFromGa4Cache(c), { pageviews: 7, windowDays: 30, fetchedAt: "x" });
    assert.equal(extractConfirmadaFromGa4Cache({ top_pages: [] }), null);
    assert.equal(extractConfirmadaFromGa4Cache(null), null);
  });
});

describe("#8543 fase 2 — CLI fail-soft", () => {
  it("sem data/: exit 0, sem relatório, mensagem clara", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-"));
    try {
      const r = runPhase2Report(["--data-root", dir]);
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /relatório não gerado/);
      assert.match(r.stderr, /roster do Kit ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com roster mas índice corrompido: relatório sai com nota", () => {
    const dir = mkdtempSync(join(tmpdir(), "phase2-"));
    try {
      mkdirSync(join(dir, "kit-sub-state"), { recursive: true });
      mkdirSync(join(dir, "google-ads"), { recursive: true });
      writeFileSync(join(dir, "kit-sub-state", "current.json"), JSON.stringify(roster));
      writeFileSync(join(dir, "google-ads", "_confirmation-conversions-sent.json"), "{nao-json");
      const r = runPhase2Report(["--data-root", dir, "--since", "2026-09-27", "--until", "2026-10-18", "--format", "json"]);
      assert.equal(r.exitCode, 0);
      const j = JSON.parse(r.stdout);
      assert.equal(j.rows[0].cadastros, 2);
      assert.equal(j.rows[0].importGoogle, null);
      assert.ok(j.sourceNotes.some((n: string) => /Google ilegível/.test(n)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("argumento inválido → exit 2", () => {
    assert.equal(runPhase2Report(["--since", "ontem"]).exitCode, 2);
    assert.equal(runPhase2Report(["--format", "xml"]).exitCode, 2);
  });
});
