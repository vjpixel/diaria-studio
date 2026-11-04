/**
 * #12078: a legenda revisada do horizontal (o backfill dos 7 horizontais sem a
 * faixa pt-BR) tem de sair no tempo do EXPORT final do Premiere, não no da
 * sequência montada pelo XML: o editor abre respiros e insere vinheta, e uma
 * legenda no tempo da montagem chega adiantada no vídeo publicado.
 * `srt --seq youtube --from-final PATH` transcreve o export e alinha a ele o
 * roteiro do horizontal (`forceAlignToScript`, #11960).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { exportTranscriptCacheKey, fromFinalPlan, main, srtFromExport, srtFromExportFileName } from "../scripts/video-montagem.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

const youtube = { target: "youtube" as const, width: 1920, height: 1080, name: "Diaria comentada_Youtube_V1" };
const vertical = { target: "outras-redes" as const, width: 1080, height: 1920, name: "Diaria comentada_Vertical_V1" };
const corteYt = { target: "youtube" as const, corte: "extra", width: 1920, height: 1080, name: "Diaria comentada_Youtube_V1-extra" };

describe("#12078: fromFinalPlan escolhe o horizontal", () => {
  it("sem --seq ou com --seq youtube, o horizontal sem corte", () => {
    const plans = [{ spec: vertical }, { spec: corteYt }, { spec: youtube }];
    assert.equal(fromFinalPlan(plans, undefined).spec.name, youtube.name);
    assert.equal(fromFinalPlan(plans, "youtube").spec.name, youtube.name);
  });

  it("plan.json sem o horizontal: erro claro que manda rodar build --seq youtube", () => {
    assert.throws(() => fromFinalPlan([{ spec: vertical }, { spec: corteYt }], "youtube"), /plan\.json sem a sequência youtube.*build --seq youtube/);
  });

  it("--seq de outra sequência é recusado (só o horizontal vai ao YouTube)", () => {
    assert.throws(() => fromFinalPlan([{ spec: youtube }, { spec: vertical }], "outras-redes"), /só gera a legenda do horizontal/);
  });
});

describe("#12078: srtFromExport", () => {
  const plan = { spec: { ...youtube, order: [], scales: [100, 110] as [number, number] }, script: "Bom dia. A Mistral lançou um modelo novo." };

  it("o SRT sai no tempo do export (respiro de 2 s depois da vinheta), com o texto do roteiro", () => {
    // Na montagem a fala começa em 0 s; no export, depois de 4 s de vinheta e com um respiro de 2 s no meio.
    const heard = [...say("Bom dia.", 4), ...say("A mistral lançou o modelo novo.", 6.6)];
    const { srt, notes } = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 20 });
    assert.match(srt, /^1\r?\n00:00:04,000 --> /);
    assert.ok(srt.replace(/\r?\n/g, " ").includes("A Mistral lançou um modelo novo."), `texto do roteiro, não o ouvido: ${JSON.stringify(srt)}`);
    assert.ok(srt.includes("00:00:06,600"), "a 2ª frase no tempo do export");
    assert.ok(notes.some((n) => n.includes("(export)") && n.includes('ouvido "o"')), "a substituição vira nota");
  });

  it("fala do export depois do fim (duração) sai da legenda", () => {
    const heard = [...say("Bom dia. A Mistral lançou um modelo novo.", 1), ...say("E aí", 30)];
    const { srt } = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 10 });
    assert.ok(!srt.includes("aí"));
  });

  it("o nome do arquivo no out dir não é o da montagem (a prévia queima aquele)", () => {
    assert.equal(srtFromExportFileName(youtube.name), "Diaria comentada_Youtube_V1 - legendas do export.srt");
  });
});

describe("#12078: cache da transcrição do export por identidade do arquivo", () => {
  it("mesmo arquivo = mesma chave; tamanho ou mtime diferente invalida", () => {
    const a = exportTranscriptCacheKey({ path: "G:\\261103\\Final\\x.mp4", size: 10, mtimeMs: 1 });
    assert.equal(a, exportTranscriptCacheKey({ path: "G:/261103/Final/x.mp4", size: 10, mtimeMs: 1 }));
    assert.notEqual(a, exportTranscriptCacheKey({ path: "G:/261103/Final/x.mp4", size: 11, mtimeMs: 1 }));
    assert.notEqual(a, exportTranscriptCacheKey({ path: "G:/261103/Final/x.mp4", size: 10, mtimeMs: 2 }));
  });
});

describe("#12078: CLI srt --from-final", () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "vm-12078-"));
    const origErr = console.error;
    console.error = () => {};
    try {
      await fn(dir);
    } finally {
      console.error = origErr;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const base = (dir: string) => ["srt", "261103", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir];

  it("sem o horizontal no plan.json: erro claro, antes de transcrever nada", () =>
    withDir(async (dir) => {
      const exp = join(dir, "Diaria comentada_Youtube_261103.mp4");
      writeFileSync(exp, "");
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ hash: "x", plans: [{ spec: vertical, script: "oi" }], source: { fps: 30 } }));
      await assert.rejects(main([...base(dir), "--seq", "youtube", "--from-final", exp]), /plan\.json sem a sequência youtube/);
    }));

  it("--from-final sem caminho, ou com --from-raw, é recusado", () =>
    withDir(async (dir) => {
      await assert.rejects(main([...base(dir), "--from-final"]), /exige o caminho do export/);
      const exp = join(dir, "x.mp4");
      writeFileSync(exp, "");
      await assert.rejects(main([...base(dir), "--from-final", exp, "--from-raw"]), /não se combinam/);
    }));

  it("export inexistente: erro com o caminho", () =>
    withDir(async (dir) => {
      await assert.rejects(main([...base(dir), "--from-final", join(dir, "nao-existe.mp4")]), /export não encontrado/);
    }));
});
