/**
 * test/carousel-keep-art-reindex-11213.test.ts (#11213)
 *
 * `_internal/carousel-keep-art.json` (#11210) é chaveado pela POSIÇÃO (d1/d2/d3).
 * Achado do review da PR #11212: `reorder-destaques.ts`, `promote-to-destaque.ts`
 * e `swap-destaque.ts` não mexiam no arquivo, então depois de um reorder a
 * exceção passava a valer para a história errada — o gate rebaixava a warning
 * o stale/overflow de um destaque que o editor NÃO quis manter. No swap, a
 * exceção da história rebaixada ficava presa à posição e congelaria a arte
 * nova assim que gerada.
 *
 * CLI ponta a ponta no reorder e nos swaps porque a regressão é de fiação em
 * main(); promote via `promoteToDestaque` (a função é o main).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  remapCarouselKeepArt,
  clearCarouselKeepArt,
  updateCarouselKeepArtFile,
  carouselKeepArtPath,
  readCarouselKeepArt,
  describeCarouselKeepArtRemap,
} from "../scripts/lib/carousel-keep-art.ts";
import { promoteToDestaque } from "../scripts/promote-to-destaque.ts";

const ROOT = join(import.meta.dirname, "..");

function run(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeKeepArt(dir: string, data: unknown): void {
  writeFileSync(carouselKeepArtPath(dir), JSON.stringify(data));
}

function makeEdition(n: 2 | 3): string {
  const dir = mkdtempSync(join(tmpdir(), "keep-art-11213-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const urls = ["https://a.com/1", "https://b.com/2", "https://c.com/3"].slice(0, n);
  const approved = {
    highlights: urls.map((url, i) => ({
      rank: i + 1,
      score: 90 - i,
      bucket: "radar",
      url,
      title_options: [`T${i + 1}`],
      article: { url, title: `T${i + 1}` },
    })),
    radar: [{ url: "https://r.com/0", title: "Radar 0", score: 50, category: "noticias" }],
    lancamento: [],
    use_melhor: [],
    video: [],
    runners_up: [],
  };
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved, null, 2));
  writeFileSync(join(internal, "01-approved-capped.json"), JSON.stringify(approved, null, 2));
  return dir;
}

describe("remapCarouselKeepArt / clearCarouselKeepArt (#11213)", () => {
  it("a exceção segue a história: newOrder [2,1,3] leva d2 → d1", () => {
    assert.deepEqual(remapCarouselKeepArt({ d2: "m" }, [2, 1, 3]), { d1: "m" });
    assert.deepEqual(remapCarouselKeepArt({ d1: "a", d3: "c" }, [3, 1, 2]), { d1: "c", d2: "a" });
  });

  it("chave sem posição nova correspondente (d3 numa edição de 2) sai", () => {
    assert.deepEqual(remapCarouselKeepArt({ d3: "resíduo", d1: "a" }, [2, 1]), { d2: "a" });
  });

  it("clear apaga a posição inserida depois do remapeamento (resíduo d3 não vaza)", () => {
    assert.deepEqual(remapCarouselKeepArt({ d3: "resíduo", d1: "a" }, [3, 1, 2], ["d1"]), { d2: "a" });
  });

  it("clearCarouselKeepArt só tira as posições pedidas, sem mover as demais", () => {
    assert.deepEqual(clearCarouselKeepArt({ d1: "a", d2: "b" }, ["d2"]), { d1: "a" });
  });
});

describe("updateCarouselKeepArtFile (#11213)", () => {
  it("ausente → no-op; malformado → warning e arquivo intocado; dry-run não grava", () => {
    const dir = makeEdition(3);
    try {
      assert.deepEqual(updateCarouselKeepArtFile(dir, (k) => k).rewritten, null);

      writeFileSync(carouselKeepArtPath(dir), "{ não é json");
      const bad = updateCarouselKeepArtFile(dir, (k) => remapCarouselKeepArt(k, [2, 1, 3]));
      assert.equal(bad.rewritten, null);
      assert.match(bad.warning ?? "", /NÃO reindexada/);
      assert.equal(readFileSync(carouselKeepArtPath(dir), "utf8"), "{ não é json");

      writeKeepArt(dir, { d2: "m" });
      const dry = updateCarouselKeepArtFile(dir, (k) => remapCarouselKeepArt(k, [2, 1, 3]), true);
      assert.equal(dry.rewritten, carouselKeepArtPath(dir));
      assert.deepEqual(readCarouselKeepArt(dir), { d2: "m" });

      // ordem de chaves diferente com o mesmo conteúdo não regrava
      writeKeepArt(dir, { d3: "c", d1: "a" });
      assert.equal(updateCarouselKeepArtFile(dir, (k) => remapCarouselKeepArt(k, [1, 2, 3])).rewritten, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reorder-destaques.ts reindexa carousel-keep-art.json (#11213)", () => {
  it("--new-order 2,1,3 com exceção em d2: a exceção vai para d1, junto com a história", () => {
    const dir = makeEdition(3);
    try {
      writeKeepArt(dir, { d2: "editor reparagrafou" });
      const r = run("reorder-destaques.ts", ["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readCarouselKeepArt(dir), { d1: "editor reparagrafou" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não mexe no arquivo", () => {
    const dir = makeEdition(3);
    try {
      writeKeepArt(dir, { d2: "m" });
      const r = run("reorder-destaques.ts", ["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3", "--dry-run"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readCarouselKeepArt(dir), { d2: "m" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("promote-to-destaque.ts reindexa carousel-keep-art.json (#11213)", () => {
  it("--position 1: d1→d2, d2→d3, e a posição nova nasce sem exceção (resíduo d3 não vaza)", () => {
    const dir = makeEdition(2);
    try {
      writeKeepArt(dir, { d1: "a", d2: "b", d3: "resíduo de demoção" });
      promoteToDestaque(dir, "https://r.com/0", 1);
      assert.deepEqual(readCarouselKeepArt(dir), { d2: "a", d3: "b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("swaps apagam a exceção da posição trocada (#11213)", () => {
  it("swap-destaque.ts --demote d2: exceção de d2 sai, a de d1 fica", () => {
    const dir = makeEdition(3);
    try {
      writeKeepArt(dir, { d1: "a", d2: "b" });
      const r = run("swap-destaque.ts", ["--edition", "999999", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d2"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readCarouselKeepArt(dir), { d1: "a" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque.ts --dry-run anuncia a remoção sem gravar", () => {
    const dir = makeEdition(3);
    try {
      writeKeepArt(dir, { d2: "b" });
      const r = run("swap-destaque.ts", [
        "--edition", "999999", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d2", "--dry-run",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /exceção de d2 removida/);
      assert.deepEqual(readCarouselKeepArt(dir), { d2: "b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaques.ts --d3-url: exceção de d3 sai", () => {
    const dir = makeEdition(3);
    try {
      writeKeepArt(dir, { d1: "a", d3: "c" });
      const r = run("swap-destaques.ts", [
        "--edition", "999999", "--edition-dir", dir, "--d3-url", "https://novo.com/x", "--d3-title", "Novo",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readCarouselKeepArt(dir), { d1: "a" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review da PR #11229: arquivo malformado tem que aparecer no plano do dry-run,
// no resultado estruturado e dizer quais posições a operação mexeu.
// ---------------------------------------------------------------------------

const MALFORMED = "{ não é json";

function parseStdoutJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
}

describe("aviso de carousel-keep-art.json malformado (#11213, review #11229)", () => {
  it("describeCarouselKeepArtRemap descreve as posições movidas e as zeradas", () => {
    assert.equal(describeCarouselKeepArtRemap([2, 1, 3]), "newOrder=[2,1,3] (d1←d2, d2←d1, d3←d3)");
    assert.equal(
      describeCarouselKeepArtRemap([3, 1, 2], ["d1"]),
      "newOrder=[3,1,2] (d1←d3, d2←d1, d3←d2); d1 sem exceção (história nova)",
    );
  });

  it("updateCarouselKeepArtFile põe a operação no warning do caso malformado", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(carouselKeepArtPath(dir), MALFORMED);
      const r = updateCarouselKeepArtFile(
        dir,
        (k) => remapCarouselKeepArt(k, [2, 1, 3]),
        false,
        undefined,
        `reorder aplicado com ${describeCarouselKeepArtRemap([2, 1, 3])}`,
      );
      assert.match(r.warning ?? "", /reorder aplicado com newOrder=\[2,1,3\] \(d1←d2, d2←d1, d3←d3\)/);
      assert.match(r.warning ?? "", /remapear as chaves à mão/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque.ts --dry-run com arquivo malformado: plano mostra o aviso, não 'nada a remover'", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(carouselKeepArtPath(dir), MALFORMED);
      const r = run("swap-destaque.ts", [
        "--edition", "999999", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d2", "--dry-run",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = parseStdoutJson(r.stdout);
      const plan = (out.dry_run_plan as Record<string, string>).carousel_keep_art;
      assert.match(plan, /NÃO reindexada/);
      assert.doesNotMatch(plan, /nada a remover/);
      assert.ok((out.warnings as string[]).some((w) => /NÃO reindexada.*d2/.test(w)), r.stdout);
      assert.equal(readFileSync(carouselKeepArtPath(dir), "utf8"), MALFORMED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaque.ts run real com arquivo malformado: aviso chega em result.warnings", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(carouselKeepArtPath(dir), MALFORMED);
      const r = run("swap-destaque.ts", ["--edition", "999999", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d2"]);
      assert.equal(r.status, 0, r.stderr);
      const warnings = parseStdoutJson(r.stdout).warnings as string[] | undefined;
      assert.ok(warnings?.some((w) => /NÃO reindexada: swap trocou a história de d2/.test(w)), r.stdout);
      assert.equal(readFileSync(carouselKeepArtPath(dir), "utf8"), MALFORMED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swap-destaques.ts com arquivo malformado: aviso chega em result.warnings", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(carouselKeepArtPath(dir), MALFORMED);
      const r = run("swap-destaques.ts", [
        "--edition", "999999", "--edition-dir", dir, "--d3-url", "https://novo.com/x", "--d3-title", "Novo",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const warnings = parseStdoutJson(r.stdout).warnings as string[];
      assert.ok(warnings.some((w) => /NÃO reindexada: swap trocou a história de d3/.test(w)), r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reorder-destaques.ts com arquivo malformado: aviso com o newOrder chega em warnings", () => {
    const dir = makeEdition(3);
    try {
      writeFileSync(carouselKeepArtPath(dir), MALFORMED);
      const r = run("reorder-destaques.ts", ["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"]);
      assert.equal(r.status, 0, r.stderr);
      const warnings = parseStdoutJson(r.stdout).warnings as string[];
      assert.ok(
        warnings.some((w) => w.includes("reorder aplicado com newOrder=[2,1,3] (d1←d2, d2←d1, d3←d3)")),
        r.stdout,
      );
      assert.equal(readFileSync(carouselKeepArtPath(dir), "utf8"), MALFORMED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
