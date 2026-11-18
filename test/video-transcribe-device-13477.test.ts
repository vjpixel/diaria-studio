/**
 * #13477: `transcribe_words.py --device auto` tenta a GPU e cai na CPU quando a
 * CUDA falha — inclusive no primeiro `encode`, que é onde o Windows acusa
 * `cublas64_12.dll is not found` (a carga do modelo passa). Roda o helper real
 * contra um `faster_whisper` falso no PYTHONPATH, sem GPU nem modelo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER = resolve("scripts/video/transcribe_words.py");

function findPython(): string | null {
  for (const p of ["python3", "python"]) {
    const r = spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 8)"]);
    if (r.status === 0) return p;
  }
  return null;
}
const PY = findPython();

/** faster_whisper falso: `mode` decide como a CUDA falha. Registra cada carga em loads.log. */
function fakeEnv(mode: "encode-fail" | "load-fail" | "ok" | "native-crash" | "fail-2nd-encode"): { dir: string; audio: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "fw-13477-"));
  const pkg = join(dir, "faster_whisper");
  mkdirSync(pkg);
  const log = join(dir, "loads.log");
  writeFileSync(
    join(pkg, "__init__.py"),
    `
import os
MODE = ${JSON.stringify(mode)}
LOG = ${JSON.stringify(log)}
class _Seg:
    def __init__(self):
        self.start, self.end, self.text = 0.0, 1.0, " oi"
        self.no_speech_prob, self.avg_logprob, self.words = 0.0, -0.1, []
class _Info:
    duration = 1.0
class WhisperModel:
    def __init__(self, name, device="cpu", compute_type="int8"):
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{device}:{compute_type}\\n")
        if device == "cuda" and MODE == "load-fail":
            raise RuntimeError("CUDA failed with error no CUDA-capable device is detected")
        self.device = device
        self.calls = 0
    def transcribe(self, audio, **kw):
        self.calls += 1
        def gen():
            if self.device == "cuda" and MODE == "encode-fail":
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
            if self.device == "cuda" and MODE == "native-crash":
                os._exit(9)  # cuDNN ausente: o CTranslate2 derruba o processo sem exceção Python
            if self.device == "cuda" and MODE == "fail-2nd-encode" and self.calls == 2:
                raise RuntimeError("CUDA failed with error out of memory")
            yield _Seg()
        return gen(), _Info()
def decode_audio(path, sampling_rate=16000):
    return [0.0] * (sampling_rate * 30)
`,
  );
  const audio = join(dir, "a.wav");
  writeFileSync(audio, "x");
  return { dir, audio, log };
}

function run(env: ReturnType<typeof fakeEnv>, args: string[], extraEnv: Record<string, string> = {}) {
  const out = join(env.dir, "out.json");
  const r = spawnSync(PY!, ["-P", HELPER, env.audio, out, ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: env.dir, PYTHONIOENCODING: "utf-8", DIARIA_WHISPER_DEVICE: "", ...extraEnv },
  });
  const loads = (() => {
    try {
      return readFileSync(env.log, "utf8").trim().split(/\r?\n/);
    } catch {
      return [];
    }
  })();
  return { ...r, out, loads };
}

describe("#13477 transcribe_words.py --device", { skip: PY ? false : "sem python3" }, () => {
  it("auto: CUDA falha no 1º encode (cublas64_12.dll) → avisa e refaz na CPU int8", () => {
    const env = fakeEnv("encode-fail");
    const r = run(env, ["--device", "auto"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.match(r.stderr, /\[aviso\].*CUDA indisponível.*cublas64_12/);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()!).device, "cpu");
    assert.equal(JSON.parse(readFileSync(r.out, "utf8")).segments.length, 1);
  });

  it("auto: CUDA falha na carga → CPU, sem tentar a GPU de novo", () => {
    const env = fakeEnv("load-fail");
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.match(r.stderr, /\[aviso\]/);
  });

  it("auto com GPU funcionando fica na GPU (sonda + carga real)", () => {
    const env = fakeEnv("ok");
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()!).device, "cuda");
  });

  it("auto: cuDNN ausente derruba a sonda no código nativo → o processo principal nem toca a GPU e transcreve na CPU", () => {
    const env = fakeEnv("native-crash");
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.match(r.stderr, /\[aviso\].*sonda da GPU saiu 9/);
    assert.equal(JSON.parse(readFileSync(r.out, "utf8")).segments.length, 1);
  });

  it("--windows: CUDA falha na 2ª janela → refaz só ela na CPU, as anteriores ficam e as seguintes seguem na CPU", () => {
    const env = fakeEnv("fail-2nd-encode");
    const win = join(env.dir, "win.json");
    writeFileSync(win, JSON.stringify([1, 2, 3].map((k) => ({ key: `w${k}`, start: k * 2, end: k * 2 + 1 }))));
    const r = run(env, ["--windows", win]);
    assert.equal(r.status, 0, r.stderr);
    // sonda (1 encode, passa), carga na GPU, queda para a CPU na 2ª janela
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16", "cpu:int8"]);
    const out = JSON.parse(readFileSync(r.out, "utf8"));
    assert.deepEqual(out.windows.map((w: { key: string; segments: unknown[] }) => [w.key, w.segments.length]), [["w1", 1], ["w2", 1], ["w3", 1]]);
    const last = JSON.parse(r.stdout.trim().split("\n").pop()!);
    assert.equal(last.device, "cpu");
    assert.equal(last.fallback, true);
  });

  it("--device cpu nunca toca a GPU (comportamento anterior ao #13477)", () => {
    const env = fakeEnv("ok");
    const r = run(env, ["--device", "cpu"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cpu:int8"]);
  });

  it("DIARIA_WHISPER_DEVICE=cpu vale quando a flag não vem", () => {
    const env = fakeEnv("ok");
    const r = run(env, [], { DIARIA_WHISPER_DEVICE: "cpu" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cpu:int8"]);
  });

  it("--device cuda explícito com a carga falhando sai 1, sem cair na CPU", () => {
    const env = fakeEnv("load-fail");
    const r = run(env, ["--device", "cuda"]);
    assert.equal(r.status, 1);
    assert.deepEqual(r.loads, ["cuda:int8_float16"]);
  });

  it("--device inválido sai 2", () => {
    const env = fakeEnv("ok");
    const r = run(env, ["--device", "tpu"]);
    assert.equal(r.status, 2);
    assert.deepEqual(r.loads, []);
  });
});
