import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import { writeSentinel } from "../scripts/check-humanizer-social.ts";
import { emptyRunRecord, planRunRecord, writeRunRecord, describeProvenance } from "../scripts/lib/humanizer-run-record.ts";

const rule = STAGE_2_RULES.find((r) => r.id === "social-humanizer-provenance-recorded")!;
const pre = "# Social\n## d1\nTexto original.\n## d2\nSegundo texto.\n## d3\nTerceiro texto.\n## um\nDica útil.\n";
const humanized = pre.replace("Texto original.", "Texto humanizado.");
const final = humanized.replace("Segundo texto.", "Segundo texto corrigido.");

function fixture(md = final) {
  const dir = mkdtempSync(join(tmpdir(), "social-provenance-12331-"));
  writeFileSync(join(dir, "03-social.md"), md);
  writeSentinel(dir);
  return dir;
}

describe("#12331: provenance social no fim do Stage 2", () => {
  it("selo inicial válido sem record-run não é prova; d1/d2/d3 bloqueiam e UM avisa", () => {
    const dir = fixture();
    try {
      const violations = rule.run(dir);
      assert.equal(violations.length, 4);
      assert.deepEqual(violations.map((v) => v.severity), ["error", "error", "error", "warning"]);
      assert.match(violations[1].message, /main_d2: humanizador NÃO · Clarice NÃO/);
      assert.match(violations[2].message, /--record-run/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("registros full-file do Stage 2 provam inclusive d2 corrigido e d3/UM mantidos", () => {
    const dir = fixture();
    try {
      const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized);
      writeRunRecord(dir, h.record);
      assert.equal(rule.run(dir).length, 4, "humanizador sozinho não prova Clarice");
      const c = planRunRecord(h.record, "clarice", humanized, final);
      writeRunRecord(dir, c.record);
      assert.deepEqual(rule.run(dir), []);
      assert.ok(describeProvenance(final, c.record).every((r) => r.humanizador && r.clarice));
      // Alteração posterior exige prova nova só da seção editada.
      writeFileSync(join(dir, "03-social.md"), final.replace("Terceiro texto.", "Terceiro reescrito."));
      const violations = rule.run(dir);
      assert.equal(violations.length, 1);
      assert.match(violations[0].message, /main_d3/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // #12361: as duas saídas legítimas do --write também valem na invariante do Stage 2.
  function provenFixture() {
    const dir = fixture();
    const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized);
    const c = planRunRecord(h.record, "clarice", humanized, final);
    writeRunRecord(dir, c.record);
    writeSentinel(dir);
    assert.deepEqual(rule.run(dir), []);
    return dir;
  }

  it("#12361: editor edita main_d2 no gate + --write --unproven-ok → sem violação", () => {
    const dir = provenFixture();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Segundo texto do editor."));
      assert.equal(rule.run(dir).length, 1, "edição do editor sem selo segue sem prova");
      assert.throws(() => writeSentinel(dir, "editor editou no gate"), /UnprovenSectionsError|sem prova/);
      writeSentinel(dir, "editor editou no gate", { unprovenOk: "editor" });
      assert.deepEqual(rule.run(dir), []);
      // Um --write seguinte sem mudança não apaga o aceite.
      writeSentinel(dir);
      assert.deepEqual(rule.run(dir), []);
      // Nova redação na mesma seção depois do aceite volta a exigir prova.
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Outra redação."));
      assert.equal(rule.run(dir).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("#12361: mudança só de formatação sobre texto provado → sem violação, sem --unproven-ok", () => {
    const dir = provenFixture();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Segundo texto{quebra}corrigido. #IA"));
      writeSentinel(dir, "ajuste de quebra/hashtag");
      assert.deepEqual(rule.run(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("#12361: formatação sobre texto que nunca teve prova continua bloqueando", () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Segundo texto  corrigido. #IA"));
      writeSentinel(dir, "só formatação");
      const violations = rule.run(dir);
      assert.equal(violations.length, 4);
      assert.match(violations[1].message, /main_d2/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("#12361: aceite do selo não vale com selo defasado (hash não bate)", () => {
    const dir = provenFixture();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Segundo texto do editor."));
      writeSentinel(dir, "editor", { unprovenOk: "editor" });
      writeFileSync(join(dir, "03-social.md"), final.replace("Segundo texto corrigido.", "Segundo texto do editor.").replace("Terceiro texto.", "Terceiro novo."));
      const violations = rule.run(dir);
      assert.deepEqual(violations.map((v) => v.message.slice(0, 7)), ["main_d2", "main_d3"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Clarice sem sugestões aceita registro explícito com note", () => {
    const dir = fixture(humanized);
    try {
      const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized);
      const c = planRunRecord(h.record, "clarice", humanized, humanized, undefined, { note: "Clarice sem sugestões" });
      writeRunRecord(dir, c.record);
      assert.deepEqual(rule.run(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
