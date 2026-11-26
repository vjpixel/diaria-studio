/**
 * #13989: o compute type da GPU em `transcribe_words.py` sai do que o dispositivo
 * suporta. A GTX 1060 do 300 (Pascal, compute 6.1) não tem `int8_float16`
 * (`get_supported_compute_types("cuda")` = float32, int8, int8_float32); com o tipo
 * fixo, a sonda dava `ValueError: Requested int8_float16 compute type...` e tudo
 * caía na CPU. Sem GPU no teste: `pick_compute_type` é chamada direto via
 * `python3 -c`, e o helper inteiro roda contra `faster_whisper` e `ctranslate2`
 * falsos no PYTHONPATH (mesmo harness do teste do #13477).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HELPER = resolve("scripts/video/transcribe_words.py");
const HELPER_DIR = resolve("scripts/video");

function findPython(): string | null {
  for (const p of ["python3", "python"]) {
    const r = spawnSync(p, ["-c", "import sys; assert sys.version_info >= (3, 8)"]);
    if (r.status === 0) return p;
  }
  return null;
}
const PY = findPython();

const PASCAL = ["float32", "int8", "int8_float32"];
const AMPERE = ["float32", "int8", "int8_float32", "int8_float16", "float16", "bfloat16"];

/** Chama `pick_compute_type(supported, override=...)` no módulo real; devolve o tipo ou `ERR:<msg>`. */
function pick(supported: string[] | null, override: string | null = null): string {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(HELPER_DIR)})
import transcribe_words as tw
sup = json.loads(sys.argv[1])
ov = json.loads(sys.argv[2])
try:
    print(tw.pick_compute_type(None if sup is None else set(sup), override=ov))
except tw.ComputeTypeError as e:
    print("ERR:" + str(e))
`;
  const r = spawnSync(PY!, ["-c", code, JSON.stringify(supported), JSON.stringify(override)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/**
 * faster_whisper + ctranslate2 falsos. `supported` é a lista que o ctranslate2 falso devolve
 * (null = sem pacote ctranslate2; "raise" = a consulta lança, como sem dispositivo CUDA). O
 * WhisperModel falso recusa na cuda o compute type fora da lista, com a mensagem real do CTranslate2.
 */
function fakeEnv(supported: string[] | null | "raise", gpuTypes: string[] = Array.isArray(supported) ? supported : AMPERE) {
  const dir = mkdtempSync(join(tmpdir(), "fw-13989-"));
  mkdirSync(join(dir, "faster_whisper"));
  const log = join(dir, "loads.log");
  writeFileSync(
    join(dir, "faster_whisper", "__init__.py"),
    `
GPU_TYPES = set(${JSON.stringify(gpuTypes)})
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
        if device == "cuda" and compute_type not in GPU_TYPES:
            raise ValueError(f"Requested {compute_type} compute type, but the target device or backend do not support efficient {compute_type} computation.")
        self.device = device
    def transcribe(self, audio, **kw):
        def gen():
            yield _Seg()
        return gen(), _Info()
def decode_audio(path, sampling_rate=16000):
    return [0.0] * (sampling_rate * 30)
