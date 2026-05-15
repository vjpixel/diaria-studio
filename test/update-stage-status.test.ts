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
  renderStageStatus,
  parseStageStatus,
  loadDoc,
  saveDoc,
  STAGES,
  type StageStatusDoc,
} from "../scripts/update-stage-status.ts";

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
