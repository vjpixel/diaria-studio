/**
 * #13506: Whisper residente por sessão. A 1ª chamada do `transcribe_words.py`
 * sobe `--serve`, que carrega o modelo uma vez; as seguintes usam o residente
 * pelo socket local. Qualquer falha do residente cai na carga local de sempre.
 * Roda o helper real contra um `faster_whisper` falso no PYTHONPATH (sem GPU,
 * sem modelo, como o teste do #13477); cada teste tem o próprio diretório de
 * estado (`DIARIA_WHISPER_PROBE_CACHE_DIR`) e mata o residente que subiu.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

function fakeEnv(): { dir: string; audio: string; log: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "fw-13506-"));
  const pkg = join(dir, "faster_whisper");
  mkdirSync(pkg);
  const log = join(dir, "loads.log");
  writeFileSync(
    join(pkg, "__init__.py"),
    `
LOG = ${JSON.stringify(log)}
class _Seg:
    def __init__(self, t):
        self.start, self.end, self.text = 0.0, 1.0, " " + t
        self.no_speech_prob, self.avg_logprob, self.words = 0.0, -0.1, []
class _Info:
    duration = 1.0
class WhisperModel:
    def __init__(self, name, device="cpu", compute_type="int8"):
        import os, time
        time.sleep(float(os.environ.get("FW_LOAD_SLEEP", "0") or 0))
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{device}:{compute_type}\\n")
    def transcribe(self, audio, **kw):
        def gen():
            yield _Seg(kw.get("initial_prompt") or "oi")
        return gen(), _Info()
def decode_audio(path, sampling_rate=16000):
    return [0.0] * (sampling_rate * 30)
`,
  );
  const audio = join(dir, "a.wav");
  writeFileSync(audio, "x");
  return { dir, audio, log, state: join(dir, STATE_NAME) };
}

function run(env: ReturnType<typeof fakeEnv>, args: string[], extraEnv: Record<string, string> = {}, outName = "out.json") {
  const out = join(env.dir, outName);
  const r = spawnSync(PY!, ["-P", HELPER, env.audio, out, "--device", "cpu", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PYTHONPATH: env.dir,
      PYTHONIOENCODING: "utf-8",
      DIARIA_WHISPER_DEVICE: "",
      DIARIA_WHISPER_PROBE_CACHE_DIR: env.dir,
      DIARIA_WHISPER_RESIDENT: "",
      DIARIA_WHISPER_RESIDENT_IDLE_S: "20",
      DIARIA_WHISPER_RESIDENT_WAIT_S: "30",
      ...extraEnv,
    },
  });
  const st = readState(env);
  if (st && typeof st.pid === "number" && st.pid !== process.pid) spawnedPids.add(st.pid);
  return { ...r, out, last: lastJson(r.stdout) };
}

function lastJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split("\n").pop();
  try {
    return line ? (JSON.parse(line) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readState(env: ReturnType<typeof fakeEnv>): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(env.state, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const loads = (env: ReturnType<typeof fakeEnv>) => (existsSync(env.log) ? readFileSync(env.log, "utf8").trim().split(/\r?\n/).filter(Boolean) : []);

after(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      /* já saiu */
    }
  }
});

