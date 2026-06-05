/**
 * test/update-stage-status.test.ts (#960)
 *
 * Cobre helpers puros + integração CLI do stage-status.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  makeInitialDoc,
  applyUpdate,
  computeDurationMs,
  renderStageStatus,
  parseStageStatus,
  loadDoc,
  saveDoc,
  STAGES,
  type StageStatusDoc,
} from "../scripts/update-stage-status.ts";

describe("computeDurationMs (#1706) — auto-computa, trata 0 como não-medido", () => {
  const emptyRow = { stage: 1, status: "done" as const };
  it("duration_ms > 0 passado é usado", () => {
    assert.equal(computeDurationMs({ stage: 1, status: "done", duration_ms: 5000 }, emptyRow), 5000);
  });
  it("duration_ms 0 + start/end → computa end - start (não fica 0)", () => {
    const ms = computeDurationMs(
      { stage: 1, status: "done", duration_ms: 0, start: "2026-06-02T10:00:00Z", end: "2026-06-02T10:03:00Z" },
      emptyRow,
    );
    assert.equal(ms, 180000); // 3 min
  });
  it("duration_ms ausente + start/end → computa", () => {
    const ms = computeDurationMs(
      { stage: 1, status: "done", start: "2026-06-02T10:00:00Z", end: "2026-06-02T10:01:30Z" },
      emptyRow,
    );
    assert.equal(ms, 90000);
  });
  it("0 não sobrescreve valor já computado antes (existing)", () => {
    const ms = computeDurationMs(
      { stage: 1, status: "done", duration_ms: 0 },
      { stage: 1, status: "done", duration_ms: 120000 },
    );
    assert.equal(ms, 120000);
  });
  it("sem dados → undefined (report mostra '(não medido)')", () => {
    assert.equal(computeDurationMs({ stage: 1, status: "done" }, emptyRow), undefined);
  });
  it("#1783: running auto-carimba start; done auto-carimba end → duração sem o playbook passar timestamps", () => {
    let doc = makeInitialDoc("260603");
    // Stage 1 entra em running sem --start; auto-carimba.
    doc = applyUpdate(doc, { stage: 1, status: "running" }, "2026-06-03T10:00:00.000Z");
    const r1 = doc.rows.find((r) => r.stage === 1)!;
    assert.equal(r1.start, "2026-06-03T10:00:00.000Z");
    assert.equal(r1.end, undefined);
    // Stage 1 conclui sem --end; auto-carimba e duração computa.
    doc = applyUpdate(doc, { stage: 1, status: "done" }, "2026-06-03T10:05:00.000Z");
    const r1done = doc.rows.find((r) => r.stage === 1)!;
    assert.equal(r1done.end, "2026-06-03T10:05:00.000Z");
    assert.equal(r1done.duration_ms, 300000); // 5 min
  });

  it("#1783: não sobrescreve start existente em resume (preserva o original)", () => {
    let doc = makeInitialDoc("260603");
    doc = applyUpdate(doc, { stage: 2, status: "running" }, "2026-06-03T10:00:00.000Z");
    // Resume: re-marca running mais tarde — start original preservado.
    doc = applyUpdate(doc, { stage: 2, status: "running" }, "2026-06-03T11:00:00.000Z");
    assert.equal(doc.rows.find((r) => r.stage === 2)!.start, "2026-06-03T10:00:00.000Z");
  });

  it("#1783: failed também carimba end", () => {
    let doc = makeInitialDoc("260603");
    doc = applyUpdate(doc, { stage: 3, status: "running" }, "2026-06-03T10:00:00.000Z");
    doc = applyUpdate(doc, { stage: 3, status: "failed" }, "2026-06-03T10:02:00.000Z");
    const r = doc.rows.find((r) => r.stage === 3)!;
    assert.equal(r.end, "2026-06-03T10:02:00.000Z");
    assert.equal(r.duration_ms, 120000);
  });

  it("#1783: sem `now` (chamada legada) NÃO auto-carimba — retrocompat", () => {
    let doc = makeInitialDoc("260603");
    doc = applyUpdate(doc, { stage: 1, status: "running" });
    assert.equal(doc.rows.find((r) => r.stage === 1)!.start, undefined);
  });

  /** Captura console.error durante `fn`. */
  function captureStderr(fn: () => void): string[] {
    const orig = console.error;
    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { fn(); } finally { console.error = orig; }
    return lines;
  }

  it("#1853: done com --end SEM start prévio → backfill start do end do stage anterior + warn", () => {
    // Caso 260604: stage 2 marcado done com --end mas mark-running pulado.
    let doc = makeInitialDoc("260604");
    doc = applyUpdate(doc, { stage: 1, status: "running" }, "2026-06-03T18:00:00.000Z");
    doc = applyUpdate(doc, { stage: 1, status: "done" }, "2026-06-03T18:10:00.000Z");
    let r2!: ReturnType<typeof doc.rows.find>;
    const warns = captureStderr(() => {
      doc = applyUpdate(doc, { stage: 2, status: "done", end: "2026-06-03T18:22:00.000Z" });
      r2 = doc.rows.find((r) => r.stage === 2);
    });
    // start backfillado do end do stage 1 (18:10) → duração = 12 min, não vazia.
    assert.equal(r2!.start, "2026-06-03T18:10:00.000Z");
    assert.equal(r2!.duration_ms, 12 * 60 * 1000);
    // #1853 (issue): warn `stage_start_backfilled` emitido.
    assert.ok(warns.some((l) => l.includes("stage_start_backfilled")), "warn de backfill deve ser emitido");
  });

  it("#1853: sem end de stage anterior VÁLIDO (< end) → NÃO inventa start, warn unbackfillable", () => {
    let doc = makeInitialDoc("260604");
    // Stage 1 direto pra done com --end, sem stage anterior com end.
    let r1!: ReturnType<typeof doc.rows.find>;
    const warns = captureStderr(() => {
      doc = applyUpdate(doc, { stage: 1, status: "done", end: "2026-06-03T18:00:00.000Z" });
      r1 = doc.rows.find((r) => r.stage === 1);
    });
    assert.equal(r1!.start, undefined); // não inventa start=end (daria dur 0, inútil)
    assert.equal(r1!.duration_ms, undefined);
    assert.ok(warns.some((l) => l.includes("stage_start_unbackfillable")), "warn honesto deve ser emitido");
  });

  it("#1853: end do stage anterior DEPOIS do end deste (skew/out-of-order) → não backfila (sem start>end)", () => {
    let doc = makeInitialDoc("260604");
    // Stage 1 termina 18:30 (tarde); stage 2 done com end 18:22 (antes).
    doc = applyUpdate(doc, { stage: 1, status: "done", end: "2026-06-03T18:30:00.000Z", start: "2026-06-03T18:00:00.000Z" });
    doc = applyUpdate(doc, { stage: 2, status: "done", end: "2026-06-03T18:22:00.000Z" });
    const r2 = doc.rows.find((r) => r.stage === 2)!;
    // prevEnd (18:30) > end (18:22) → não usa → start fica undefined (não start>end).
    assert.equal(r2.start, undefined);
    assert.equal(r2.duration_ms, undefined);
  });

  it("#1853: NÃO backfila quando já há start (preserva duração real)", () => {
    let doc = makeInitialDoc("260604");
    doc = applyUpdate(doc, { stage: 2, status: "running" }, "2026-06-03T10:00:00.000Z");
    doc = applyUpdate(doc, { stage: 2, status: "done", end: "2026-06-03T10:30:00.000Z" });
    const r2 = doc.rows.find((r) => r.stage === 2)!;
    assert.equal(r2.start, "2026-06-03T10:00:00.000Z"); // start original, não backfillado
    assert.equal(r2.duration_ms, 30 * 60 * 1000);
  });

  it("#1783: --start/--end explícitos têm precedência sobre o auto-carimbo", () => {
    let doc = makeInitialDoc("260603");
    doc = applyUpdate(doc, { stage: 1, status: "running", start: "2026-06-03T09:00:00.000Z" }, "2026-06-03T10:00:00.000Z");
    assert.equal(doc.rows.find((r) => r.stage === 1)!.start, "2026-06-03T09:00:00.000Z");
  });

  it("integração: applyUpdate com --duration-ms 0 + start/end grava duração real", () => {
    let doc = makeInitialDoc("260602");
    doc = applyUpdate(doc, {
      stage: 1,
      status: "done",
      start: "2026-06-02T08:00:00Z",
      end: "2026-06-02T08:12:00Z",
      duration_ms: 0, // o orchestrator passava isso — não deve virar 0
    });
    const row = doc.rows.find((r) => r.stage === 1)!;
    assert.equal(row.duration_ms, 720000); // 12 min, não 0
  });
});

