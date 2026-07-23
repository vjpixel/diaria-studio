import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLAY_DIR_PREFIX,
  STAGE_INPUT_FILES,
  isKnownStagePreset,
  resolveStagePreset,
  planFileList,
  slugifyLabel,
  buildReplayDirName,
  buildFixtureManifest,
  isSafeRelPath,
  copyReferenceFile,
  createReplayFixture,
} from "../scripts/lib/replay-stage-input.ts";
import { findEditionsInProgress, enumerateEditionDirs } from "../scripts/lib/find-current-edition.ts";

function setupSandbox(): { root: string; editionsRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "replay-stage-input-"));
  const editionsRoot = join(root, "data/editions");
  mkdirSync(editionsRoot, { recursive: true });
  return { root, editionsRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeFlatEdition(editionsRoot: string, aammdd: string, files: Record<string, string>): void {
  const dir = join(editionsRoot, aammdd);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function makeNestedEdition(editionsRoot: string, aammdd: string, files: Record<string, string>): void {
  const aamm = aammdd.slice(0, 4);
  const dir = join(editionsRoot, aamm, aammdd);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

describe("slugifyLabel", () => {
  it("minúsculo, espaços/pontuação viram hífen", () => {
    assert.equal(slugifyLabel("Scorer AB Teste 1"), "scorer-ab-teste-1");
  });

  it("colapsa hífens repetidos e apara das bordas", () => {
    assert.equal(slugifyLabel("--foo__bar--"), "foo-bar");
  });

  it("lança se o slug resultante for vazio", () => {
    assert.throws(() => slugifyLabel("!!!"), /slug vazio/);
  });
});

describe("buildReplayDirName", () => {
  it("sempre prefixado replay-, mesmo com label puramente numérico (nunca vira AAMMDD/AAMM)", () => {
    const name = buildReplayDirName("260415");
    assert.equal(name, "replay-260415");
    assert.doesNotMatch(name, /^\d{6}$/);
    assert.doesNotMatch(name, /^\d{4}$/);
  });

  it("sem label, deriva slug do timestamp passado (ainda prefixado)", () => {
    const name = buildReplayDirName(undefined, "2026-07-22T10:00:00.000Z");
    assert.ok(name.startsWith(REPLAY_DIR_PREFIX));
  });
});

describe("resolveStagePreset / isKnownStagePreset", () => {
  it("presets conhecidos: 1, 1-scorer, 2", () => {
    assert.ok(isKnownStagePreset("1"));
    assert.ok(isKnownStagePreset("1-scorer"));
    assert.ok(isKnownStagePreset("2"));
    assert.equal(isKnownStagePreset("3"), false);
  });

  it("retorna cópia (não a referência viva) do array de arquivos do preset", () => {
    const a = resolveStagePreset("2");
    a.push("mutacao-nao-deveria-vazar.json");
    const b = resolveStagePreset("2");
    assert.deepEqual(b, STAGE_INPUT_FILES["2"]);
  });

  it("lança com mensagem listando os presets válidos quando desconhecido", () => {
    assert.throws(() => resolveStagePreset("99"), /preset de --stage desconhecido.*1-scorer/s);
  });
});

describe("planFileList", () => {
  it("--files explícito vence sobre --stage", () => {
    const list = planFileList("2", "a.json, b.json ,c.json");
    assert.deepEqual(list, ["a.json", "b.json", "c.json"]);
  });

  it("sem --files, resolve o preset de --stage", () => {
    assert.deepEqual(planFileList("1-scorer", undefined), STAGE_INPUT_FILES["1-scorer"]);
  });

  it("lança se nem --stage nem --files forem passados", () => {
    assert.throws(() => planFileList(undefined, undefined), /precisa de --stage/);
  });
});

describe("isSafeRelPath (#3922 self-review — guard de path traversal)", () => {
  it("aceita paths relativos normais (com ou sem subdiretório)", () => {
    assert.equal(isSafeRelPath("_internal/01-approved.json"), true);
    assert.equal(isSafeRelPath("01-categorized.md"), true);
  });

  it("rejeita paths absolutos", () => {
    assert.equal(isSafeRelPath("/etc/passwd"), false);
  });

  it("rejeita qualquer segmento '..' (posix e windows)", () => {
    assert.equal(isSafeRelPath("../../../../etc/passwd"), false);
    assert.equal(isSafeRelPath("_internal/../../escape.json"), false);
    assert.equal(isSafeRelPath("..\\..\\escape.json"), false);
  });

  it("rejeita string vazia", () => {
    assert.equal(isSafeRelPath(""), false);
  });
});

describe("copyReferenceFile", () => {
  it("path inseguro ('..') → copied:false com reason, nunca copia nem lança (#3922 path traversal guard)", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      const refDir = join(editionsRoot, "260715");
      makeFlatEdition(editionsRoot, "260715", {});
      // Arquivo que EXISTE fora da edição de referência, no editionsRoot.
      writeFileSync(join(editionsRoot, "outside-secret.json"), "nao deveria vazar");
      const testDir = join(editionsRoot, "replay-test-traversal");
      const result = copyReferenceFile(refDir, testDir, "../outside-secret.json");
      assert.equal(result.copied, false);
      assert.match(result.reason ?? "", /inseguro/);
      assert.equal(existsSync(join(editionsRoot, "outside-secret.json")), true, "arquivo original intacto");
      assert.equal(existsSync(testDir), false, "nada deveria ter sido criado no destino");
    } finally {
      cleanup();
    }
  });

  it("copia arquivo existente e retorna copied:true com bytes", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      const refDir = join(editionsRoot, "260715");
      makeFlatEdition(editionsRoot, "260715", { "_internal/01-approved.json": '{"x":1}' });
      const testDir = join(editionsRoot, "replay-test-copy");
      const result = copyReferenceFile(refDir, testDir, "_internal/01-approved.json");
      assert.equal(result.copied, true);
      assert.ok((result.bytes ?? 0) > 0);
      assert.equal(readFileSync(join(testDir, "_internal/01-approved.json"), "utf8"), '{"x":1}');
    } finally {
      cleanup();
    }
  });

  it("arquivo ausente na referência → copied:false com reason, nunca lança", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      const refDir = join(editionsRoot, "260715");
      makeFlatEdition(editionsRoot, "260715", {});
      const testDir = join(editionsRoot, "replay-test-missing");
      const result = copyReferenceFile(refDir, testDir, "_internal/tmp-dates-reviewed.json");
      assert.equal(result.copied, false);
      assert.ok(result.reason);
      assert.equal(existsSync(join(testDir, "_internal/tmp-dates-reviewed.json")), false);
    } finally {
      cleanup();
    }
  });
});

