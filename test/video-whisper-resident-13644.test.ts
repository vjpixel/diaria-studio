/**
 * #13644: Whisper residente (#13506) com cliente sem limite de espera e job
 * abandonado gravando depois.
 *  1. Ctrl+C no cliente durante um job: o residente terminava o job e gravava
 *     `out` (transcript.json) depois que o comando já tinha saído.
 *  2. Residente vivo e travado: toda chamada nova esperava para sempre.
 * Mesmo harness do teste do #13506: helper real contra um `faster_whisper`
 * falso no PYTHONPATH. O falso dorme no 1º transcribe do residente (`--serve`)
 * quando `FW_SERVE_SLEEP` está posto, e grava um marcador ao começar.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const STATE_NAME = process.platform === "win32" ? "diaria-whisper-server.json" : `diaria-whisper-server-${process.getuid!()}.json`;
const spawnedPids = new Set<number>();

type Env = { dir: string; audio: string; log: string; state: string; started: string };

function fakeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "fw-13644-"));
  const pkg = join(dir, "faster_whisper");
  mkdirSync(pkg);
  const log = join(dir, "loads.log");
  const started = join(dir, "started");
  writeFileSync(
    join(pkg, "__init__.py"),
    `
LOG = ${JSON.stringify(log)}
STARTED = ${JSON.stringify(started)}
class _Seg:
    def __init__(self, t):
        self.start, self.end, self.text = 0.0, 1.0, " " + t
        self.no_speech_prob, self.avg_logprob, self.words = 0.0, -0.1, []
class _Info:
    duration = 1.0
class WhisperModel:
    def __init__(self, name, device="cpu", compute_type="int8"):
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{device}:{compute_type}\\n")
    def transcribe(self, audio, **kw):
        import os, sys, time
        sleep = float(os.environ.get("FW_SERVE_SLEEP", "0") or 0)
        if sleep and "--serve" in sys.argv and not os.path.exists(STARTED):
            with open(STARTED, "w") as f:
                f.write(str(os.getpid()))
            time.sleep(sleep)
        def gen():
            yield _Seg(kw.get("initial_prompt") or "oi")
        return gen(), _Info()
def decode_audio(path, sampling_rate=16000):
    return [0.0] * (sampling_rate * 30)
`,
  );
  const audio = join(dir, "a.wav");
  writeFileSync(audio, "x");
  return { dir, audio, log, started, state: join(dir, STATE_NAME) };
}

function helperEnv(env: Env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: env.dir,
    PYTHONIOENCODING: "utf-8",
    DIARIA_WHISPER_DEVICE: "",
    DIARIA_WHISPER_PROBE_CACHE_DIR: env.dir,
    DIARIA_WHISPER_RESIDENT: "",
    DIARIA_WHISPER_RESIDENT_IDLE_S: "20",
    DIARIA_WHISPER_RESIDENT_WAIT_S: "30",
    DIARIA_WHISPER_RESIDENT_JOB_TIMEOUT_S: "",
    ...extra,
  };
}

function readState(env: Env): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(env.state, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function track(env: Env): void {
  const st = readState(env);
  if (st && typeof st.pid === "number" && st.pid !== process.pid) spawnedPids.add(st.pid);
  if (existsSync(env.started)) spawnedPids.add(Number(readFileSync(env.started, "utf8")));
}

function run(env: Env, outName: string, extra: Record<string, string> = {}) {
  const out = join(env.dir, outName);
  const r = spawnSync(PY!, ["-P", HELPER, env.audio, out, "--device", "cpu", "--initial-prompt", outName], {
    encoding: "utf8",
    timeout: 60_000,
    env: helperEnv(env, extra),
  });
  track(env);
  const line = r.stdout.trim().split("\n").pop();
  let last: Record<string, unknown> | null = null;
  try {
    last = line ? (JSON.parse(line) as Record<string, unknown>) : null;
  } catch {
    last = null;
  }
  return { ...r, out, last };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

const loads = (env: Env) => (existsSync(env.log) ? readFileSync(env.log, "utf8").trim().split(/\r?\n/).filter(Boolean) : []);

after(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      /* já saiu */
    }
  }
});

