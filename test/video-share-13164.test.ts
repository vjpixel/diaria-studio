import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validarRoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { confirmedShare, readShareCue, shareDescription, shareForRun, shareLine, shareTimeInPlan } from "../scripts/lib/diaria/video-share.ts";
import { defaultSequences, type SequencePlan, type ResolvedItem } from "../scripts/lib/diaria/video-montage.ts";
import { setYouTubeShareDescription, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { planYouTubePublish, runYouTubeUpload, buildYouTubePlanManifest } from "../scripts/publish-youtube.ts";
import { planSha256 } from "../scripts/lib/diaria/video-publish-plan.ts";

const cue = { inicio: "H11", rotulo: "Pra mandar pros seus pais", texto: "Antes de comprar confira quem está falando." };
const roteiro = { falas: [{ id: "H11", texto: cue.texto, videos: ["horizontal"], bloco: "comentario" }], porVideo: { horizontal: { trechoCompartilhar: { inicio: cue.inicio, rotulo: cue.rotulo } } } };
const reviewedMd = "DESTAQUE 1 | SEGURANÇA\nVídeo falso engana famílias\nhttps://example.org/fonte\n\nUm médico teve a imagem falsificada.\n\nPor que isso importa:\nÉ um golpe.\n";
const bytes = Buffer.from("fake-final-video");
const id = "abc123XYZ_9";
const now = new Date("2026-11-15T20:00:00Z");
const env = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", YOUTUBE_REFRESH_TOKEN: "refresh", YOUTUBE_CHANNEL_ID: "channel" };
function temp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "video-share-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function plan(dir: string, seconds = "61") {
  return planYouTubePublish({ aammdd: "261117", reviewedMd, now, video: { path: join(dir, "final.mp4"), exists: true, sizeBytes: bytes.length }, thumb: { path: "none", exists: false }, share: confirmedShare(cue, seconds, bytes) });
}

