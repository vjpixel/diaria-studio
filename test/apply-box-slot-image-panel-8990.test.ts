// #8990 (decisão do editor 260930): (1) imagem irmã do snippet copiada pra
// `04-box-slot{N}.jpg` + upload validado; (2) painel Caixas avisa quando a
// edição corrente já foi stitched e oferece "aplicar na edição" — sempre sem
// sobrescrever box editado à mão. `data/` é gitignored: tudo em fixture tmp.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  applyBoxSlotToEdition,
  classifyPublishMarkers,
  findSiblingSnippetImage,
  isBoxSlotImageUploaded,
  siblingImageCandidates,
} from "../scripts/apply-box-slot.ts";
import {
  applySlotToStitchedEdition,
  checkStitchedEditionAfterSlotSave,
  detectStitchedSlotMismatches,
  findStitchedEdition,
} from "../scripts/studio-ui/studio-boxes.ts";
import { md5OfFile } from "../scripts/lib/shared/file-md5.ts";

const OLD = "**📚 Livro velho: [Compre](https://amzn.to/velho)**";
const NEW = "**📣 Workshop novo: [Inscreva-se](https://diar.ia.br/workshop?utm_content=x)**";
const OTHER = "**🎉 Outra caixa: [Veja](https://x.com/outra)**";
const md = (box1: string, box2 = OTHER): string =>
  `intro\n\n---\n\n**DESTAQUE 1 | 🚀**\n\n[Título 1](https://d1.com)\n\ncorpo 1\n\n---\n\n${box1}\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[Título 2](https://d2.com)\n\ncorpo 2\n\n---\n\n${box2}\n\n---\n\n**DESTAQUE 3 | 🚀**\n\n[Título 3](https://d3.com)\n\ncorpo 3\n`;

const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const JPEG_OLD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9]);

let root: string;
let edDir: string;

function setup(opts: { reviewed?: string; publicImages?: boolean } = {}): void {
  root = mkdtempSync(join(tmpdir(), "abs-8990-"));
  const snip = join(root, "data", "snippets");
  mkdirSync(snip, { recursive: true });
  writeFileSync(join(snip, "velho.md"), OLD);
  writeFileSync(join(snip, "novo.md"), NEW);
  writeFileSync(join(snip, "outra.md"), OTHER);
  edDir = join(root, "data", "editions", "2610", "261001");
  mkdirSync(join(edDir, "_internal"), { recursive: true });
  writeFileSync(join(edDir, "02-reviewed.md"), opts.reviewed ?? md(OLD));
  writeFileSync(
    join(edDir, "_internal", "box-selection.json"),
    JSON.stringify([
      { slot: 1, mode: "auto", file: "velho.md" },
      { slot: 2, mode: "auto", file: "outra.md" },
    ]),
  );
  writeFileSync(join(edDir, "04-box-slot1.jpg"), JPEG_OLD);
  if (opts.publicImages !== false) writeFileSync(join(edDir, "06-public-images.json"), JSON.stringify({ images: {} }));
}