describe("makeInitialDoc (#960)", () => {
  it("cria doc com 5 stages todos pending", () => {
    const doc = makeInitialDoc("260508");
    assert.equal(doc.edition, "260508");
    assert.equal(doc.rows.length, STAGES.length);
    for (const r of doc.rows) {
      assert.equal(r.status, "pending");
    }
    assert.deepEqual(
      doc.rows.map((r) => r.stage),
      [0, 1, 2, 3, 4],
    );
  });

  it("#1304: seta run_started_at automaticamente quando não passado", () => {
    const before = Date.now();
    const doc = makeInitialDoc("260508");
    const after = Date.now();
    assert.ok(doc.run_started_at, "run_started_at deve estar setado");
    const ms = new Date(doc.run_started_at!).getTime();
    assert.ok(ms >= before && ms <= after, "timestamp dentro da janela de chamada");
  });

  it("#1304: respeita run_started_at explícito quando passado", () => {
    const explicit = "2026-05-15T14:00:00Z";
    const doc = makeInitialDoc("260516", explicit);
    assert.equal(doc.run_started_at, explicit);
  });
});

describe("applyUpdate run_started_at preservation (#1304)", () => {
  it("preserva run_started_at em updates subsequentes", () => {
    const initial = "2026-05-15T14:00:00Z";
    let doc = makeInitialDoc("260516", initial);
    doc = applyUpdate(doc, { stage: 1, status: "done" });
    doc = applyUpdate(doc, { stage: 2, status: "done", duration_ms: 100 });
    assert.equal(doc.run_started_at, initial, "run_started_at sobrevive múltiplos updates");
  });

  it("#1306-followup: applyUpdate em doc legado (sem run_started_at) preserva ausência", () => {
    // Doc estilo pré-#1304 — não tem o campo run_started_at. Forçando o tipo
    // pra simular state pós-load de um stage-status.json antigo no disco.
    const legacyDoc: StageStatusDoc = {
      edition: "260424",
      rows: STAGES.map((s) => ({ stage: s, status: "pending" })),
      generated_at: "2026-04-24T12:00:00Z",
      // run_started_at intencionalmente ausente
    };
    const updated = applyUpdate(legacyDoc, { stage: 1, status: "done" });
    assert.equal(
      updated.run_started_at,
      undefined,
      "doc legado mantém ausência do field após update",
    );
    // E confirma que o update do stage funcionou normalmente
    assert.equal(updated.rows.find((r) => r.stage === 1)?.status, "done");
  });
});

