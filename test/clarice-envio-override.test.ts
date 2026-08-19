/**
 * test/clarice-envio-override.test.ts (#5515)
 *
 * Cobre `scripts/lib/clarice-envio-override.ts` — o mecanismo de override
 * persistente pro freio de envio Clarice. Os 4 casos exigidos pela issue:
 *   1. override expirado é ignorado (silenciosamente).
 *   2. override cobre stop→hold, mas NUNCA destrava ok.
 *   3. ambas as metades (risk + guard) o respeitam igual — coberto aqui via
 *      `applyEnvioOverride` (função pura compartilhada pelas duas) e em
 *      integração em `test/clarice-envio-risk.test.ts` /
 *      `test/clarice-envio-guard.test.ts`.
 *   4. ausência de arquivo é idêntica ao comportamento de hoje (regressão
 *      zero pro caso comum).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readClariceEnvioOverrideState,
  setClariceEnvioOverride,
  clearClariceEnvioOverride,
  applyEnvioOverride,
  runCli,
  type ClariceEnvioOverrideState,
  type CliIO,
} from "../scripts/lib/clarice-envio-override.ts";
import type { BrakeDecision } from "../scripts/lib/clarice-envio-policy.ts";
import type { GhRunFn } from "../scripts/lib/wait-until-sync.ts";

const NOW = new Date("2026-08-17T02:00:00.000Z");

function rootWithFile(label: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), `clarice-envio-override-${label}-`));
  mkdirSync(resolve(dir, "data"), { recursive: true });
  writeFileSync(resolve(dir, "data", "clarice-envio-override.json"), contents, "utf8");
  return dir;
}

function freshRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `clarice-envio-override-${label}-`));
}

function collector(): { warnings: string[]; onInvalid: (m: string) => void } {
  const warnings: string[] = [];
  return { warnings, onInvalid: (m: string) => warnings.push(m) };
}

function stopBrake(reasons: string[] = ["hard bounce: 3,00% estourou o limiar de 2,00% (150% do limiar)."]): BrakeDecision {
  return { level: "stop", reasons, maxUtil: 1.5 };
}

function holdBrake(): BrakeDecision {
  return { level: "hold", reasons: ["hard bounce: 1,50% está em 2,00% (75% do limiar)."], maxUtil: 0.75 };
}

function okBrake(): BrakeDecision {
  return { level: "ok", reasons: ["risco de ISP dentro dos limiares."], maxUtil: 0.1 };
}

describe("readClariceEnvioOverrideState — ausência de arquivo (regressão zero pro caso comum)", () => {
  let root: string;
  before(() => {
    root = freshRoot("absent");
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/clarice-envio-override.json -> null, sem aviso", () => {
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.deepEqual(c.warnings, []);
  });
});

describe("readClariceEnvioOverrideState — expiração é silenciosa (comportamento CORRETO, não erro)", () => {
  it("until no passado -> null, ZERO avisos", () => {
    const root = rootWithFile(
      "expired",
      JSON.stringify({
        brake: "hold",
        until: "2026-08-16T00:00:00.000Z", // antes de NOW
        reason: "pico de campanha antiga",
        decidedBy: "editor",
        issueRef: 5487,
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
    );
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.deepEqual(c.warnings, [], "expiração nunca gera warning — silêncio é o comportamento correto");
    rmSync(root, { recursive: true, force: true });
  });

  it("until no futuro -> override ativo, retornado por completo", () => {
    const root = rootWithFile(
      "active",
      JSON.stringify({
        brake: "hold",
        until: "2026-08-18T09:00:00.000Z", // depois de NOW
        reason: "pico de campanha de 27/06 (#5487) confirmado falso-positivo",
        decidedBy: "editor",
        issueRef: 5487,
        createdAt: "2026-08-17T02:05:00.000Z",
      }),
    );
    const state = readClariceEnvioOverrideState(root, NOW);
    assert.ok(state);
    assert.equal(state!.brake, "hold");
    assert.equal(state!.issueRef, 5487);
    assert.equal(state!.reason, "pico de campanha de 27/06 (#5487) confirmado falso-positivo");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("readClariceEnvioOverrideState — validação defensiva (nunca destrava ok)", () => {
  it("brake: \"ok\" no arquivo -> null + aviso (restrição deliberada #5515)", () => {
    const root = rootWithFile(
      "brake-ok",
      JSON.stringify({
        brake: "ok",
        until: "2026-08-18T09:00:00.000Z",
        reason: "tentativa de escalar sobre risco não confirmado",
        decidedBy: "editor",
        issueRef: 1,
        createdAt: NOW.toISOString(),
      }),
    );
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /só "hold" é aceito/);
    rmSync(root, { recursive: true, force: true });
  });

  it("brake: \"stop\" no arquivo -> null + aviso", () => {
    const root = rootWithFile(
      "brake-stop",
      JSON.stringify({ brake: "stop", until: "2026-08-18T09:00:00.000Z", reason: "x", decidedBy: "editor", issueRef: 1, createdAt: NOW.toISOString() }),
    );
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("until ausente -> null + aviso (campo obrigatório)", () => {
    const root = rootWithFile("no-until", JSON.stringify({ brake: "hold", reason: "x", decidedBy: "editor", issueRef: 1, createdAt: NOW.toISOString() }));
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /obrigat[oó]rio/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("until não-parseável -> null + aviso", () => {
    const root = rootWithFile(
      "bad-until",
      JSON.stringify({ brake: "hold", until: "não é uma data", reason: "x", decidedBy: "editor", issueRef: 1, createdAt: NOW.toISOString() }),
    );
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("reason ausente -> null + aviso", () => {
    const root = rootWithFile("no-reason", JSON.stringify({ brake: "hold", until: "2026-08-18T09:00:00.000Z", decidedBy: "editor", issueRef: 1, createdAt: NOW.toISOString() }));
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("issueRef ausente -> null + aviso", () => {
    const root = rootWithFile("no-issue", JSON.stringify({ brake: "hold", until: "2026-08-18T09:00:00.000Z", reason: "x", decidedBy: "editor", createdAt: NOW.toISOString() }));
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("JSON quebrado -> null + aviso", () => {
    const root = rootWithFile("broken-json", "{ not json");
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });

  it("array em vez de objeto -> null + aviso", () => {
    const root = rootWithFile("array", "[1,2,3]");
    const c = collector();
    const state = readClariceEnvioOverrideState(root, NOW, { onInvalid: c.onInvalid });
    assert.equal(state, null);
    assert.equal(c.warnings.length, 1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("setClariceEnvioOverride / clearClariceEnvioOverride — CLI subjacente", () => {
  it("escreve o arquivo com brake:hold fixo, mesmo se alguém tentasse passar outro valor via cast", () => {
    const root = freshRoot("set");
    const state = setClariceEnvioOverride(root, {
      until: "2026-08-19T00:00:00.000Z",
      reason: "teste",
      decidedBy: "editor",
      issueRef: 42,
      createdAt: NOW.toISOString(),
    });
    assert.equal(state.brake, "hold");
    const onDisk = JSON.parse(readFileSync(resolve(root, "data", "clarice-envio-override.json"), "utf8"));
    assert.equal(onDisk.brake, "hold");
    assert.equal(onDisk.issueRef, 42);

    // Round-trip: lido de volta com sucesso e ativo.
    const read = readClariceEnvioOverrideState(root, NOW);
    assert.ok(read);
    assert.equal(read!.issueRef, 42);

    rmSync(root, { recursive: true, force: true });
  });

  it("--until inválido lança na escrita (nunca grava um arquivo quebrado)", () => {
    const root = freshRoot("set-bad-until");
    assert.throws(() =>
      setClariceEnvioOverride(root, {
        until: "não é data",
        reason: "teste",
        decidedBy: "editor",
        issueRef: 1,
        createdAt: NOW.toISOString(),
      }),
    );
    assert.equal(existsSync(resolve(root, "data", "clarice-envio-override.json")), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("clearClariceEnvioOverride remove o arquivo; idempotente quando já ausente", () => {
    const root = freshRoot("clear");
    setClariceEnvioOverride(root, { until: "2026-08-19T00:00:00.000Z", reason: "x", decidedBy: "editor", issueRef: 1, createdAt: NOW.toISOString() });
    assert.equal(existsSync(resolve(root, "data", "clarice-envio-override.json")), true);
    clearClariceEnvioOverride(root);
    assert.equal(existsSync(resolve(root, "data", "clarice-envio-override.json")), false);
    // idempotente
    assert.doesNotThrow(() => clearClariceEnvioOverride(root));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("applyEnvioOverride — cobre stop→hold, nunca destrava ok, nunca esconde o STOP real", () => {
  const activeOverride: ClariceEnvioOverrideState = {
    brake: "hold",
    until: "2026-08-18T09:00:00.000Z",
    reason: "pico de campanha de 27/06 (#5487) confirmado falso-positivo",
    decidedBy: "editor",
    issueRef: 5487,
    createdAt: "2026-08-17T02:05:00.000Z",
  };

  it("sem override (null) -> brake IDÊNTICO, overrideApplied false", () => {
    const brake = stopBrake();
    const { brake: out, overrideApplied } = applyEnvioOverride(brake, null);
    assert.equal(out, brake, "mesmo objeto — nenhuma cópia desnecessária");
    assert.equal(overrideApplied, false);
  });

  it("override ativo + freio STOP -> rebaixa pra HOLD, overrideApplied true, reasons mostra o STOP real + o motivo do override", () => {
    const brake = stopBrake(["hard bounce: 3,00% estourou o limiar de 2,00% (150% do limiar)."]);
    const { brake: out, overrideApplied } = applyEnvioOverride(brake, activeOverride);
    assert.equal(out.level, "hold");
    assert.equal(overrideApplied, true);
    assert.equal(out.maxUtil, brake.maxUtil, "maxUtil real preservado — override não maquia o número");
    assert.ok(out.reasons.length >= 2, "razão de override + razão(ões) originais do STOP");
    assert.match(out.reasons[0], /OVERRIDE do editor/);
    assert.match(out.reasons[0], /seria STOP, rebaixado para HOLD/);
    assert.match(out.reasons[0], /5487/, "cita a issue");
    assert.match(out.reasons[0], /pico de campanha de 27\/06/, "cita o motivo");
    assert.ok(
      out.reasons.slice(1).includes("hard bounce: 3,00% estourou o limiar de 2,00% (150% do limiar)."),
      "razão original do STOP real segue presente, não escondida",
    );
  });

  it("override ativo + freio já HOLD -> NUNCA muda (não é stop, override não se aplica), overrideApplied false", () => {
    const brake = holdBrake();
    const { brake: out, overrideApplied } = applyEnvioOverride(brake, activeOverride);
    assert.equal(out, brake);
    assert.equal(overrideApplied, false);
  });

  it("override ativo + freio já OK -> NUNCA destrava/muda nada (override só rebaixa stop, nunca mexe em ok)", () => {
    const brake = okBrake();
    const { brake: out, overrideApplied } = applyEnvioOverride(brake, activeOverride);
    assert.equal(out, brake);
    assert.equal(overrideApplied, false);
  });

  it("idempotente: aplicar 2x sobre o resultado já rebaixado não duplica a razão de override", () => {
    const brake = stopBrake();
    const once = applyEnvioOverride(brake, activeOverride);
    const twice = applyEnvioOverride(once.brake, activeOverride);
    assert.equal(twice.overrideApplied, false, "2ª aplicação é no-op — o freio recebido já não é mais stop");
    assert.equal(twice.brake, once.brake);
    assert.equal(once.brake.reasons.filter((r) => r.includes("OVERRIDE do editor")).length, 1);
  });
});

describe("runCli — wiring do --set/--clear com a sincronização do marcador (#5729, achado de mutação do self-review)", () => {
  function freshCliRoot(label: string): string {
    return mkdtempSync(join(tmpdir(), `clarice-envio-override-cli-${label}-`));
  }

  /** Stub de `GhRunFn` no mesmo formato de `test/wait-until-sync.test.ts` —
   * serve `gh issue view`/`gh issue edit` a partir de um corpo em memória,
   * reproduzindo o `\n` extra que o `gh` real sempre anexa em `-q .body`. */
  function fakeGh(initialBody: string): { run: GhRunFn; editedBodies: string[] } {
    let body = initialBody;
    const editedBodies: string[] = [];
    const run: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { status: 0, stdout: `${body}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const idx = args.indexOf("--body");
        body = args[idx + 1];
        editedBodies.push(body);
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    return { run, editedBodies };
  }

  function collectingIo(): { io: CliIO; logs: string[]; warnings: string[] } {
    const logs: string[] = [];
    const warnings: string[] = [];
    return { io: { log: (m) => logs.push(m), warn: (m) => warnings.push(m) }, logs, warnings };
  }

  it("--set ESCREVE o marcador na issue (prova de mutação: reverta a chamada de sync e este teste falha)", () => {
    const root = freshCliRoot("set-writes-marker");
    const { run, editedBodies } = fakeGh("Contexto original da issue.");
    const { io } = collectingIo();

    const exitCode = runCli(
      ["--set", "--until", "2026-08-21T09:00:00.000Z", "--reason", "teste", "--issue", "5673"],
      root,
      run,
      io,
    );

    assert.equal(exitCode, 0);
    assert.equal(editedBodies.length, 1, "runCli --set deveria ter chamado gh issue edit exatamente 1x");
    assert.match(editedBodies[0], /^<!-- aguardando-ate: 2026-08-22 -->/);
    // e o override local também foi gravado (função primária do comando).
    const onDisk = JSON.parse(readFileSync(resolve(root, "data", "clarice-envio-override.json"), "utf8"));
    assert.equal(onDisk.issueRef, 5673);
    rmSync(root, { recursive: true, force: true });
  });

  it("--clear REMOVE o marcador da issue que o override referenciava (prova de mutação equivalente)", () => {
    const root = freshCliRoot("clear-removes-marker");
    setClariceEnvioOverride(root, {
      until: "2026-08-21T09:00:00.000Z",
      reason: "teste",
      decidedBy: "teste",
      issueRef: 5673,
      createdAt: "2026-08-19T01:03:00.000Z",
    });
    const { run, editedBodies } = fakeGh("<!-- aguardando-ate: 2026-08-22 -->\n\nContexto original.");
    const { io } = collectingIo();

    const exitCode = runCli(["--clear"], root, run, io);

    assert.equal(exitCode, 0);
    assert.equal(editedBodies.length, 1, "runCli --clear deveria ter chamado gh issue edit exatamente 1x");
    assert.equal(editedBodies[0], "Contexto original.");
    assert.equal(existsSync(resolve(root, "data", "clarice-envio-override.json")), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("--set com falha de gh: override local gravado, exit code 2, warning inequívoco", () => {
    const root = freshCliRoot("set-gh-fails");
    const failingRun: GhRunFn = () => ({ status: 1, stdout: "", stderr: "gh: not authenticated" });
    const { io, warnings } = collectingIo();

    const exitCode = runCli(
      ["--set", "--until", "2026-08-21T09:00:00.000Z", "--reason", "teste", "--issue", "5673"],
      root,
      failingRun,
      io,
    );

    assert.equal(exitCode, 2);
    assert.ok(warnings.some((w) => w.includes("marcador NÃO sincronizado")));
    // override local sobrevive à falha de rede — função primária do comando.
    const onDisk = JSON.parse(readFileSync(resolve(root, "data", "clarice-envio-override.json"), "utf8"));
    assert.equal(onDisk.issueRef, 5673);
    rmSync(root, { recursive: true, force: true });
  });

  it("--clear com JSON local corrompido: 'cleared' NUNCA aparece sozinho — vem com warning inequívoco + exit code 2", () => {
    const root = freshCliRoot("clear-corrupted");
    mkdirSync(resolve(root, "data"), { recursive: true });
    writeFileSync(resolve(root, "data", "clarice-envio-override.json"), "{ isto não é json válido", "utf8");
    const { run, editedBodies } = fakeGh("Corpo qualquer.");
    const { io, logs, warnings } = collectingIo();

    const exitCode = runCli(["--clear"], root, run, io);

    assert.equal(exitCode, 2);
    assert.ok(logs.includes("cleared"), "o arquivo local foi de fato removido — 'cleared' continua verdade");
    assert.ok(
      warnings.some((w) => w.includes("NÃO FOI POSSÍVEL determinar a issue")),
      "precisa qualificar o 'cleared' com um aviso inequívoco quando o issueRef não pôde ser determinado",
    );
    // sem issueRef determinável, nenhuma tentativa de gh issue edit acontece.
    assert.equal(editedBodies.length, 0);
    assert.equal(existsSync(resolve(root, "data", "clarice-envio-override.json")), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("--clear em arquivo AUSENTE continua silencioso (regressão zero pro caso comum, sem warning espúrio)", () => {
    const root = freshCliRoot("clear-absent");
    const { run, editedBodies } = fakeGh("Corpo qualquer.");
    const { io, logs, warnings } = collectingIo();

    const exitCode = runCli(["--clear"], root, run, io);

    assert.equal(exitCode, 0);
    assert.deepEqual(logs, ["cleared"]);
    assert.deepEqual(warnings, []);
    assert.equal(editedBodies.length, 0);
    rmSync(root, { recursive: true, force: true });
  });
});