/** Upload fake: grava a entry como o upload-images-public.ts faria. */
function fakeUpload(calls: string[]) {
  return (dir: string) => {
    calls.push(dir);
    const p = join(dir, "06-public-images.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.images.box_slot1_image = { url: "https://x/img.jpg", md5: md5OfFile(join(dir, "04-box-slot1.jpg")) };
    writeFileSync(p, JSON.stringify(j));
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("#8990 imagem irmã — helpers puros", () => {
  it("candidatos seguem o basename do .md, ordem jpg > jpeg > png", () => {
    assert.deepEqual(siblingImageCandidates("x-y.md"), ["x-y.jpg", "x-y.jpeg", "x-y.png"]);
    assert.equal(findSiblingSnippetImage("x.md", (n) => n === "x.png" || n === "x.jpeg"), "x.jpeg");
    assert.equal(findSiblingSnippetImage("x.md", () => false), null);
  });
  it("isBoxSlotImageUploaded exige md5 igual e URL", () => {
    assert.equal(isBoxSlotImageUploaded({ images: { box_slot1_image: { md5: "a", url: "u" } } }, 1, "a"), true);
    assert.equal(isBoxSlotImageUploaded({ images: { box_slot1_image: { md5: "b", url: "u" } } }, 1, "a"), false);
    assert.equal(isBoxSlotImageUploaded({ images: {} }, 1, "a"), false);
  });
});

describe("#8990 applyBoxSlotToEdition — imagem", () => {
  it("imagem irmã .jpg → copiada pra 04-box-slot1.jpg, upload roda e valida", async () => {
    setup();
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const calls: string[] = [];
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", runUpload: fakeUpload(calls) });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.image, "copied");
    assert.equal(res.uploaded, true);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_A);
    assert.equal(calls.length, 1);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(NEW));
  });

  it("sem imagem irmã → imagem anterior retirada (jpg + entry do 06-public-images) com backup", async () => {
    setup();
    const oldEntry = { url: "https://x/velho.jpg", md5: "old" };
    writeFileSync(join(edDir, "06-public-images.json"), JSON.stringify({ images: { box_slot1_image: oldEntry, cover: { url: "c" } } }));
    const calls: string[] = [];
    const res = await applyBoxSlotToEdition({
      rootDir: root,
      editionDir: edDir,
      slot: 1,
      file: "novo.md",
      runUpload: fakeUpload(calls),
      now: () => new Date("2026-10-01T12:00:00Z"),
    });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.image, "removed");
    assert.equal(res.uploaded, null);
    assert.equal(calls.length, 0);
    assert.match(res.warnings.join(" "), /sem imagem irmã.*slot 1 fica sem imagem/);
    assert.equal(existsSync(join(edDir, "04-box-slot1.jpg")), false);
    const stamp = "2026-10-01T12-00-00-000Z";
    assert.deepEqual(readFileSync(join(edDir, "_internal", `04-box-slot1.replaced-${stamp}.jpg`)), JPEG_OLD);
    const pub = JSON.parse(readFileSync(join(edDir, "06-public-images.json"), "utf8"));
    assert.equal(pub.images.box_slot1_image, undefined);
    assert.deepEqual(pub.images.cover, { url: "c" }, "demais entries intactas");
    const bak = JSON.parse(readFileSync(join(edDir, "_internal", `box_slot1_image.replaced-${stamp}.json`), "utf8"));
    assert.deepEqual(bak, { box_slot1_image: oldEntry });
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(NEW), "texto troca mesmo sem imagem");
  });

  it("--force reaplicando o MESMO snippet sem imagem irmã → imagem atual mantida (kept)", async () => {
    setup();
    const entry = { url: "https://x/manual.jpg", md5: "m" };
    writeFileSync(join(edDir, "06-public-images.json"), JSON.stringify({ images: { box_slot1_image: entry } }));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "velho.md", force: true });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.image, "kept");
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_OLD);
    assert.deepEqual(JSON.parse(readFileSync(join(edDir, "06-public-images.json"), "utf8")).images.box_slot1_image, entry);
  });

  it("dry-run: só a entry box_slot1_image (sem .jpg) → removed citando a URL", async () => {
    setup();
    rmSync(join(edDir, "04-box-slot1.jpg"));
    writeFileSync(join(edDir, "06-public-images.json"), JSON.stringify({ images: { box_slot1_image: { url: "https://x/velho.jpg" } } }));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", dryRun: true });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.image, "removed");
    assert.match(res.warnings.join(" "), /seria retirado: entry box_slot1_image \(https:\/\/x\/velho\.jpg\)/);
    assert.ok(JSON.parse(readFileSync(join(edDir, "06-public-images.json"), "utf8")).images.box_slot1_image, "dry-run não remove");
  });

  it("falha no passo de imagem pós-texto → warning 'texto aplicado, imagem não', sem exceção", async () => {
    setup();
    writeFileSync(join(edDir, "06-public-images.json"), "{ json quebrado");
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", now: () => new Date("2026-10-01T12:00:00Z") });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.image, "failed");
    assert.match(res.warnings.join(" "), /texto aplicado, imagem não:/);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(NEW));
  });

  it("sem imagem irmã e slot sem imagem → missing, nada movido", async () => {
    setup();
    rmSync(join(edDir, "04-box-slot1.jpg"));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md" });
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.image, "missing");
  });

  it("PNG irmão corrompido → image-failed SEM escrever texto/seleção/imagem", async () => {
    setup();
    writeFileSync(join(root, "data", "snippets", "novo.png"), Buffer.from("não sou png"));
    const beforeMd = readFileSync(join(edDir, "02-reviewed.md"), "utf8");
    const beforeSel = readFileSync(join(edDir, "_internal", "box-selection.json"), "utf8");
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", runUpload: () => assert.fail("upload") });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "image-failed");
    assert.equal(readFileSync(join(edDir, "02-reviewed.md"), "utf8"), beforeMd);
    assert.equal(readFileSync(join(edDir, "_internal", "box-selection.json"), "utf8"), beforeSel);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_OLD);
    assert.equal(existsSync(join(edDir, "_internal", ".04-box-slot1.pending.jpg")), false, "temporário limpo");
  });

  it("slot 2 com imagem irmã", async () => {
    setup();
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 2, file: "novo.md", runUpload: () => {} });
    assert.ok(res.ok);
    assert.equal(readFileSync(join(edDir, "02-reviewed.md"), "utf8"), md(OLD, NEW));
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot2.jpg")), JPEG_A);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_OLD, "slot 1 intocado");
  });

  it("rascunho no ESP (marcador Kit sem scheduled_at) → warning de re-rodar Stage 5", async () => {
    setup();
    writeFileSync(join(edDir, "_internal", "newsletter-kit-published.json"), JSON.stringify({ status: "draft", broadcast_id: 1 }));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md" });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.publishState, "draft");
    assert.match(res.warnings.join(" "), /rascunho no ESP continua com o box antigo.*\/diaria-5-publicacao newsletter 261001/);
  });

  it("sem baseline → mensagem com comando de CLI --force exato e erro da caixa anterior", async () => {
    setup();
    rmSync(join(root, "data", "snippets", "velho.md"));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md" });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, "no-baseline");
    assert.ok(res.message.includes("npx tsx scripts/apply-box-slot.ts --edition 261001 --slot 1 --file novo.md --force"));
    assert.match(res.message, /velho\.md.*não existe/);
  });

  it("box editado à mão → aborta antes de tocar texto OU imagem", async () => {
    setup({ reviewed: md("**📚 Texto que o editor reescreveu: [Compre](https://amzn.to/velho)**") });
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const calls: string[] = [];
    const before = readFileSync(join(edDir, "02-reviewed.md"), "utf8");
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", runUpload: fakeUpload(calls) });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "edited");
    assert.equal(readFileSync(join(edDir, "02-reviewed.md"), "utf8"), before);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_OLD);
    assert.equal(calls.length, 0);
  });

  it("upload falha → ok com warning e uploaded=false (imagem local já trocada)", async () => {
    setup();
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const res = await applyBoxSlotToEdition({
      rootDir: root,
      editionDir: edDir,
      slot: 1,
      file: "novo.md",
      runUpload: () => {
        throw new Error("KV 500");
      },
    });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.uploaded, false);
    assert.match(res.warnings.join(" "), /upload da imagem falhou \(KV 500\).*upload-images-public\.ts/);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_A);
  });

  it("sem 06-public-images.json → copia mas não sobe (pipeline sobe depois)", async () => {
    setup({ publicImages: false });
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const calls: string[] = [];
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", runUpload: fakeUpload(calls) });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.uploaded, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_A);
  });

  it("imagem irmã .png → convertida pra JPEG de verdade", async () => {
    setup({ publicImages: false });
    await sharp({ create: { width: 4, height: 6, channels: 4, background: { r: 0, g: 160, b: 160, alpha: 1 } } })
      .png()
      .toFile(join(root, "data", "snippets", "novo.png"));
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md" });
    assert.ok(res.ok);
    const out = readFileSync(join(edDir, "04-box-slot1.jpg"));
    assert.equal(out[0], 0xff);
    assert.equal(out[1], 0xd8);
  });

  it("dry-run não escreve nada", async () => {
    setup();
    writeFileSync(join(root, "data", "snippets", "novo.jpg"), JPEG_A);
    const res = await applyBoxSlotToEdition({ rootDir: root, editionDir: edDir, slot: 1, file: "novo.md", dryRun: true, runUpload: () => assert.fail("upload em dry-run") });
    assert.ok(res.ok);
    assert.deepEqual(readFileSync(join(edDir, "04-box-slot1.jpg")), JPEG_OLD);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(OLD));
  });
});

