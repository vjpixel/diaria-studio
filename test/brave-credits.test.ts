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
    const now = new Date("2026-06-27T12:00:00Z");
    recordBraveCreditEstimate({ edition: "260627", source: "stage1-agents", count: total }, path, now);
    const stats = computeBraveCreditStats("260627", path, now);
    assert.ok(stats.queries_this_month >= total, "queries_this_month deve ser >= count");
    assert.ok(stats.queries_this_edition >= total, "queries_this_edition deve ser >= count");
    assert.equal(stats.queries_this_month_estimated, total, "estimated deve ser exatamente count");
    assert.equal(stats.queries_this_month_real, 0, "real deve ser 0 (sem Path A)");
    rmSync(path, { force: true });
  });

  // (#3271) recordBraveCreditEstimate agora retorna boolean — callers (ex:
  // reconcile-brave-path-b.ts) usam isso pra decidir se podem avançar estado
  // incremental derivado (o anchor). Um no-op silencioso não pode ser
  // indistinguível de uma escrita bem-sucedida pro caller.
  it("retorna true quando escreve com sucesso (#3271)", () => {
    const path = makeTmpPath();
    const wrote = recordBraveCreditEstimate({ edition: "260627", source: "stage1-agents", count: 3 }, path);
    assert.equal(wrote, true, "deve retornar true — escreveu 3 linhas de fato");
    rmSync(path, { force: true });
  });

  it("retorna false quando count<=0 (nada escrito) (#3271)", () => {
    const path = makeTmpPath();
    const wrote = recordBraveCreditEstimate({ source: "stage1-agents", count: 0 }, path);
    assert.equal(wrote, false, "count=0 não escreve — deve retornar false");
  });

  it("retorna false quando count é não-finito (nada escrito) (#3271)", () => {
    const path = makeTmpPath();
    const originalWarn = console.warn;
    console.warn = () => {};
    let wrote: boolean;
    try {
      wrote = recordBraveCreditEstimate({ source: "stage1-agents", edition: "260630", count: NaN }, path);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(wrote, false, "count NaN não escreve — deve retornar false");
  });

  it("retorna false quando o guard de idempotência no-opa (entry já existe pra edition+source+mês) (#3271)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-27T12:00:00Z");
    const first = recordBraveCreditEstimate({ edition: "260627", source: "path-b-reconcile", count: 5 }, path, now);
    assert.equal(first, true, "1ª chamada escreve — deve retornar true");
    // 2ª chamada: MESMA edition+source+mês — guard de idempotência dispara, mesmo
    // com um count diferente (genuinamente novo do ponto de vista do caller).
    const second = recordBraveCreditEstimate({ edition: "260627", source: "path-b-reconcile", count: 7 }, path, now);
    assert.equal(second, false, "2ª chamada no-opa (guard de idempotência) — deve retornar false");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 5, "só as 5 linhas da 1ª chamada existem — 2ª não escreveu nada");
    rmSync(path, { force: true });
  });

  // (#3271 review — achado do próprio code-review) count fracionário entre 0 e 1
  // passava o gate `count<=0` (0.4 > 0) e só arredondava pra 0 DEPOIS — gerando 0
  // entradas reais (só um "\n" em branco no arquivo) mas AINDA retornando `true`.
  // Isso quebraria o contrato "true ⇒ pelo menos 1 entrada foi de fato gravada" que
  // reconcile-brave-path-b.ts agora depende para decidir se avança seu anchor. O fix
  // reordena o `Math.round` pra ANTES do gate.
  it("count fracionário que arredonda pra 0 retorna false, não grava linha em branco (#3271 review)", () => {
    const path = makeTmpPath();
    const wrote = recordBraveCreditEstimate({ edition: "260627", source: "stage1-agents", count: 0.4 }, path);
    assert.equal(wrote, false, "0.4 arredonda pra 0 — deve retornar false, não true");
    assert.ok(!existsSync(path), "nenhum arquivo deve ser criado (nem uma linha em branco)");
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
    recordBraveCreditEstimate({ source: "stage1-agents", count: 5 }, path, now);
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

  // REGRESSÃO #3002: este é EXATAMENTE o caso do falso-positivo real (edição
  // 260706) — local=5 (na prática 55 na edição real, mas a mesma ordem de
  // grandeza vs. o header), header quota_remaining=49 → real_used=1951. A
  // divergência (1951 vs 5, ~390×) é implausível: reflete um resquício do ciclo
  // de rate-limit anterior do Brave (fim de junho) que não zerou junto com o
  // mês-calendário, não uso real do Path B. O header deve ser DESCARTADO e o
  // alerta deve refletir a contagem local (~5), não "critical" por 1951/2000.
  // Este teste ANTES esperava alert_basis="brave_header"/critical — essa era a
  // manifestação do próprio bug #3002 (ver issue: dashboard oficial Brave
  // mostrou 55 requests no mês real, não 1951).
  it("descarta header quando diverge implausivelmente do local (regressão #3002)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    // só 5 entradas locais (Path A), mas o header diz quota_remaining=49 →
    // real_used = 2000-49 = 1951. Ratio vs. local (5) = 390× >> threshold (10×).
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
    assert.equal(stats.effective_used, 5, "base do alerta = contagem local (header descartado)");
    assert.equal(stats.alert_basis, "local", "header descartado → cai pra local");
    assert.equal(stats.header_discarded, true, "deve sinalizar que o header foi descartado");
    assert.equal(stats.alert_level, "ok", "NÃO deve ser critical — 5/2000 é ok");
    assert.equal(stats.delta_untracked, undefined, "delta não deve refletir o gap implausível");
    rmSync(path, { force: true });
  });

  // (#2668, ainda coberto após #3002) Contagem local baixa-mas-plausível MAS header
  // Brave mais alto, com divergência MODESTA (~2×, não 390×) → o header ainda deve
  // ser autoritativo. Este é o caso legítimo que motivou #2668 originalmente:
  // Path B (WebSearch dos agentes) genuinamente subnotificado pela contagem local.
  it("mantém header quando a divergência é modesta e plausível (#2668 preservado)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-29T12:00:00Z");
    // 999 entradas locais (Path A), header diz quota_remaining=49 → real_used=1951.
    // Ratio vs. local (999) = ~1.95× << threshold (10×) → header plausível, mantido.
    const lines = Array.from({ length: 998 }, (_, i) =>
      JSON.stringify({ timestamp: "2026-06-29T10:00:00Z", query: `q${i}`, status: "ok" }),
    );
    lines.push(
      JSON.stringify({ timestamp: "2026-06-29T10:05:00Z", query: "q999", status: "ok", quota_remaining: 49 }),
    );
    writeFileSync(path, lines.join("\n"), "utf8");
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.queries_this_month, 999, "contagem local permanece 999");
    assert.equal(stats.effective_used, 1951, "base do alerta = real_used do header (1951)");
    assert.equal(stats.alert_basis, "brave_header");
    assert.equal(stats.header_discarded, undefined, "header plausível não deve ser descartado");
    assert.equal(stats.alert_level, "critical", "deve ser critical (1951/2000=97.5%)");
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

  // #2378 (atualizado por #3389): "error" agora PODE aparecer no arquivo —
  // fetch-websearch-batch.ts passou a gravá-las quando trazem quota_remaining
  // (ver shouldRecordBraveResponse). Continuam NÃO contando como query real —
  // ver describe("#3389") abaixo para a cobertura completa desse guard.
  it("does not count queries with status error even when present in the file", () => {
    const path = makeTmpPath();
    const now = new Date("2026-06-18T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-06-18T10:00:00Z", query: "q1", status: "ok" }),
        JSON.stringify({ timestamp: "2026-06-18T10:01:00Z", query: "q2", status: "rate_limited" }),
        JSON.stringify({ timestamp: "2026-06-18T10:02:00Z", query: "q3", status: "error", quota_remaining: 100 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    // Only the 2 ok/rate_limited entries count — the error entry is excluded.
    assert.equal(stats.queries_this_month, 2);
    rmSync(path, { force: true });
  });
});

