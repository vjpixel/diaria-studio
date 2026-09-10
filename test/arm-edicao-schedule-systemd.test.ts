/**
 * test/arm-edicao-schedule-systemd.test.ts (#7036)
 *
 * Writer Linux da atestação cross-machine: o marcador só existe se o
 * `systemctl` de fato mudou o estado do timer, e sempre no arquivo PRÓPRIO
 * do systemd — nunca no do Windows (senão desarmar aqui apagaria o
 * `armed: true` de lá).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  armEdicaoScheduleSystemd,
  buildSystemctlArgs,
  parseArmAction,
  type ArmDeps,
} from "../scripts/overnight/arm-edicao-schedule-systemd.ts";
import {
  EDICAO_SCHEDULE_ATTESTATION_FILES,
  parseEdicaoScheduleAttestation,
} from "../scripts/lib/edicao-schedule-attestation.ts";
import { buildEdicaoArmInstructions } from "../scripts/overnight/setup-edicao-schedule-systemd.ts";

describe("buildEdicaoArmInstructions — o que o gerador manda o operador rodar", () => {
  it("arma via wrapper, nunca `systemctl enable` direto (senão o alarme não fica sabendo)", () => {
    const text = buildEdicaoArmInstructions("/repo/.systemd-units");
    assert.match(text, /arm-edicao-schedule-systemd\.ts --arm/);
    assert.doesNotMatch(text, /systemctl --user enable/);
  });
});

const NOW = new Date("2026-09-10T19:00:00Z");

function fakeDeps(overrides: Partial<ArmDeps> = {}) {
  const writes: Array<{ path: string; content: string }> = [];
  const calls: string[][] = [];
  const deps: ArmDeps = {
    runSystemctl: (args) => {
      calls.push(args);
      return { status: 0, stderr: "" };
    },
    dataDirExists: () => true,
    writeFile: (path, content) => writes.push({ path, content }),
    machine: "helios",
    now: NOW,
    ...overrides,
  };
  return { deps, writes, calls };
}

describe("parseArmAction", () => {
  it("--arm / --disarm", () => {
    assert.equal(parseArmAction(["--arm"]), "arm");
    assert.equal(parseArmAction(["--disarm"]), "disarm");
  });
  it("nenhum ou os dois → null", () => {
    assert.equal(parseArmAction([]), null);
    assert.equal(parseArmAction(["--arm", "--disarm"]), null);
  });
});

describe("buildSystemctlArgs", () => {
  it("enable/disable --now no timer da edição", () => {
    assert.deepEqual(buildSystemctlArgs("arm"), ["--user", "enable", "--now", "diaria-edicao-diaria.timer"]);
    assert.deepEqual(buildSystemctlArgs("disarm"), ["--user", "disable", "--now", "diaria-edicao-diaria.timer"]);
  });
});

describe("armEdicaoScheduleSystemd", () => {
  it("--arm com sucesso grava armed=true no arquivo do systemd", () => {
    const { deps, writes, calls } = fakeDeps();
    const r = armEdicaoScheduleSystemd("arm", "/data", deps);
    assert.equal(r.ok, true);
    assert.equal(r.attestationWritten, true);
    assert.equal(calls.length, 1);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].path.endsWith(EDICAO_SCHEDULE_ATTESTATION_FILES.systemd));
    const att = parseEdicaoScheduleAttestation(writes[0].content);
    assert.deepEqual(att, { machine: "helios", scheduler: "systemd", armed: true, updatedAt: NOW.toISOString() });
  });

  it("--disarm grava armed=false, e NUNCA no arquivo do Windows (regressão do clobber)", () => {
    const { deps, writes } = fakeDeps();
    armEdicaoScheduleSystemd("disarm", "/data", deps);
    assert.deepEqual(parseEdicaoScheduleAttestation(writes[0].content), {
      machine: "helios",
      scheduler: "systemd",
      armed: false,
      updatedAt: NOW.toISOString(),
    });
    assert.ok(!writes[0].path.endsWith(EDICAO_SCHEDULE_ATTESTATION_FILES["windows-task-scheduler"]));
  });

  it("systemctl falhou → ok=false e NENHUM marcador gravado", () => {
    const { deps, writes } = fakeDeps({ runSystemctl: () => ({ status: 1, stderr: "Unit not found" }) });
    const r = armEdicaoScheduleSystemd("arm", "/data", deps);
    assert.equal(r.ok, false);
    assert.equal(r.attestationWritten, false);
    assert.equal(writes.length, 0);
    assert.match(r.message, /Unit not found/);
  });

  it("systemctl ausente (status null) também não grava", () => {
    const { deps, writes } = fakeDeps({ runSystemctl: () => ({ status: null, stderr: "spawn systemctl ENOENT" }) });
    assert.equal(armEdicaoScheduleSystemd("arm", "/data", deps).ok, false);
    assert.equal(writes.length, 0);
  });

  it("data/ ausente → timer mudou (ok=true), marcador não gravado, com aviso", () => {
    const { deps, writes } = fakeDeps({ dataDirExists: () => false });
    const r = armEdicaoScheduleSystemd("arm", "/data", deps);
    assert.equal(r.ok, true);
    assert.equal(r.attestationWritten, false);
    assert.equal(writes.length, 0);
  });

  it("escrita do marcador lança → ok=true (best-effort), attestationWritten=false", () => {
    const { deps } = fakeDeps({
      writeFile: () => {
        throw new Error("EACCES");
      },
    });
    const r = armEdicaoScheduleSystemd("arm", "/data", deps);
    assert.equal(r.ok, true);
    assert.equal(r.attestationWritten, false);
    assert.match(r.message, /EACCES/);
  });
});