describe("#13506 transcribe_words.py residente", { skip: PY ? false : "sem python3" }, () => {
  it("duas chamadas seguidas: o modelo carrega UMA vez (no residente), e as duas saídas são gravadas", () => {
    const env = fakeEnv();
    const r1 = run(env, ["--initial-prompt", "primeira"], {}, "o1.json");
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.last?.resident, true);
    const r2 = run(env, ["--initial-prompt", "segunda"], {}, "o2.json");
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.last?.resident, true);
    assert.deepEqual(loads(env), ["cpu:int8"]);
    // cada chamada leva o próprio pedido (prompt) ao residente
    assert.equal(JSON.parse(readFileSync(r1.out, "utf8")).segments[0].text, "primeira");
    assert.equal(JSON.parse(readFileSync(r2.out, "utf8")).segments[0].text, "segunda");
  });

  it("--windows passa pelo residente com o mesmo formato de saída", () => {
    const env = fakeEnv();
    const win = join(env.dir, "win.json");
    writeFileSync(win, JSON.stringify([{ key: "a", start: 1, end: 2 }, { key: "b", start: 3, end: 4 }]));
    const r = run(env, ["--windows", win]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.last?.resident, true);
    const out = JSON.parse(readFileSync(r.out, "utf8"));
    assert.deepEqual(out.windows.map((w: { key: string; segments: unknown[] }) => [w.key, w.segments.length]), [["a", 1], ["b", 1]]);
  });

  it("DIARIA_WHISPER_RESIDENT=0: cada chamada carrega o modelo (o helper avulso de antes)", () => {
    const env = fakeEnv();
    for (const n of ["o1.json", "o2.json"]) {
      const r = run(env, [], { DIARIA_WHISPER_RESIDENT: "0" }, n);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.last?.resident, undefined);
    }
    assert.deepEqual(loads(env), ["cpu:int8", "cpu:int8"]);
    assert.equal(readState(env), null);
  });

  it("estado de residente que não atende (porta fechada): cai na carga local com [aviso] e limpa o estado", () => {
    const env = fakeEnv();
    // pid vivo (o do próprio teste) e uma porta onde ninguém escuta
    writeFileSync(env.state, JSON.stringify({ pid: process.pid, ready: true, port: 1, token: "x", model: "large-v3-turbo", device_req: "cpu", helper: helperFingerprint() }));
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[aviso\].*residente não atendeu/);
    assert.equal(r.last?.resident, undefined);
    assert.deepEqual(loads(env), ["cpu:int8"]);
    assert.equal(readState(env), null);
  });

  it("residente de outro modelo, ou de outra versão do helper: carga local, sem subir outro", () => {
    const env = fakeEnv();
    const base = { pid: process.pid, ready: true, port: 1, token: "x", device_req: "cpu" };
    writeFileSync(env.state, JSON.stringify({ ...base, model: "outro", helper: helperFingerprint() }));
    const r1 = run(env, [], {}, "o1.json");
    assert.equal(r1.status, 0, r1.stderr);
    writeFileSync(env.state, JSON.stringify({ ...base, model: "large-v3-turbo", helper: "0:0" }));
    const r2 = run(env, [], {}, "o2.json");
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(loads(env), ["cpu:int8", "cpu:int8"]);
    assert.equal(readState(env)?.pid, process.pid, "o estado de outro residente vivo não é apagado");
  });

  it("estado de processo morto: sobe um residente novo e atende por ele", () => {
    const env = fakeEnv();
    writeFileSync(env.state, JSON.stringify({ pid: 2 ** 22 + 12345, ready: true, port: 1, token: "x", model: "large-v3-turbo", device_req: "cpu", helper: helperFingerprint() }));
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.last?.resident, true);
    assert.notEqual(readState(env)?.pid, 2 ** 22 + 12345);
  });

  it("residente vivo mas parado no load (heartbeat velho): não espera o WAIT inteiro, cai na carga local (#13530 review)", () => {
    const env = fakeEnv();
    // pid vivo (o do próprio teste, como no Windows antes do OpenProcess) e ready:false com heartbeat recente que ninguém renova
    const now = Date.now() / 1000;
    writeFileSync(env.state, JSON.stringify({ pid: process.pid, ready: false, at: now, hb: now, model: "large-v3-turbo", device_req: "cpu", helper: helperFingerprint() }));
    const t0 = Date.now();
    const r = run(env, [], { DIARIA_WHISPER_RESIDENT_WAIT_S: "60", DIARIA_WHISPER_RESIDENT_HEARTBEAT_STALE_S: "2" });
    const elapsed = (Date.now() - t0) / 1000;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(elapsed < 20, `esperou ${elapsed.toFixed(1)} s (WAIT era 60 s)`);
    assert.match(r.stderr, /\[aviso\].*não ficou pronto/);
    assert.equal(r.last?.resident, undefined);
    assert.deepEqual(loads(env), ["cpu:int8"]);
  });

  it("load lento (5 s) com heartbeat de 3 s: o heartbeat mantém o residente vivo e a chamada é atendida por ele", () => {
    const env = fakeEnv();
    const r = run(env, [], { FW_LOAD_SLEEP: "5", DIARIA_WHISPER_RESIDENT_HEARTBEAT_STALE_S: "3" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.last?.resident, true, r.stderr);
    assert.deepEqual(loads(env), ["cpu:int8"]);
  });

  it("estado de load com heartbeat já vencido na entrada: é tratado como morto e sobe um residente novo", () => {
    const env = fakeEnv();
    const old = Date.now() / 1000 - 120;
    writeFileSync(env.state, JSON.stringify({ pid: process.pid, ready: false, at: old, hb: old, model: "large-v3-turbo", device_req: "cpu", helper: helperFingerprint() }));
    const r = run(env, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.last?.resident, true);
    assert.notEqual(readState(env)?.pid, process.pid);
  });

  it("versão do helper pelo conteúdo: mtime trocado com os mesmos bytes dá a mesma impressão", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-13530-"));
    const copy = join(dir, "transcribe_words.py");
    copyFileSync(HELPER, copy);
    utimesSync(copy, new Date(2030, 0, 1), new Date(2030, 0, 1));
    const fp = (file: string) => spawnSync(PY!, ["-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('tw', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.helper_fingerprint())", file], { encoding: "utf8" }).stdout.trim();
    assert.equal(fp(copy), fp(HELPER));
    assert.equal(fp(HELPER), helperFingerprint());
    writeFileSync(copy, readFileSync(HELPER, "utf8") + "\n# outro conteúdo\n");
    assert.notEqual(fp(copy), fp(HELPER));
  });
});

/** O mesmo `helper_fingerprint()` do Python: sha256 do conteúdo, 16 hex (#13530 review). */
function helperFingerprint(): string {
  return createHash("sha256").update(readFileSync(HELPER)).digest("hex").slice(0, 16);
}