describe("buildFixtureManifest", () => {
  it("monta o objeto com scope note e schema_version fixos", () => {
    const m = buildFixtureManifest({
      referenceEdition: "260715",
      referenceDirRel: "260715",
      testDirName: "replay-foo",
      stagePreset: "2",
      files: [{ relPath: "_internal/01-approved.json", copied: true, bytes: 10 }],
      createdAtIso: "2026-07-22T00:00:00.000Z",
    });
    assert.equal(m.schema_version, 1);
    assert.equal(m.kind, "replay-stage-input-fixture");
    assert.match(m.note, /NÃO é uma edição real/);
    assert.equal(m.reference_edition, "260715");
    assert.equal(m.test_dir_name, "replay-foo");
  });
});

describe("createReplayFixture — (a) fixture criado corretamente a partir de edição de referência real", () => {
  it("copia os arquivos do preset '2' da edição de referência FLAT para o diretório de teste isolado", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      makeFlatEdition(editionsRoot, "260715", {
        "_internal/01-approved.json": '{"destaques":[]}',
        "01-categorized.md": "# categorizado",
        "02-reviewed.md": "não deveria ser copiado", // fora do preset "2" input
      });

      const manifest = createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "writer-ab-a",
        nowIso: "2026-07-22T00:00:00.000Z",
      });

      assert.equal(manifest.test_dir_name, "replay-writer-ab-a");
      assert.equal(manifest.reference_edition, "260715");
      assert.equal(manifest.files.length, 2);
      assert.ok(manifest.files.every((f) => f.copied));

      const testDir = join(editionsRoot, "replay-writer-ab-a");
      assert.equal(
        readFileSync(join(testDir, "_internal/01-approved.json"), "utf8"),
        '{"destaques":[]}',
      );
      assert.equal(readFileSync(join(testDir, "01-categorized.md"), "utf8"), "# categorizado");
      // Arquivo fora do preset não deve ter sido copiado.
      assert.equal(existsSync(join(testDir, "02-reviewed.md")), false);

      // Manifest também foi persistido em disco.
      const onDisk = JSON.parse(readFileSync(join(testDir, "_internal/replay-manifest.json"), "utf8"));
      assert.deepEqual(onDisk, manifest);
    } finally {
      cleanup();
    }
  });

  it("funciona com edição de referência em layout NESTED (reusa resolveEditionDir)", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      makeNestedEdition(editionsRoot, "260706", {
        "_internal/tmp-dates-reviewed.json": '{"lancamento":[]}',
      });

      const manifest = createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260706",
        stage: "1-scorer",
        label: "scorer-ab-nested",
      });

      assert.equal(manifest.files.length, 1);
      assert.equal(manifest.files[0].copied, true);
      const testDir = join(editionsRoot, "replay-scorer-ab-nested");
      assert.equal(
        readFileSync(join(testDir, "_internal/tmp-dates-reviewed.json"), "utf8"),
        '{"lancamento":[]}',
      );
    } finally {
      cleanup();
    }
  });

  it("arquivo ausente na edição de referência aparece como copied:false, não lança", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      // Edição de referência só tem 01-approved.json — sem 01-categorized.md.
      makeFlatEdition(editionsRoot, "260715", { "_internal/01-approved.json": "{}" });
      const manifest = createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "partial",
      });
      const md = manifest.files.find((f) => f.relPath === "01-categorized.md");
      assert.ok(md);
      assert.equal(md!.copied, false);
    } finally {
      cleanup();
    }
  });

  it("--files explícito sobrescreve o preset default", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      makeFlatEdition(editionsRoot, "260715", { "_internal/custom-pool.json": '{"custom":true}' });
      const manifest = createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        filesOverrideCsv: "_internal/custom-pool.json",
        label: "custom",
      });
      assert.deepEqual(
        manifest.files.map((f) => f.relPath),
        ["_internal/custom-pool.json"],
      );
      assert.equal(manifest.files[0].copied, true);
    } finally {
      cleanup();
    }
  });

  it("lança se a edição de referência não existir em disco", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      assert.throws(
        () =>
          createReplayFixture({
            editionsRootDir: editionsRoot,
            referenceAammdd: "260101",
            stage: "2",
            label: "sem-referencia",
          }),
        /não encontrada em disco/,
      );
    } finally {
      cleanup();
    }
  });

  it("lança se --reference-edition não for AAMMDD (6 dígitos)", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      assert.throws(
        () =>
          createReplayFixture({
            editionsRootDir: editionsRoot,
            referenceAammdd: "replay-outro-teste",
            stage: "2",
          }),
        /deve ser AAMMDD/,
      );
    } finally {
      cleanup();
    }
  });

  it("lança se o diretório de teste já existir sem force; sobrescreve com force:true", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      makeFlatEdition(editionsRoot, "260715", { "_internal/01-approved.json": "{}" });
      createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "dup",
      });
      assert.throws(
        () =>
          createReplayFixture({
            editionsRootDir: editionsRoot,
            referenceAammdd: "260715",
            stage: "2",
            label: "dup",
          }),
        /já existe/,
      );
      // Com force, sobrescreve sem lançar.
      const manifest = createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "dup",
        force: true,
      });
      assert.equal(manifest.test_dir_name, "replay-dup");
    } finally {
      cleanup();
    }
  });
});