// ---------------------------------------------------------------------------
// #3389 — regressão: alarme critical persistente por header congelado
// ---------------------------------------------------------------------------
//
// Causa raiz confirmada (ver scripts/fetch-websearch-batch.ts `runQuery` +
// `shouldRecordBraveResponse`): quando o free tier Brave esgota, toda query
// Path A passa a retornar HTTP 402 (`status: "error"` em braveSearch()). Antes
// do #3389, o guard de gravação de crédito só disparava para `ok`/`rate_limited`
// — descartando o header `X-RateLimit-Remaining` mesmo quando ele vinha
// preenchido na resposta de erro. Resultado: `quota_remaining_last_seen`
// CONGELAVA no último valor lido antes da exaustão pelo resto do mês (Path A
// continuava rodando normalmente, edição após edição, sem nunca deixar rastro
// no jsonl) — daí `data/brave-credits.jsonl` "silencioso" desde a exaustão
// (não porque Path A parou, mas porque toda tentativa falhava sem gravar
// nada), e o relatório reportando "critical" com uma leitura de dias atrás,
// sem qualquer sinal de que estava obsoleta.
//
// O fix (#3389): fetch-websearch-batch.ts agora GRAVA entradas status="error"
// quando elas trazem quota_remaining — mas computeBraveCreditStats (guard
// acima) as EXCLUI da contagem de queries reais, então elas só servem pra
// manter quota_remaining_last_seen fresco. Os testes abaixo comprovam as duas
// pontas: (1) entradas de erro atualizam quota_remaining_last_seen mesmo após
// entradas reais mais antigas — a leitura passa a refletir SEMPRE a mais
// recente, mesmo que só "error" tenha ocorrido desde então; (2) isso não
// infla queries_this_month_real (senão o breakdown do relatório mentiria).
describe("computeBraveCreditStats — leitura fresca do header durante exaustão (#3389)", () => {
  it("quota_remaining_last_seen reflete a ÚLTIMA leitura, mesmo vinda de uma entrada status=error (fix)", () => {
    const path = makeTmpPath();
    const now = new Date("2026-07-13T12:00:00Z");
    writeFileSync(
      path,
      [
        // 260709: Path A ainda funcionando, quota caindo pra 49 (97.55% usado).
        ...Array.from({ length: 999 }, (_, i) =>
          JSON.stringify({ timestamp: "2026-07-09T10:00:00Z", query: `q${i}`, status: "ok" }),
        ),
        JSON.stringify({ timestamp: "2026-07-09T10:05:00Z", query: "q999b", status: "ok", quota_remaining: 49 }),
        // 260710-260713: free tier esgotado — toda query 402, mas o fix (#3389)
        // grava o header mesmo assim (status="error"). Aqui simulamos uma leitura
        // FRESCA diferente (quota_remaining=49 ainda, confirmado de novo — não é
        // eco do dia 9, é uma NOVA leitura do dia 13 que corrobora o mesmo estado).
        JSON.stringify({ timestamp: "2026-07-13T09:00:00Z", query: "q_edition_260713", status: "error", quota_remaining: 49, http_status: 402 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats("260713", path, now);
    // A leitura de 260713 (mesmo sendo "error") é a mais recente no arquivo —
    // confirma que o header foi consultado de novo hoje, não é eco de dias atrás.
    assert.equal(stats.quota_remaining_last_seen, 49);
    // CRÍTICO: a entrada error NÃO conta como query real — só as 1000 de 260709 contam.
    assert.equal(stats.queries_this_month_real, 1000, "entrada status=error não deve inflar o contador real");
    assert.equal(stats.queries_this_edition_real, 0, "a única entrada desta edição é status=error — não conta");
    assert.equal(stats.alert_level, "critical", "1951/2000 = 97.55% — critical é uma leitura FRESCA confirmada, não um eco congelado");
    // A leitura foi feita 3h antes de `now` (09:00 vs 12:00 do mesmo dia) — fresca.
    assert.equal(stats.quota_remaining_age_hours, 3, "leitura de hoje às 09:00, now=12:00 → 3h de idade");
    rmSync(path, { force: true });
  });

  it("caracterização do bug pré-#3389: sem a entrada error, o header trava numa leitura de dias atrás e o breakdown desta edição fica sem NENHUM registro", () => {
    const path = makeTmpPath();
    const now = new Date("2026-07-13T12:00:00Z");
    // Só a entrada de 260709 — reproduz o estado real reportado na issue #3389
    // (data/brave-credits.jsonl sem NENHUMA entrada nova desde 260709, pro guard
    // antigo que descartava respostas de erro mesmo com header presente).
    writeFileSync(
      path,
      [
        ...Array.from({ length: 999 }, (_, i) =>
          JSON.stringify({ timestamp: "2026-07-09T10:00:00Z", query: `q${i}`, status: "ok" }),
        ),
        JSON.stringify({ timestamp: "2026-07-09T10:05:00Z", query: "q999b", status: "ok", quota_remaining: 49 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats("260713", path, now);
    // O alerta ainda mostra critical (correto, o free tier de fato está esgotado),
    // mas ZERO evidência de que essa leitura foi reconfirmada nesta edição —
    // exatamente o sintoma relatado: brave-credits.jsonl "silencioso" desde 260709.
    assert.equal(stats.quota_remaining_last_seen, 49);
    assert.equal(stats.queries_this_edition, 0, "260713 não deixou NENHUM rastro no jsonl — o sintoma relatado na issue");
    assert.equal(stats.alert_level, "critical");
    // (#3389 defesa em profundidade) quota_remaining_age_hours EXPÕE que essa
    // leitura tem 4 dias (96h) — mesmo que o fix principal (gravar header em
    // erros) por algum motivo não capture uma leitura nova, o relatório agora
    // consegue sinalizar "isso é obsoleto" em vez de apresentar como corrente.
    assert.equal(stats.quota_remaining_age_hours, 97.9, "260709 10:05 até 260713 12:00 = ~98h de idade");
    rmSync(path, { force: true });
  });
});

describe("computeBraveCreditStats — quota_remaining_age_hours (#3389)", () => {
  it("ausente quando não há quota_remaining este mês", () => {
    const path = makeTmpPath();
    const now = new Date("2026-07-13T12:00:00Z");
    writeFileSync(
      path,
      JSON.stringify({ timestamp: "2026-07-13T10:00:00Z", query: "q1", status: "ok" }),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.quota_remaining_age_hours, undefined);
    rmSync(path, { force: true });
  });

  it("arredonda pra 1 casa decimal", () => {
    const path = makeTmpPath();
    const now = new Date("2026-07-13T12:15:00Z"); // 2h15min depois
    writeFileSync(
      path,
      JSON.stringify({ timestamp: "2026-07-13T10:00:00Z", query: "q1", status: "ok", quota_remaining: 100 }),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.quota_remaining_age_hours, 2.3, "2h15min = 2.25h, arredonda pra 2.3");
    rmSync(path, { force: true });
  });

  it("acompanha a entrada MAIS RECENTE com quota_remaining, não a primeira", () => {
    const path = makeTmpPath();
    const now = new Date("2026-07-13T12:00:00Z");
    writeFileSync(
      path,
      [
        JSON.stringify({ timestamp: "2026-07-10T00:00:00Z", query: "q_old", status: "ok", quota_remaining: 500 }),
        JSON.stringify({ timestamp: "2026-07-13T10:00:00Z", query: "q_new", status: "error", quota_remaining: 49, http_status: 402 }),
      ].join("\n"),
      "utf8",
    );
    const stats = computeBraveCreditStats(null, path, now);
    assert.equal(stats.quota_remaining_last_seen, 49, "deve usar a leitura mais recente (49), não a antiga (500)");
    assert.equal(stats.quota_remaining_age_hours, 2, "idade relativa à leitura mais recente (260713 10:00 → 12:00 = 2h)");
    rmSync(path, { force: true });
  });
});
