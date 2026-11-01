/**
 * test/humanizer-record-run-noop-11674.test.ts
 *
 * #11674: `check-humanizer-social.ts --record-run --step clarice` aceitava o
 * mesmo arquivo como `--pre` e `--post` e registrava a seção como provada sem
 * passada real da Clarice (edição 261030, Stage 4, 4 vezes). Agora o run sem
 * mudança é recusado (exit 1, nada gravado) e só vira prova — mais fraca, com
 * o motivo gravado — com `--note`. A mensagem de "seção ausente" passa a dizer
 * que `--pre`/`--post` são o `03-social.md` inteiro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  planRunRecord,
  emptyRunRecord,
  readRunRecord,
  runRecordPath,
  describeProvenance,
} from "../scripts/lib/humanizer-run-record.ts";

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/check-humanizer-social.ts");

const SOCIAL = (d1: string, d3: string) => `# Social
## d1
${d1}

## d2
Texto do d2.

## d3
${d3}
`;

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT_PATH, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function mkEdition(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-noop-11674-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Registro com o texto humanizado já provado pelo humanizador. */
function humanizedRecord(pre: string, post: string) {
  const h = planRunRecord(emptyRunRecord(), "humanizador", pre, post);
  assert.ok(h.recorded.length > 0);
  return h.record;
}

describe("#11674: --record-run da Clarice com --pre igual a --post", () => {
  const pre = SOCIAL("d1 rascunho", "d3 rascunho");
  const humanized = SOCIAL("d1 humanizado", "d3 humanizado");

  it("sem --note não prova nada e o plano marca noop", () => {
    const c = planRunRecord(humanizedRecord(pre, humanized), "clarice", humanized, humanized);
    assert.equal(c.noop, true);
    assert.deepEqual(c.recorded, []);
    assert.deepEqual(c.record.clarice, []);
    assert.ok(c.skipped.every((s) => /--note/.test(s.reason)), JSON.stringify(c.skipped));
  });

  it("com --note vira prova mais fraca: clarice_unchanged + motivo no run + provenance", () => {
    const c = planRunRecord(humanizedRecord(pre, humanized), "clarice", humanized, humanized, undefined, {
      note: "Clarice sem sugestões",
    });
    assert.deepEqual(c.recorded.sort(), ["main_d1", "main_d2", "main_d3"]);
    assert.equal(c.record.clarice_unchanged.length, 3);
    assert.equal(c.record.runs.at(-1)?.note, "Clarice sem sugestões");
    const row = describeProvenance(humanized, c.record).find((r) => r.section === "main_d1");
    assert.deepEqual(row, { section: "main_d1", humanizador: true, clarice: true, clarice_unchanged: true });
  });

  it("--note não lava texto não humanizado", () => {
    const c = planRunRecord(emptyRunRecord(), "clarice", humanized, humanized, undefined, { note: "x" });
    assert.deepEqual(c.recorded, []);
  });

  it("Clarice que mudou algo não precisa de --note e não marca clarice_unchanged", () => {
    const corrected = SOCIAL("d1 humanizado e corrigido", "d3 humanizado");
    const c = planRunRecord(humanizedRecord(pre, humanized), "clarice", humanized, corrected);
    assert.equal(c.noop, false);
    assert.deepEqual(c.recorded.sort(), ["main_d1", "main_d2", "main_d3"]);
    assert.deepEqual(c.record.clarice_unchanged, []);
    assert.equal(c.record.runs.at(-1)?.note, undefined);
  });

  it("registro antigo sem clarice_unchanged é lido como lista vazia", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(runRecordPath(dir), JSON.stringify({ version: 1, humanizador: [], clarice: [], runs: [] }), "utf8");
      assert.deepEqual(readRunRecord(dir).clarice_unchanged, []);
    } finally {
      cleanup();
    }
  });

  it("CLI: mesmo arquivo como --pre e --post sai 1 sem gravar; com --note grava", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const preP = join(dir, "_internal", "pre.md");
      const postH = join(dir, "_internal", "post-h.md");
      writeFileSync(preP, pre, "utf8");
      writeFileSync(postH, humanized, "utf8");
      writeFileSync(join(dir, "03-social.md"), humanized, "utf8");
      const h = runCli(["--record-run", "--step", "humanizador", "--pre", preP, "--post", postH, "--edition-dir", dir]);
      assert.equal(h.status, 0, h.stderr);
      const before = readFileSync(runRecordPath(dir), "utf8");

      const social = join(dir, "03-social.md");
      const refused = runCli(["--record-run", "--step", "clarice", "--pre", social, "--post", social, "--edition-dir", dir]);
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /RECUSADO/);
      assert.equal(JSON.parse(refused.stdout.trim()).reason, "noop_without_note");
      assert.equal(readFileSync(runRecordPath(dir), "utf8"), before, "nada gravado");

      const ok = runCli([
        "--record-run", "--step", "clarice", "--pre", postH, "--post", social,
        "--note", "Clarice sem sugestões", "--edition-dir", dir,
      ]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(readRunRecord(dir).runs.at(-1)?.note, "Clarice sem sugestões");

      const prov = runCli(["--provenance", "--edition-dir", dir]);
      assert.match(prov.stderr, /main_d1: humanizador sim · Clarice sim \(sem sugestões, --note\)/);
    } finally {
      cleanup();
    }
  });

  it("CLI: --note no passo do humanizador é rejeitado (#11609)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const f = join(dir, "_internal", "x.md");
      writeFileSync(f, humanized, "utf8");
      const r = runCli(["--record-run", "--step", "humanizador", "--pre", f, "--post", f, "--note", "x", "--edition-dir", dir]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--note só vale para --step clarice/);
      assert.equal(existsSync(runRecordPath(dir)), false);
    } finally {
      cleanup();
    }
  });
});

describe("#11674 item 2: trecho de seção como --pre/--post", () => {
  const fragment = "## d3\nTexto do d3.\n";

  it("com --sections, a seção ausente explica que é o arquivo inteiro", () => {
    const p = planRunRecord(emptyRunRecord(), "humanizador", fragment, fragment, ["main_d3"]);
    assert.match(p.skipped[0]?.reason ?? "", /03-social\.md INTEIRO/);
  });

  it("sem --sections, nenhuma seção reconhecida também vira aviso", () => {
    const p = planRunRecord(emptyRunRecord(), "clarice", fragment, fragment);
    assert.deepEqual(p.recorded, []);
    assert.match(p.skipped[0]?.reason ?? "", /03-social\.md INTEIRO/);
  });
});