describe("applyUpdate (#960)", () => {
  it("atualiza só a linha do stage especificado", () => {
    const doc = makeInitialDoc("260508");
    const updated = applyUpdate(doc, {
      stage: 1,
      status: "done",
      cost_usd: 0.45,
      duration_ms: 16 * 60 * 1000,
    });
    const stage1 = updated.rows.find((r) => r.stage === 1);
    assert.equal(stage1?.status, "done");
    assert.equal(stage1?.cost_usd, 0.45);
    // Stage 0 e 2-4 ainda pending
    for (const stage of [0, 2, 3, 4]) {
      assert.equal(updated.rows.find((r) => r.stage === stage)?.status, "pending");
    }
  });

  it("preserva campos não-passados em update parcial", () => {
    let doc = makeInitialDoc("260508");
    doc = applyUpdate(doc, {
      stage: 1,
      status: "running",
      start: "2026-05-08T08:30:00Z",
    });
    doc = applyUpdate(doc, {
      stage: 1,
      status: "done",
      end: "2026-05-08T08:48:00Z",
      duration_ms: 18 * 60 * 1000,
      cost_usd: 0.45,
    });
    const stage1 = doc.rows.find((r) => r.stage === 1);
    assert.equal(stage1?.status, "done");
    assert.equal(stage1?.start, "2026-05-08T08:30:00Z", "preserva start do update anterior");
    assert.equal(stage1?.end, "2026-05-08T08:48:00Z");
    assert.equal(stage1?.cost_usd, 0.45);
  });
});