describe("#8990 painel Caixas — edição já stitched", () => {
  beforeEach(() => setup());

  it("detectStitchedSlotMismatches: só slots com box e snippet diferente", () => {
    const selection = [
      { slot: 1, mode: "auto", file: "velho.md" },
      { slot: 2, mode: "auto", file: "outra.md" },
    ];
    const base = { edition: "261001", selection, reviewedMd: md(OLD) };
    assert.deepEqual(detectStitchedSlotMismatches({ ...base, slots: { slot1: "novo.md", slot2: "outra.md" } }), [
      {
        slot: 1,
        from: "velho.md",
        to: "novo.md",
        applicable: true,
        forceCommand: "npx tsx scripts/apply-box-slot.ts --edition 261001 --slot 1 --file novo.md --force",
      },
    ]);
    const s2 = detectStitchedSlotMismatches({ ...base, slots: { slot1: "velho.md", slot2: "novo.md" } });
    assert.deepEqual(s2.map((m) => [m.slot, m.from, m.to]), [[2, "outra.md", "novo.md"]]);
    assert.deepEqual(detectStitchedSlotMismatches({ ...base, slots: { slot1: "", slot2: "outra.md" } }), []);
    const noBoxes = "intro\n\n---\n\n**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\ncorpo\n";
    assert.deepEqual(detectStitchedSlotMismatches({ ...base, slots: { slot1: "novo.md", slot2: "x.md" }, reviewedMd: noBoxes }), []);
  });

  it("sem referência (from nulo ou caixa anterior sumiu) → applicable=false (sem botão que sempre dá 409)", () => {
    const nulo = detectStitchedSlotMismatches({ edition: "261001", slots: { slot1: "novo.md", slot2: "" }, selection: [], reviewedMd: md(OLD) });
    assert.equal(nulo[0].from, null);
    assert.equal(nulo[0].applicable, false);
    rmSync(join(root, "data", "snippets", "velho.md"));
    const info = checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" });
    assert.equal(info?.mismatches[0].applicable, false);
  });

  it("checkStitchedEditionAfterSlotSave acha a edição corrente; Beehiiv publicada → null", () => {
    const info = checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" });
    assert.equal(info?.edition, "261001");
    assert.equal(info?.publishState, "none");
    assert.deepEqual(info?.mismatches.map((m) => [m.slot, m.from, m.to, m.applicable]), [[1, "velho.md", "novo.md", true]]);
    writeFileSync(join(edDir, "_internal", "05-published.json"), JSON.stringify({ status: "published" }));
    assert.equal(findStitchedEdition(root), null);
    assert.equal(checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" }), null);
  });

  it("backend Kit: newsletter-kit-published.json agendado → edição excluída; rascunho → incluída como draft", () => {
    const kit = join(edDir, "_internal", "newsletter-kit-published.json");
    writeFileSync(kit, JSON.stringify({ status: "draft" }));
    assert.equal(findStitchedEdition(root)?.publishState, "draft");
    assert.equal(checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" })?.publishState, "draft");
    writeFileSync(kit, JSON.stringify({ status: "scheduled", scheduled_at: "2026-10-01T09:00:00Z" }));
    assert.equal(findStitchedEdition(root), null);
    assert.equal(checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" }), null);
  });

  it("só a edição MAIS RECENTE conta: mais nova locked + antigas com rascunho → null", () => {
    // edDir = 261001 (draft antigo); adiciona 261002 (draft) e 261003 (locked)
    writeFileSync(join(edDir, "_internal", "05-published.json"), JSON.stringify({ status: "draft" }));
    for (const [ed, marker] of [
      ["261002", { status: "draft" }],
      ["261003", { status: "scheduled", scheduled_at: "2026-10-03T09:00:00Z" }],
    ] as const) {
      const d = join(root, "data", "editions", "2610", ed);
      mkdirSync(join(d, "_internal"), { recursive: true });
      writeFileSync(join(d, "02-reviewed.md"), md(OLD));
      writeFileSync(join(d, "_internal", "newsletter-kit-published.json"), JSON.stringify(marker));
    }
    assert.equal(findStitchedEdition(root), null);
    assert.equal(checkStitchedEditionAfterSlotSave(root, { slot1: "novo.md", slot2: "outra.md" }), null);
  });

  it("classifyPublishMarkers", () => {
    assert.equal(classifyPublishMarkers([]), "none");
    assert.equal(classifyPublishMarkers([{ status: "draft" }]), "draft");
    assert.equal(classifyPublishMarkers([{ status: "draft", scheduled_at: "x" }]), "locked");
    assert.equal(classifyPublishMarkers([{ published_at: "x" }]), "locked");
    assert.equal(classifyPublishMarkers([{ status: "sent" }]), "locked");
    assert.equal(classifyPublishMarkers([null]), "locked", "ilegível = conservador");
  });

  it("fail-soft: data/ ausente → null", () => {
    const empty = mkdtempSync(join(tmpdir(), "abs-8990-empty-"));
    try {
      assert.equal(checkStitchedEditionAfterSlotSave(empty, { slot1: "novo.md", slot2: "" }), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("botão aplicar: roda o núcleo na edição corrente", async () => {
    const res = await applySlotToStitchedEdition(root, { edition: "261001", slot: 1, file: "novo.md" }, { runUpload: () => {} });
    assert.ok(res.ok);
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(NEW));
  });

  it("botão aplicar: box editado à mão → recusa sem escrever", async () => {
    const edited = md("**📚 Editado à mão: [Compre](https://amzn.to/velho)**");
    writeFileSync(join(edDir, "02-reviewed.md"), edited);
    const res = await applySlotToStitchedEdition(root, { edition: "261001", slot: 1, file: "novo.md" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "edited");
    assert.equal(readFileSync(join(edDir, "02-reviewed.md"), "utf8"), edited);
  });

  it("botão aplicar: edição que não é a corrente / slot ou arquivo inválido → recusa", async () => {
    const wrong = await applySlotToStitchedEdition(root, { edition: "260101", slot: 1, file: "novo.md" });
    assert.equal(wrong.ok, false);
    const badSlot = await applySlotToStitchedEdition(root, { edition: "261001", slot: 3, file: "novo.md" });
    assert.equal(badSlot.ok, false);
    const badFile = await applySlotToStitchedEdition(root, { edition: "261001", slot: 1, file: "../x.md" });
    assert.equal(badFile.ok, false);
    assert.ok(existsSync(join(edDir, "02-reviewed.md")));
    assert.ok(readFileSync(join(edDir, "02-reviewed.md"), "utf8").includes(OLD));
  });
});