`,
  );
  if (supported !== null) {
    mkdirSync(join(dir, "ctranslate2"));
    const body =
      supported === "raise"
        ? `def get_supported_compute_types(device):\n    raise RuntimeError("CUDA failed with error no CUDA-capable device is detected")\n`
        : `def get_supported_compute_types(device):\n    return set(${JSON.stringify(supported)}) if device == "cuda" else {"float32", "int8"}\n`;
    writeFileSync(join(dir, "ctranslate2", "__init__.py"), body);
  } else {
    // sem pacote: um ctranslate2 que falha no import esconde o real que a máquina tiver
    mkdirSync(join(dir, "ctranslate2"));
    writeFileSync(join(dir, "ctranslate2", "__init__.py"), `raise ImportError("ctranslate2 ausente (teste #13989)")\n`);
  }
  const audio = join(dir, "a.wav");
  writeFileSync(audio, "x");
  return { dir, audio, log };
}

function readLoads(log: string): string[] {
  try {
    return readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function envFor(env: ReturnType<typeof fakeEnv>, extra: Record<string, string>) {
  return {
    ...process.env,
    PYTHONPATH: env.dir,
    PYTHONIOENCODING: "utf-8",
    DIARIA_WHISPER_DEVICE: "",
    DIARIA_WHISPER_PROBE_CACHE: "",
    DIARIA_WHISPER_PROBE_CACHE_DIR: env.dir,
    DIARIA_WHISPER_CUDA_DRIVER_PATH: "",
    DIARIA_WHISPER_RESIDENT: "0",
    DIARIA_WHISPER_COMPUTE_TYPE: "",
    ...extra,
  };
}

function run(env: ReturnType<typeof fakeEnv>, args: string[] = [], extra: Record<string, string> = {}) {
  const out = join(env.dir, "out.json");
  const r = spawnSync(PY!, ["-P", HELPER, env.audio, out, ...args], { encoding: "utf8", env: envFor(env, extra) });
  const last = r.stdout.trim().split("\n").pop() || "{}";
  return { ...r, loads: readLoads(env.log), res: JSON.parse(last) };
}

function probe(env: ReturnType<typeof fakeEnv>, extra: Record<string, string> = {}) {
  const r = spawnSync(PY!, ["-P", HELPER, "--probe-cuda", "large-v3-turbo"], { encoding: "utf8", env: envFor(env, extra) });
  return { ...r, loads: readLoads(env.log) };
}

describe("#13989 pick_compute_type (função pura)", { skip: PY ? false : "sem python3" }, () => {
  it("Pascal (GTX 1060: float32, int8, int8_float32) → int8_float32, nunca int8_float16", () => {
    assert.equal(pick(PASCAL), "int8_float32");
  });

  it("Ampere/Turing (lista com int8_float16) → int8_float16", () => {
    assert.equal(pick(AMPERE), "int8_float16");
  });

  it("ordem de preferência: int8_float16 > int8_float32 > int8 > float32", () => {
    assert.equal(pick(["float32", "int8"]), "int8");
    assert.equal(pick(["float32"]), "float32");
  });

  it("sem lista (None/vazia) ou só tipos fora da ordem → int8_float16, o comportamento de antes", () => {
    assert.equal(pick(null), "int8_float16");
    assert.equal(pick([]), "int8_float16");
    assert.equal(pick(["float16"]), "int8_float16");
  });

  it("override suportado vale; `auto` e vazio são sem override; caixa e espaços são normalizados", () => {
    assert.equal(pick(PASCAL, "int8"), "int8");
    assert.equal(pick(PASCAL, " INT8 "), "int8");
    assert.equal(pick(PASCAL, "auto"), "int8_float32");
    assert.equal(pick(PASCAL, ""), "int8_float32");
  });

  it("override fora da lista → erro claro que nomeia o tipo e os suportados", () => {
    const r = pick(PASCAL, "int8_float16");
    assert.match(r, /^ERR:DIARIA_WHISPER_COMPUTE_TYPE=int8_float16 não é suportado/);
    assert.match(r, /float32, int8, int8_float32/);
  });

  it("override sem lista para conferir vale como pedido (a sonda decide)", () => {
    assert.equal(pick(null, "int8"), "int8");
  });
});

describe("#13989 transcribe_words.py na GPU sem int8_float16", { skip: PY ? false : "sem python3" }, () => {
  it("Pascal: sonda e modelo carregam na cuda em int8_float32 e a transcrição fica na GPU", () => {
    const env = fakeEnv(PASCAL);
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    // sem o fix: ["cuda:int8_float16", "cpu:int8"] (sonda recusada, tudo na CPU)
    assert.deepEqual(r.loads, ["cuda:int8_float32", "cuda:int8_float32"]);
    assert.equal(r.res.device, "cuda");
    assert.doesNotMatch(r.stderr, /\[aviso\]/);
  });

  it("--probe-cuda no Pascal usa a mesma escolha do modelo e passa", () => {
    const env = fakeEnv(PASCAL);
    const r = probe(env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cuda-ok/);
    assert.deepEqual(r.loads, ["cuda:int8_float32"]);
  });

  it("GPU com int8_float16 (Neo) segue em int8_float16", () => {
    const env = fakeEnv(AMPERE);
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
  });

  it("sem ctranslate2: int8_float16 como antes; a sonda recusada no Pascal cai na CPU em int8", () => {
    const env = fakeEnv(null, PASCAL);
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cpu:int8"]);
    assert.equal(r.res.device, "cpu");
  });

  it("consulta que lança (sem dispositivo CUDA): int8_float16 como antes", () => {
    const env = fakeEnv("raise", AMPERE);
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float16", "cuda:int8_float16"]);
  });

  it("--device cpu fica em int8, sem consultar a GPU", () => {
    const env = fakeEnv(PASCAL);
    const r = run(env, ["--device", "cpu"], { DIARIA_WHISPER_COMPUTE_TYPE: "float32" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cpu:int8"]);
  });

  it("override válido (DIARIA_WHISPER_COMPUTE_TYPE=int8) vale na sonda e no modelo", () => {
    const env = fakeEnv(PASCAL);
    const r = run(env, [], { DIARIA_WHISPER_COMPUTE_TYPE: "int8" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8", "cuda:int8"]);
  });

  it("override inválido: [aviso] no stderr e a escolha automática, nos dois lugares", () => {
    const env = fakeEnv(PASCAL);
    const r = run(env, [], { DIARIA_WHISPER_COMPUTE_TYPE: "int8_float16" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.loads, ["cuda:int8_float32", "cuda:int8_float32"]);
    assert.match(r.stderr, /\[aviso\] transcribe_words: DIARIA_WHISPER_COMPUTE_TYPE=int8_float16 não é suportado.*usando int8_float32/);
    assert.equal(r.res.device, "cuda");
    const p = probe(fakeEnv(PASCAL), { DIARIA_WHISPER_COMPUTE_TYPE: "int8_float16" });
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stderr, /\[aviso\].*usando int8_float32/);
  });

  it("override entra na chave do cache da sonda; sem override, a chave é a de antes", () => {
    const env = fakeEnv(PASCAL);
    assert.equal(run(env).status, 0);
    assert.equal(run(env, [], { DIARIA_WHISPER_COMPUTE_TYPE: "int8" }).status, 0);
    const name =
      process.platform === "win32" ? "diaria-whisper-cuda-probe.json" : `diaria-whisper-cuda-probe-${process.getuid!()}.json`;
    const keys = Object.keys(JSON.parse(readFileSync(join(env.dir, name), "utf8")));
    assert.equal(keys.length, 2, keys.join("\n"));
    assert.ok(keys.some((k) => k.endsWith("|large-v3-turbo")), keys.join("\n"));
    assert.ok(keys.some((k) => k.endsWith("|large-v3-turbo|compute=int8")), keys.join("\n"));
  });
});
