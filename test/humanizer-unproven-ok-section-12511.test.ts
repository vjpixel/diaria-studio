/**
 * #12511: `--write --unproven-ok` sem mudança desde o selo (1ª gravação do
 * Stage 2, selo ilegível ou já batendo com o texto) aceitava TODAS as seções sem
 * prova do humanizador — um agente seguindo a dica da invariante
 * `social-humanizer-provenance-recorded` silenciava D1/D2/D3 de uma vez.
 *
 * Agora esse caminho exige `--unproven-ok-section` e só aceita as seções nomeadas;
 * a dica da invariante nomeia a seção da própria linha.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import {
  UnknownSectionSelectorError,
  UnprovenOkSectionRequiredError,
  UnprovenSectionsError,
  writeSentinel,
  type HumanizerSocialSentinel,
} from "../scripts/check-humanizer-social.ts";
import { emptyRunRecord, planRunRecord, resolveSectionSelector, writeRunRecord } from "../scripts/lib/humanizer-run-record.ts";

const rule = STAGE_2_RULES.find((r) => r.id === "social-humanizer-provenance-recorded")!;
const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-humanizer-social.ts");

const pre = "# Social\n\n## d1\nTexto um.\n\n## d2\nTexto dois.\n\n## d3\nTexto três.\n";
// Humanizador e Clarice provam só o D1 — D2/D3 ficam sem prova (o cenário da issue).
const humanized = pre.replace("Texto um.", "Texto um humanizado.");
const final = humanized.replace("Texto um humanizado.", "Texto um humanizado e revisado.");

const sealPath = (dir: string) => join(dir, "_internal", ".humanizer-social-done.json");
const readSeal = (dir: string) => JSON.parse(readFileSync(sealPath(dir), "utf8")) as HumanizerSocialSentinel;

/** 1ª gravação do Stage 2: registro prova só o D1, ainda sem selo. */
function firstWriteEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "humanizer-12511-"));
  writeFileSync(join(dir, "03-social.md"), final);
  const h = planRunRecord(emptyRunRecord(), "humanizador", pre, humanized, ["main_d1"]);
  const c = planRunRecord(h.record, "clarice", humanized, final, ["main_d1"]);
  writeRunRecord(dir, c.record);
  return dir;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

describe("#12511: --unproven-ok sem mudança desde o selo exige seletor de seção", () => {
  it("sem selo anterior e sem seletor: recusa, lista D2/D3 e não grava selo nenhum", () => {
    const dir = firstWriteEdition();
    try {
      assert.throws(
        () => writeSentinel(dir, undefined, { unprovenOk: "motivo genérico" }),
        (e: unknown) => {
          assert.ok(e instanceof UnprovenOkSectionRequiredError);
          assert.deepEqual(e.candidates, ["main_d2", "main_d3"]);
          return true;
        },
      );
      assert.equal(existsSync(sealPath(dir)), false, "nada gravado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo fresco e sem seletor: recusa e o selo continua sem aceite (invariante segue acusando D2/D3)", () => {
    const dir = firstWriteEdition();
    try {
      writeSentinel(dir);
      const before = readFileSync(sealPath(dir), "utf8");
      assert.deepEqual(rule.run(dir).map((v) => v.message.slice(0, 7)), ["main_d2", "main_d3"]);
      assert.throws(() => writeSentinel(dir, undefined, { unprovenOk: "motivo" }), UnprovenOkSectionRequiredError);
      assert.equal(readFileSync(sealPath(dir), "utf8"), before, "selo intocado");
      assert.equal(rule.run(dir).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com seletor: aceita só a seção nomeada; a outra segue sem prova na invariante", () => {
    const dir = firstWriteEdition();
    try {
      writeSentinel(dir, undefined, { unprovenOk: "editor manteve o D2 dele", unprovenOkSections: ["d2"] });
      const seal = readSeal(dir);
      assert.deepEqual(seal.unproven_sections, ["main_d2"]);
      const v = rule.run(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /^main_d3:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seletor nomeando seção já provada não aceita nada além dela (no-op), sem erro", () => {
    const dir = firstWriteEdition();
    try {
      writeSentinel(dir, undefined, { unprovenOk: "motivo", unprovenOkSections: ["main_d1"] });
      assert.equal(readSeal(dir).unproven_sections, undefined);
      assert.equal(rule.run(dir).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seletor com seção inexistente: recusa sem gravar", () => {
    const dir = firstWriteEdition();
    try {
      assert.throws(
        () => writeSentinel(dir, undefined, { unprovenOk: "motivo", unprovenOkSections: ["d9"] }),
        UnknownSectionSelectorError,
      );
      assert.equal(existsSync(sealPath(dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selo divergente + seletor: seção sem prova não nomeada recusa (exit 4 no CLI)", () => {
    const dir = firstWriteEdition();
    try {
      writeSentinel(dir, undefined, { unprovenOk: "x", unprovenOkSections: ["d2", "d3"] });
      writeFileSync(join(dir, "03-social.md"), final.replace("Texto dois.", "Dois do editor.").replace("Texto três.", "Três do editor."));
      assert.throws(
        () => writeSentinel(dir, "editor", { unprovenOk: "editor", unprovenOkSections: ["d2"] }),
        (e: unknown) => e instanceof UnprovenSectionsError && e.sections.join() === "main_d3",
      );
      writeSentinel(dir, "editor", { unprovenOk: "editor", unprovenOkSections: ["d2", "d3"] });
      assert.deepEqual(readSeal(dir).unproven_sections, ["main_d2", "main_d3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dica da invariante nomeia a seção da linha", () => {
    const dir = firstWriteEdition();
    try {
      writeSentinel(dir);
      const v = rule.run(dir);
      assert.match(v[0].message, /--unproven-ok "<motivo>" --unproven-ok-section main_d2 /);
      assert.match(v[1].message, /--unproven-ok-section main_d3 /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: sem seletor sai 5 listando as seções; com seletor sai 0; seletor sem --unproven-ok sai 1", () => {
    const dir = firstWriteEdition();
    try {
      const r = runCli(["--write", "--unproven-ok", "motivo", "--edition-dir", dir]);
      assert.equal(r.status, 5, r.stderr);
      const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
      assert.equal(out.reason, "unproven_ok_section_required");
      assert.deepEqual(out.candidates, ["main_d2", "main_d3"]);
      assert.equal(existsSync(sealPath(dir)), false);

      const lone = runCli(["--write", "--unproven-ok-section", "d2", "--edition-dir", dir]);
      assert.equal(lone.status, 1, lone.stderr);

      const ok = runCli(["--write", "--unproven-ok", "editor", "--unproven-ok-section", "d2,d3", "--edition-dir", dir]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout.trim().split("\n").pop()!).unproven_sections, ["main_d2", "main_d3"]);
      assert.deepEqual(rule.run(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12511: resolveSectionSelector", () => {
  const available = ["main_d1", "main_d1-cards", "main_um", "comment_pixel_d1", "post_pixel"];
  it("aceita nome completo e atalho sem main_, deduplica", () => {
    assert.deepEqual(resolveSectionSelector(["d1", "main_d1", "d1-cards", "um", "post_pixel", " comment_pixel_d1 "], available), {
      sections: ["main_d1", "main_d1-cards", "main_um", "post_pixel", "comment_pixel_d1"],
      unknown: [],
    });
  });
  it("nome inexistente vai para unknown", () => {
    assert.deepEqual(resolveSectionSelector(["d2", ""], available), { sections: [], unknown: ["d2"] });
  });
});