describe("#13164 roteiro e tempo no corte", () => {
  it("campo opcional valida id horizontal e rótulo, rejeita vertical/id ausente/linha extra", () => {
    assert.deepEqual(validarRoteiroFalas(roteiro), []);
    for (const bad of [
      { ...roteiro, falas: [{ ...roteiro.falas[0], videos: ["vertical1"] }] },
      { ...roteiro, porVideo: { horizontal: { trechoCompartilhar: { inicio: "H99", rotulo: "Pais" } } } },
      { ...roteiro, porVideo: { vertical1: roteiro.porVideo.horizontal } },
      { ...roteiro, porVideo: { horizontal: { trechoCompartilhar: { inicio: "H11", rotulo: " " } } } },
      { ...roteiro, porVideo: { horizontal: { trechoCompartilhar: { inicio: "H11", rotulo: "Pais\nLink" } } } },
    ]) assert.match(validarRoteiroFalas(bad).join(";"), /trechoCompartilhar/);
  });
  it("leitura sem roteiro não muda edições antigas; JSON quebrado só falha se citar o trecho", () => temp((dir) => {
    assert.equal(readShareCue(dir), null);
    mkdirSync(join(dir, "_internal"));
    const p = join(dir, "_internal/roteiro-falas.json");
    writeFileSync(p, JSON.stringify(roteiro));
    assert.deepEqual(readShareCue(dir), cue);
    const avisos: string[] = [];
    writeFileSync(p, "{");
    assert.equal(readShareCue(dir, (m) => avisos.push(m)), null);
    assert.match(avisos.join(";"), /ilegível/);
    writeFileSync(p, `{"porVideo":{"horizontal":{"trechoCompartilhar":`);
    assert.throws(() => readShareCue(dir), /trechoCompartilhar/);
  }));
  it("review #13170: problema em outro campo do roteiro não bloqueia; trecho inválido falha", () => temp((dir) => {
    mkdirSync(join(dir, "_internal"));
    const p = join(dir, "_internal/roteiro-falas.json");
    // `ordem` no horizontal é inválido para validarRoteiroFalas, mas não toca o trecho.
    const outroCampo = { ...roteiro, porVideo: { horizontal: { ...roteiro.porVideo.horizontal, ordem: ["H11"] } }, falas: [...roteiro.falas, { id: "X1", texto: "", videos: ["vertical9"] }] };
    assert.notDeepEqual(validarRoteiroFalas(outroCampo), []);
    writeFileSync(p, JSON.stringify(outroCampo));
    assert.deepEqual(readShareCue(dir), cue);
    writeFileSync(p, JSON.stringify({ ...roteiro, porVideo: { horizontal: { trechoCompartilhar: { inicio: "H99", rotulo: "Pais" } } } }));
    assert.throws(() => readShareCue(dir), /inicio/);
    writeFileSync(p, JSON.stringify({ ...roteiro, porVideo: { horizontal: { trechoCompartilhar: { inicio: "H11", rotulo: "Pais → aqui" } } } }));
    assert.throws(() => readShareCue(dir), /rotulo/);
  }));
  it("usa palavras da decupagem e posição final, com pausa cortada e início deslocado", () => {
    const spec = defaultSequences("V1", "monologo", "gancho")[0];
    const p: SequencePlan = { spec, clips: [{ block: "comentario", srcIn: 100, srcOut: 110, frameIn: 3000, frameOut: 3300, seqStart: 900, seqEnd: 1200, scale: 1 }], durationFrames: 1200, script: "", missingBlocks: [], dropped: [] };
    const item = { text: cue.texto, interval: { start: 100, end: 110 }, words: [{ start: 100.5, end: 101, text: "Antes" }] } as ResolvedItem;
    assert.equal(shareTimeInPlan(cue, p, { comentario: [item] }, 30), 30.5);
    // review #13170: sem casamento único, null com aviso (nunca derruba o build).
    const avisos: string[] = [];
    const w = (m: string) => avisos.push(m);
    assert.equal(shareTimeInPlan(cue, p, {}, 30, w), null);
    assert.equal(shareTimeInPlan(cue, p, { comentario: [item, item] }, 30, w), null);
    assert.equal(shareTimeInPlan(cue, { ...p, clips: [] }, { comentario: [item] }, 30, w), null);
    assert.match(avisos.join("\n"), /ausente/);
    assert.match(avisos.join("\n"), /ambíguo/);
    assert.match(avisos.join("\n"), /removido/);
  });
  it("review #13170: fala dividida em vários itens usa o item que abre a fala", () => {
    const spec = defaultSequences("V1", "monologo", "gancho")[0];
    const p: SequencePlan = { spec, clips: [{ block: "comentario", srcIn: 100, srcOut: 120, frameIn: 3000, frameOut: 3600, seqStart: 900, seqEnd: 1500, scale: 1 }], durationFrames: 1500, script: "", missingBlocks: [], dropped: [] };
    const fim = { text: "confira quem está falando.", interval: { start: 110, end: 114 }, words: [{ start: 110.2, end: 110.6, text: "confira" }] } as ResolvedItem;
    const abre = { text: "Antes de comprar", interval: { start: 102, end: 104 }, words: [{ start: 102, end: 102.4, text: "Antes" }] } as ResolvedItem;
    // ordem no blocks.json com o fim antes do início: o tempo é do item que abre a fala.
    assert.equal(shareTimeInPlan(cue, p, { comentario: [fim, abre] }, 30), 32);
    // só o fim decupado: início fora, null com aviso.
    const avisos: string[] = [];
    assert.equal(shareTimeInPlan(cue, p, { comentario: [fim] }, 30, (m) => avisos.push(m)), null);
    assert.match(avisos.join(";"), /início da fala/);
    // trecho curto (<3 palavras) não casa sozinho.
    assert.equal(shareTimeInPlan(cue, p, { comentario: [{ ...abre, text: "Antes de" }] }, 30), null);
  });
  it("review #13170: rerun depois do cleanup (sem vídeo) e caminhos que não criam vídeo não leem o arquivo nem pedem --share-start", () => {
    const enoent = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };
    for (const o of [
      { videoExists: false, createsVideo: false }, // --upload retomado com registro done / --accept-period-match
      { videoExists: false, createsVideo: true }, // --dry-run sem o vídeo baixado
      { videoExists: true, createsVideo: false },
    ]) {
      const avisos: string[] = [];
      assert.equal(shareForRun({ cue, rawSeconds: undefined, ...o, readVideo: enoent, warn: (m) => avisos.push(m) }), undefined);
      assert.match(avisos.join(";"), /trechoCompartilhar H11/);
    }
    assert.equal(shareForRun({ cue: null, rawSeconds: undefined, videoExists: false, createsVideo: true, readVideo: enoent, warn: () => assert.fail() }), undefined);
    assert.throws(() => shareForRun({ cue, rawSeconds: undefined, videoExists: true, createsVideo: true, readVideo: () => bytes, warn: () => {} }), /--share-start/);
    assert.equal(shareForRun({ cue, rawSeconds: "61", videoExists: true, createsVideo: true, readVideo: () => bytes, warn: () => {} })?.seconds, 61);
  });
  it("requer segundo conferido no export, aceita zero e rejeita fração/negativo/NaN", () => {
    for (const s of [undefined, "-1", "1.5", "NaN", ""]) assert.throws(() => confirmedShare(cue, s, bytes), /confira a fala no export final/);
    assert.equal(confirmedShare(cue, "0", bytes).seconds, 0);
    assert.equal(shareLine(confirmedShare(cue, "61", bytes), id), `Pra mandar pros seus pais: https://youtu.be/${id}?t=61`);
  });
  it("plano mostra template aprovado sem enviar id fictício; mudar segundo muda hash", () => temp((dir) => {
    writeFileSync(join(dir, "final.mp4"), bytes);
    const a = plan(dir), b = plan(dir, "62");
    assert.match(a.metadata.description, /\{VIDEO_ID\}\?t=61/);
    assert.doesNotMatch(a.request.body.snippet.description, /VIDEO_ID|\?t=/);
    assert.notEqual(planSha256(buildYouTubePlanManifest(a, dir)), planSha256(buildYouTubePlanManifest(b, dir)));
  }));
});

