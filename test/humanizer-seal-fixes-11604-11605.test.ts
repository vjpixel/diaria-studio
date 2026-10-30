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
  it("ajuste pequeno no D1 + humanizador sem mudança no D1 (mas reescrevendo o D3 no mesmo run) + Clarice → --write passa (sem --unproven-ok)", () => {
    const original = SOCIAL("A OpenAI lançou o modelo X ontem.", "Texto do d3.");
    const { dir, cleanup } = mkEdition(original);
    try {
      writeSentinel(dir);
      // Editor troca uma palavra no D1 e outra no D3; o humanizador mantém o
      // D1 e reescreve o D3 (#11609: idêntica só prova com outra seção mudando).
      const edited = SOCIAL("A OpenAI lançou o modelo X na terça.", "Texto do d3 mexido.");
      const humanized = SOCIAL("A OpenAI lançou o modelo X na terça.", "Texto do d3 humanizado.");
      writeFileSync(join(dir, "03-social.md"), humanized, "utf8");
      const h = planRunRecord(readRunRecord(dir), "humanizador", edited, humanized, ["main_d1", "main_d3"]);
      assert.deepEqual(h.recorded.sort(), ["main_d1", "main_d3"]);
      assert.deepEqual(h.skipped, []);
      const c = planRunRecord(h.record, "clarice", humanized, humanized, undefined, { note: "Clarice sem sugestões" });
      assert.ok(c.recorded.includes("main_d1"), "Clarice parte de texto provado");
      writeRunRecord(dir, c.record);

      const data = JSON.parse(readFileSync(writeSentinel(dir, "ajuste pequeno no D1"), "utf8"));
      assert.equal(data.unproven_sections, undefined);
      assert.equal(checkSentinel(dir).ok, true);

      const row = describeProvenance(humanized, readRunRecord(dir)).find((r) => r.section === "main_d1");
      assert.deepEqual(row, { section: "main_d1", humanizador: true, clarice: true, kept: true, clarice_unchanged: true });
    } finally {
      cleanup();
    }
  });

  it("seção fora do --sections continua sem prova", () => {
    const pre = SOCIAL("x", "y");
    const post = SOCIAL("x humanizado", "y");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", pre, post, ["main_d1"]);
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

describe("#11609: seção idêntica só prova se outra seção do mesmo run mudou", () => {
  it("Skill pulada no modo full-file (pre === post) não prova nada e o --write segue recusando", () => {
    const original = SOCIAL("Texto do d1 humanizado.", "Texto do d3 humanizado.");
    const { dir, cleanup } = mkEdition(original);
    try {
      writeSentinel(dir);
      // Agente reescreve o D1 à mão, tira o snapshot, PULA a Skill, tira o outro.
      const handEdited = SOCIAL("Texto do d1 reescrito à mão sem humanizar.", "Texto do d3 humanizado.");
      writeFileSync(join(dir, "03-social.md"), handEdited, "utf8");
      const h = planRunRecord(readRunRecord(dir), "humanizador", handEdited, handEdited);
      assert.deepEqual(h.recorded, []);
      assert.deepEqual(h.record.humanizador, []);
      assert.deepEqual(h.record.humanizador_unchanged, []);
      assert.deepEqual(h.skipped.map((s) => s.section).sort(), ["main_d1", "main_d2", "main_d3"]);
      const c = planRunRecord(h.record, "clarice", handEdited, handEdited);
      assert.deepEqual(c.recorded, [], "Clarice não prova texto que não passou pelo humanizador");
      writeRunRecord(dir, c.record);
      assert.throws(() => writeSentinel(dir, "ajuste D1"), /main_d1/);
    } finally {
      cleanup();
    }
  });

  it("Skill pulada no modo scoped com várias seções (todas idênticas) não prova", () => {
    const md = SOCIAL("a", "b");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", md, md, ["main_d1", "main_d3"]);
    assert.deepEqual(h.recorded, []);
    assert.equal(h.skipped.length, 2);
  });

  it("ao menos uma seção mudou → as idênticas do mesmo run são provadas (texto mantido)", () => {
    const pre = SOCIAL("d1 rascunho", "d3 mantido");
    const post = SOCIAL("d1 humanizado", "d3 mantido");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", pre, post);
    assert.deepEqual(h.recorded.sort(), ["main_d1", "main_d2", "main_d3"]);
    assert.deepEqual(h.skipped, []);
    const rows = describeProvenance(post, h.record);
    assert.equal(rows.find((r) => r.section === "main_d1")?.kept, undefined);
    assert.equal(rows.find((r) => r.section === "main_d3")?.kept, true);
  });

  it("mudança só fora do escopo não conta como 'outra seção do run mudou'", () => {
    const pre = SOCIAL("d1 igual", "d3 antes");
    const post = SOCIAL("d1 igual", "d3 depois");
    const h = planRunRecord(readRunRecord("/nao/existe"), "humanizador", pre, post, ["main_d1"]);
    assert.deepEqual(h.recorded, []);
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
