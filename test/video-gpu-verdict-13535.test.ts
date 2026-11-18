/**
 * #13535: o `check-video-env.ts --montagem` diz se a transcrição vai rodar na
 * GPU ou na CPU, numa linha só informativa que nunca reprova o check. A
 * leitura do veredito é pura (`parseGpuVerdict`); o modo `--gpu-verdict` do
 * `transcribe_words.py` roda contra um `faster_whisper` falso, sem GPU.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assessMontageEnv,
  formatMontageEnvReport,
  parseGpuVerdict,
  type MontageEnvProbes,
} from "../scripts/lib/diaria/video-montage-env.ts";
import { probeGpu } from "../scripts/check-video-env.ts";

const ok = { ok: true };
const base: MontageEnvProbes = { ffmpeg: ok, python: ok, model: ok, opencv: ok, drive: ok, disk: ok };
const PY = { python: "python", from: "path" };

describe("#13535 parseGpuVerdict", () => {
  it("cuda → [ok], dizendo se veio do cache", () => {
    const p = parseGpuVerdict({ status: 0, stdout: '{"device": "cuda", "why": "", "cached": true}\n', stderr: "" });
    assert.equal(p.ok, true);
    assert.match(p.detail!, /GPU \(cuda; veredito em cache/);
  });

  it("cpu → não ok, com o motivo da sonda", () => {
    const p = parseGpuVerdict({ status: 0, stdout: '{"device": "cpu", "why": "sonda da GPU saiu 1: cublas64_12.dll is not found", "cached": false}', stderr: "" });
    assert.equal(p.ok, false);
    assert.match(p.detail!, /^transcrição na CPU: sonda da GPU saiu 1: cublas64_12\.dll/);
    assert.match(p.detail!, /sonda agora/);
  });

  it("saída ilegível, exit != 0 ou spawn falho → CPU com o motivo, nunca lança", () => {
    assert.match(parseGpuVerdict({ status: 1, stdout: "", stderr: "Traceback\nImportError: x" }).detail!, /CPU \(veredito da GPU não lido: ImportError: x\)/);
    assert.match(parseGpuVerdict({ status: 0, stdout: "lixo", stderr: "" }).detail!, /não lido/);
    assert.match(parseGpuVerdict({ status: null, stdout: "", stderr: "", error: "ENOENT" }).detail!, /ENOENT/);
  });
});

describe("#13535 item gpu no relatório da montagem", () => {
  it("CPU: [info] com o comando de setup, e o check continua pronto (nem falta nem aviso)", () => {
    const r = assessMontageEnv({ ...base, gpu: { ok: false, detail: "transcrição na CPU: sem DLL" } }, "win32", PY);
    assert.equal(r.ready, true);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.warnings, []);
    const txt = formatMontageEnvReport(r);
    assert.match(txt, /\[info\] gpu \(transcrição na CPU: sem DLL\)\. Para usar a GPU: python -m pip install --user nvidia-cublas-cu12/);
    assert.match(txt, /A montagem roda nesta máquina\./);
  });

  it("GPU: [ok] gpu", () => {
    const txt = formatMontageEnvReport(assessMontageEnv({ ...base, gpu: { ok: true, detail: "transcrição na GPU (cuda; sonda agora)" } }, "linux", PY));
    assert.match(txt, /\[ok\] gpu \(transcrição na GPU \(cuda; sonda agora\)\)/);
  });

  it("sem sonda de gpu (chamada antiga) o item não aparece", () => {
    assert.ok(!assessMontageEnv(base, "linux", PY).items.some((i) => i.id === "gpu"));
  });

  it("DIARIA_WHISPER_DEVICE=cpu: CPU forçada, sem rodar a sonda", () => {
    const p = probeGpu("/nao/existe/python", "cpu");
    assert.equal(p.ok, false);
    assert.match(p.detail!, /DIARIA_WHISPER_DEVICE=cpu/);
  });
});

function findPython(): string | null {
  for (const p of ["python3", "python"]) {
    const r = spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 8)"]);
    if (r.status === 0) return p;
  }
  return null;
}
const PYBIN = findPython();

/** faster_whisper falso: a carga na cuda falha (`fail`) ou passa. */
function fakeFw(fail: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-13535-"));
  mkdirSync(join(dir, "faster_whisper"));
  writeFileSync(
    join(dir, "faster_whisper", "__init__.py"),
    `
class WhisperModel:
    def __init__(self, name, device="cpu", compute_type="int8"):
        if device == "cuda" and ${fail ? "True" : "False"}:
            raise RuntimeError("CUDA failed with error no CUDA-capable device is detected")
    def transcribe(self, audio, **kw):
        return iter([]), None
`,
  );
  return dir;
}

function verdict(dir: string) {
  return spawnSync(PYBIN!, ["-P", resolve("scripts/video/transcribe_words.py"), "--gpu-verdict", "large-v3-turbo"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, PYTHONIOENCODING: "utf-8", DIARIA_WHISPER_PROBE_CACHE: "", DIARIA_WHISPER_PROBE_CACHE_DIR: dir, DIARIA_WHISPER_CUDA_DRIVER_PATH: "" },
  });
}

describe("#13535 transcribe_words.py --gpu-verdict", { skip: PYBIN ? false : "sem python3" }, () => {
  it("GPU falha: device cpu com o motivo; a 2ª chamada lê o veredito do cache", () => {
    const dir = fakeFw(true);
    const r1 = verdict(dir);
    assert.equal(r1.status, 0, r1.stderr);
    const v1 = JSON.parse(r1.stdout.trim());
    assert.equal(v1.device, "cpu");
    assert.equal(v1.cached, false);
    assert.match(v1.why, /no CUDA-capable device/);
    const v2 = JSON.parse(verdict(dir).stdout.trim());
    assert.equal(v2.device, "cpu");
    assert.equal(v2.cached, true);
    assert.equal(parseGpuVerdict({ status: 0, stdout: JSON.stringify(v2), stderr: "" }).ok, false);
  });

  it("GPU passa: device cuda", () => {
    const r = verdict(fakeFw(false));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim()).device, "cuda");
  });
});