describe("#13164 upload sem rede", () => {
  for (const fail of [false, true]) it(`grava link e pendência de fixar; falha na descrição=${fail} preserva id e não duplica upload`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-upload-"));
    let description = "";
    let inserts = 0;
    const calls: string[] = [];
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    const deps: YouTubeUploadDeps = { now: () => now, fetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("oauth2")) return json({ access_token: "token" });
      if (String(url).includes("/channels")) return json({ items: [{ id: "channel" }] });
      if (String(url).includes("uploadType=resumable")) { inserts++; return new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } }); }
      if (String(url) === "https://upload.example/session") return json({ id, snippet: { channelId: "channel" } });
      if (String(url).endsWith("videos?part=snippet") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.status, undefined);
        description = body.snippet.description;
        assert.match(description, /https:\/\/youtu.be\/abc123XYZ_9\?t=61/);
        return json({}, fail ? 403 : 200);
      }
      if (String(url).includes("part=snippet&id=")) return json({ items: [{ id, snippet: { description } }] });
      if (String(url).includes("part=status")) return json({ items: [{ id, status: { uploadStatus: "processed", privacyStatus: "private" } }] });
      throw new Error(`Unexpected mock ${url}`);
    } };
    try {
      const p = plan(dir);
      const logs: string[] = [];
      const input = { plan: p, editionDir: dir, env, force: true, readFile: () => bytes, log: (s: string) => logs.push(s) };
      const result = await runYouTubeUpload(deps, input);
      assert.equal(result.record?.videoId, id);
      assert.equal(result.record?.share?.descriptionOk, !fail);
      assert.equal(result.record?.share?.pinnedComment, "pending-studio");
      assert.match(logs.join("\n"), /comentário para publicar e fixar/);
      if (fail) assert.match(logs.join("\n"), /Não repetir o upload/);
      const saved = JSON.parse(readFileSync(join(dir, "_internal/05-youtube-published.json"), "utf8"));
      assert.equal(saved.share.descriptionOk, !fail);
      await runYouTubeUpload(deps, { ...input, force: false });
      assert.equal(inserts, 1);
      assert.ok(calls.every((u) => !u.includes("commentThreads")));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("troca do arquivo após conferência impede qualquer chamada externa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-changed-"));
    try {
      const result = await runYouTubeUpload({ now: () => now, fetch: async () => { throw new Error("rede proibida"); } }, { plan: plan(dir), editionDir: dir, env, force: true, readFile: () => Buffer.from("changed"), log: () => {} });
      assert.equal(result.exitCode, 1);
      assert.equal(result.record, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("releitura divergente não declara sucesso", async () => {
    const deps: YouTubeUploadDeps = { now: () => now, fetch: async (_url, init) => new Response(JSON.stringify(init?.method === "PUT" ? {} : { items: [{ id, snippet: { description: "outra" } }] })) };
    await assert.rejects(() => setYouTubeShareDescription(deps, "token", id, { title: "Título", description: "base" }, shareDescription("base", confirmedShare(cue, "61", bytes), id)), /não confirmada/);
  });
});