describe("#13644 transcribe_words.py residente: timeout do cliente e job abandonado", { skip: PY ? false : "sem python3" }, () => {
  it("Ctrl+C no cliente durante o job: o residente termina, mas o transcript NÃO é gravado depois", async () => {
    const env = fakeEnv();
    const out1 = join(env.dir, "o1.json");
    const child = spawn(PY!, ["-P", HELPER, env.audio, out1, "--device", "cpu"], { env: helperEnv(env, { FW_SERVE_SLEEP: "3" }), stdio: "ignore" });
    try {
      assert.ok(await waitFor(() => existsSync(env.started), 30_000), "o residente não começou o job");
      track(env);
      child.kill("SIGINT");
      await new Promise((r) => child.once("exit", r));
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    // A 2ª chamada entra na fila do residente atrás do job abandonado: quando ela volta, o abandonado já acabou.
    const r2 = run(env, "o2.json");
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.last?.resident, true, r2.stderr);
    assert.equal(JSON.parse(readFileSync(r2.out, "utf8")).segments[0].text, "o2.json");
    assert.equal(existsSync(out1), false, "o job abandonado gravou o transcript depois do Ctrl+C");
    assert.deepEqual(
      readdirSync(env.dir).filter((f) => f.includes(".resident-")),
      [],
      "sobrou temporário do residente",
    );
    assert.deepEqual(loads(env), ["cpu:int8"]);
  });

  it("residente vivo que não responde: o cliente desiste no limite, avisa com o pid e cai na carga local", () => {
    const env = fakeEnv();
    const t0 = Date.now();
    const r = run(env, "o1.json", { FW_SERVE_SLEEP: "8", DIARIA_WHISPER_RESIDENT_JOB_TIMEOUT_S: "2" });
    const elapsed = (Date.now() - t0) / 1000;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(elapsed < 7, `esperou ${elapsed.toFixed(1)} s (limite era 2 s, o job dorme 8 s)`);
    const pid = Number(readFileSync(env.started, "utf8"));
    assert.match(r.stderr, new RegExp(`\\[aviso\\].*residente do Whisper \\(pid ${pid}\\) não respondeu em 2 s`));
    assert.match(r.stderr, /DIARIA_WHISPER_RESIDENT=0/);
    assert.equal(r.last?.resident, undefined, "a saída veio da carga local");
    assert.equal(JSON.parse(readFileSync(r.out, "utf8")).segments[0].text, "o1.json");
    assert.deepEqual(loads(env), ["cpu:int8", "cpu:int8"], "residente + carga local");
    // A próxima chamada não espera o travado: o estado dele foi solto.
    assert.notEqual(readState(env)?.pid, pid);
  });

  it("o residente nunca grava o `out` de verdade, só o temporário que o cliente nomeou", () => {
    const env = fakeEnv();
    const r1 = run(env, "o1.json");
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.last?.resident, true);
    const st = readState(env)!;
    const py = `
import json, socket, sys
st = json.load(open(sys.argv[1]))
c = socket.create_connection(("127.0.0.1", st["port"]), timeout=10)
c.sendall((json.dumps({"token": st["token"], "audio": sys.argv[2], "out": sys.argv[3]}) + "\\n").encode())
print(c.recv(65536).decode().strip())
`;
    const direct = join(env.dir, "direto.json");
    const r = spawnSync(PY!, ["-c", py, env.state, env.audio, direct], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, false);
    assert.equal(existsSync(direct), false);
    assert.equal(readState(env)?.pid, st.pid);
  });

  it("limite proporcional à duração: janelas somadas, WAV pela stdlib, desconhecida no teto", () => {
    const env = fakeEnv();
    const win = join(env.dir, "win.json");
    writeFileSync(win, JSON.stringify([{ key: "a", start: 10, end: 40 }, { key: "b", start: 50, end: 80 }]));
    const wav = join(env.dir, "real.wav");
    const py = `
import importlib.util, json, sys, wave
s = importlib.util.spec_from_file_location("tw", sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with wave.open(sys.argv[4], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\\0\\0" * 16000 * 100)
print(json.dumps([
    m.resident_job_timeout({"audio": sys.argv[2], "windows": sys.argv[3]}),
    m.resident_job_timeout({"audio": sys.argv[4], "windows": None}),
    m.resident_job_timeout({"audio": sys.argv[2], "windows": None}),
]))
`;
    const pyAbs = spawnSync(PY!, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const r = spawnSync(pyAbs, ["-c", py, HELPER, env.audio, win, wav], {
      encoding: "utf8",
      env: { ...process.env, DIARIA_WHISPER_RESIDENT_JOB_TIMEOUT_S: "", DIARIA_WHISPER_RESIDENT_JOB_FACTOR: "", PATH: env.dir },
    });
    assert.equal(r.status, 0, r.stderr);
    // 120 + 3 x 60 (janelas); 120 + 3 x 100 (WAV); sem ffprobe no PATH e áudio ilegível: teto de 3600
    assert.deepEqual(JSON.parse(r.stdout), [300, 420, 3600]);
  });
});
