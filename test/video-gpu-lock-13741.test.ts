/**
 * #13741: preview, review e gaze do `video-montagem.ts` rodados juntos
 * travaram na GPU (261119, Neo). O 2º subcomando espera o 1º, com [aviso].
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GPU_AFTER_DOWNLOAD_COMMANDS,
  GPU_FREE_COMMANDS,
  GPU_FREE_WITH_FLAG,
  acquireGpuLock,
  describeGpuHolder,
  gpuLockAfterDownload,
  needsGpuLock,
  readGpuLockHolder,
  releaseGpuLockEarly,
  withGpuLock,
} from "../scripts/lib/diaria/video-gpu-lock.ts";
import { lockHostId } from "../scripts/lib/file-lock.ts";
import { SUBCOMMANDS, cliMain } from "../scripts/video-montagem.ts";

function sandbox(): { dir: string; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vm-gpu-13741-"));
  return { dir, path: join(dir, "gpu.lock"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("#13741 needsGpuLock", () => {
  it("preview, review e gaze (os da 261119) pegam o lock; blocks/fact-check-merge/upload não", () => {
    for (const c of ["preview", "review", "gaze", "build", "transcribe", "verify-xml", "face", "decupagem"]) assert.equal(needsGpuLock(c, {}), true, c);
    for (const c of GPU_FREE_COMMANDS) assert.equal(needsGpuLock(c, {}), false, c);
  });
  it("os subcomandos fora do lock existem de verdade (nome errado deixaria um GPU de fora em silêncio)", () => {
    for (const c of GPU_FREE_COMMANDS) assert.ok((SUBCOMMANDS as readonly string[]).includes(c), c);
  });
  it("DIARIA_VIDEO_GPU_LOCK=0 desliga; sem subcomando, nada", () => {
    assert.equal(needsGpuLock("preview", { DIARIA_VIDEO_GPU_LOCK: "0" }), false);
    assert.equal(needsGpuLock("preview", { DIARIA_VIDEO_GPU_LOCK: "1" }), true);
    assert.equal(needsGpuLock(undefined, {}), false);
  });
});

describe("#13741 acquireGpuLock", () => {
  it("livre: pega na hora, sem log, grava o dono e solta no release", async () => {
    const s = sandbox();
    try {
      const logs: string[] = [];
      const h = await acquireGpuLock("preview", "261119", { path: s.path, log: (l) => logs.push(l) });
      const holder = JSON.parse(readFileSync(s.path, "utf8"));
      assert.equal(holder.cmd, "preview");
      assert.equal(holder.edition, "261119");
      assert.equal(holder.pid, process.pid);
      assert.equal(holder.host, lockHostId());
      assert.deepEqual(logs, []);
      h.release();
      assert.equal(existsSync(s.path), false);
    } finally {
      s.done();
    }
  });

  it("ocupado (o cenário da 261119): o 2º espera com [aviso] dizendo quem segura e segue quando o 1º solta", async () => {
    const s = sandbox();
    try {
      const first = await acquireGpuLock("preview", "261119", { path: s.path });
      const logs: string[] = [];
      let t = 0;
      let sleeps = 0;
      const second = acquireGpuLock("review", "261119", {
        path: s.path,
        log: (l) => logs.push(l),
        now: () => t,
        sleep: async (ms) => {
          t += ms;
          sleeps++;
          if (sleeps === 3) first.release();
        },
        stealOrphan: () => false,
      });
      const h = await second;
      assert.equal(sleeps, 3);
      assert.match(logs[0], /^\[aviso\] GPU ocupada por preview 261119 \(pid \d+/);
      assert.match(logs[0], /review 261119 espera/);
      assert.match(logs[logs.length - 1], /GPU livre depois de 6 s: review segue/);
      assert.equal(JSON.parse(readFileSync(s.path, "utf8")).cmd, "review");
      h.release();
    } finally {
      s.done();
    }
  });

  it("o [aviso] não se repete a cada tentativa, só a cada noticeEveryS", async () => {
    const s = sandbox();
    try {
      writeFileSync(s.path, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "x", cmd: "gaze", edition: "261119" }));
      const logs: string[] = [];
      let t = 0;
      await assert.rejects(
        acquireGpuLock("preview", "261119", { path: s.path, log: (l) => logs.push(l), now: () => t, sleep: async (ms) => void (t += ms), stealOrphan: () => false, pollS: 2, noticeEveryS: 10, maxWaitS: 31 }),
        /GPU ocupada por gaze 261119 .*teto de 31 s/,
      );
      // 0, 10, 20, 30 s.
      assert.equal(logs.filter((l) => l.startsWith("[aviso]")).length, 4);
    } finally {
      s.done();
    }
  });

  it("dono morto não trava: o órfão sai e o lock é pego", async () => {
    const s = sandbox();
    try {
      // PID que não existe neste host: o órfão do Ctrl-C.
      writeFileSync(s.path, JSON.stringify({ pid: 2 ** 22 + 12345, host: lockHostId(), ts: 0, token: "morto", cmd: "gaze" }));
      const logs: string[] = [];
      const h = await acquireGpuLock("preview", "261119", { path: s.path, log: (l) => logs.push(l), sleep: async () => assert.fail("não devia esperar") });
      assert.equal(JSON.parse(readFileSync(s.path, "utf8")).cmd, "preview");
      h.release();
    } finally {
      s.done();
    }
  });

  it("erro de disco que não é EEXIST propaga na hora (nunca gira até o teto)", async () => {
    const err = Object.assign(new Error("sem permissão"), { code: "EACCES" });
    await assert.rejects(acquireGpuLock("preview", "261119", { path: "/x/gpu.lock", openWx: () => { throw err; }, sleep: async () => assert.fail("não devia esperar") }), /sem permissão/);
  });

  it("release não apaga o lock de outro dono", async () => {
    const s = sandbox();
    try {
      const h = await acquireGpuLock("preview", "261119", { path: s.path });
      writeFileSync(s.path, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "outro" }));
      h.release();
      assert.equal(existsSync(s.path), true);
    } finally {
      s.done();
    }
  });
});

describe("#13741 withGpuLock e cliMain", () => {
  it("solta o lock também quando o subcomando lança", async () => {
    const s = sandbox();
    try {
      await assert.rejects(withGpuLock("review", "261119", async () => { assert.ok(existsSync(s.path)); throw new Error("falhou"); }, { path: s.path, env: {} }), /falhou/);
      assert.equal(existsSync(s.path), false);
      // #13806: preview pega o lock depois do download (gate); lançando depois dele, solta igual.
      await assert.rejects(withGpuLock("preview", "261119", async () => { await gpuLockAfterDownload(); assert.ok(existsSync(s.path)); throw new Error("falhou"); }, { path: s.path, env: {} }), /falhou/);
      assert.equal(existsSync(s.path), false);
    } finally {
      s.done();
    }
  });

  it("subcomando sem GPU roda sem tocar no lock (mesmo com ele tomado)", async () => {
    const s = sandbox();
    try {
      writeFileSync(s.path, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "x", cmd: "build" }));
      assert.equal(await withGpuLock("blocks", "261119", async () => 7, { path: s.path, env: {}, sleep: async () => assert.fail("não devia esperar") }), 7);
    } finally {
      s.done();
    }
  });

  it("cliMain: --help não espera a GPU ocupada", async () => {
    const s = sandbox();
    try {
      writeFileSync(s.path, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "x", cmd: "build" }));
      const code = await cliMain(["preview", "261119", "--help"], undefined, s.dir, { path: s.path, sleep: async () => assert.fail("não devia esperar") });
      assert.equal(code, 2);
    } finally {
      s.done();
    }
  });

  it("descrição de quem segura: conteúdo ilegível vira 'outro subcomando'", () => {
    assert.deepEqual(readGpuLockHolder("lixo"), {});
    assert.equal(describeGpuHolder({}), "outro subcomando");
    assert.equal(describeGpuHolder({ cmd: "gaze", edition: "261119", pid: 42, ts: Date.UTC(2026, 10, 18, 21, 3, 10) }), "gaze 261119 (pid 42, desde 21:03:10 UTC)");
  });
});

describe("#13806 o lock cobre só o trecho com GPU", () => {
  it("fact-check-input fica de fora; decupagem, roteiro e verify-xml só com a flag que desliga o Whisper", () => {
    assert.equal(needsGpuLock("fact-check-input", {}), false);
    for (const [c, flag] of Object.entries(GPU_FREE_WITH_FLAG)) {
      assert.ok((SUBCOMMANDS as readonly string[]).includes(c), c);
      assert.equal(needsGpuLock(c, {}), true, `${c} sem --${flag}`);
      assert.equal(needsGpuLock(c, {}, new Set([flag])), false, `${c} --${flag}`);
    }
    // Flag de outro subcomando não tira ninguém do lock.
    assert.equal(needsGpuLock("decupagem", {}, new Set(["no-transcribe"])), true);
    assert.equal(needsGpuLock("constructor", {}), true);
  });

  it("os subcomandos de download adiado existem de verdade e usam a GPU", () => {
    for (const c of GPU_AFTER_DOWNLOAD_COMMANDS) {
      assert.ok((SUBCOMMANDS as readonly string[]).includes(c), c);
      assert.equal(needsGpuLock(c, {}), true, c);
    }
  });

  it("transcribe com Drive lento: o download roda sem o lock e o lock é pego depois dele", async () => {
    const s = sandbox();
    try {
      const steps: string[] = [];
      const code = await withGpuLock("transcribe", "261119", async () => {
        // O download do bruto: o lock ainda não existe.
        steps.push(`download lock=${existsSync(s.path)}`);
        await gpuLockAfterDownload();
        steps.push(`whisper cmd=${JSON.parse(readFileSync(s.path, "utf8")).cmd}`);
        await gpuLockAfterDownload(); // idempotente
        releaseGpuLockEarly();
        steps.push(`upload lock=${existsSync(s.path)}`);
        return 0;
      }, { path: s.path, env: {} });
      assert.equal(code, 0);
      assert.deepEqual(steps, ["download lock=false", "whisper cmd=transcribe", "upload lock=false"]);
      assert.equal(existsSync(s.path), false);
    } finally {
      s.done();
    }
  });

  it("com a GPU ocupada por outro subcomando, o download não espera; só o passo com GPU espera", async () => {
    const s = sandbox();
    try {
      writeFileSync(s.path, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: 0, token: "x", cmd: "gaze", edition: "261119" }));
      let downloaded = false;
      let sleeps = 0;
      await withGpuLock("preview", "261119", async () => {
        downloaded = true;
        await gpuLockAfterDownload();
      }, {
        path: s.path,
        env: {},
        stealOrphan: () => false,
        log: () => {},
        sleep: async () => {
          assert.ok(downloaded, "esperou a GPU antes do download");
          if (++sleeps === 2) rmSync(s.path);
        },
      });
      assert.equal(sleeps, 2);
    } finally {
      s.done();
    }
  });

  it("subcomando de lock imediato segue pegando no começo; o gate é no-op nele e fora do withGpuLock", async () => {
    const s = sandbox();
    try {
      await gpuLockAfterDownload();
      await withGpuLock("review", "261119", async () => {
        assert.ok(existsSync(s.path));
        await gpuLockAfterDownload();
      }, { path: s.path, env: {} });
      assert.equal(existsSync(s.path), false);
    } finally {
      s.done();
    }
  });

  it("guard de fiação: runCommand chama o gate depois de cada download e o main solta antes do upload", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "video-montagem.ts"), "utf8");
    const body = src.slice(src.indexOf("async function runCommand("), src.indexOf("export async function cliMain("));
    // needLocalBruto (face, face-compare, gaze, frame, preview, build) termina no gate.
    assert.match(body, /const needLocalBruto = async \(\) => \{[\s\S]*?await gpuLockAfterDownload\(\);\n  \};/);
    for (const call of ["cmdTranscribe(", "cmdSrt(", "cmdSrtFromFinalNoPlan(", "cmdSrtFromFinal(", "cmdReviewFinal("]) {
      const at = body.indexOf(`return ${call}`);
      assert.ok(at > 0, call);
      assert.match(body.slice(Math.max(0, at - 200), at), /await gpuLockAfterDownload\(\);\s*$/, `${call} sem o gate logo antes`);
    }
    assert.match(body, /await needLocalBruto\(\);\n\s*await gpuLockAfterDownload\(\);/, "build: o gate depois do download condicional");
    assert.match(body, /return cmdPreview\(ctx, seq, d, [^\n]*needLocalBruto \}\)/);
    for (const c of ["face", "face-compare", "gaze"]) assert.match(body, new RegExp(`case "${c}":\\n\\s*await needLocalBruto\\(\\);`), c);
    assert.match(body, /case "frame": \{\n\s*await needLocalBruto\(\);/);
    assert.match(src, /const code = await runCommand\(ctx, cmd, values, flags, seq, d\);\n[^\n]*\n  releaseGpuLockEarly\(\);/);
    assert.match(src, /withGpuLock\(lockable \? cmd : undefined, edition, \(\) => main\(argv, deps\), \{ \.\.\.gpuLock, flags \}\)/);
  });
});
