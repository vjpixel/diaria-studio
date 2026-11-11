/**
 * test/renumber-edition-video-12713.test.ts (#12713)
 *
 * O caso do Nubank (10/11/2026, 261112 → 261111): a pasta de origem só tinha o
 * vídeo e a edição de destino já existia. Antes, `renumber-edition.ts` recusava
 * (destino existe) e a troca foi à mão: mover `_internal/video-montagem`,
 * trocar o `"edition"` do `blocks.json` (o `build` recusa com divergência),
 * reescrever caminhos e renomear os arquivos com prefixo na pasta do Drive.
 *
 * Tudo em tmpdir — nunca em `data/` real nem no Drive. A "pasta do Drive" do
 * `--video-dir` é uma pasta local de teste.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { leftOutItems, planVideoMerge } from "../scripts/lib/renumber-edition.ts";
import { runRenumberEdition, runUnschedule, type RenumberCliDeps } from "../scripts/renumber-edition.ts";

const FROM = "261112";
const TO = "261111";
let root: string;
const fromDir = () => join(root, "data", "editions", "2611", FROM);
const toDir = () => join(root, "data", "editions", "2611", TO);
const driveDir = () => join(root, "drive", "YouTube", FROM);

function put(base: string, rel: string, content: string | Buffer): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const BRUTO = `G:/Meu Drive/Work/YouTube/${FROM}/20261112_150417.mp4`;

function seedVideoOnlyOrigin(): void {
  put(fromDir(), "_internal/video-montagem/blocks.json", JSON.stringify({ edition: FROM, blocks: [{ id: "titulo", start: 1.5 }] }, null, 2));
  put(
    fromDir(),
    "_internal/video-montagem/source.json",
    JSON.stringify({ path: BRUTO, id: "20261112_150417", durationS: 261.112 }),
  );
  put(
    fromDir(),
    "_internal/video-montagem/audio-tratado.meta.json",
    JSON.stringify({ path: `G:\\Meu Drive\\Work\\YouTube\\${FROM}\\${FROM}_audio_tratado-81a61a72.wav`, key: "81a61a72" }),
  );
  put(fromDir(), "_internal/video-montagem/plan.json", JSON.stringify({ edition: FROM, xml: `YouTube/${FROM}/instagram.xml` }));
  put(fromDir(), "_internal/video-montagem/frame-208.0.jpg", Buffer.from([0xff, 0xd8, 0, 0x32, 0x36]));
  put(fromDir(), "diaria-comentada-261112.srt", "1\n00:00:00,000 --> 00:00:01,000\nedição 261112\n");
}

function seedDestinationEdition(): void {
  put(toDir(), "02-reviewed.md", "Edição 261111\n");
  put(toDir(), "_internal/newsletter-kit-published.json", '{"broadcast_id":10,"status":"draft"}');
}

function seedDriveDir(): void {
  put(driveDir(), `${FROM}_audio_tratado-81a61a72.wav`, Buffer.from([0, 1, 2]));
  put(driveDir(), `${FROM}_titulo_vertical-soberana.png`, Buffer.from([0x89, 0x50]));
  put(driveDir(), `${FROM} - previa instagram.mp4`, Buffer.from([0, 0]));
  put(driveDir(), "20261112_150417.mp4", Buffer.from([0, 0]));
  put(
    driveDir(),
    "instagram.xml",
    `<xmeml version="4"><pathurl>file://localhost/G:/Meu%20Drive/Work/YouTube/${FROM}/${FROM}_audio_tratado-81a61a72.wav</pathurl>` +
      `<pathurl>file://localhost/G:/Meu%20Drive/Work/YouTube/${FROM}/20261112_150417.mp4</pathurl><uuid>a${FROM}f</uuid></xmeml>`,
  );
}

function cliDeps(): RenumberCliDeps & { logs: string[]; ran: string[][] } {
  const logs: string[] = [];
  const ran: string[][] = [];
  return {
    root,
    logs,
    ran,
    log: (m) => void logs.push(m),
    nowIso: () => "2026-11-10T12:00:00.000Z",
    runStep: (argv) => {
      ran.push(argv);
      return 0;
    },
  };
}

const read = (p: string) => readFileSync(p, "utf8");

describe("renumber-edition: vídeo com destino existente (#12713)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-video-12713-"));
    seedVideoOnlyOrigin();
    seedDestinationEdition();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("dry-run descreve a mescla sem escrever nada", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false }, d), 0);
    const out = d.logs.join("\n");
    assert.match(out, /só tem vídeo/);
    assert.match(out, /moveria _internal\/video-montagem\//);
    assert.match(out, /moveria diaria-comentada-261112\.srt → .*diaria-comentada-261111\.srt/);
    assert.ok(existsSync(join(fromDir(), "_internal", "video-montagem", "blocks.json")));
    assert.ok(!existsSync(join(toDir(), "_internal", "video-montagem")));
    assert.match(read(join(fromDir(), "_internal", "video-montagem", "blocks.json")), /"edition": "261112"/);
  });

  it("--apply move o vídeo, troca o edition do blocks.json e os caminhos, preserva o bruto", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: true }, d), 0);
    const vm = join(toDir(), "_internal", "video-montagem");
    assert.equal(JSON.parse(read(join(vm, "blocks.json"))).edition, TO);
    const source = JSON.parse(read(join(vm, "source.json")));
    assert.equal(source.path, `G:/Meu Drive/Work/YouTube/${TO}/20261112_150417.mp4`);
    assert.equal(source.id, "20261112_150417");
    assert.equal(source.durationS, 261.112);
    assert.match(read(join(vm, "audio-tratado.meta.json")), /YouTube\\\\261111\\\\261111_audio_tratado-81a61a72\.wav/);
    assert.equal(JSON.parse(read(join(vm, "plan.json"))).edition, TO);
    assert.ok(existsSync(join(vm, "frame-208.0.jpg")));
    assert.equal(read(join(toDir(), "diaria-comentada-261111.srt")), "1\n00:00:00,000 --> 00:00:01,000\nedição 261111\n");
    // Destino: o resto da edição fica intacto; origem vazia some.
    assert.equal(read(join(toDir(), "02-reviewed.md")), "Edição 261111\n");
    assert.ok(!existsSync(fromDir()));
    // Sem passo remoto (a edição de destino é outra) e sem relatório da edição.
    assert.equal(d.ran.length, 0);
    assert.ok(!existsSync(join(toDir(), "_internal", "renumber-edition.json")));
    const report = JSON.parse(read(join(vm, "renumber-video.json")));
    assert.equal(report.from, FROM);
    assert.equal(report.to, TO);
    assert.equal(report.removed_from_dir, true);
  });

  it("rodar de novo depois da mescla é idempotente (exit 0, nada muda)", () => {
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, cliDeps()), 0);
    const before = read(join(toDir(), "_internal", "video-montagem", "blocks.json"));
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 0);
    assert.match(d.logs.join("\n"), /já feita/);
    assert.equal(read(join(toDir(), "_internal", "video-montagem", "blocks.json")), before);
  });

  it("origem com qualquer coisa além do vídeo ⇒ recusa (exit 2), nada escrito", () => {
    put(fromDir(), "02-reviewed.md", "Edição 261112\n");
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2);
    const out = d.logs.join("\n");
    assert.match(out, /já existe/);
    assert.match(out, /não é só vídeo \(02-reviewed\.md\)/);
    assert.match(read(join(fromDir(), "_internal", "video-montagem", "blocks.json")), /261112/);
    assert.ok(!existsSync(join(toDir(), "_internal", "video-montagem")));
  });

  it("destino que já tem vídeo ⇒ recusa (nunca mescla dois vídeos)", () => {
    put(toDir(), "_internal/video-montagem/blocks.json", JSON.stringify({ edition: TO }));
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, d), 2);
    assert.match(d.logs.join("\n"), /video-montagem\/ já existe/);
    assert.equal(JSON.parse(read(join(fromDir(), "_internal", "video-montagem", "blocks.json"))).edition, FROM);
  });

  it("srt já existente no destino ⇒ recusa antes de escrever", () => {
    put(toDir(), "diaria-comentada-261111.srt", "outro");
    assert.equal(planVideoMerge(root, FROM, TO).ok, false);
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false }, cliDeps()), 2);
    assert.equal(read(join(toDir(), "diaria-comentada-261111.srt")), "outro");
    assert.ok(existsSync(join(fromDir(), "diaria-comentada-261112.srt")));
  });

  it("--unschedule com origem só de vídeo não chama nada e deixa seguir", async () => {
    const d = cliDeps();
    let calls = 0;
    const code = await runUnschedule(
      { from: FROM, to: TO },
      {
        root,
        log: d.log,
        unschedule: {
          deleteWorkerEntry: async () => {
            calls += 1;
            return { deleted: true, alreadyGone: false };
          },
          unscheduleKit: async () => {
            calls += 1;
            return { ok: true, message: "" };
          },
          nowIso: () => "2026-11-10T12:00:00.000Z",
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(calls, 0);
  });
});

describe("renumber-edition --video-dir (#12713)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "renumber-video-dir-12713-"));
    seedVideoOnlyOrigin();
    seedDestinationEdition();
    seedDriveDir();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("dry-run lista as trocas na pasta do vídeo sem renomear", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: false, runRemote: false, videoDir: driveDir() }, d), 0);
    assert.match(d.logs.join("\n"), /renomearia 261112_audio_tratado-81a61a72\.wav → 261111_audio_tratado-81a61a72\.wav/);
    assert.ok(existsSync(join(driveDir(), `${FROM}_audio_tratado-81a61a72.wav`)));
    assert.match(read(join(driveDir(), "instagram.xml")), /YouTube\/261112\/261112_audio/);
  });

  it("--apply renomeia os arquivos com prefixo e reescreve os pathurl, preservando o bruto e o hash", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false, videoDir: driveDir() }, d), 0);
    assert.deepEqual(readdirSync(driveDir()).sort(), [
      "20261112_150417.mp4",
      `${TO} - previa instagram.mp4`,
      `${TO}_audio_tratado-81a61a72.wav`,
      `${TO}_titulo_vertical-soberana.png`,
      "instagram.xml",
    ]);
    const xml = read(join(driveDir(), "instagram.xml"));
    assert.match(xml, /YouTube\/261111\/261111_audio_tratado-81a61a72\.wav/);
    assert.match(xml, /YouTube\/261111\/20261112_150417\.mp4/);
    assert.match(xml, /<uuid>a261112f<\/uuid>/);
    // A pasta em si fica com o nome antigo e continua na lista do que fica fora.
    assert.ok(existsSync(driveDir()));
    assert.match(d.logs.join("\n"), /Drive: renomear a pasta 261112\/.*já foram renomeados/);
  });

  it("vale também na renumeração da edição inteira (destino ausente)", () => {
    rmSync(toDir(), { recursive: true });
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false, videoDir: driveDir() }, d), 0);
    assert.equal(JSON.parse(read(join(toDir(), "_internal", "video-montagem", "blocks.json"))).edition, TO);
    assert.ok(existsSync(join(driveDir(), `${TO}_audio_tratado-81a61a72.wav`)));
  });

  it("colisão de nome na pasta do vídeo ⇒ exit 1, nada renomeado lá", () => {
    put(driveDir(), `${TO}_audio_tratado-81a61a72.wav`, "já existe");
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false, videoDir: driveDir() }, d), 1);
    assert.match(d.logs.join("\n"), /ERRO no --video-dir/);
    assert.ok(existsSync(join(driveDir(), `${FROM}_titulo_vertical-soberana.png`)));
    assert.match(read(join(driveDir(), "instagram.xml")), /YouTube\/261112\//);
  });

  it("--video-dir inexistente ⇒ exit 2 antes de qualquer escrita", () => {
    const d = cliDeps();
    assert.equal(runRenumberEdition({ from: FROM, to: TO, apply: true, runRemote: false, videoDir: join(root, "nao-existe") }, d), 2);
    assert.ok(existsSync(join(fromDir(), "_internal", "video-montagem", "blocks.json")));
  });
});

describe("leftOutItems (#12713)", () => {
  it("cita a pasta do Drive, os arquivos dentro dela, o Doc do roteiro e o .prproj", () => {
    const items = leftOutItems(FROM, TO).join("\n");
    assert.match(items, /Drive: renomear a pasta 261112\//);
    assert.match(items, /--video-dir/);
    assert.match(items, /Doc do roteiro/);
    assert.match(items, /\.prproj/);
    assert.match(leftOutItems(FROM, TO, { videoDirDone: true }).join("\n"), /já foram renomeados/);
  });
});
