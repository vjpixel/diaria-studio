/**
 * test/humanizer-seal-fixes-11604-11605.test.ts
 *
 * #11604: ajuste pequeno do editor que o humanizador devolve idêntico não pode
 * prender o `--write` do Stage 4 (passo 6.6) em exit 4.
 * #11605: o re-selo do reorder (D1↔D3) leva `unproven_sections` /
 * `section_provenance` junto com o texto, não pelo nome antigo da seção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSentinel, checkSentinel } from "../scripts/check-humanizer-social.ts";
import {
  planRunRecord,
  readRunRecord,
  writeRunRecord,
  describeProvenance,
} from "../scripts/lib/humanizer-run-record.ts";
import { planHumanizerReseal, sectionRenameMap } from "../scripts/lib/humanizer-social-seal.ts";

const SOCIAL = (d1: string, d3: string) => `# LinkedIn
## d1
${d1}

## d2
Texto do d2.

## d3
${d3}
`;

function mkEdition(md: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-seal-11604-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "03-social.md"), md, "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("#11604: seção que o humanizador devolve idêntica conta como provada", () => {
  it("ajuste pequeno no D1 + humanizador sem mudança + Clarice → --write passa (sem --unproven-ok)", () => {
    const original = SOCIAL("A OpenAI lançou o modelo X ontem.", "Texto do d3.");
    const { dir, cleanup } = mkEdition(original);
    try {
      writeSentinel(dir);
      // Editor troca uma palavra no D1; o humanizador lê e não muda nada.
      const edited = SOCIAL("A OpenAI lançou o modelo X na terça.", "Texto do d3.");
      writeFileSync(join(dir, "03-social.md"), edited, "utf8");
      const h = planRunRecord(readRunRecord(dir), "humanizador", edited, edited, ["main_d1"]);
      assert.deepEqual(h.recorded, ["main_d1"]);
      assert.deepEqual(h.skipped, []);
      const c = planRunRecord(h.record, "clarice", edited, edited);
      assert.ok(c.recorded.includes("main_d1"), "Clarice parte de texto provado");
      writeRunRecord(dir, c.record);

      const data = JSON.parse(readFileSync(writeSentinel(dir, "ajuste pequeno no D1"), "utf8"));
      assert.equal(data.unproven_sections, undefined);
      assert.equal(checkSentinel(dir).ok, true);

      const row = describeProvenance(edited, readRunRecord(dir)).find((r) => r.section === "main_d1");
      assert.deepEqual(row, { section: "main_d1", humanizador: true, clarice: true, kept: true });
    } finally {
      cleanup();
    }
  });

  it("seção fora do --sections continua sem prova", () => {
    const md = SOCIAL("x", "y");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", md, md, ["main_d1"]);
    assert.deepEqual(h.recorded, ["main_d1"]);
    assert.equal(h.record.humanizador.length, 1);
  });

  it("seção alterada pelo humanizador não é marcada como 'texto mantido'", () => {
    const pre = SOCIAL("rascunho", "y");
    const post = SOCIAL("humanizado", "y");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", pre, post, ["main_d1"]);
    assert.deepEqual(h.record.humanizador_unchanged, []);
    const row = describeProvenance(post, h.record).find((r) => r.section === "main_d1");
    assert.equal(row?.kept, undefined);
  });

  it("registro antigo sem humanizador_unchanged é lido como lista vazia", () => {
    const { dir, cleanup } = mkEdition(SOCIAL("a", "b"));
    try {
      writeFileSync(join(dir, "_internal", ".humanizer-run.json"), JSON.stringify({ version: 1, humanizador: ["h"], clarice: [], runs: [] }));
      assert.deepEqual(readRunRecord(dir).humanizador_unchanged, []);
    } finally {
      cleanup();
    }
  });
});

describe("#11605: re-selo do reorder remapeia campos endereçados por nome", () => {
  it("unproven_sections e section_provenance seguem o texto quando D1↔D3 trocam", () => {
    const before = SOCIAL("Texto do d1 aceito sem prova.", "Texto do d3 humanizado.");
    const after = SOCIAL("Texto do d3 humanizado.", "Texto do d1 aceito sem prova.");
    const { dir, cleanup } = mkEdition(before);
    try {
      // Selo com main_d1 aceito sem prova (ex.: autofix do fact-check).
      const sentinelPath = join(dir, "_internal", ".humanizer-social-done.json");
      writeSentinel(dir);
      const s = JSON.parse(readFileSync(sentinelPath, "utf8"));
      s.unproven_sections = ["main_d1"];
      s.unproven_ok = "autofix fact-check";
      s.section_provenance = [{ section: "main_d1", change: "redaction", humanizador: false, clarice: false }];
      writeFileSync(sentinelPath, JSON.stringify(s), "utf8");

      const plan = planHumanizerReseal(dir, before, after, "reorder-destaques");
      assert.equal(plan.status, "reseal");
      if (plan.status !== "reseal") return;
      const resealed = JSON.parse(plan.content);
      assert.deepEqual(resealed.unproven_sections, ["main_d3"], "o texto sem prova agora é o D3");
      assert.equal(resealed.section_provenance[0].section, "main_d3");
      assert.equal(resealed.unproven_ok, "autofix fact-check");
      assert.equal(resealed.section_format_hashes.main_d3, s.section_format_hashes.main_d1);
    } finally {
      cleanup();
    }
  });

  it("sectionRenameMap: ponto fixo mantém o nome; texto repetido não reaproveita destino", () => {
    const map = sectionRenameMap({ main_d1: "a", main_d2: "b", main_d3: "c" }, { main_d1: "c", main_d2: "b", main_d3: "a" });
    assert.deepEqual([...map].sort(), [["main_d1", "main_d3"], ["main_d2", "main_d2"], ["main_d3", "main_d1"]]);
    const dup = sectionRenameMap({ main_d1: "x", main_d2: "x" }, { main_d1: "x", main_d2: "x" });
    assert.deepEqual([...dup].sort(), [["main_d1", "main_d1"], ["main_d2", "main_d2"]]);
  });
});
