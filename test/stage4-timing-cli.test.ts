/**
 * test/stage4-timing-cli.test.ts (#8313 review)
 *
 * Fecha os achados de cobertura do review do PR #8313 — todos da MESMA
 * família do defeito que o #8123 residual existe pra corrigir:
 *
 * - **achado 8 (P1):** `report-stage4-timing.ts` tinha o miolo puro testado e
 *   a INVOCAÇÃO não. É literalmente "CLI entregue que ninguém chama passa por
 *   CI", uma CLI ao lado da que motivou o trabalho. Aqui ela roda por
 *   subprocesso de verdade, com `--json`, `--edition` e run-log ausente.
 * - **achado 1 (P1):** o watcher observa o diretório inteiro (certo — asset
 *   relativo também deve recarregar), mas MEDIR o diretório inteiro
 *   contaminaria a mediana com escrita de arquivo irmão (`--persist-to`,
 *   `stage4-post-edit-checks.json`). A medição passou a exigir mudança de
 *   mtime do arquivo servido; este teste prova isso.
 * - **achados 6 e 7:** "uma medição por rajada, não por write" e "o estado da
 *   rajada reinicia" eram afirmações de comentário sem teste.
 * - **achado 9:** linha truncada de verdade (append concorrente), não só
 *   objeto com campo errado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { startPreviewServer } from "../scripts/serve-preview.ts";
import { buildStage4TimingReport, type RunLogEntry } from "../scripts/lib/stage4-timing-report.ts";
import { readRunLog } from "../scripts/report-stage4-timing.ts";

const CLI = resolve(import.meta.dirname, "..", "scripts", "report-stage4-timing.ts");

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

function runCli(root: string, args: string[] = []): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "--root-dir", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? "", status: r.status };
}

function seedLog(root: string, entries: object[]): void {
  mkdirSync(resolve(root, "data"), { recursive: true });
  writeFileSync(resolve(root, "data", "run-log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("#8313 achado 8 — a CLI de relatório é exercitada, não só o miolo", () => {
  it("run-log ausente: exit 0 e diz que não há medição, em vez de estourar", () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-cli-"));
    try {
      const { stdout, status } = runCli(root);
      assert.equal(status, 0);
      assert.match(stdout, /Nenhuma medição/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--json devolve JSON parseável com a forma de Stage4TimingReport", () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-cli-"));
    try {
      seedLog(root, [
        {
          timestamp: "2026-09-18T01:00:00.000Z",
          edition: "260918",
          stage: 4,
          agent: "serve-preview",
          details: { edit_to_preview_ms: 1200, within_target_10s: true, clients_notified: 1 },
        },
      ]);
      const { stdout, status } = runCli(root, ["--json"]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.previewCycles.length, 1);
      assert.equal(parsed.medianEditToPreviewMs, 1200);
      assert.equal(parsed.allWithinTarget, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--edition filtra no caminho da CLI, não só na função pura", () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-cli-"));
    try {
      seedLog(root, [
        { edition: "260918", agent: "serve-preview", details: { edit_to_preview_ms: 500, within_target_10s: true } },
        { edition: "260917", agent: "serve-preview", details: { edit_to_preview_ms: 40000, within_target_10s: false } },
      ]);
      const { stdout } = runCli(root, ["--edition", "260918", "--json"]);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.previewCycles.length, 1);
      assert.equal(parsed.maxEditToPreviewMs, 500, "medição de outra edição não pode contaminar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("achado 9 — linha TRUNCADA (append concorrente) é pulada pelo readRunLog real", () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-cli-"));
    try {
      mkdirSync(resolve(root, "data"), { recursive: true });
      const good = JSON.stringify({
        edition: "260918",
        agent: "serve-preview",
        details: { edit_to_preview_ms: 700, within_target_10s: true },
      });
      // JSON cortado no meio — o caso que o try/catch do readRunLog cita como
      // motivo de existir, e que o teste do miolo não cobria (ele passava
      // objetos JS já válidos).
      const truncated = '{"edition":"260918","agent":"serve-pre';
      writeFileSync(resolve(root, "data", "run-log.jsonl"), `${good}\n${truncated}\n`, "utf8");

      const entries = readRunLog(resolve(root, "data", "run-log.jsonl"));
      assert.equal(entries.length, 1, "a linha boa sobrevive, a truncada é descartada");
      assert.equal(runCli(root, ["--json"]).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem amostra, allWithinTarget é null — nunca false, que leria como meta perdida", () => {
    const report = buildStage4TimingReport([], null);
    assert.equal(report.allWithinTarget, null);
    assert.equal(report.medianEditToPreviewMs, null);
  });
});

describe("#8313 achado 1 — mede o ARQUIVO SERVIDO, não o diretório observado", () => {
  async function serve(root: string, debounceMs = 50) {
    const served = resolve(root, "served");
    mkdirSync(served, { recursive: true });
    const htmlPath = join(served, "preview.html");
    writeFileSync(htmlPath, "<html>v1</html>", "utf8");
    const server = await startPreviewServer({
      filePath: htmlPath,
      port: 0,
      watch: true,
      watchDebounceMs: debounceMs,
      timingLogRootDir: root,
    });
    return { server, htmlPath, served };
  }

  it("escrita de arquivo IRMÃO no diretório NÃO gera medição", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-sibling-"));
    const { server, served } = await serve(root);
    try {
      // É o que `--persist-to` faz segundos depois do start, e o que
      // `stage4-post-edit-checks.json` faz entre ajustes. Sem o escopo por
      // mtime do arquivo servido, cada um viraria uma amostra "rapidíssima"
      // dentro da mediana do loop de ajuste.
      writeFileSync(join(served, "04-newsletter-url.json"), JSON.stringify({ newsletter_url: "http://x" }), "utf8");
      await new Promise((r) => setTimeout(r, 600));
      const cycles = readLog(root).filter((e) => e.agent === "serve-preview");
      assert.equal(cycles.length, 0, "arquivo irmão pode recarregar o browser, mas não é latência de ajuste");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("achado 6 — rajada de writes no arquivo servido gera UMA medição, não N", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-burst-"));
    const { server, htmlPath } = await serve(root, 200);
    try {
      for (let i = 0; i < 5; i++) writeFileSync(htmlPath, `<html>v${i}</html>`, "utf8");
      await waitFor(() => readLog(root).some((e) => e.agent === "serve-preview"));
      await new Promise((r) => setTimeout(r, 600));
      const cycles = readLog(root).filter((e) => e.agent === "serve-preview");
      assert.equal(cycles.length, 1, `o debounce tem que coalescer a rajada (saíram ${cycles.length} medições)`);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("achado 7 — duas rajadas separadas geram medições independentes", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-restart-"));
    const { server, htmlPath } = await serve(root, 50);
    try {
      writeFileSync(htmlPath, "<html>v2</html>", "utf8");
      await waitFor(() => readLog(root).filter((e) => e.agent === "serve-preview").length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(htmlPath, "<html>v3</html>", "utf8");
      const two = await waitFor(() => readLog(root).filter((e) => e.agent === "serve-preview").length >= 2);
      assert.ok(two, "o estado da rajada precisa reiniciar, não ficar preso depois da 1ª medição");
      const cycles = readLog(root).filter((e) => e.agent === "serve-preview");
      assert.notEqual(
        String(cycles[0].details?.file_changed_at),
        String(cycles[1].details?.file_changed_at),
        "a 2ª medição não pode carregar o timestamp da 1ª",
      );
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
