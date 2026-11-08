/**
 * test/card-crop-review-rerun-12109.test.ts (#12109, regressão #633)
 *
 * Edição 261104: a troca do título do D1 no gate recompôs o card 4:5
 * (`gen-social-card-4x5.ts --destaque d1`), o `image-crop-warn` passou a dizer
 * "revisão descartada, re-rodar o image-crop-reviewer" e nada na cadeia de
 * re-render fazia isso. Cobre:
 *
 *  (a) `cardCropReviewRerunTargets`: quais `dN:4x5` precisam de re-revisão;
 *  (b) a descoberta `--only` grava fora do veredito principal e o persist
 *      `--only` mantém os outros destaques (o subagente gravando no principal
 *      apagava as outras entradas antes do merge);
 *  (c) `gen-social-card-4x5.ts` imprime `crop_review_rerun` quando o título
 *      mudou, e não imprime quando o card sai idêntico.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

import {
  buildCardCropReviewRerun,
  cardCropReviewRerunTargets,
  partialCropReviewOutPath,
} from "../scripts/run-image-crop-reviewer.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";

const projectRoot = join(import.meta.dirname, "..");

function makeTmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "card-crop-rerun-12109-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function verdictPath(dir: string): string {
  return join(dir, "_internal", "04-crop-review.json");
}

function writeVerdict(dir: string, results: unknown[]): void {
  writeFileSync(verdictPath(dir), JSON.stringify({ edition: "261104", checked_at: "x", results }), "utf8");
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("cardCropReviewRerunTargets (#12109)", () => {
  it("sem veredito persistido → nada a revisar (revisor não rodou nesta edição)", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), "card");
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1"]), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entrada de crop carimbada com o card atual → nada; card recomposto → alvo d1:4x5", () => {
    const dir = makeTmpEdition();
    try {
      const card = join(dir, "04-d1-4x5.jpg");
      writeFileSync(card, "card com título antigo");
      writeVerdict(dir, [{ destaque: "d1", ratio: "4x5", status: "ok", categoria: "crop", image_md5: md5OfFile(card) }]);
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1"]), []);

      writeFileSync(card, "card com título novo");
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1"]), [{ destaque: "d1", ratio: "4x5" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("só os destaques pedidos e com card no disco entram", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), "novo");
      writeFileSync(join(dir, "04-d2-4x5.jpg"), "novo");
      writeVerdict(dir, [
        { destaque: "d1", ratio: "4x5", status: "ok", image_md5: "0".repeat(32) },
        { destaque: "d2", ratio: "4x5", status: "ok", image_md5: "0".repeat(32) },
        { destaque: "d3", ratio: "4x5", status: "ok", image_md5: "0".repeat(32) },
      ]);
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1"]), [{ destaque: "d1", ratio: "4x5" }]);
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d3"]), [], "d3 sem card no disco");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("card sem entrada de crop do 4:5, ou entrada sem carimbo (pré-#9598) → alvo", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), "card");
      writeFileSync(join(dir, "04-d2-4x5.jpg"), "card");
      writeVerdict(dir, [
        { destaque: "d1", ratio: "2x1", status: "ok", image_md5: "0".repeat(32) },
        { destaque: "d2", ratio: "4x5", status: "ok" },
      ]);
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1", "d2"]), [
        { destaque: "d1", ratio: "4x5" },
        { destaque: "d2", ratio: "4x5" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entrada de estilo do 4:5 (carimbada na arte, #10325) não decide sozinha", () => {
    const dir = makeTmpEdition();
    try {
      const card = join(dir, "04-d1-4x5.jpg");
      writeFileSync(card, "card");
      writeFileSync(join(dir, "04-d1-4x5-nativo.jpg"), "arte");
      writeVerdict(dir, [
        { destaque: "d1", ratio: "4x5", status: "ok", categoria: "crop", image_md5: md5OfFile(card) },
        {
          destaque: "d1",
          ratio: "4x5",
          status: "ok",
          categoria: "estilo",
          image_md5: "0".repeat(32),
          image_variant: "4x5-nativo",
        },
      ]);
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1"]), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("veredito ilegível → todos os pedidos (o persist --only recusa e manda revisar tudo)", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(verdictPath(dir), "{não é json", "utf8");
      assert.deepEqual(cardCropReviewRerunTargets(dir, ["d1", "d9"]), [{ destaque: "d1", ratio: "4x5" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildCardCropReviewRerun: comandos de descoberta e persist com --only e o arquivo parcial", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), "novo");
      writeVerdict(dir, [{ destaque: "d1", ratio: "4x5", status: "ok", image_md5: "0".repeat(32) }]);
      const r = buildCardCropReviewRerun(dir, "data/editions/261104/", ["d1"]);
      assert.deepEqual(r, {
        targets: ["d1:4x5"],
        discover_command: "npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/261104/ --only d1:4x5",
        persist_command:
          "npx tsx scripts/run-image-crop-reviewer.ts --edition-dir data/editions/261104/ --only d1:4x5 " +
          "--input-json data/editions/261104/_internal/04-crop-review.only.json",
      });
      assert.equal(buildCardCropReviewRerun(dir, dir, ["d2"]), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run-image-crop-reviewer --only: o subagente nunca grava no veredito principal (#12109)", () => {
  it("descoberta --only devolve out_path parcial e persist_command; o persist mantém os outros destaques", () => {
    const dir = makeTmpEdition();
    try {
      for (const d of ["d1", "d2"]) {
        writeFileSync(join(dir, `04-${d}-2x1.jpg`), `${d} 2x1`);
        writeFileSync(join(dir, `04-${d}-4x5.jpg`), `${d} card`);
      }
      writeVerdict(dir, [
        { destaque: "d1", ratio: "2x1", status: "ok", image_md5: md5OfFile(join(dir, "04-d1-2x1.jpg")) },
        { destaque: "d1", ratio: "4x5", status: "ok", image_md5: "0".repeat(32) },
        { destaque: "d2", ratio: "4x5", status: "warn", motivo: "sujeito cortado", image_md5: md5OfFile(join(dir, "04-d2-4x5.jpg")) },
      ]);

      const disc = runScript("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--only", "d1:4x5"]);
      assert.equal(disc.status, 0, disc.stderr);
      const parsed = JSON.parse(disc.stdout) as { pairs: Array<{ destaque: string; ratio: string }>; out_path: string; persist_command: string };
      assert.deepEqual(parsed.pairs.map((p) => `${p.destaque}:${p.ratio}`), ["d1:4x5"]);
      assert.equal(parsed.out_path, partialCropReviewOutPath(verdictPath(dir)));
      assert.notEqual(parsed.out_path, verdictPath(dir));
      assert.match(parsed.persist_command, /--only d1:4x5 --input-json .*04-crop-review\.only\.json$/);

      // O subagente grava no out_path da descoberta.
      writeFileSync(
        parsed.out_path,
        JSON.stringify({ results: [{ destaque: "d1", ratio: "4x5", status: "warn", motivo: "título cobre o rosto" }] }),
        "utf8",
      );
      const persist = runScript("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--only", "d1:4x5", "--input-json", parsed.out_path]);
      assert.equal(persist.status, 0, persist.stderr);
      const saved = JSON.parse(readFileSync(verdictPath(dir), "utf8")) as {
        results: Array<{ destaque: string; ratio: string; status: string; motivo?: string; image_md5?: string }>;
      };
      const key = (r: { destaque: string; ratio: string }) => `${r.destaque}:${r.ratio}`;
      assert.deepEqual(saved.results.map(key).sort(), ["d1:2x1", "d1:4x5", "d2:4x5"]);
      const d1card = saved.results.find((r) => key(r) === "d1:4x5")!;
      assert.equal(d1card.motivo, "título cobre o rosto");
      assert.equal(d1card.image_md5, md5OfFile(join(dir, "04-d1-4x5.jpg")), "entrada nova carimbada com o card atual");
      assert.equal(saved.results.find((r) => key(r) === "d2:4x5")!.motivo, "sujeito cortado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persist --only com --input-json = veredito principal → exit 1 e veredito intacto", () => {
    const dir = makeTmpEdition();
    try {
      writeFileSync(join(dir, "04-d1-4x5.jpg"), "card");
      writeVerdict(dir, [{ destaque: "d1", ratio: "4x5", status: "ok" }]);
      const before = readFileSync(verdictPath(dir), "utf8");
      const r = runScript("run-image-crop-reviewer.ts", ["--edition-dir", dir, "--only", "d1:4x5", "--input-json", verdictPath(dir)]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /04-crop-review\.only\.json/);
      assert.equal(readFileSync(verdictPath(dir), "utf8"), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function reviewedMd(d1Title: string): string {
  return [
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    `**[${d1Title}](https://example.com/1)**`,
    "",
    "Corpo do primeiro destaque com contexto suficiente.",
    "",
    "Por que isso importa: contexto.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | PESQUISA**",
    "",
    "**[Modelos de linguagem superam humanos](https://example.com/2)**",
    "",
    "Corpo do segundo destaque.",
    "",
    "Por que isso importa: contexto.",
    "",
  ].join("\n");
}

describe("gen-social-card-4x5.ts sinaliza a re-revisão do card recomposto (#12109)", () => {
  it("título trocado → crop_review_rerun com d1:4x5; mesmo título → sem o bloco", async () => {
    const dir = join(makeTmpEdition(), "261104");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    try {
      const art = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#336699" } }).jpeg().toBuffer();
      writeFileSync(join(dir, "04-d1-2x1.jpg"), art);
      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd("Título original do destaque"), "utf8");
      const env = { DIARIA_ALLOW_FONT_FALLBACK: "1" };

      const first = runScript("gen-social-card-4x5.ts", ["--edition-dir", dir, "--destaque", "d1"], env);
      assert.equal(first.status, 0, first.stderr);
      assert.equal((JSON.parse(first.stdout) as { crop_review_rerun?: unknown }).crop_review_rerun, undefined, "sem veredito ainda");

      // Revisão persistida sobre o card atual (o que o Stage 3 deixa).
      writeVerdict(dir, [{ destaque: "d1", ratio: "4x5", status: "ok", categoria: "crop", image_md5: md5OfFile(join(dir, "04-d1-4x5.jpg")) }]);

      const same = runScript("gen-social-card-4x5.ts", ["--edition-dir", dir, "--destaque", "d1"], env);
      assert.equal(same.status, 0, same.stderr);
      assert.equal((JSON.parse(same.stdout) as { crop_review_rerun?: unknown }).crop_review_rerun, undefined, "card idêntico");

      writeFileSync(join(dir, "02-reviewed.md"), reviewedMd("Título trocado no gate"), "utf8");
      const changed = runScript("gen-social-card-4x5.ts", ["--edition-dir", dir, "--destaque", "d1"], env);
      assert.equal(changed.status, 0, changed.stderr);
      const out = JSON.parse(changed.stdout) as { crop_review_rerun?: { targets: string[]; discover_command: string } };
      assert.deepEqual(out.crop_review_rerun?.targets, ["d1:4x5"]);
      assert.match(out.crop_review_rerun?.discover_command ?? "", /--only d1:4x5$/);
      assert.match(changed.stderr, /revisão de crop desatualizada para d1:4x5/);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

describe("playbook do Stage 4 consome o sinal (#12109)", () => {
  it("§4d.1a manda seguir crop_review_rerun com out_path parcial antes de aceitar sim", () => {
    const md = readFileSync(join(projectRoot, ".claude", "agents", "orchestrator-stage-4.md"), "utf8");
    const i = md.indexOf("**Card 4:5 recomposto sem arte nova (troca de título, #12109).**");
    assert.ok(i > md.indexOf("### 4d.1a"), "parágrafo vive em §4d.1a, não em §4c.6 (fact-check)");
    const para = md.slice(i, md.indexOf("\n", i));
    assert.match(para, /crop_review_rerun/);
    assert.match(para, /04-crop-review\.only\.json/);
    assert.match(para, /antes de aceitar `sim`/);
    assert.match(para, /persist_command/);
    assert.match(para, /check-invariants --stage 4/);
  });
});