describe("createReplayFixture — (b) find-current-edition.ts NUNCA trata o diretório de teste como edição real", () => {
  it("enumerateEditionDirs não inclui o diretório replay- entre as edições enumeradas", () => {
    const { editionsRoot, cleanup } = setupSandbox();
    try {
      makeFlatEdition(editionsRoot, "260715", { "_internal/01-approved.json": "{}" });
      createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "260716", // label numérico de propósito — pior caso de colisão
      });

      const found = enumerateEditionDirs(editionsRoot);
      assert.ok(found.has("260715"), "edição real de referência deve continuar visível");
      assert.equal(found.has("260716"), false, "label do replay não deve colidir com uma AAMMDD real");
      assert.equal(
        [...found.keys()].some((k) => k.startsWith("replay-")),
        false,
        "nenhuma chave enumerada deve conter o diretório replay-",
      );
    } finally {
      cleanup();
    }
  });

  it("findEditionsInProgress (qualquer stage) nunca lista o diretório replay- como candidato", () => {
    const { root, editionsRoot, cleanup } = setupSandbox();
    try {
      // Diretório de teste com EXATAMENTE os arquivos que satisfariam o prereq
      // do Stage 2 (_internal/01-approved.json presente, 02-reviewed.md ausente)
      // — se o guard de prefixo falhasse, isto apareceria como candidato Stage 2.
      makeFlatEdition(editionsRoot, "260715", { "_internal/01-approved.json": "{}" });
      createReplayFixture({
        editionsRootDir: editionsRoot,
        referenceAammdd: "260715",
        stage: "2",
        label: "fake-stage2-shape",
      });

      const candidates = findEditionsInProgress(2, root);
      assert.deepEqual(candidates, ["260715"], "só a edição real de referência deve aparecer, nunca o replay-");
    } finally {
      cleanup();
    }
  });
});
