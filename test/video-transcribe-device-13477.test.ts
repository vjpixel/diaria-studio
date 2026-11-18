/**
 * #13477: `transcribe_words.py --device auto` tenta a GPU e cai na CPU quando a
 * CUDA falha — inclusive no primeiro `encode`, que é onde o Windows acusa
 * `cublas64_12.dll is not found` (a carga do modelo passa). Roda o helper real
 * contra um `faster_whisper` falso no PYTHONPATH, sem GPU nem modelo.
 *
 * #13504: o veredito da sonda fica em cache; cada `fakeEnv` aponta o cache para o
 * próprio tmpdir (`DIARIA_WHISPER_PROBE_CACHE_DIR`), então os testes não se veem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
function fakeEnv(mode: "encode-fail" | "load-fail" | "ok" | "native-crash" | "fail-2nd-encode" | "oom"): { dir: string; audio: string; log: string } {
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
            if self.device == "cuda" and MODE == "oom":
                raise RuntimeError("CUDA failed with error out of memory")
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
    env: {
      ...process.env,
      PYTHONPATH: env.dir,
      PYTHONIOENCODING: "utf-8",
      DIARIA_WHISPER_DEVICE: "",
      DIARIA_WHISPER_PROBE_CACHE: "",
      DIARIA_WHISPER_PROBE_CACHE_DIR: env.dir,
      DIARIA_WHISPER_CUDA_DRIVER_PATH: "",
      ...extraEnv,
    },
  });
  return { ...r, out, loads: readLoads(env) };
}

function readLoads(env: ReturnType<typeof fakeEnv>): string[] {
  try {
    return readFileSync(env.log, "utf8").trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Roda e devolve só as cargas desta chamada (o loads.log acumula entre chamadas no mesmo env). */
function runDelta(env: ReturnType<typeof fakeEnv>, args: string[], extraEnv: Record<string, string> = {}) {
  const before = readLoads(env).length;
  const r = run(env, args, extraEnv);
  return { ...r, loads: r.loads.slice(before) };
}

// fora do Windows o uid entra no nome do arquivo (o /tmp é compartilhado entre usuários)
const CACHE_NAME =
  process.platform === "win32" ? "diaria-whisper-cuda-probe.json" : `diaria-whisper-cuda-probe-${process.getuid!()}.json`;
const cacheFile = (env: ReturnType<typeof fakeEnv>) => join(env.dir, CACHE_NAME);

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

