/**
 * test/video-xml-vs-final-cache-dir-13279.test.ts
 *
 * #13279: no `main` de `scripts/video-xml-vs-final.ts`, as três chamadas de
 * `compareEdition` (compare, backfill, run) não passavam `brutoLookup`, então
 * `brutoWav` caía em `defaultBrutoLookup()` sem o `--cache-dir`. No modo API
 * do 300 com `--cache-dir X`, o bruto em vários arquivos baixado pela montagem
 * em `X/{AAMMDD}/bruto/` (com o `audio.wav` já apagado) era "não achado" e a
 * edição era pulada.
 *
 * Aqui: (1) o lookup montado do `--cache-dir` custom acha o bruto em vários
 * arquivos nesse diretório e o concatena; (2) guard estrutural: toda chamada
 * de `compareEdition` dentro do `main` passa o `brutoLookup` montado do
 * `--cache-dir` (o bug foi exatamente a chamada sem ele).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brutoWav, defaultBrutoLookup, type Finder, type PlanFileLite } from "../scripts/video-xml-vs-final.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
/** Edição falsa e única por teste: o áudio montado fica em `tmpdir()/diaria-video-xml-vs-final/{AAMMDD}` e seria reaproveitado. */
const fakeEdition = () => `9${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;

function tone(path: string, seconds: number): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "pcm_s16le", path]);
  assert.equal(r.status, 0, String(r.stderr));
}

function durationS(path: string): number {
  return Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).stdout.trim());
}

describe("#13279: --cache-dir custom vale na busca do bruto", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("bruto em vários arquivos em {cache-dir}/{AAMMDD}/bruto/, sem audio.wav: achado e concatenado, sem consultar o Drive", async () => {
    const ed = fakeEdition();
    const dir = mkdtempSync(join(tmpdir(), "xml-vs-final-cache-dir-13279-"));
    const cacheRoot = join(dir, "cache-custom");
    mkdirSync(join(cacheRoot, ed, "bruto"), { recursive: true });
    tone(join(cacheRoot, ed, "bruto", "a.wav"), 1);
    tone(join(cacheRoot, ed, "bruto", "b.wav"), 0.5);
    const asked: string[] = [];
    const finder: Finder = { mode: "api", list: async () => [], workDir: () => join(dir, "work"), brutoFile: async (_e, name) => (asked.push(name), null) };
    const pf: PlanFileLite = {
      plans: [],
      source: {
        fps: 30,
        path: "I:/Meu Drive/diaria-studio-video/x/a.wav",
        files: [
          { path: "I:/Meu Drive/diaria-studio-video/x/a.wav", frames: 30, offsetFrames: 0 },
          { path: "I:/Meu Drive/diaria-studio-video/x/b.wav", frames: 15, offsetFrames: 30 },
        ],
      },
    };
    // Sem arquivo do HD e sem DIARIA_VIDEO_CACHE_DIR: só o --cache-dir aponta para o bruto.
    const env = { VIDEO_ARCHIVE_ROOT: join(dir, "sem-hd") };
    const res = await brutoWav(ed, join(dir, "work"), pf, finder, defaultBrutoLookup(cacheRoot, env));
    assert.ok(res.wav, JSON.stringify(res));
    assert.ok(Math.abs(durationS(res.wav) - 1.5) < 1 / 30, `duração ${durationS(res.wav)}`);
    assert.deepEqual(asked, [], "o Drive não é consultado quando o bruto está no cache do --cache-dir");

    // Contraprova: o lookup sem o --cache-dir (o que o main usava antes) não acha o bruto.
    const ed2 = fakeEdition();
    mkdirSync(join(cacheRoot, ed2, "bruto"), { recursive: true });
    tone(join(cacheRoot, ed2, "bruto", "a.wav"), 1);
    tone(join(cacheRoot, ed2, "bruto", "b.wav"), 0.5);
    const semFlag = await brutoWav(ed2, join(dir, "work2"), pf, finder, defaultBrutoLookup(undefined, { ...env, DIARIA_VIDEO_CACHE_DIR: join(dir, "outro-cache") }));
    assert.equal(semFlag.wav, null);
  });
});

describe("#13279: o main passa o brutoLookup do --cache-dir a toda chamada de compareEdition", () => {
  const src = readFileSync(new URL("../scripts/video-xml-vs-final.ts", import.meta.url), "utf8");
  const mainBody = src.slice(src.indexOf("export async function main("));

  it("monta o lookup com values[\"cache-dir\"]", () => {
    assert.match(mainBody, /const brutoLookup = defaultBrutoLookup\(values\["cache-dir"\]\)/);
  });

  it("as três chamadas (compare, backfill, run) levam brutoLookup", () => {
    const calls = [...mainBody.matchAll(/compareEdition\(([^;]*?)\);/g)].map((m) => m[1]);
    assert.equal(calls.length, 3, `chamadas achadas: ${calls.join(" | ")}`);
    for (const c of calls) assert.match(c, /\bbrutoLookup\b/, `chamada sem brutoLookup: compareEdition(${c})`);
  });
});
