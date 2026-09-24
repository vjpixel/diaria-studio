/**
 * test/stage4-cascade-status-cli.test.ts (#8123 Fatia 4; multi-highlight #8783)
 *
 * Testes de CLI (subprocess) do wrapper `scripts/stage4-cascade-status.ts`:
 * --start/--mark/--status/--clear/--apply-badge, exit codes, e o arquivo
 * `_internal/stage4-cascade-status.json` gravado no disco — agora um MAPA
 * `{ [highlight]: entry }` em vez de um único objeto (#8783).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "stage4-cascade-status.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

function withEditionDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "stage4-cascade-cli-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stage4-cascade-status.ts CLI", () => {
  it("--edition-dir ausente: exit 2", () => {
    const result = runCli(["--start", "--highlight", "d1", "--pieces", "image"]);
    assert.equal(result.status, 2);
  });

  it("--status sem cascata: exit 0, active:false", () => {
    withEditionDir((dir) => {
      const result = runCli(["--edition-dir", dir, "--status"]);
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.active, false);
      assert.equal(parsed.pending, false);
    });
  });

  it("--start grava o arquivo (mapa por highlight) e --status reporta pending:true (exit 1)", () => {
    withEditionDir((dir) => {
      const start = runCli([
        "--edition-dir",
        dir,
        "--start",
        "--highlight",
        "d1",
        "--pieces",
        "image,carousel,social",
        "--reason",
        "título alterado",
      ]);
      assert.equal(start.status, 0);
      const written = JSON.parse(
        readFileSync(join(dir, "_internal", "stage4-cascade-status.json"), "utf8"),
      );
      assert.deepEqual(written.d1.pieces, { image: "pending", carousel: "pending", social: "pending" });

      const status = runCli(["--edition-dir", dir, "--status"]);
      assert.equal(status.status, 1); // informativo — algo pendente
      const parsed = JSON.parse(status.stdout);
      assert.equal(parsed.pending, true);
      assert.equal(parsed.active, true);
    });
  });

  it("--start sem --pieces reconhecível: exit 2", () => {
    withEditionDir((dir) => {
      const result = runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "xyz"]);
      assert.equal(result.status, 2);
    });
  });

  it("--mark transiciona a peça e --status volta a exit 0 quando tudo resolve", () => {
    withEditionDir((dir) => {
      runCli(["--edition-dir", dir, "--start", "--highlight", "d2", "--pieces", "image"]);
      const mark = runCli(["--edition-dir", dir, "--mark", "--highlight", "d2", "--piece", "image", "--state", "done"]);
      assert.equal(mark.status, 0);
      const status = runCli(["--edition-dir", dir, "--status"]);
      assert.equal(status.status, 0);
      assert.equal(JSON.parse(status.stdout).pending, false);
    });
  });

  it("--clear remove o arquivo inteiro quando sem --highlight", () => {
    withEditionDir((dir) => {
      runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "image"]);
      const cleared = runCli(["--edition-dir", dir, "--clear"]);
      assert.equal(cleared.status, 0);
      const status = runCli(["--edition-dir", dir, "--status"]);
      assert.equal(JSON.parse(status.stdout).active, false);
    });
  });

  it("--apply-badge injeta o banner no HTML enquanto pendente, e remove quando resolvido", () => {
    withEditionDir((dir) => {
      const htmlPath = join(dir, "preview.html");
      writeFileSync(htmlPath, "<html><body><h1>D1</h1></body></html>", "utf8");

      runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "social"]);
      const applied = runCli(["--edition-dir", dir, "--apply-badge", "--html", htmlPath]);
      assert.equal(applied.status, 0);
      assert.equal(JSON.parse(applied.stdout).applied, true);
      const htmlWithBadge = readFileSync(htmlPath, "utf8");
      assert.match(htmlWithBadge, /regenerando em segundo plano/);
      assert.match(htmlWithBadge, /<h1>D1<\/h1>/);

      runCli(["--edition-dir", dir, "--mark", "--highlight", "d1", "--piece", "social", "--state", "done"]);
      const cleared = runCli(["--edition-dir", dir, "--apply-badge", "--html", htmlPath]);
      assert.equal(JSON.parse(cleared.stdout).applied, false);
      const htmlWithoutBadge = readFileSync(htmlPath, "utf8");
      assert.doesNotMatch(htmlWithoutBadge, /regenerando em segundo plano/);
      assert.match(htmlWithoutBadge, /<h1>D1<\/h1>/);
    });
  });

  describe("múltiplos highlights concorrentes (#8783 regressão — reprodução exata da issue)", () => {
    it("--start --highlight d1 seguido de --start --highlight d2 mantém AMBOS rastreados (não sobrescreve)", () => {
      withEditionDir((dir) => {
        runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "image"]);
        runCli(["--edition-dir", dir, "--start", "--highlight", "d2", "--pieces", "image"]);

        const written = JSON.parse(
          readFileSync(join(dir, "_internal", "stage4-cascade-status.json"), "utf8"),
        );
        // Com o bug pré-#8783, "d1" teria sumido do arquivo aqui.
        assert.deepEqual(Object.keys(written).sort(), ["d1", "d2"]);
        assert.deepEqual(written.d1.pieces, { image: "pending" });
        assert.deepEqual(written.d2.pieces, { image: "pending" });
      });
    });

    it("3 --start sequenciais (D1, D2, D3 — reshuffle completo) mantêm os 3 rastreados; --mark de um não afeta os outros", () => {
      withEditionDir((dir) => {
        runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "image"]);
        runCli(["--edition-dir", dir, "--start", "--highlight", "d2", "--pieces", "image"]);
        runCli(["--edition-dir", dir, "--start", "--highlight", "d3", "--pieces", "image,carousel,social"]);

        const afterStart = JSON.parse(
          readFileSync(join(dir, "_internal", "stage4-cascade-status.json"), "utf8"),
        );
        assert.deepEqual(Object.keys(afterStart).sort(), ["d1", "d2", "d3"]);

        // --status ainda enxerga os 3 como pendentes.
        const status1 = runCli(["--edition-dir", dir, "--status"]);
        assert.equal(status1.status, 1);

        // Resolver só d1 não libera o gate — d2/d3 seguem pendentes.
        runCli(["--edition-dir", dir, "--mark", "--highlight", "d1", "--piece", "image", "--state", "done"]);
        const status2 = runCli(["--edition-dir", dir, "--status"]);
        assert.equal(status2.status, 1);
        const parsed2 = JSON.parse(status2.stdout);
        assert.equal(parsed2.status.d1.pieces.image, "done");
        assert.equal(parsed2.status.d2.pieces.image, "pending");

        // Resolver os 3 libera o gate.
        runCli(["--edition-dir", dir, "--mark", "--highlight", "d2", "--piece", "image", "--state", "done"]);
        runCli(["--edition-dir", dir, "--mark", "--highlight", "d3", "--piece", "image", "--state", "done"]);
        runCli(["--edition-dir", dir, "--mark", "--highlight", "d3", "--piece", "carousel", "--state", "done"]);
        runCli(["--edition-dir", dir, "--mark", "--highlight", "d3", "--piece", "social", "--state", "done"]);
        const status3 = runCli(["--edition-dir", dir, "--status"]);
        assert.equal(status3.status, 0);
        assert.equal(JSON.parse(status3.stdout).pending, false);
      });
    });

    it("--clear --highlight d1 remove só a entrada de d1, preservando d2", () => {
      withEditionDir((dir) => {
        runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "image"]);
        runCli(["--edition-dir", dir, "--start", "--highlight", "d2", "--pieces", "image"]);

        const cleared = runCli(["--edition-dir", dir, "--clear", "--highlight", "d1"]);
        assert.equal(cleared.status, 0);
        assert.equal(JSON.parse(cleared.stdout).highlight, "d1");

        const written = JSON.parse(
          readFileSync(join(dir, "_internal", "stage4-cascade-status.json"), "utf8"),
        );
        assert.deepEqual(Object.keys(written), ["d2"]);
      });
    });

    it("badge do --apply-badge agrega highlights distintos numa única injeção", () => {
      withEditionDir((dir) => {
        const htmlPath = join(dir, "preview.html");
        writeFileSync(htmlPath, "<html><body><h1>Newsletter</h1></body></html>", "utf8");

        runCli(["--edition-dir", dir, "--start", "--highlight", "d1", "--pieces", "image"]);
        runCli(["--edition-dir", dir, "--start", "--highlight", "d2", "--pieces", "social"]);
        runCli(["--edition-dir", dir, "--apply-badge", "--html", htmlPath]);

        const html = readFileSync(htmlPath, "utf8");
        assert.match(html, /D1: imagem/);
        assert.match(html, /D2: texto social/);
      });
    });
  });
});