describe("#13504 cache do veredito da sonda da GPU", { skip: PY ? false : "sem python3" }, () => {
  it("GPU ok: a 2ª chamada em auto pula a sonda (só a carga real)", () => {
    const env = fakeEnv("ok");
    const r1 = runDelta(env, []);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    const r2 = runDelta(env, []);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(r2.loads, ["cuda:int8_float16"]);
    assert.equal(JSON.parse(r2.stdout.trim().split("\n").pop()!).device, "cuda");
  });

  it("veredito falho cacheado: a 2ª chamada nem toca a GPU e o aviso cita o motivo cacheado", () => {
    const env = fakeEnv("native-crash");
    const r1 = runDelta(env, []);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.loads, ["cuda:int8_float16", "cpu:int8"]);
    const r2 = runDelta(env, []);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(r2.loads, ["cpu:int8"]);
    assert.match(r2.stderr, /\[aviso\].*sonda da GPU saiu 9.*veredito em cache/);
  });

  it("sonda ok mas o encode falha no processo principal → cache invalidado, a chamada seguinte sonda de novo", () => {
    const env = fakeEnv("fail-2nd-encode");
    const win = join(env.dir, "win.json");
    writeFileSync(win, JSON.stringify([1, 2, 3].map((k) => ({ key: `w${k}`, start: k * 2, end: k * 2 + 1 }))));
    const r1 = runDelta(env, ["--windows", win]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.loads, ["cuda:int8_float16", "cuda:int8_float16", "cpu:int8"]);
    assert.deepEqual(JSON.parse(readFileSync(cacheFile(env), "utf8")), {});
    const r2 = runDelta(env, ["--windows", win]);
    assert.equal(r2.status, 0, r2.stderr);
    // a sonda roda de novo (1ª carga): nem um "ok" velho que pularia a sonda, nem um "falho" que pularia a GPU
    assert.deepEqual(r2.loads, ["cuda:int8_float16", "cuda:int8_float16", "cpu:int8"]);
  });

  it("sonda ok mas a carga real falha → cache invalidado", () => {
    const env = fakeEnv("ok");
    assert.equal(runDelta(env, []).status, 0);
    // a GPU "some" entre as chamadas: veredito ok em cache, carga falha
    const init = join(env.dir, "faster_whisper", "__init__.py");
    writeFileSync(init, readFileSync(init, "utf8").replace('MODE = "ok"', 'MODE = "load-fail"'));
    const r2 = runDelta(env, []);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(r2.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.deepEqual(JSON.parse(readFileSync(cacheFile(env), "utf8")), {});
    const r3 = runDelta(env, []);
    // sem cache: a sonda roda (e falha na carga), depois CPU
    assert.deepEqual(r3.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.match(r3.stderr, /sonda da GPU saiu/);
  });

  it("cache corrompido → roda a sonda, sem erro, e regrava um cache válido", () => {
    const env = fakeEnv("ok");
    writeFileSync(cacheFile(env), "{isto não é json");
    const r1 = runDelta(env, []);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.deepEqual(runDelta(env, []).loads, ["cuda:int8_float16"]);
  });

  it("TTL vencido → roda a sonda de novo", () => {
    const env = fakeEnv("ok");
    assert.equal(runDelta(env, []).status, 0);
    const data = JSON.parse(readFileSync(cacheFile(env), "utf8")) as Record<string, { at: number }>;
    assert.equal(Object.keys(data).length, 1);
    for (const k of Object.keys(data)) data[k].at -= 6 * 3600 + 1;
    writeFileSync(cacheFile(env), JSON.stringify(data));
    const r = runDelta(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
  });

  it("trocar a versão do nvidia-cudnn-cu12 (DLLs pelo pip) muda a chave: veredito ok em cache não vale, roda a sonda", () => {
    const env = fakeEnv("ok");
    // dist-info falso no PYTHONPATH: vem antes do site-packages, então importlib.metadata lê este
    const fakeDist = (v: string) => {
      const d = join(env.dir, `nvidia_cudnn_cu12-${v}.dist-info`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "METADATA"), `Metadata-Version: 2.1\nName: nvidia-cudnn-cu12\nVersion: ${v}\n`);
      return d;
    };
    const d1 = fakeDist("9.1.0");
    assert.deepEqual(runDelta(env, []).loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.deepEqual(runDelta(env, []).loads, ["cuda:int8_float16"]); // mesma versão: cache vale
    rmSync(d1, { recursive: true, force: true });
    fakeDist("9.5.1");
    const r = runDelta(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    const keys = Object.keys(JSON.parse(readFileSync(cacheFile(env), "utf8")));
    assert.ok(keys.some((k) => k.includes("nvidia-cudnn-cu12=9.5.1")), keys.join("\n"));
  });

  it("--device cpu e --device cuda não leem nem gravam o cache", () => {
    const env = fakeEnv("ok");
    for (const dev of ["cpu", "cuda"]) {
      const r = runDelta(env, ["--device", dev]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.loads, [`${dev}:${dev === "cuda" ? "int8_float16" : "int8"}`]);
    }
    assert.throws(() => readFileSync(cacheFile(env), "utf8"), "nada gravado");
    // um veredito falho em cache não impede --device cuda nem muda o arquivo
    const sentinel = JSON.stringify({ x: { ok: false, why: "velho", at: Date.now() / 1000 } });
    writeFileSync(cacheFile(env), sentinel);
    for (const dev of ["cpu", "cuda"]) assert.equal(runDelta(env, ["--device", dev]).status, 0);
    assert.equal(readFileSync(cacheFile(env), "utf8"), sentinel);
  });

  it("falta de memória na GPU durante a sonda não é cacheada: a chamada seguinte sonda de novo", () => {
    const env = fakeEnv("oom");
    const r1 = runDelta(env, []);
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(r1.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.match(r1.stderr, /out of memory/);
    assert.throws(() => readFileSync(cacheFile(env), "utf8"), "falha passageira não grava");
    const r2 = runDelta(env, []);
    assert.deepEqual(r2.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.doesNotMatch(r2.stderr, /veredito em cache/);
  });

  it("veredito falho com mais de 10 min → sonda de novo (o ok vale 6 h)", () => {
    const env = fakeEnv("native-crash");
    assert.equal(runDelta(env, []).status, 0);
    const data = JSON.parse(readFileSync(cacheFile(env), "utf8")) as Record<string, { ok: boolean; at: number }>;
    const [k] = Object.keys(data);
    assert.equal(data[k].ok, false);
    data[k].at -= 5 * 60; // 5 min: ainda vale
    writeFileSync(cacheFile(env), JSON.stringify(data));
    assert.deepEqual(runDelta(env, []).loads, ["cpu:int8"]);
    data[k].at -= 6 * 60; // 11 min: venceu
    writeFileSync(cacheFile(env), JSON.stringify(data));
    assert.deepEqual(runDelta(env, []).loads, ["cuda:int8_float16", "cpu:int8"]);
  });

  it("atualizar o driver CUDA (nvcuda.dll/libcuda.so.1) invalida o veredito ok", () => {
    const env = fakeEnv("ok");
    const drv = join(env.dir, "nvcuda.dll");
    writeFileSync(drv, "a");
    const drvEnv = { DIARIA_WHISPER_CUDA_DRIVER_PATH: drv };
    assert.deepEqual(runDelta(env, [], drvEnv).loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.deepEqual(runDelta(env, [], drvEnv).loads, ["cuda:int8_float16"]);
    writeFileSync(drv, "driver novo, outro tamanho");
    const r = runDelta(env, [], drvEnv);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
  });

  it("DIARIA_WHISPER_PROBE_CACHE=0 desliga o cache: toda chamada sonda", () => {
    const env = fakeEnv("ok");
    const off = { DIARIA_WHISPER_PROBE_CACHE: "0" };
    assert.deepEqual(runDelta(env, [], off).loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.deepEqual(runDelta(env, [], off).loads, ["cuda:int8_float16", "cuda:int8_float16"]);
    assert.throws(() => readFileSync(cacheFile(env), "utf8"));
  });
});
