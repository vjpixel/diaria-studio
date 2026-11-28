/**
 * #14327 item 5: as fases de `mainUnlocked` que não são destino saíram de
 * `scripts/publish-shorts/run.ts` para `run-replace.ts` (lock da troca, escolha
 * dos alvos, fase destrutiva) e `run-authorize.ts` (manifesto do dry-run,
 * consumo da autorização do plano, KV do /video). Este arquivo trava a ordem
 * em que o `mainUnlocked` as chama (a mesma do código inline de antes) e o
 * comportamento das duas fases puras de saída antecipada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectShortsReplacement, takeShortsReplaceLock } from "../scripts/publish-shorts/run-replace.ts";

const RUN = readFileSync(join(import.meta.dirname, "..", "scripts", "publish-shorts", "run.ts"), "utf8");
const MAIN = RUN.slice(RUN.indexOf("async function mainUnlocked(): Promise<number>"));

describe("#14327 mainUnlocked chama as fases extraídas na ordem do código inline", () => {
  it("lock → seleção da troca → plano → fase da troca → dry-run → consumo → KV → autorização do corte → envio", () => {
    const order = [
      "takeShortsReplaceLock(dir, replaceRun)",
      "selectShortsReplacement({",
      "plan = planShortsPublish({",
      "await runShortsReplacePhase({",
      "shortsPlanDryRunManifest({",
      "await consumeShortsPlanAuthorization({",
      "await updateShortVideoRedirects(dir, aammdd)",
      "recordCortePublishAuthorization(dir,",
      "for (const item of plan.items)",
    ];
    let last = -1;
    for (const needle of order) {
      const at = MAIN.indexOf(needle);
      assert.ok(at > last, `${needle} fora de ordem (${at} <= ${last})`);
      assert.equal(MAIN.indexOf(needle, at + 1), -1, `${needle} chamado mais de uma vez`);
      last = at;
    }
  });

  it("cada fase só roda sob a condição de antes", () => {
    assert.match(MAIN, /if \(flags\.has\("publish"\) && !corte && writer === "main"\) \{\n\s*const lock = takeShortsReplaceLock\(dir, replaceRun\);/);
    assert.match(MAIN, /if \(replaceRun\) \{\n\s*const selection = selectShortsReplacement\(/);
    assert.match(MAIN, /if \(replaceRun\) \{\n\s*\/\/[^\n]*\n\s*const phase = await runShortsReplacePhase\(/);
    assert.match(MAIN, /if \(!flags\.has\("publish"\)\) \{\n\s*\/\/[^\n]*\n\s*const planOut = shortsPlanDryRunManifest\(/);
    assert.match(MAIN, /if \(planGated && !replaceRun\) \{\n\s*\/\/[^\n]*\n\s*const auth = await consumeShortsPlanAuthorization\(/);
    // A recusa de cada fase vira o exit code da rodada, sem seguir adiante.
    for (const v of ["lock", "selection", "phase", "auth"]) assert.match(MAIN, new RegExp(`if \\(typeof ${v} === "number"\\) return ${v};`));
  });
});

describe("#14327 takeShortsReplaceLock", () => {
  it("troca toma o lock; outra troca ou outro --publish com ele vivo recusa (exit 2); solto, segue livre", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-take-lock-14327-"));
    const err = console.error;
    console.error = () => {};
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      assert.deepEqual(takeShortsReplaceLock(dir, false), { release: null }, "sem lock: o --publish normal segue");
      const held = takeShortsReplaceLock(dir, true);
      assert.ok(typeof held === "object" && typeof held.release === "function", "a troca toma o lock");
      assert.equal(takeShortsReplaceLock(dir, true), 2, "segunda troca com o lock vivo");
      assert.equal(takeShortsReplaceLock(dir, false), 2, "--publish normal com a troca em curso");
      if (typeof held === "object") held.release?.();
      assert.deepEqual(takeShortsReplaceLock(dir, false), { release: null }, "lock solto: livre de novo");
    } finally {
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14327 selectShortsReplacement", () => {
  const base = { aammdd: "261128", published: { aammdd: "261128", entries: [] }, onlyList: null, videoPath: "/x/v2.mp4" };
  const quiet = <T>(fn: () => T): T => {
    const [err, log] = [console.error, console.log];
    console.error = () => {};
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.error = err;
      console.log = log;
    }
  };

  it("sem o vídeo novo legível: exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-select-14327-"));
    try {
      assert.equal(quiet(() => selectShortsReplacement({ ...base, dir, file: null, videoHash: null, duration: null, publish: false })), 2);
      assert.equal(quiet(() => selectShortsReplacement({ ...base, dir, file: Buffer.from("x"), videoHash: "h", duration: null, publish: false })), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nada agendado a trocar: dry-run sai 0, --publish sai 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-select-14327-"));
    try {
      const ok = { ...base, dir, file: Buffer.from("x"), videoHash: "a".repeat(64), duration: 30 };
      assert.equal(quiet(() => selectShortsReplacement({ ...ok, publish: false })), 0);
      assert.equal(quiet(() => selectShortsReplacement({ ...ok, publish: true })), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
