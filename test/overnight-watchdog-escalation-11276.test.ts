/**
 * test/overnight-watchdog-escalation-11276.test.ts (#11276)
 *
 * Rodada 261027b: 9 `stall_events` em ~4,5h, todos com `resumed_at: null`, e
 * nada chegou ao editor — o alerta de stall é `acao`, e sob
 * `email_policy: "urgent_only"` `acao` vira só issue reusada, sem e-mail.
 * A escalada "stall sem retomada" é `urgente`, com fingerprint próprio, 1 por
 * rodada. Nenhum teste toca rede: `gh` e envio são injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import {
  UNRESUMED_STALL_ESCALATION_COUNT,
  countTrailingUnresumedStalls,
  sendStallAlert,
  sendUnresumedStallEscalation,
  shouldEscalateUnresumedStalls,
  type StallEvent,
} from "../scripts/overnight-watchdog.ts";

const ev = (at: string, resumed_at: string | null = null): StallEvent => ({ at, reason: "unknown", resumed_at });

/** Os 9 stalls da rodada 261027b (08:10 a 12:40 UTC), todos sem retomada. */
const INCIDENT_261027B: StallEvent[] = Array.from({ length: 9 }, (_, i) => {
  const min = 8 * 60 + 10 + i * 34;
  return ev(`2026-10-27T${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}:00.000Z`);
});

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-escalation-11276-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePolicy(dir: string, policy: "legacy" | "urgent_only"): string {
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify({ notifications: { email_policy: policy } }), "utf8");
  return path;
}

function ghRunCreating(issueNumber: number, created: string[][] = []): (args: string[], cwd: string) => GhSpawnResult {
  return (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      created.push(args);
      return { status: 0, stdout: `https://github.com/vjpixel/diaria-studio/issues/${issueNumber}\n`, stderr: "" };
    }
    throw new Error(`chamada gh inesperada no teste: ${args.join(" ")}`);
  };
}

describe("#11276 — contagem de stalls sem retomada", () => {
  it("conta só a sequência final sem resumed_at", () => {
    assert.equal(countTrailingUnresumedStalls(undefined), 0);
    assert.equal(countTrailingUnresumedStalls([]), 0);
    assert.equal(countTrailingUnresumedStalls(INCIDENT_261027B), 9);
    assert.equal(
      countTrailingUnresumedStalls([ev("a"), ev("b"), ev("c", "2026-10-27T09:00:00Z"), ev("d"), ev("e")]),
      2,
      "stall retomado zera a sequência",
    );
  });

  it("escala no incidente 261027b, uma vez só por rodada", () => {
    assert.equal(shouldEscalateUnresumedStalls(INCIDENT_261027B, false), true);
    assert.equal(shouldEscalateUnresumedStalls(INCIDENT_261027B, true), false, "já escalado nesta rodada");
  });

  it("não escala abaixo do limiar, nem quando a sessão retomou no meio", () => {
    const below = INCIDENT_261027B.slice(0, UNRESUMED_STALL_ESCALATION_COUNT - 1);
    assert.equal(shouldEscalateUnresumedStalls(below, false), false);
    const resumed = [...INCIDENT_261027B.slice(0, 5).map((e) => ({ ...e, resumed_at: "2026-10-27T11:00:00Z" })), ev("x")];
    assert.equal(shouldEscalateUnresumedStalls(resumed, false), false);
  });
});

describe("#11276 — escalada chega ao editor mesmo sob urgent_only", () => {
  it("o alerta normal (acao) não e-mailia sob urgent_only; a escalada (urgente, issue nova) e-mailia", async () => {
    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      const sendPush = async (msg: { subject: string }) => {
        sent.push(msg.subject);
        return { ok: true as const };
      };
      await sendStallAlert(dir, "overnight", "261027b", "stall", "corpo", false, {
        platformConfigPath: writePolicy(dir, "urgent_only"),
        ghRun: ghRunCreating(9001),
        sendPush,
        log: () => {},
      });
      assert.deepEqual(sent, [], "pré-condição: o alerta acao é mudo por e-mail sob urgent_only");

      const created: string[][] = [];
      const reached = await sendUnresumedStallEscalation(dir, "overnight", "261027b", 9, 270, {
        platformConfigPath: writePolicy(dir, "urgent_only"),
        ghRun: ghRunCreating(9002, created),
        sendPush,
        log: () => {},
      });
      assert.equal(reached, true);
      assert.equal(sent.length, 1, "escalada sai por e-mail");
      assert.match(sent[0], /sem retomar — rodada 261027b/);
      assert.ok(created[0].join(" ").includes("overnight:261027b:sem-retomada"), "fingerprint próprio, separado do alerta normal");
    });
  });

  it("falha de envio reporta não-entrega (o caller não grava stall_escalated) e nunca lança", async () => {
    await withTmpDir(async (dir) => {
      const reached = await sendUnresumedStallEscalation(dir, "overnight", "261027b", 3, 90, {
        platformConfigPath: writePolicy(dir, "urgent_only"),
        ghRun: ghRunCreating(9003),
        sendPush: async () => ({ ok: false, error: "rede fora" }),
        log: () => {},
      });
      assert.equal(reached, false);
    });
  });
});