describe("renderStageStatus (#960)", () => {
  it("inclui header + 5 linhas + total", () => {
    const doc = makeInitialDoc("260508");
    const md = renderStageStatus(doc);
    assert.match(md, /# Stage Status — edição 260508/);
    assert.match(md, /\*\*Total\*\*/);
    // 5 stages + header
    const tableRows = (md.match(/^\|\s*\d+\s*\|/gm) ?? []).length;
    assert.equal(tableRows, 5, "uma linha por stage 0-4");
  });

  it("formato BRT timestamp na coluna de início", () => {
    const doc = applyUpdate(makeInitialDoc("260508"), {
      stage: 1,
      status: "done",
      start: "2026-05-08T08:30:00Z", // = 05:30 BRT
      end: "2026-05-08T08:48:00Z", // = 05:48 BRT
      duration_ms: 18 * 60 * 1000,
    });
    const md = renderStageStatus(doc);
    assert.match(md, /05:30/);
    assert.match(md, /05:48/);
    assert.match(md, /18m/);
  });

  it("formato custos: <$0.01 mostra 4 decimais", () => {
    const doc = applyUpdate(makeInitialDoc("260508"), {
      stage: 0,
      status: "done",
      cost_usd: 0.0023,
    });
    const md = renderStageStatus(doc);
    assert.match(md, /\$0\.0023/);
  });

  it("totaliza linha 'Total'", () => {
    let doc = makeInitialDoc("260508");
    doc = applyUpdate(doc, { stage: 0, status: "done", duration_ms: 60000, cost_usd: 0.001 });
    doc = applyUpdate(doc, { stage: 1, status: "done", duration_ms: 60000, cost_usd: 0.45 });
    const md = renderStageStatus(doc);
    // Total: 2m | $0.451 | -
    assert.match(md, /\*\*Total\*\*.*2m.*\$0\.451/);
  });
});

describe("parseStageStatus (#960)", () => {
  it("round-trip: render → parse preserva edition + stage statuses", () => {
    let doc = makeInitialDoc("260508");
    doc = applyUpdate(doc, { stage: 0, status: "done" });
    doc = applyUpdate(doc, { stage: 1, status: "running" });

    const md = renderStageStatus(doc);
    const parsed = parseStageStatus(md);
    assert.ok(parsed);
    assert.equal(parsed?.edition, "260508");
    assert.equal(parsed?.rows.find((r) => r.stage === 0)?.status, "done");
    assert.equal(parsed?.rows.find((r) => r.stage === 1)?.status, "running");
    assert.equal(parsed?.rows.find((r) => r.stage === 2)?.status, "pending");
  });

  it("retorna null em MD inválido", () => {
    assert.equal(parseStageStatus("texto qualquer"), null);
  });
});

describe("update-stage-status CLI (#960)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "update-stage-status.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--init cria stage-status.md com 5 stages pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-init-"));
    try {
      const editionDir = join(dir, "260508");
      mkdirSync(editionDir, { recursive: true });
      const r = runCli(["--edition-dir", editionDir, "--init"]);
      assert.equal(r.status, 0, r.stderr);
      const path = join(editionDir, "stage-status.md");
      assert.ok(existsSync(path));
      const md = readFileSync(path, "utf8");
      assert.match(md, /# Stage Status — edição 260508/);
      // 5 linhas pending
      const pendingCount = (md.match(/pending/g) ?? []).length;
      assert.ok(pendingCount >= 5);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("update incremental: stage 1 done → preserva pending nos demais", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-update-"));
    try {
      const editionDir = join(dir, "260508");
      mkdirSync(editionDir, { recursive: true });
      runCli(["--edition-dir", editionDir, "--init"]);
      const r = runCli([
        "--edition-dir",
        editionDir,
        "--stage",
        "1",
        "--status",
        "done",
        "--duration-ms",
        "1080000",
        "--cost-usd",
        "0.45",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const md = readFileSync(join(editionDir, "stage-status.md"), "utf8");
      assert.match(md, /\| 1 \| Pesquisa \| done/);
      // Stage 0 ainda pending
      assert.match(md, /\| 0 \| Setup \+ dedup \| pending/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("idempotência: re-rodar com mesmo stage atualiza, não duplica", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-idem-"));
    try {
      const editionDir = join(dir, "260508");
      mkdirSync(editionDir, { recursive: true });
      runCli(["--edition-dir", editionDir, "--init"]);
      runCli([
        "--edition-dir",
        editionDir,
        "--stage",
        "1",
        "--status",
        "running",
      ]);
      runCli([
        "--edition-dir",
        editionDir,
        "--stage",
        "1",
        "--status",
        "done",
      ]);
      const md = readFileSync(join(editionDir, "stage-status.md"), "utf8");
      // Apenas uma linha pra Stage 1, com status "done"
      const stage1Lines = md.split("\n").filter((l) => /^\|\s*1\s*\|/.test(l));
      assert.equal(stage1Lines.length, 1);
      assert.match(stage1Lines[0], /done/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1216: --start preservado em update subsequente que só passa --end", () => {
    // Regressão: pre-#1216, parseStageStatus perdia start/end ao re-ler
    // MD, então o 2º update (--end ISO_B sem --start) sobrescrevia com
    // undefined. Resultado: MD final mostrava "-" no Início.
    // Com JSON sidecar, a leitura preserva todos campos.
    const dir = mkdtempSync(join(tmpdir(), "stage-status-1216-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir, { recursive: true });
      runCli(["--edition-dir", editionDir, "--init"]);
      runCli([
        "--edition-dir", editionDir,
        "--stage", "1",
        "--status", "running",
        "--start", "2026-05-13T02:50:00Z",
      ]);
      runCli([
        "--edition-dir", editionDir,
        "--stage", "1",
        "--status", "done",
        "--end", "2026-05-13T03:00:00Z",
      ]);
      const md = readFileSync(join(editionDir, "stage-status.md"), "utf8");
      // Início (BRT) deve ter persistido: 02:50 UTC = 23:50 BRT (dia anterior)
      assert.match(md, /\| 1 \| Pesquisa \| done \| 23:50 \|/, "Início preservado");
      assert.match(md, /\| 00:00 \|/, "Fim presente");

      // E o JSON sidecar deve ter os ISOs canônicos
      const jsonPath = join(editionDir, "_internal", "stage-status.json");
      assert.ok(existsSync(jsonPath), "JSON sidecar criado");
      const doc = JSON.parse(readFileSync(jsonPath, "utf8")) as StageStatusDoc;
      const s1 = doc.rows.find((r) => r.stage === 1);
      assert.equal(s1?.start, "2026-05-13T02:50:00Z");
      assert.equal(s1?.end, "2026-05-13T03:00:00Z");
      assert.equal(s1?.status, "done");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#1530: Stage 4 done bloqueado sem edition-report.html", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-1530-"));
    try {
      const editionDir = join(dir, "260527");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      runCli(["--edition-dir", editionDir, "--init"]);

      // Without report → exit 1
      const r1 = runCli([
        "--edition-dir", editionDir,
        "--stage", "4",
        "--status", "done",
      ]);
      assert.equal(r1.status, 1, "should block stage 4 done without report");
      assert.match(r1.stderr, /edition-report\.html/);

      // With report → exit 0
      writeFileSync(join(editionDir, "_internal", "edition-report.html"), "<html>report</html>");
      const r2 = runCli([
        "--edition-dir", editionDir,
        "--stage", "4",
        "--status", "done",
      ]);
      assert.equal(r2.status, 0, r2.stderr);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("loadDoc/saveDoc (#1216)", () => {
  it("round-trip JSON sidecar preserva todos campos", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-rt-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir, { recursive: true });
      let doc = makeInitialDoc("260517");
      doc = applyUpdate(doc, {
        stage: 1,
        status: "done",
        start: "2026-05-13T02:50:00Z",
        end: "2026-05-13T03:00:00Z",
        duration_ms: 10 * 60 * 1000,
        cost_usd: 0.234,
        tokens_in: 12000,
        tokens_out: 850,
        models: ["haiku-4-5", "opus-4-7"],
      });
      saveDoc(editionDir, doc);

      const reloaded = loadDoc(editionDir, "260517");
      const s1 = reloaded.rows.find((r) => r.stage === 1)!;
      assert.equal(s1.status, "done");
      assert.equal(s1.start, "2026-05-13T02:50:00Z");
      assert.equal(s1.end, "2026-05-13T03:00:00Z");
      assert.equal(s1.duration_ms, 10 * 60 * 1000);
      assert.equal(s1.cost_usd, 0.234);
      assert.equal(s1.tokens_in, 12000);
      assert.equal(s1.tokens_out, 850);
      assert.deepEqual(s1.models, ["haiku-4-5", "opus-4-7"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("loadDoc fallback: só MD existe → parseStageStatus legacy", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-fallback-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir, { recursive: true });
      const legacyMd = renderStageStatus(
        applyUpdate(makeInitialDoc("260517"), { stage: 1, status: "running" })
      );
      writeFileSync(join(editionDir, "stage-status.md"), legacyMd, "utf8");

      const reloaded = loadDoc(editionDir, "260517");
      assert.equal(reloaded.edition, "260517");
      assert.equal(reloaded.rows.find((r) => r.stage === 1)?.status, "running");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("loadDoc fallback: nenhum arquivo → makeInitialDoc", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-empty-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir, { recursive: true });
      const reloaded = loadDoc(editionDir, "260517");
      assert.equal(reloaded.edition, "260517");
      assert.equal(reloaded.rows.length, 5);
      for (const r of reloaded.rows) assert.equal(r.status, "pending");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("loadDoc: JSON sidecar ganha sobre MD se ambos existem", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-status-priority-"));
    try {
      const editionDir = join(dir, "260517");
      mkdirSync(editionDir, { recursive: true });
      mkdirSync(join(editionDir, "_internal"), { recursive: true });

      // JSON: stage 1 done com cost
      const jsonDoc = applyUpdate(makeInitialDoc("260517"), {
        stage: 1, status: "done", cost_usd: 0.45,
      });
      writeFileSync(
        join(editionDir, "_internal", "stage-status.json"),
        JSON.stringify(jsonDoc),
        "utf8",
      );

      // MD: stage 1 running (stale)
      const staleDoc = applyUpdate(makeInitialDoc("260517"), {
        stage: 1, status: "running",
      });
      writeFileSync(
        join(editionDir, "stage-status.md"),
        renderStageStatus(staleDoc),
        "utf8",
      );

      const reloaded = loadDoc(editionDir, "260517");
      const s1 = reloaded.rows.find((r) => r.stage === 1)!;
      assert.equal(s1.status, "done", "JSON sidecar vence (canonical)");
      assert.equal(s1.cost_usd, 0.45, "cost_usd só está no JSON");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
