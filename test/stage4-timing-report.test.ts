/**
 * test/stage4-timing-report.test.ts (#8123 residual)
 *
 * Dois níveis:
 *
 * 1. **A instrumentação dispara de verdade** — sobe o servidor real com
 *    `--watch`, escreve no arquivo servido, e confere que a medição apareceu
 *    no run-log. É o teste que faltava: a Fatia 5 entregou um CLI que
 *    ninguém chamava, e nenhum teste percebeu porque todos exercitavam o
 *    cálculo, não o disparo.
 * 2. **O agregador degrada em vez de sumir** — sem a perna do modelo (o CLI
 *    da Fatia 5 não foi chamado), a tabela ainda reporta a perna automática.
 *    Era o que tornava a medição tudo-ou-nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startPreviewServer } from "../scripts/serve-preview.ts";
import { buildStage4TimingReport, renderStage4TimingReport, type RunLogEntry } from "../scripts/lib/stage4-timing-report.ts";

function readLog(root: string): RunLogEntry[] {
  const p = resolve(root, "data", "run-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunLogEntry);
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe("#8123 residual — o watcher MEDE sozinho, sem ninguém lembrar de medir", () => {
  it("escrever no arquivo servido grava a medição edição→preview no run-log", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-timing-"));
    const served = resolve(root, "served");
    mkdirSync(served, { recursive: true });
    const htmlPath = join(served, "preview.html");
    writeFileSync(htmlPath, "<html><body>v1</body></html>", "utf8");

    const server = await startPreviewServer({
      filePath: htmlPath,
      port: 0,
      watch: true,
      watchDebounceMs: 50,
      edition: "260918",
      timingLogRootDir: root,
    });
    try {
      // Um cliente SSE conectado — é o que o browser do editor faria.
      const controller = new AbortController();
      const sse = fetch(`${server.url.replace(/\/[^/]*$/, "")}/__live-reload`, { signal: controller.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 200));

      writeFileSync(htmlPath, "<html><body>v2 — ajuste do editor</body></html>", "utf8");

      const logged = await waitFor(() => readLog(root).some((e) => e.agent === "serve-preview"));
      assert.ok(logged, "o watcher tinha que ter gravado a medição sem nenhuma chamada extra");

      const entry = readLog(root).find((e) => e.agent === "serve-preview")!;
      assert.equal(entry.edition, "260918");
      assert.equal(entry.stage, 4);
      const ms = entry.details?.edit_to_preview_ms as number;
      assert.ok(typeof ms === "number" && ms >= 0, "mediu um delta numérico");
      assert.ok(ms < 10_000, `ciclo local tem que ficar bem abaixo da meta de 10s (foi ${ms}ms)`);
      assert.equal(entry.details?.within_target_10s, true);

      controller.abort();
      await sse;
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem cliente conectado ainda mede — e registra que ninguém estava olhando", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-timing-"));
    const served = resolve(root, "served");
    mkdirSync(served, { recursive: true });
    const htmlPath = join(served, "preview.html");
    writeFileSync(htmlPath, "<html>v1</html>", "utf8");

    const server = await startPreviewServer({
      filePath: htmlPath,
      port: 0,
      watch: true,
      watchDebounceMs: 50,
      timingLogRootDir: root,
    });
    try {
      writeFileSync(htmlPath, "<html>v2</html>", "utf8");
      const logged = await waitFor(() => readLog(root).some((e) => e.agent === "serve-preview"));
      assert.ok(logged, "medição é do SERVIDOR — não depende de ter aba aberta");
      const entry = readLog(root).find((e) => e.agent === "serve-preview")!;
      assert.equal(entry.details?.clients_notified, 0, "0 clientes fica registrado, não inferido");
      assert.equal(entry.edition, null, "sem --edition a medição continua válida");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem --watch não mede nada — a instrumentação não muda o comportamento de quem não a pediu", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-timing-"));
    const served = resolve(root, "served");
    mkdirSync(served, { recursive: true });
    const htmlPath = join(served, "preview.html");
    writeFileSync(htmlPath, "<html>v1</html>", "utf8");

    const server = await startPreviewServer({ filePath: htmlPath, port: 0, timingLogRootDir: root });
    try {
      writeFileSync(htmlPath, "<html>v2</html>", "utf8");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(readLog(root).filter((e) => e.agent === "serve-preview").length, 0);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#8123 residual — o relatório degrada em vez de sumir", () => {
  const cycle = (ms: number, edition = "260918"): RunLogEntry => ({
    timestamp: "2026-09-18T01:00:00.000Z",
    edition,
    stage: 4,
    agent: "serve-preview",
    details: { edit_to_preview_ms: ms, within_target_10s: ms <= 10_000, clients_notified: 1 },
  });

  it("só com a perna automática, a tabela sai e diz que a do modelo falta", () => {
    const report = buildStage4TimingReport([cycle(900), cycle(1500), cycle(1200)], "260918");
    assert.equal(report.previewCycles.length, 3);
    assert.equal(report.adjusts.length, 0);
    assert.equal(report.medianEditToPreviewMs, 1200, "mediana, não média — rajada de writes vira outlier");
    assert.equal(report.maxEditToPreviewMs, 1500);
    assert.equal(report.allWithinTarget, true);

    const md = renderStage4TimingReport(report);
    assert.match(md, /Mediana: \*\*1\.2 s\*\*/);
    assert.match(md, /Sem medição.*log-stage4-adjust-timing/s, "diz QUAL perna falta e de quem depende");
  });

  it("com as duas pernas, a tabela por ajuste aparece", () => {
    const report = buildStage4TimingReport(
      [
        cycle(800),
        {
          timestamp: "2026-09-18T01:05:00.000Z",
          edition: "260918",
          stage: 4,
          agent: "orchestrator",
          details: { description: "troca título D2", requestToEditMs: 22_000, editToPreviewMs: 800, requestToPreviewMs: 22_800, toolCalls: 2 },
        },
      ],
      "260918",
    );
    assert.equal(report.adjusts.length, 1);
    const md = renderStage4TimingReport(report);
    assert.match(md, /troca título D2/);
    assert.match(md, /22\.0 s/);
  });

  it("medição fora da meta é contada como fora — o relatório não maquia", () => {
    const report = buildStage4TimingReport([cycle(500), cycle(45_000)], "260918");
    assert.equal(report.withinTargetCount, 1);
    assert.equal(report.allWithinTarget, false);
    assert.equal(report.maxEditToPreviewMs, 45_000);
  });

  it("filtra por edição — medição de outra edição não contamina o relatório", () => {
    const report = buildStage4TimingReport([cycle(500, "260918"), cycle(9_000, "260917")], "260918");
    assert.equal(report.previewCycles.length, 1);
    assert.equal(report.medianEditToPreviewMs, 500);
  });

  it("linha malformada do run-log é ignorada, nunca derruba o relatório", () => {
    const entries = [
      { agent: "serve-preview", details: null },
      { agent: "serve-preview" },
      { agent: "serve-preview", details: { edit_to_preview_ms: "não é número" } },
      cycle(700),
    ] as RunLogEntry[];
    const report = buildStage4TimingReport(entries, "260918");
    assert.equal(report.previewCycles.length, 1);
  });

  it("run-log sem nenhuma medição diz isso explicitamente, em vez de tabela vazia", () => {
    const md = renderStage4TimingReport(buildStage4TimingReport([], null));
    assert.match(md, /Nenhuma medição/);
  });
});
