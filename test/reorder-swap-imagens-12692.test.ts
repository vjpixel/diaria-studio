/**
 * #12692 — edição 261111: `reorder-destaques --new-order 3,1,2` seguido de
 * `swap-destaques` no D1 deixou um `04-d2-2x1-play.jpg` órfão (o play do D1
 * antigo renomeado junto com o destaque) e o `next_steps` mandava rodar o
 * upload sem `--mode`, que só faz o social (sem `cover`/`d{N}_2x1`).
 *
 * Quem tira `04-d1-2x1.jpg`/`04-d1-4x5-nativo.jpg` do lugar no fluxo é o
 * próprio `swap-destaques` (o D1 trocado precisa de arte nova): os arquivos vão
 * para `_internal/_forensic/swap-...-d1/` com manifest (#11573), e o teste
 * trava isso para o destino deles nunca mais ser "sumiram".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { removeStaleD1PlayImages, renameDestaqueImages } from "../scripts/reorder-destaques.ts";
import { buildSwapNextSteps } from "../scripts/swap-destaques.ts";
import { uploadImagesNextSteps } from "../scripts/lib/public-images-invalidate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUFFIXES = ["2x1", "4x5", "1x1", "4x5-nativo"];

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "reorder-swap-12692-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const titles = ["Um", "Dois", "Nubank"];
  const highlights = titles.map((t, i) => ({
    rank: i + 1,
    url: `https://example.com/${i + 1}`,
    article: { url: `https://example.com/${i + 1}`, title: t },
  }));
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({ highlights, runners_up: [], lancamento: [], radar: [], use_melhor: [], video: [] }, null, 2),
  );
  for (const n of [1, 2, 3]) {
    for (const s of SUFFIXES) writeFileSync(join(dir, `04-d${n}-${s}.jpg`), `d${n}-${s}`);
  }
  writeFileSync(join(dir, "04-d1-2x1-play.jpg"), "d1-play");
  return dir;
}

function run(script: string, args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", script), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), status: err.status ?? 1 };
  }
}

function images(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((x) => x.startsWith("04-")).sort()) {
    out[f] = readFileSync(join(dir, f), "utf8");
  }
  return out;
}

describe("reorder 3,1,2 + swap no D1 (#12692)", () => {
  it("o play do D1 antigo não vira 04-d2-2x1-play órfão e o next_steps pede os dois modos de upload", () => {
    const dir = makeEdition();
    try {
      const r = run("reorder-destaques.ts", ["--edition", "261111", "--edition-dir", dir, "--new-order", "3,1,2"]);
      assert.equal(r.status, 0, r.stderr);
      const reorder = JSON.parse(r.stdout) as { modified: { removed: string[] }; next_steps: string[] };

      const afterReorder = images(dir);
      assert.equal(afterReorder["04-d2-2x1-play.jpg"], undefined, "play do D1 antigo não pode seguir para o D2");
      assert.equal(afterReorder["04-d1-2x1-play.jpg"], undefined, "play do hero antigo apagado (o upload regera)");
      assert.deepEqual(reorder.modified.removed, ["04-d1-2x1-play.jpg"]);
      // O resto segue o destaque normalmente.
      assert.equal(afterReorder["04-d1-2x1.jpg"], "d3-2x1");
      assert.equal(afterReorder["04-d1-4x5-nativo.jpg"], "d3-4x5-nativo");
      assert.equal(afterReorder["04-d2-2x1.jpg"], "d1-2x1");
      assert.equal(afterReorder["04-d2-4x5-nativo.jpg"], "d1-4x5-nativo");
      assert.equal(afterReorder["04-d3-2x1.jpg"], "d2-2x1");
      for (const step of uploadImagesNextSteps(dir)) assert.ok(reorder.next_steps.includes(step), step);

      const s = run("swap-destaques.ts", [
        "--edition", "261111", "--edition-dir", dir,
        "--d1-url", "https://example.com/novo", "--d1-title", "Novo",
      ]);
      assert.equal(s.status, 0, s.stderr);
      const swap = JSON.parse(s.stdout) as {
        next_steps: string[];
        backups: Array<{ position: number; dir: string | null; files: string[] }>;
      };

      const afterSwap = images(dir);
      assert.deepEqual(
        Object.keys(afterSwap).filter((f) => f.includes("-play")),
        [],
        "nenhum play sobra fora do D1",
      );
      // Quem tira os 2x1/nativo do D1 é o swap, e eles ficam no backup forense.
      const b = swap.backups.find((x) => x.position === 1);
      assert.ok(b?.dir, "backup do D1 trocado");
      for (const f of ["04-d1-2x1.jpg", "04-d1-4x5-nativo.jpg"]) {
        assert.equal(afterSwap[f], undefined);
        assert.ok(b.files.includes(f), `${f} no manifest do backup`);
        assert.ok(existsSync(join(b.dir, f)), `${f} guardado em ${b.dir}`);
      }
      assert.equal(readFileSync(join(b.dir, "04-d1-2x1.jpg"), "utf8"), "d3-2x1");
      // D2/D3 intocados pelo swap.
      assert.equal(afterSwap["04-d2-2x1.jpg"], "d1-2x1");
      assert.equal(afterSwap["04-d3-2x1.jpg"], "d2-2x1");
      for (const step of uploadImagesNextSteps(dir)) assert.ok(swap.next_steps.includes(step), step);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeStaleD1PlayImages / renameDestaqueImages (#12692)", () => {
  it("com o D1 no lugar, o play do D1 fica e o órfão de outra posição sai", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "04-d2-2x1-play.jpg"), "orfao");
      const renamed = renameDestaqueImages(dir, [1, 3, 2], false);
      assert.ok(renamed.every((x) => !x.from.includes("-play")), "play nunca é renomeado");
      const res = removeStaleD1PlayImages(dir, [1, 3, 2], false);
      assert.deepEqual(res.removed, ["04-d2-2x1-play.jpg"]);
      assert.equal(readFileSync(join(dir, "04-d1-2x1-play.jpg"), "utf8"), "d1-play");
      assert.ok(!existsSync(join(dir, "04-d3-2x1-play.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run lista o play defasado sem apagar", () => {
    const dir = makeEdition();
    try {
      const res = removeStaleD1PlayImages(dir, [2, 1, 3], true);
      assert.deepEqual(res.removed, ["04-d1-2x1-play.jpg"]);
      assert.ok(existsSync(join(dir, "04-d1-2x1-play.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next_steps do swap pede upload --mode newsletter e --mode social", () => {
    const steps = buildSwapNextSteps("/x/261111/", [{ position: 1, url: "u", title: "t" }]);
    assert.ok(steps.some((s) => s.includes("upload-images-public.ts --edition-dir /x/261111/ --mode newsletter")));
    assert.ok(steps.some((s) => s.includes("upload-images-public.ts --edition-dir /x/261111/ --mode social")));
    assert.ok(!steps.some((s) => /upload-images-public\.ts(?!.*--mode)/.test(s)), "nenhum upload sem --mode");
  });
});
