import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEditionsInProgress, resolveEditionDir } from "../scripts/lib/find-current-edition.ts";

function setupSandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "find-current-edition-"));
  mkdirSync(join(root, "data/editions"), { recursive: true });
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeEdition(
  root: string,
  aammdd: string,
  files: string[],
): void {
  const editionDir = join(root, "data/editions", aammdd);
  for (const f of files) {
    const full = join(editionDir, f);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x");
  }
}

describe("findEditionsInProgress", () => {
  it("returns [] when editions dir doesn't exist", () => {
    const { root, cleanup } = setupSandbox();
    try {
      rmSync(join(root, "data/editions"), { recursive: true });
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("returns [] when editions dir is empty", () => {
    const { root, cleanup } = setupSandbox();
    try {
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: returns AAMMDD when prereq present, output missing", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: skips edition when prereq missing", () => {
    const { root, cleanup } = setupSandbox();
    try {
      // No _internal/01-approved.json
      makeEdition(root, "260505", ["01-categorized.md"]);
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 2: skips edition when output already exists", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "_internal/01-approved.json",
        "02-reviewed.md",
      ]);
      assert.deepEqual(findEditionsInProgress(2, root), []);
    } finally {
      cleanup();
    }
  });

  it("returns multiple candidates sorted", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260507", ["_internal/01-approved.json"]);
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      makeEdition(root, "260506", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(2, root), [
        "260505",
        "260506",
        "260507",
      ]);
    } finally {
      cleanup();
    }
  });

  it("ignores non-AAMMDD directory entries", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      // Create some noise that should be ignored
      mkdirSync(join(root, "data/editions/.tmp"), { recursive: true });
      mkdirSync(join(root, "data/editions/archive"), { recursive: true });
      writeFileSync(join(root, "data/editions/notes.md"), "x");
      assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
    } finally {
      cleanup();
    }
  });

  it("Stage 3: prereq is _internal/01-approved.json, output is 04-d1-1x1.jpg", () => {
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", ["_internal/01-approved.json"]);
      assert.deepEqual(findEditionsInProgress(3, root), ["260505"]);
      // Now add the output → no longer in progress
      makeEdition(root, "260505", ["04-d1-1x1.jpg"]);
      assert.deepEqual(findEditionsInProgress(3, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 4 (Revisão #1694): requires both 02-reviewed.md AND 03-social.md as prereq, output is .step-4-done.json", () => {
    const { root, cleanup } = setupSandbox();
    try {
      // Only 02-reviewed.md → not enough
      makeEdition(root, "260505", ["02-reviewed.md"]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
      // Add 03-social.md → now in progress
      makeEdition(root, "260505", ["03-social.md"]);
      assert.deepEqual(findEditionsInProgress(4, root), ["260505"]);
      // Add output sentinel → done
      makeEdition(root, "260505", ["_internal/.step-4-done.json"]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 5 (Publicação #1694): requires _internal/.step-4-done.json as prereq, output is _internal/06-social-published.json", () => {
    // #1694 finding 3: output marker is 06-social-published.json (written after social
    // dispatch). 05-published.json is mid-stage and would cause false-done.
    const { root, cleanup } = setupSandbox();
    try {
      // No prereq → not a candidate
      makeEdition(root, "260505", ["02-reviewed.md", "03-social.md"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
      // Add Stage 4 sentinel → now in progress for Stage 5
      makeEdition(root, "260505", ["_internal/.step-4-done.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // 05-published.json written mid-stage (newsletter done) → still in progress
      makeEdition(root, "260505", ["_internal/05-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // Stage 5 fully done: 06-social-published.json present
      makeEdition(root, "260505", ["_internal/06-social-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 4: skips pre-#1694 edition that has 05-published.json but no .step-4-done.json", () => {
    // Regression for #1694 finding 2: pre-split editions have all Stage 4 prereqs
    // (02-reviewed.md + 03-social.md) but were published before .step-4-done.json existed.
    // Without the guard, they would be false Stage 4 candidates and Revisão would re-run.
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "02-reviewed.md",
        "03-social.md",
        "_internal/05-published.json", // already published — pre-#1694 edition
      ]);
      assert.deepEqual(findEditionsInProgress(4, root), []);
    } finally {
      cleanup();
    }
  });

  it("Stage 5: partial run (newsletter done, social pending) still detected as in-progress", () => {
    // Regression for #1694 finding 3: 05-published.json is written mid-Stage 5 (newsletter only).
    // An edition where newsletter dispatched but social failed should still appear as Stage 5
    // in-progress (no 06-social-published.json yet).
    const { root, cleanup } = setupSandbox();
    try {
      makeEdition(root, "260505", [
        "_internal/.step-4-done.json",
        "_internal/05-published.json", // newsletter done — but stage NOT complete
        // NOTE: 06-social-published.json is absent → social pending → still in progress
      ]);
      assert.deepEqual(findEditionsInProgress(5, root), ["260505"]);
      // Now social completes → fully done
      makeEdition(root, "260505", ["_internal/06-social-published.json"]);
      assert.deepEqual(findEditionsInProgress(5, root), []);
    } finally {
      cleanup();
    }
  });

  // #2463: layout nested convive com o flat legado até a migração (step 3, gated) rodar.
  describe("#2463: dual-layout (flat legado + nested novo)", () => {
    function makeNestedEdition(
      root: string,
      aammdd: string,
      files: string[],
    ): void {
      const aamm = aammdd.slice(0, 4);
      const editionDir = join(root, "data/editions", aamm, aammdd);
      for (const f of files) {
        const full = join(editionDir, f);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "x");
      }
    }

    it("finds an in-progress edition in the OLD flat layout", () => {
      const { root, cleanup } = setupSandbox();
      try {
        makeEdition(root, "260505", ["_internal/01-approved.json"]);
        assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
      } finally {
        cleanup();
      }
    });

    it("finds an in-progress edition in the NEW nested layout", () => {
      const { root, cleanup } = setupSandbox();
      try {
        makeNestedEdition(root, "260706", ["_internal/01-approved.json"]);
        assert.deepEqual(findEditionsInProgress(2, root), ["260706"]);
      } finally {
        cleanup();
      }
    });

    it("finds candidates across BOTH layouts simultaneously, sorted together", () => {
      const { root, cleanup } = setupSandbox();
      try {
        makeEdition(root, "260505", ["_internal/01-approved.json"]); // flat (pre-migration)
        makeNestedEdition(root, "260706", ["_internal/01-approved.json"]); // nested (post-migration)
        assert.deepEqual(findEditionsInProgress(2, root), ["260505", "260706"]);
      } finally {
        cleanup();
      }
    });

    it("ignores AAMM-looking dirs with no valid AAMMDD subdirs, and non-AAMM noise", () => {
      const { root, cleanup } = setupSandbox();
      try {
        makeEdition(root, "260505", ["_internal/01-approved.json"]);
        mkdirSync(join(root, "data/editions/2607"), { recursive: true }); // empty AAMM dir
        mkdirSync(join(root, "data/editions/archive"), { recursive: true });
        assert.deepEqual(findEditionsInProgress(2, root), ["260505"]);
      } finally {
        cleanup();
      }
    });

    it("if same AAMMDD exists in both layouts (shouldn't happen in practice), prefers nested", () => {
      const { root, cleanup } = setupSandbox();
      try {
        // Flat: only prereq present (in-progress if it were the source of truth)
        makeEdition(root, "260706", ["_internal/01-approved.json"]);
        // Nested: prereq + output already present (done) — nested should win, so NOT a candidate
        makeNestedEdition(root, "260706", [
          "_internal/01-approved.json",
          "02-reviewed.md",
        ]);
        assert.deepEqual(findEditionsInProgress(2, root), []);
      } finally {
        cleanup();
      }
    });
  });

  // #3530: Stage 0 (mkdir/criação) e Stages 1-3 (leitura/escrita) passam a
  // resolver `{EDITION_DIR}` via `resolveEditionDir()` em vez de montar
  // `data/editions/{AAMMDD}` à mão. Estes testes cobrem exatamente as duas
  // garantias que a migração depende: (a) edição NOVA nasce nested; (b)
  // edição já existente EM QUALQUER layout é encontrada nesse mesmo layout
  // (nunca recriada do zero num layout diferente — isso seria split-brain).
  describe("#3530: resolveEditionDir — criação (Stage 0) usa o mesmo path que leitura (Stages 1-6)", () => {
    it("edição que ainda não existe em disco → retorna path NESTED (layout de toda edição nova)", () => {
      const { root, cleanup } = setupSandbox();
      try {
        const editionsRootDir = join(root, "data/editions");
        const dir = resolveEditionDir(editionsRootDir, "260801");
        assert.equal(
          dir.replaceAll("\\", "/"),
          join(editionsRootDir, "2608", "260801").replaceAll("\\", "/"),
        );
      } finally {
        cleanup();
      }
    });

    it("edição já existente em FLAT (pré-migração) → retorna o path FLAT (resume-safe, não recria em nested)", () => {
      const { root, cleanup } = setupSandbox();
      try {
        makeEdition(root, "260505", ["_internal/01-approved.json"]);
        const editionsRootDir = join(root, "data/editions");
        const dir = resolveEditionDir(editionsRootDir, "260505");
        assert.equal(
          dir.replaceAll("\\", "/"),
          join(editionsRootDir, "260505").replaceAll("\\", "/"),
        );
      } finally {
        cleanup();
      }
    });

    it("edição já existente em NESTED → retorna o path NESTED", () => {
      const { root, cleanup } = setupSandbox();
      try {
        const aamm = "2607";
        const editionDir = join(root, "data/editions", aamm, "260706");
        mkdirSync(join(editionDir, "_internal"), { recursive: true });
        writeFileSync(join(editionDir, "_internal/01-approved.json"), "x");
        const editionsRootDir = join(root, "data/editions");
        const dir = resolveEditionDir(editionsRootDir, "260706");
        assert.equal(
          dir.replaceAll("\\", "/"),
          editionDir.replaceAll("\\", "/"),
        );
      } finally {
        cleanup();
      }
    });

    it("resume de edição FLAT criada por uma sessão Stage 0 anterior a #3530 continua resolvendo pro mesmo diretório (sem split-brain)", () => {
      // Simula: Stage 0 de uma sessão ANTIGA (pré-#3530) criou a pasta flat via
      // mkdir literal. Uma sessão NOVA (pós-#3530) retoma essa mesma edição —
      // resolveEditionDir() deve achar a pasta flat existente, não desviar
      // pra nested (que criaria uma segunda pasta vazia e "perderia" o
      // trabalho já feito na flat).
      const { root, cleanup } = setupSandbox();
      try {
        makeEdition(root, "260420", [
          "_internal/01-categorized.json",
          "01-categorized.md",
        ]);
        const editionsRootDir = join(root, "data/editions");
        const dirAtStage0Resume = resolveEditionDir(editionsRootDir, "260420");
        const dirAtStage2Read = resolveEditionDir(editionsRootDir, "260420");
        assert.equal(dirAtStage0Resume, dirAtStage2Read);
        assert.equal(
          dirAtStage0Resume.replaceAll("\\", "/"),
          join(editionsRootDir, "260420").replaceAll("\\", "/"),
        );
      } finally {
        cleanup();
      }
    });
  });
});
