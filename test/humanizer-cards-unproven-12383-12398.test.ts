/**
 * #12383: `main_d{N}-cards` nos hashes por seção, na prova (`--record-run`), no
 * coverage e na cobrança do Stage 2 — com transição para selo antigo (sem hash
 * dos cards), que não pode passar a bloquear edição em curso.
 *
 * #12398: `--write --unproven-ok` com o selo já batendo com `03-social.md` (ou
 * sem selo anterior) aceita as seções sem prova; antes saía exit 0 sem efeito e
 * a invariante `social-humanizer-provenance-recorded` repetia a mesma dica.
 *
 * #12377 item 2: `--provenance` lê `accepted_section_hashes`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import {
  computeChangedSections,
  describeSealAcceptance,
  writeSentinel,
  type HumanizerSocialSentinel,
} from "../scripts/check-humanizer-social.ts";
import {
  checkHumanizerSectionCoverage,
  checkScopedHumanizerCoverage,
  computeSectionHashes,
} from "../scripts/lib/social-lint-rules.ts";
import { emptyRunRecord, planRunRecord, writeRunRecord, readRunRecord } from "../scripts/lib/humanizer-run-record.ts";

const rule = STAGE_2_RULES.find((r) => r.id === "social-humanizer-provenance-recorded")!;
const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-humanizer-social.ts");

const pre =
  "# Social\n\n## d1\nLegenda um.\n\n## d1-cards\nCard um.\n\nCard dois.\n\nCard três.\n\n" +
  "## d2\nLegenda dois.\n\n## d3\nLegenda três.\n";
const humanized = pre.replace("Legenda um.", "Legenda um humanizada.").replace("Card dois.", "Card dois humanizado.");
const final = humanized.replace("Legenda dois.", "Legenda dois corrigida.");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "humanizer-cards-12383-"));
}
const sealPath = (dir: string) => join(dir, "_internal", ".humanizer-social-done.json");
const readSeal = (dir: string) => JSON.parse(readFileSync(sealPath(dir), "utf8")) as HumanizerSocialSentinel;

/** Edição já provada pelos dois passos full-file, com o selo do código atual. */
function provenEdition(): string {
  const dir = tmp();
  writeFileSync(join(dir, "03-social.md"), final);
  const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized);
  const c = planRunRecord(h.record, "clarice", humanized, final);
  writeRunRecord(dir, c.record);
  writeSentinel(dir);
  return dir;
}

/**
 * Edição em curso selada ANTES da #12383: o registro não tem prova dos cards e
 * o selo não tem o hash deles nem `cards_sections_tracked`.
 */
function legacyEdition(): string {
  const dir = tmp();
  writeFileSync(join(dir, "03-social.md"), final);
  const scope = ["main_d1", "main_d2", "main_d3"];
  const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized, scope);
  const c = planRunRecord(h.record, "clarice", humanized, final, scope);
  writeRunRecord(dir, c.record);
  writeSentinel(dir);
  const seal = readSeal(dir);
  delete seal.cards_sections_tracked;
  for (const k of Object.keys(seal.section_hashes ?? {})) if (k.endsWith("-cards")) delete seal.section_hashes![k];
  for (const k of Object.keys(seal.section_format_hashes ?? {})) if (k.endsWith("-cards")) delete seal.section_format_hashes![k];
  writeFileSync(sealPath(dir), JSON.stringify(seal, null, 2));
  return dir;
}

