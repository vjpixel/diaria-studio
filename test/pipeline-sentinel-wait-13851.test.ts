/**
 * test/pipeline-sentinel-wait-13851.test.ts (#13851)
 *
 * Edição 261123: o gate 4 foi aprovado no `300` às 22:00:18 e a Etapa 5 rodou
 * no Neo às ~22:03, antes de o sentinel chegar pelo sync do Drive. O `assert`
 * decidia na hora e o playbook mandou re-rodar a Etapa 4. `--wait-seconds`
 * relê o sentinel por uma janela curta antes de decidir o exit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeWaitReason,
  formatWaitLine,
  parseWaitArgs,
  WAIT_USAGE_EXIT,
  waitForSentinel,
} from "../scripts/pipeline-sentinel.ts";
import { writeSentinel } from "../scripts/lib/pipeline-state.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

function makeEdition(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "sentinel-wait-13851-"));
  const dir = join(root, "261123");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "revisado");
  writeFileSync(join(dir, "03-social.md"), "social");
  return { root, dir };
}

/** Relógio falso: `sleep` avança o tempo em vez de dormir. */
function fakeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("waitForSentinel (#13851)", () => {
  it("sentinel que chega durante a janela (sync atrasado) passa, sem halt", () => {
    const { root, dir } = makeEdition();
    try {
      const clock = fakeClock();
      let calls = 0;
      const result = waitForSentinel(dir, 4, {
        waitMs: 180_000,
        intervalMs: 30_000,
        now: clock.now,
        sleep: (ms) => {
          clock.sleep(ms);
          calls += 1;
          // o sync traz o sentinel depois da 2ª espera (~1 min)
          if (calls === 2) writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
        },
      });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(clock.sleeps, [30_000, 30_000]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sentinel que não chega: espera a janela inteira (3 min em passos de 30 s) e devolve sentinel_missing", () => {
    const { root, dir } = makeEdition();
    try {
      const clock = fakeClock();
      const waits: number[] = [];
      const result = waitForSentinel(dir, 4, {
        waitMs: 180_000,
        intervalMs: 30_000,
        now: clock.now,
        sleep: clock.sleep,
        onWait: (attempt) => waits.push(attempt),
      });
      assert.deepEqual(result, { ok: false, reason: "sentinel_missing" });
      assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 180_000);
      assert.equal(clock.sleeps.length, 6);
      assert.deepEqual(waits, [1, 2, 3, 4, 5, 6]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sentinel já presente: não espera", () => {
    const { root, dir } = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
      const clock = fakeClock();
      const result = waitForSentinel(dir, 4, { waitMs: 180_000, intervalMs: 30_000, now: clock.now, sleep: clock.sleep });
      assert.deepEqual(result, { ok: true });
      assert.equal(clock.sleeps.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("última espera é cortada no fim da janela (intervalo maior que o resto)", () => {
    const { root, dir } = makeEdition();
    try {
      const clock = fakeClock();
      waitForSentinel(dir, 4, { waitMs: 50_000, intervalMs: 30_000, now: clock.now, sleep: clock.sleep });
      assert.deepEqual(clock.sleeps, [30_000, 20_000]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waitMs 0 = uma leitura só", () => {
    const { root, dir } = makeEdition();
    try {
      const clock = fakeClock();
      const result = waitForSentinel(dir, 4, { waitMs: 0, intervalMs: 30_000, now: clock.now, sleep: clock.sleep });
      assert.equal(result.ok, false);
      assert.equal(clock.sleeps.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseWaitArgs (#13851)", () => {
  it("sem --wait-seconds → null (assert decide na hora, resume check inalterado)", () => {
    assert.equal(parseWaitArgs({}), null);
  });
  it("poll default de 30 s", () => {
    assert.deepEqual(parseWaitArgs({ "wait-seconds": "180" }), { waitMs: 180_000, intervalMs: 30_000 });
  });
  it("valores inválidos lançam", () => {
    assert.throws(() => parseWaitArgs({ "wait-seconds": "-1" }));
    assert.throws(() => parseWaitArgs({ "wait-seconds": "abc" }));
    assert.throws(() => parseWaitArgs({ "wait-seconds": "10", "poll-seconds": "0" }));
  });
  it("valor em branco (`--wait-seconds=`) lança em vez de virar 0 em silêncio", () => {
    assert.throws(() => parseWaitArgs({ "wait-seconds": "" }), /--wait-seconds inválido/);
    assert.throws(() => parseWaitArgs({ "wait-seconds": "  " }), /--wait-seconds inválido/);
    assert.throws(() => parseWaitArgs({ "wait-seconds": "10", "poll-seconds": "" }), /--poll-seconds inválido/);
  });
});

describe("linha [aguardando] (#13851)", () => {
  it("outputs_missing lista os outputs que faltam", () => {
    const r = { ok: false as const, reason: "outputs_missing" as const, missingOutputs: ["02-reviewed.md", "03-social.md"] };
    assert.equal(describeWaitReason(r), "outputs_missing (02-reviewed.md, 03-social.md)");
    assert.match(formatWaitLine(4, 2, 90_000, 30_000, r), /\[aguardando\] sentinel step 4 outputs_missing \(02-reviewed\.md, 03-social\.md\) \(leitura 2\)/);
  });
  it("sentinel_missing sai como o motivo cru", () => {
    assert.equal(describeWaitReason({ ok: false, reason: "sentinel_missing" }), "sentinel_missing");
  });
});

function runAssert(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, "assert", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

describe("pipeline-sentinel assert --wait-seconds (CLI, #13851)", () => {
  it("sentinel ausente: espera, loga [aguardando] e sai 1 com a dica de sync", () => {
    const { root, dir } = makeEdition();
    try {
      const { status, stderr } = runAssert([
        "--edition", "261123", "--step", "4", "--dir", dir,
        "--outputs", "02-reviewed.md,03-social.md", "--sync-hint",
        "--wait-seconds", "1", "--poll-seconds", "0.3",
      ]);
      assert.equal(status, 1, stderr);
      assert.match(stderr, /\[aguardando\] sentinel step 4 sentinel_missing/);
      assert.match(stderr, /\[aviso\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sentinel presente: exit 0 sem esperar", () => {
    const { root, dir } = makeEdition();
    try {
      writeSentinel(dir, 4, ["02-reviewed.md", "03-social.md"]);
      const { status, stderr } = runAssert([
        "--edition", "261123", "--step", "4", "--dir", dir,
        "--outputs", "02-reviewed.md,03-social.md", "--wait-seconds", "180",
      ]);
      assert.equal(status, 0, stderr);
      assert.doesNotMatch(stderr, /\[aguardando\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--wait-seconds sem valor é erro de uso (exit 64, não o 1 de sentinel ausente)", () => {
    const { root, dir } = makeEdition();
    try {
      const { status, stderr } = runAssert(["--edition", "261123", "--step", "4", "--dir", dir, "--wait-seconds"]);
      assert.equal(WAIT_USAGE_EXIT, 64);
      assert.equal(status, WAIT_USAGE_EXIT, stderr);
      assert.match(stderr, /exigem um valor/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--wait-seconds= em branco é erro de uso (exit 64)", () => {
    const { root, dir } = makeEdition();
    try {
      const { status, stderr } = runAssert(["--edition", "261123", "--step", "4", "--dir", dir, "--wait-seconds="]);
      assert.equal(status, WAIT_USAGE_EXIT, stderr);
      assert.match(stderr, /\[error\] --wait-seconds inválido/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("orchestrator-stage-5.md usa a espera na pré-condição (#13851)", () => {
  const playbook = readFileSync(join(repoRoot, ".claude", "agents", "orchestrator-stage-5.md"), "utf8");
  const pre = playbook.slice(playbook.indexOf("### Pre-condicao: sentinel Stage 4"), playbook.indexOf("- `3` →"));
  it("assert da Etapa 4 com --wait-seconds 180 (30 s × 6)", () => {
    assert.match(pre, /--sync-hint --wait-seconds 180/);
  });
  it("FATAL do exit 0 do guard põe 'aguardar o sync' antes de re-rodar a Etapa 4", () => {
    const fatal = pre.slice(pre.indexOf("Exit 0 → **FATAL:**"));
    assert.ok(fatal.indexOf("aguardar o sync") >= 0, fatal);
    assert.ok(fatal.indexOf("aguardar o sync") < fatal.indexOf("/diaria-4-revisao"), fatal);
  });
  it("comando sem exit code (background) = aguardar a conclusão, nunca prosseguir", () => {
    assert.match(pre, /\*\*Sem exit code\*\*[^\n]*aguardar a conclusão[^\n]*nunca prosseguir/);
  });
  it("halt banners da pré-condição dizem Drive, não OneDrive", () => {
    assert.doesNotMatch(pre, /OneDrive/);
  });
  it("documenta o exit 64 de uso e a espera da edição legada", () => {
    const tail = playbook.slice(playbook.indexOf("### Pre-condicao: sentinel Stage 4"));
    assert.match(tail.slice(0, 6000), /- `64` → erro de uso/);
    assert.match(pre, /legada[^\n]*espera a janela inteira antes do exit `3`/);
  });
});
