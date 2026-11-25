/**
 * test/humanizer-provenance-kept-label-13925.test.ts
 *
 * #13925: o `--provenance` rotulava como "prova mais fraca" toda seção mantida
 * pelo humanizador. Isso só vale para o run sem mudança nenhuma aceito por
 * `--note` (#13889). A seção mantida com outra seção alterada no mesmo run
 * (#11604) é prova normal e sai só "texto mantido". O resultado do check não muda.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  describeProvenance,
  emptyRunRecord,
  planRunRecord,
  readRunRecord,
  writeRunRecord,
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

function provenance(dir: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT_PATH, "--provenance", "--edition-dir", dir], {
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

function withEdition(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-kept-13925-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lineFor(stderr: string, section: string): string {
  return stderr.split("\n").find((l) => l.trim().startsWith(`${section}:`)) ?? "";
}

describe("#13925: rótulo de seção mantida no --provenance", () => {
  it("#11604 (outra seção mudou no run): 'texto mantido' sem 'prova mais fraca'", () => {
    withEdition((dir) => {
      const pre = SOCIAL("d1 rascunho", "d3 mantido");
      const post = SOCIAL("d1 humanizado", "d3 mantido");
      const h = planRunRecord(emptyRunRecord(), "humanizador", pre, post);
      const row = describeProvenance(post, h.record).find((r) => r.section === "main_d3");
      assert.equal(row?.kept, true);
      assert.equal(row?.kept_noted, undefined);
      writeRunRecord(dir, h.record);
      writeFileSync(join(dir, "03-social.md"), post, "utf8");
      const r = provenance(dir);
      assert.equal(r.status, 0, r.stderr);
      const line = lineFor(r.stderr, "main_d3");
      assert.match(line, /texto mantido/);
      assert.doesNotMatch(line, /prova mais fraca/);
      assert.doesNotMatch(lineFor(r.stderr, "main_d1"), /texto mantido/);
    });
  });

  it("#13889 (run sem mudanças, --note): continua 'prova mais fraca'", () => {
    withEdition((dir) => {
      const md = SOCIAL("d1 igual", "d3 igual");
      const h = planRunRecord(emptyRunRecord(), "humanizador", md, md, ["main_d1"], { note: "sem mudanças" });
      assert.equal(h.record.humanizador_noted?.length, 1);
      writeRunRecord(dir, h.record);
      writeFileSync(join(dir, "03-social.md"), md, "utf8");
      const r = provenance(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(lineFor(r.stderr, "main_d1"), /texto mantido, run sem mudanças aceito por --note; prova mais fraca/);
    });
  });

  it("registro gravado antes do #13925 (sem humanizador_noted) lê como lista vazia", () => {
    withEdition((dir) => {
      const pre = SOCIAL("d1 rascunho", "d3 mantido");
      const post = SOCIAL("d1 humanizado", "d3 mantido");
      const { humanizador_noted: _drop, ...legacy } = planRunRecord(emptyRunRecord(), "humanizador", pre, post).record;
      writeFileSync(join(dir, "_internal", ".humanizer-run.json"), JSON.stringify(legacy), "utf8");
      assert.deepEqual(readRunRecord(dir).humanizador_noted, []);
    });
  });
});