describe("#12383: main_d{N}-cards nos hashes, na prova e no coverage", () => {
  it("computeSectionHashes inclui o hash dos cards", () => {
    assert.ok("main_d1-cards" in computeSectionHashes(final));
  });

  it("verify-scoped: mudança nos cards fora do alvo vira unexpectedChanges", () => {
    const post = pre.replace("Card um.", "Card um mexido.").replace("Legenda dois.", "Legenda dois mexida.");
    const r = checkScopedHumanizerCoverage(pre, post, ["main_d2"]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.unexpectedChanges, ["main_d1-cards"]);
  });

  it("coverage: cards idênticos são reportados mas não bloqueiam; cards apagados bloqueiam", () => {
    const post = pre.replace("Legenda um.", "A").replace("Legenda dois.", "B").replace("Legenda três.", "C");
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.deepEqual(r.untouched, ["main_d1-cards"]);
    assert.equal(r.ok, true);
    const withoutCards = post.replace(/## d1-cards\n[\s\S]*?(?=\n## d2)/, "");
    const r2 = checkHumanizerSectionCoverage(pre, withoutCards);
    assert.deepEqual(r2.deleted, ["main_d1-cards"]);
    assert.equal(r2.ok, false);
  });

  it("--record-run --sections main_d1-cards grava prova dos cards (antes: 'seção ausente')", () => {
    const post = pre.replace("Card um.", "Card um novo.");
    const plan = planRunRecord(emptyRunRecord(), "humanizador", pre, post, ["main_d1-cards"]);
    assert.deepEqual(plan.recorded, ["main_d1-cards"]);
    assert.deepEqual(plan.skipped, []);
    assert.ok(plan.record.humanizador.includes(computeSectionHashes(post)["main_d1-cards"]));
  });

  it("selo novo grava cards_sections_tracked; edição só nos cards aparece em changed_sections", () => {
    const dir = provenEdition();
    try {
      assert.equal(readSeal(dir).cards_sections_tracked, true);
      assert.deepEqual(rule.run(dir), []);
      writeFileSync(join(dir, "03-social.md"), final.replace("Card três.", "Card três editado."));
      assert.deepEqual(computeChangedSections(dir), { legacy: false, changed: ["main_d1-cards"] });
      // Stage 2: os cards editados sem prova bloqueiam.
      const v = rule.run(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /main_d1-cards/);
      assert.equal(v[0].severity, "error");
      // --write --bypass-reason sem prova dos cards recusa (exit 4 no CLI).
      assert.throws(() => writeSentinel(dir, "ajuste"), /main_d1-cards/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12383: transição — selo anterior aos cards não bloqueia edição em curso", () => {
  it("Stage 2: cards sem prova num selo antigo saem como aviso, não erro", () => {
    const dir = legacyEdition();
    try {
      const v = rule.run(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /main_d1-cards/);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /anterior à prova dos cards/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--check: edição na legenda não lista os cards como alterados por falta de hash no selo antigo", () => {
    const dir = legacyEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Legenda três.", "Legenda três editada."));
      assert.deepEqual(computeChangedSections(dir), { legacy: false, changed: ["main_d3"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--write --bypass-reason com a legenda provada passa e o selo segue sem cards_sections_tracked", () => {
    const dir = legacyEdition();
    try {
      const before = final;
      const after = final.replace("Legenda três.", "Legenda três reescrita.");
      writeFileSync(join(dir, "03-social.md"), after);
      const h = planRunRecord(readRunRecord(dir), "humanizador", before, after, ["main_d3"]);
      // Run scoped de uma seção que mudou: a Clarice registra sobre o texto humanizado.
      writeRunRecord(dir, h.record);
      const c = planRunRecord(h.record, "clarice", before, after, ["main_d3"]);
      writeRunRecord(dir, c.record);
      assert.doesNotThrow(() => writeSentinel(dir, "editor ajustou d3"));
      assert.equal(readSeal(dir).cards_sections_tracked, undefined);
      // Os cards continuam só como aviso no Stage 2.
      assert.deepEqual(rule.run(dir).map((x) => x.severity), ["warning"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12398: --unproven-ok com o selo já batendo com 03-social.md", () => {
  const plain = "# Social\n\n## d1\nTexto um.\n\n## d2\nTexto dois.\n\n## d3\nTexto três.\n";

  it("selo fresco sem prova: --write --unproven-ok aceita as seções e a invariante passa", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "03-social.md"), plain);
      writeSentinel(dir); // primeiro --write sem --record-run (#12331)
      assert.equal(rule.run(dir).length, 3);
      assert.match(rule.run(dir)[0].message, /--write --unproven-ok "<motivo>"/, "selo fresco: a dica dispensa --bypass-reason");
      writeSentinel(dir, undefined, { unprovenOk: "editor manteve o texto dele" });
      assert.deepEqual(rule.run(dir), []);
      const seal = readSeal(dir);
      assert.deepEqual(seal.unproven_sections?.sort(), ["main_d1", "main_d2", "main_d3"]);
      assert.equal(seal.unproven_ok, "editor manteve o texto dele");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo legado com unproven_ok mas sem accepted_section_hashes: o CLI aceita e lista as seções", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "03-social.md"), plain);
      writeSentinel(dir);
      const seal = readSeal(dir);
      seal.unproven_sections = ["main_d2"];
      seal.unproven_ok = "editor";
      writeFileSync(sealPath(dir), JSON.stringify(seal, null, 2));
      assert.equal(rule.run(dir).length, 3);
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", SCRIPT, "--write", "--unproven-ok", "editor", "--edition-dir", dir],
        { encoding: "utf8", cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
      assert.deepEqual(out.unproven_sections.sort(), ["main_d1", "main_d2", "main_d3"]);
      assert.deepEqual(rule.run(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo divergente segue no caminho de sempre: --unproven-ok só aceita o que mudou", () => {
    const dir = provenEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Legenda três.", "Do editor."));
      writeSentinel(dir, "editor", { unprovenOk: "editor" });
      assert.deepEqual(readSeal(dir).unproven_sections, ["main_d3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12377 item 2: --provenance lê accepted_section_hashes", () => {
  it("marca a seção aceita pelo hash do conteúdo, não só pelo nome em unproven_sections", () => {
    const dir = provenEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), final.replace("Legenda três.", "Do editor."));
      writeSentinel(dir, "editor", { unprovenOk: "editor" });
      const seal = readSeal(dir);
      seal.unproven_sections = []; // o aceite tem que vir do hash
      writeFileSync(sealPath(dir), JSON.stringify(seal, null, 2));
      const md = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.deepEqual(describeSealAcceptance(readSeal(dir), md).bySection, { main_d3: "unproven_ok" });
      const r = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--provenance", "--edition-dir", dir], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /main_d3:.*aceita sem prova \(--unproven-ok\)/);
      assert.deepEqual(JSON.parse(r.stdout).unproven_sections, ["main_d3"]);
      // Selo desatualizado não marca aceite (mesmo critério da invariante do Stage 2).
      assert.deepEqual(describeSealAcceptance(readSeal(dir), md + "\nextra\n").bySection, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo anterior ao #12361 (sem accepted_section_hashes) cai em unproven_sections por nome", () => {
    const seal = { social_sha256: "x", written_at: "", unproven_sections: ["main_d1"] } as HumanizerSocialSentinel;
    assert.deepEqual(describeSealAcceptance(seal, "# Social\n").unprovenSections, ["main_d1"]);
  });
});
