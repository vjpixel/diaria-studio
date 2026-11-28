/**
 * #14327 item 5: as fases de `mainUnlocked` que não são destino saíram de
 * `scripts/publish-shorts/run.ts` para `run-replace.ts` (lock da troca, escolha
 * dos alvos, fase destrutiva) e `run-authorize.ts` (manifesto do dry-run,
 * consumo da autorização do plano, KV do /video) e, depois, para `run-args.ts`
 * (argumentos e alvo), `run-drive.ts` (`--from-drive`), `run-plan.ts` (o
 * plano) e `run-corte.ts` (autorização e lock do corte). Este arquivo trava a ordem
 * em que o `mainUnlocked` as chama (a mesma do código inline de antes) e o
 * comportamento das duas fases puras de saída antecipada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectShortsReplacement, takeShortsReplaceLock } from "../scripts/publish-shorts/run-replace.ts";
import { resolveShortsRunTarget } from "../scripts/publish-shorts/run-args.ts";
import { fetchShortsVideoFromDrive } from "../scripts/publish-shorts/run-drive.ts";
import { takeCorteManualLock } from "../scripts/publish-shorts/run-corte.ts";
import { canonicalShortsEditionDir } from "../scripts/publish-shorts/_shared.ts";

const RUN = readFileSync(join(import.meta.dirname, "..", "scripts", "publish-shorts", "run.ts"), "utf8");
const MAIN = RUN.slice(RUN.indexOf("async function mainUnlocked(): Promise<number>"));

describe("#14327 mainUnlocked chama as fases extraídas na ordem do código inline", () => {
  it("argumentos → lock → Drive → seleção da troca → plano → fase da troca → dry-run → consumo → KV → autorização do corte → lock do corte → envio", () => {
    const order = [
      "await resolveShortsRunTarget(process.argv.slice(2))",
      "takeShortsReplaceLock(dir, replaceRun)",
      "await fetchShortsVideoFromDrive({",
      "selectShortsReplacement({",
      "await buildShortsRunPlan({",
      "await runShortsReplacePhase({",
      "shortsPlanDryRunManifest({",
      "await consumeShortsPlanAuthorization({",
      "await updateShortVideoRedirects(dir, aammdd)",
      "authorizeCortePublish({",
      "takeCorteManualLock(plan.items, dir, corte, requireCorteAuth)",
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
    assert.match(MAIN, /if \(values\["from-drive"\]\) \{\n\s*\/\/[^\n]*\n\s*const drive = await fetchShortsVideoFromDrive\(/);
    assert.match(MAIN, /if \(corte\) \{\n\s*\/\/[^\n]*\n\s*const refused = authorizeCortePublish\(/);
    // A recusa de cada fase vira o exit code da rodada, sem seguir adiante.
    for (const v of ["target", "lock", "drive", "selection", "planned", "phase", "auth"]) assert.match(MAIN, new RegExp(`if \\(typeof ${v} === "number"\\) return ${v};`));
    assert.match(MAIN, /if \(refused !== null\) return refused;/);
  });

  it("o texto das fases extraídas não ficou duplicado no mainUnlocked", () => {
    for (const gone of ["parseShortsCliArgs(", "publishConfirmationError(", "downloadDriveFileById(", "planShortsPublish(", "recordCortePublishAuthorization(", "acquireTimerLock("]) {
      assert.equal(MAIN.indexOf(gone), -1, `${gone} saiu do mainUnlocked`);
    }
  });
});

describe("#14327 resolveShortsRunTarget", () => {
  const quietErr = async <T>(fn: () => Promise<T>): Promise<T> => {
    const err = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = err;
    }
  };

  it("erro de uso sai 2 antes de ler ou gravar qualquer coisa", async () => {
    assert.equal(await quietErr(() => resolveShortsRunTarget(["261128", "publicar"])), 2, "posicional desconhecido");
    assert.equal(await quietErr(() => resolveShortsRunTarget(["261128", "--linkedin-timer", "--instagram-timer"])), 2, "dois timers");
    assert.equal(await quietErr(() => resolveShortsRunTarget(["261128", "--threads-timer", "--linkedin-timer"])), 2, "threads com outro timer");
    assert.equal(await quietErr(() => resolveShortsRunTarget(["261128", "--publish"])), 2, "--publish sem a confirmação da edição");
  });

  it("modo edição: pasta canônica, escritor do registro pelo timer, sem corte", async () => {
    const main = await resolveShortsRunTarget(["261128"]);
    assert.ok(typeof main === "object");
    assert.equal(main.aammdd, "261128");
    assert.equal(main.corte, null);
    assert.equal(main.writer, "main");
    assert.equal(main.dir, canonicalShortsEditionDir("261128"));
    assert.equal(main.editionDirOverride, undefined);
    assert.equal(main.replaceRun, false);
    const timer = await resolveShortsRunTarget(["261128", "--threads-timer"]);
    assert.ok(typeof timer === "object");
    assert.equal(timer.writer, "threads-timer");
  });
});

describe("#14327 fetchShortsVideoFromDrive", () => {
  it("id do Drive inválido: exit 2, sem baixar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-drive-14327-"));
    const err = console.error;
    console.error = () => {};
    try {
      const r = await fetchShortsVideoFromDrive({
        driveId: "curto", dir, aammdd: "261128", videoPath: join(dir, "nao-existe.mp4"), replaceRun: false,
        corte: null, requireCorteAuth: false, cleanup: () => assert.fail("nada a limpar"), onRevoked: () => assert.fail("sem corte"),
      });
      assert.equal(r, 2);
    } finally {
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#14327 takeCorteManualLock", () => {
  it("fora do corte não toma lock nenhum", () => {
    const lock = takeCorteManualLock([], "/nao-usado", null, false);
    assert.deepEqual([lock.dests, lock.busy], [[], null]);
    lock.release();
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
