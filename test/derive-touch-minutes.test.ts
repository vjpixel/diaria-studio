import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { deriveTouchSamples, existingEditions } from "../scripts/derive-touch-minutes.ts";

const ev = (edition: string, ts: string, message: string) => ({
  timestamp: ts,
  edition,
  stage: 4,
  agent: "orchestrator",
  message,
});
const P = "gate revisao: apresentado";

describe("deriveTouchSamples (#7982)", () => {
  it("apresentado -> ajustar -> apresentado -> sim", () => {
    const s = deriveTouchSamples([
      ev("260901", "2026-09-01T10:00:00Z", P),
      ev("260901", "2026-09-01T10:10:00Z", "gate revisao response: ajustar"),
      ev("260901", "2026-09-01T10:12:00Z", P),
      ev("260901", "2026-09-01T10:15:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s, [{ edition: "260901", editMinutes: 12, signoffMinutes: 3 }]);
  });

  it("sem ajuste: tudo sign-off", () => {
    const s = deriveTouchSamples([
      ev("260902", "2026-09-02T10:00:00Z", P),
      ev("260902", "2026-09-02T10:05:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s, [{ edition: "260902", editMinutes: 0, signoffMinutes: 5 }]);
  });

  it("editar offline -> sim sem re-apresentação: tudo edição", () => {
    const s = deriveTouchSamples([
      ev("260903", "2026-09-03T10:00:00Z", P),
      ev("260903", "2026-09-03T10:02:00Z", "gate revisao response: editar"),
      ev("260903", "2026-09-03T10:20:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s, [{ edition: "260903", editMinutes: 20, signoffMinutes: 0 }]);
  });

  it("ignora edição sem sim ou sem apresentação; recomeça após abortar", () => {
    assert.deepEqual(deriveTouchSamples([ev("1", "2026-09-01T10:00:00Z", P)]), []);
    assert.deepEqual(deriveTouchSamples([ev("2", "2026-09-01T10:00:00Z", "gate revisao response: sim")]), []);
    const s = deriveTouchSamples([
      ev("3", "2026-09-01T08:00:00Z", P),
      ev("3", "2026-09-01T08:30:00Z", "gate revisao response: abortar"),
      ev("3", "2026-09-01T10:00:00Z", P),
      ev("3", "2026-09-01T10:04:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s, [{ edition: "3", editMinutes: 0, signoffMinutes: 4 }]);
  });

  it("existingEditions tolera linha inválida", () => {
    assert.deepEqual([...existingEditions('{"edition":"a"}\nlixo\n{"edition":"b"}')], ["a", "b"]);
  });
});

describe("deriveTouchSamples — bordas (#7982 review)", () => {
  it("painel Studio não conta como sim", () => {
    const s = deriveTouchSamples([
      ev("1", "2026-09-01T10:00:00Z", P),
      ev("1", "2026-09-01T10:05:00Z", "gate revisao response: sim (via painel Studio, decided_at=x)"),
    ]);
    assert.deepEqual(s, []);
  });
  it("fora de ordem, timestamp inválido e stage != 4", () => {
    const s = deriveTouchSamples([
      ev("1", "2026-09-01T10:05:00Z", "gate revisao response: sim"),
      ev("1", "lixo", P),
      { ...ev("1", "2026-09-01T09:00:00Z", P), stage: 5 },
      ev("1", "2026-09-01T10:00:00Z", P),
    ]);
    assert.deepEqual(s, [{ edition: "1", editMinutes: 0, signoffMinutes: 5 }]);
  });
  it("várias edições, ordenadas", () => {
    const s = deriveTouchSamples([
      ev("b", "2026-09-01T10:00:00Z", P),
      ev("b", "2026-09-01T10:01:00Z", "gate revisao response: sim"),
      ev("a", "2026-09-01T10:00:00Z", P),
      ev("a", "2026-09-01T10:02:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s.map((x) => x.edition), ["a", "b"]);
  });
  it("vários sim: vale o último", () => {
    const s = deriveTouchSamples([
      ev("1", "2026-09-01T10:00:00Z", P),
      ev("1", "2026-09-01T10:02:00Z", "gate revisao response: sim"),
      ev("1", "2026-09-01T10:03:00Z", P),
      ev("1", "2026-09-01T10:10:00Z", "gate revisao response: sim"),
    ]);
    assert.deepEqual(s, [{ edition: "1", editMinutes: 3, signoffMinutes: 7 }]);
  });
  it("abortar depois do sim descarta", () => {
    const s = deriveTouchSamples([
      ev("1", "2026-09-01T10:00:00Z", P),
      ev("1", "2026-09-01T10:02:00Z", "gate revisao response: sim"),
      ev("1", "2026-09-01T10:03:00Z", "gate revisao response: abortar"),
    ]);
    assert.deepEqual(s, []);
  });
  it("cap por intervalo (--max-gap-min)", () => {
    const evs = [
      ev("1", "2026-09-01T10:00:00Z", P),
      ev("1", "2026-09-01T18:00:00Z", "gate revisao response: sim"),
    ];
    assert.deepEqual(deriveTouchSamples(evs), [{ edition: "1", editMinutes: 0, signoffMinutes: 120 }]);
    assert.deepEqual(deriveTouchSamples(evs, 30), [{ edition: "1", editMinutes: 0, signoffMinutes: 30 }]);
  });
});

describe("CLI derive-touch-minutes", () => {
  it("dry-run não grava; --write grava sem duplicar", () => {
    const root = mkdtempSync(join(tmpdir(), "touch-"));
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeFileSync(
        join(root, "data/run-log.jsonl"),
        [
          JSON.stringify(ev("260904", "2026-09-04T10:00:00Z", P)),
          JSON.stringify(ev("260904", "2026-09-04T10:06:00Z", "gate revisao response: sim")),
        ].join("\n") + "\n",
      );
      const script = resolve("scripts/derive-touch-minutes.ts");
      const run = (...a: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", script, "--root-dir", root, ...a], { encoding: "utf8" });
      const out = join(root, "data/calibration/touch-minutes.jsonl");
      const dry = run();
      assert.equal(dry.status, 0, dry.stderr);
      assert.equal(existsSync(out), false);
      assert.equal(run("--edition", "999999", "--write").status, 0);
      assert.equal(existsSync(out), false);
      assert.equal(run("--max-gap-min", "0").status, 2);
      assert.equal(run("--write").status, 0);
      assert.equal(run("--write").status, 0);
      const lines = readFileSync(out, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]), { edition: "260904", editMinutes: 0, signoffMinutes: 6 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
