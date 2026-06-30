/**
 * test/brave-credits.test.ts (#1558)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordBraveCredit,
  recordBraveCreditEstimate,
  computeBraveCreditStats,
} from "../scripts/lib/brave-credits.ts";

function makeTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brave-credits-"));
  return join(dir, "credits.jsonl");
}

describe("recordBraveCredit", () => {
  it("appends one line per call", () => {
    const path = makeTmpPath();
    recordBraveCredit({ query: "q1", status: "ok", http_status: 200 }, path);
    recordBraveCredit({ query: "q2", status: "ok", http_status: 200, edition: "260530" }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.query, "q1");
    assert.equal(parsed1.status, "ok");
    assert.ok(parsed1.timestamp);
    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.edition, "260530");
    rmSync(path, { force: true });
  });

  it("creates directory if missing (defensive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "brave-credits-deep-"));
    const path = join(dir, "nested", "deep", "credits.jsonl");
    recordBraveCredit({ query: "q1", status: "ok" }, path);
    assert.ok(existsSync(path));
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// recordBraveCreditEstimate (#2608 A)
// ---------------------------------------------------------------------------

describe("recordBraveCreditEstimate (#2608)", () => {
  it("escreve count entradas com estimated:true", () => {
    const path = makeTmpPath();
    recordBraveCreditEstimate({ edition: "260627", source: "stage1-agents", count: 3 }, path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 3, "deve gravar exatamente 3 linhas");
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.equal(entry.estimated, true, "estimated deve ser true");
      assert.equal(entry.source, "stage1-agents");
      assert.equal(entry.edition, "260627");
    }
    rmSync(path, { force: true });
  });

  it("count=0 é no-op (nenhuma linha gravada)", () => {
    const path = makeTmpPath();
    recordBraveCreditEstimate({ source: "stage1-agents", count: 0 }, path);
    assert.ok(!existsSync(path), "arquivo não deve ser criado para count=0");
  });

  // #2630 — regressão: count não-finito deve logar warn, não no-op silencioso.
  // Causa: LLM gerava `count: NaN` quando J (launch_candidates) era undefined
  // em `{N}*2+{M}+{J}`; o gap ficava invisível.
  it("count não-finito (NaN/±Infinity) loga warn e não grava arquivo (#2630)", () => {
    const path = makeTmpPath();
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      recordBraveCreditEstimate({ source: "stage1-agents", edition: "260630", count: NaN }, path);
      recordBraveCreditEstimate({ source: "stage1-agents", edition: "260630", count: Infinity }, path);
      recordBraveCreditEstimate({ source: "stage1-agents", edition: "260630", count: -Infinity }, path);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warns.length, 3, "deve logar 1 warn por chamada com count não-finito");
    assert.ok(
      warns.every((w) => w.includes("não-finito")),
      "mensagem de warn deve mencionar 'não-finito'",
    );
    assert.ok(
      warns.every((w) => w.includes("stage1-agents")),
      "mensagem de warn deve incluir source",
    );
    assert.ok(!existsSync(path), "arquivo não deve ser criado para count não-finito");
  });

  it("Path B: K source-researchers × 2 + L discovery + J launch → stats não-zero", () => {
    const path = makeTmpPath();
    const K = 3, L = 5, J = 2;
    const total = K * 2 + L + J; // 13
    recordBraveCreditEstimate({ edition: "260627", source: "stage1-agents", count: total }, path);
    const now = new Date("2026-06-27T12:00:00Z");
    const stats = computeBraveCreditStats("260627", path, now);
    assert.ok(stats.queries_this_month >= total, "queries_this_month deve ser >= count");
    assert.ok(stats.queries_this_edition >= total, "queries_this_edition deve ser >= count");
    assert.equal(stats.queries_this_month_estimated, total, "estimated deve ser exatamente count");
    assert.equal(stats.queries_this_month_real, 0, "real deve ser 0 (sem Path A)");
    rmSync(path, { force: true });
  });

  it("relatório distingue reais de estimadas (queries_this_month_estimated > 0)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-27T12:00:00Z");
    // 2 reais + 5 estimadas
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-06-27T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-06-27T10:01:00Z", query: "q2", status: "ok" }),
      ].join("\n") + "\n",  // trailing newline to avoid concat with appendFileSync
      "utf8",
    );
    recordBraveCreditEstimate({ source: "stage1-agents", count: 5 }, path);
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month_real, 2);
    assert.equal(stats.queries_this_month_estimated, 5);
    assert.equal(stats.queries_this_month, 7);
    rmSync(path, { force: true });
  });
});

describe("computeBraveCreditStats", () => {
  it("returns zeros when file missing", () => {
    const stats = computeBraveCreditStats(null, "/nonexistent/path.jsonl");
    assert.equal(stats.queries_this_edition, 0);
    assert.equal(stats.queries_this_month, 0);
    assert.equal(stats.alert_level, "ok");
  });

  it("counts queries for current month only", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    // 2 in May, 1 in April (skip), 1 in May (count)
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-15T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-05-20T10:00:00Z", query: "q2", status: "ok" }),
        JSON.stringify({ timestamp: "2026-04-30T10:00:00Z", query: "q3", status: "ok" }),
        JSON.stringify({ timestamp: "2026-05-28T11:00:00Z", query: "q4", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 3);
    rmSync(path, { force: true });
  });

  it("filters by edition when provided", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-28T10:00:00Z", query: "q1", status: "ok", edition: "260528" }),
        JSON.stringify({ timestamp: "2026-05-28T10:01:00Z", query: "q2", status: "ok", edition: "260529" }),
        JSON.stringify({ timestamp: "2026-05-28T10:02:00Z", query: "q3", status: "ok", edition: "260529" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats("260529", path, now);
    assert.equal(stats.queries_this_month, 3);
    assert.equal(stats.queries_this_edition, 2);
    rmSync(path, { force: true });
  });

  it("projects month-end based on day-of-month rate", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-10T12:00:00Z"); // day 10 of 31-day month
    // 100 queries in 10 days → project 310 for month
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-05T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 100);
    assert.equal(stats.projected_month_end, 310);
    rmSync(path, { force: true });
  });

  it("alert_level=warn at 80%", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-15T12:00:00Z");
    const lines = [];
    for (let i = 0; i < 1600; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-10T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.alert_level, "warn");
    rmSync(path, { force: true });
  });

  it("alert_level=critical at 95%", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-15T12:00:00Z");
    const lines = [];
    for (let i = 0; i < 1900; i++) {
      lines.push(JSON.stringify({ timestamp: "2026-05-10T10:00:00Z", query: `q${i}`, status: "ok" }));
    }
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.alert_level, "critical");
    rmSync(path, { force: true });
  });

  it("skips invalid JSON lines silently", () => {
    const path = makeTmpPath();
    const now = new Date("2026-05-28T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-28T10:00:00Z", query: "q1", status: "ok" }),
        "not valid json",
        JSON.stringify({ timestamp: "2026-05-28T11:00:00Z", query: "q2", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 2);
    rmSync(path, { force: true });
  });

  // #2378: characterisation — UTC month boundary (BRT users are UTC-3, so late-night
  // BRT may cross UTC midnight and change the UTC month). Both recordBraveCredit
  // and computeBraveCreditStats use UTC consistently → no off-by-one at month boundary.
  it("UTC month boundary: entry at BRT 22:30 on May 31 (= UTC June 1) counts in June, not May", () => {
    const path = makeTmpPath();
    // "now" = UTC June 1 (what BRT late-night of May 31 looks like in UTC)
    const now = new Date("2026-06-01T01:30:00Z");
    writeFileSync(
      path,
      [
        // Recorded at UTC June 1 (BRT May 31 22:30) → timestamp prefix "2026-06"
        JSON.stringify({ timestamp: "2026-06-01T01:30:00Z", query: "q1", status: "ok" }),
        // Recorded in UTC May → should NOT count in June
        JSON.stringify({ timestamp: "2026-05-31T20:00:00Z", query: "q2", status: "ok" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // Only q1 matches monthPrefix "2026-06"
    assert.equal(stats.queries_this_month, 1);
    rmSync(path, { force: true });
  });

  // (#2608 A) breakdown real vs estimated
  it("queries_this_month_real e _estimated separados", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-01T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-06-01T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-06-01T10:01:00Z", query: "[estimated:stage1-agents:1/3]", status: "ok", estimated: true, source: "stage1-agents" }),
        JSON.stringify({ timestamp: "2026-06-01T10:01:00Z", query: "[estimated:stage1-agents:2/3]", status: "ok", estimated: true, source: "stage1-agents" }),
        JSON.stringify({ timestamp: "2026-06-01T10:01:00Z", query: "[estimated:stage1-agents:3/3]", status: "ok", estimated: true, source: "stage1-agents" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month_real, 1, "real deve ser 1");
    assert.equal(stats.queries_this_month_estimated, 3, "estimated deve ser 3");
    assert.equal(stats.queries_this_month, 4, "total deve ser 4");
    rmSync(path, { force: true });
  });

  // (#2608 C) delta_untracked via quota_remaining header
  it("delta_untracked = real_used - local_real quando quota_remaining presente", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-01T12:00:00Z");
    // local real = 5, free_tier=2000, quota_remaining=1990 → real_used=10, delta=5
    writeFileSync(
      path,
      [
        // 5 real entries, last one has quota_remaining=1990
        ...Array.from({ length: 4 }, (_, i) =>
          JSON.stringify({ timestamp: "2026-06-01T10:00:00Z", query: `q${i}`, status: "ok" })
        ),
        JSON.stringify({ timestamp: "2026-06-01T10:05:00Z", query: "q5", status: "ok", quota_remaining: 1990 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.quota_remaining_last_seen, 1990, "deve capturar quota_remaining");
    assert.equal(stats.delta_untracked, 5, "delta deve ser 2000-1990-5=5 (5 queries nao-contadas Path B)");
    rmSync(path, { force: true });
  });

  // REGRESSÃO: o bug de jun/2026. Contagem local baixa MAS header Brave alto →
  // alerta deve ser CRITICAL pelo header, não "ok" pelo local subnotificado.
  it("alerta dirigido pelo header quando local subnotifica (causa jun/2026)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    // só 5 entradas locais (Path A), mas o header diz quota_remaining=49 →
    // real_used = 2000-49 = 1951 (Path B não-contado). Local sozinho = 0,25% = "ok".
    writeFileSync(
      path,
      [
        ...Array.from({ length: 4 }, (_, i) =>
          JSON.stringify({ timestamp: "2026-06-29T10:00:00Z", query: `q${i}`, status: "ok" })
        ),
        JSON.stringify({ timestamp: "2026-06-29T10:05:00Z", query: "q5", status: "ok", quota_remaining: 49 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 5, "contagem local permanece 5 (informativa)");
    assert.equal(stats.effective_used, 1951, "base do alerta = real_used do header (1951)");
    assert.equal(stats.alert_basis, "brave_header");
    assert.equal(stats.alert_level, "critical", "deve ser critical (1951/2000=97.5%), não 'ok'");
    // projeção coerente com o header (≈1951/29*30≈2018), NÃO a local ~5
    assert.ok(stats.projected_month_end! > 1900, `projeção (${stats.projected_month_end}) deve refletir o header, não a local`);
    rmSync(path, { force: true });
  });

  it("max() mantém a contagem LOCAL quando ela é maior que o header (branch invertido)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    // 20 locais, header quota_remaining=1995 → real_used=5 < 20 → effective = local 20
    writeFileSync(
      path,
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ timestamp: "2026-06-29T10:00:00Z", query: `q${i}`, status: "ok", ...(i === 19 ? { quota_remaining: 1995 } : {}) })
      ).join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.effective_used, 20, "max deve manter o local (20), não o header (5)");
    assert.equal(stats.alert_basis, "local");
    rmSync(path, { force: true });
  });

  it("real_used clampado em 0 quando quota_remaining > limite (defensivo)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    writeFileSync(
      path,
      JSON.stringify({ timestamp: "2026-06-29T10:00:00Z", query: "q", status: "ok", quota_remaining: 2500 }),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // real_used = max(0, 2000-2500) = 0 → não vira negativo; delta = 0 - 1 = -1 (não -501)
    assert.equal(stats.delta_untracked, -1, "delta com real_used clampado (0-1), não 2000-2500-1");
    assert.equal(stats.effective_used, 1, "effective = local (1), header clampado não rebaixa");
    rmSync(path, { force: true });
  });

  it("sem header: alerta continua pela contagem local (comportamento inalterado)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    writeFileSync(
      path,
      Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ timestamp: "2026-06-29T10:00:00Z", query: `q${i}`, status: "ok" })
      ).join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.alert_basis, "local");
    assert.equal(stats.effective_used, 10);
    assert.equal(stats.alert_level, "ok");
    rmSync(path, { force: true });
  });

  // (#2608 C) cross-month regression: quota_remaining from previous month must NOT pollute delta
  it("delta_untracked ignora quota_remaining de mes anterior (cross-month boundary)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-01T12:00:00Z");
    // Entry from May with quota_remaining=400 (1600 used in May).
    // In June (now), no real entries yet → quota_remaining_last_seen must be undefined (no June entries with quota).
    // Before fix: quota_remaining=400 from May would set quota_remaining_last_seen=400 → real_used=1600 → delta=1600 (spike).
    // After fix: May entry is skipped (monthPrefix="2026-06"); no June entry has quota → delta absent.
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-05-31T23:59:00Z", query: "q_may", status: "ok", quota_remaining: 400 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 0, "nenhuma query em junho");
    assert.equal(stats.quota_remaining_last_seen, undefined, "quota de maio nao deve vazar pra junho");
    assert.equal(stats.delta_untracked, undefined, "delta deve ser absent quando sem quota em junho");
    rmSync(path, { force: true });
  });

  // #2378: characterisation — error queries are never recorded (only ok/rate_limited count).
  // This is enforced at the call site (fetch-websearch-batch.ts), not here, but the
  // JSONL-only design means errors can never appear in the file by construction.
  it("does not count queries with status error (they would not be in the file)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-18T12:00:00Z");
    writeFileSync(
      path,
      [
        // 'error' status entries should never be written, but if they were, they'd still
        // be counted since compute() only filters by timestamp, not status.
        // This test documents the design: the guard lives at the call site, not here.
        JSON.stringify({ timestamp: "2026-06-18T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-06-18T10:01:00Z", query: "q2", status: "rate_limited" }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // Only 2 entries exist — both ok/rate_limited (as per call-site guard)
    assert.equal(stats.queries_this_month, 2);
    rmSync(path, { force: true });
  });
});
