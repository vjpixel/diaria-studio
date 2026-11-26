/**
 * #13330 — edição 261117: o Stage 2 seguiu sem a Clarice e o único `resume` do
 * Stage 4 falhou ("não respondeu em 60s", payload 3,8 KB); a edição foi ao gate
 * sem a revisão. O resume agora faz rodadas espaçadas quando a falha é de API
 * (exit 3/6), com o teto total do filho cortado para caber em 9 min, e o
 * marcador diz que houve retry. Nada aqui chama a Clarice real: o runner é fake,
 * `sleep` e `clock` são injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  skipClarice,
  readClaricePending,
  resumeClariceSpaced,
  spacedFailureMessage,
  RESUME_SPACED_BUDGET_MS,
  RESUME_SPACING_MS,
  RESUME_FIRST_ROUND_DEADLINE_MS,
} from "../scripts/lib/diaria/clarice-pending.ts";

function makePendingEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarice-spaced-13330-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "texto humanizado\n");
  skipClarice(dir, "clarice_unavailable", { edition: "261117" });
  return dir;
}

const TIMEOUT_STDOUT =
  'log\n{"failure":{"kind":"timeout","message":"a Clarice não respondeu em 60s (timeout do cliente, payload 3856 bytes)"}}\n';

/** Runner que falha `failures` vezes com exit 3 (timeout) e depois aplica. Avança o relógio fake. */
function flakyRunner(failures: number, clockRef: { t: number }, elapsedPerCall = 195_000) {
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    clockRef.t += elapsedPerCall;
    if (calls.length <= failures) return { exitCode: 3, stdout: TIMEOUT_STDOUT };
    writeFileSync(args[args.indexOf("--corrected-out") + 1], "texto corrigido\n");
    writeFileSync(args[args.indexOf("--out") + 1], "[]");
    const input = readFileSync(args[args.indexOf("--in") + 1], "utf8");
    writeFileSync(
      args[args.indexOf("--chunks-out") + 1],
      JSON.stringify([{ startOffset: 0, length: input.length, suggestions: [] }]),
    );
    return {
      exitCode: 0,
      stdout: JSON.stringify({ suggestions_count: 0, chunks: 1, chunks_used_paragraph_fallback: 0, paragraphs_failed: 0 }) + "\n",
    };
  };
  return { runner, calls };
}

function deadlineOf(args: string[]): number | undefined {
  const i = args.indexOf("--deadline-ms");
  return i >= 0 ? Number(args[i + 1]) : undefined;
}

describe("#13330 — resume da Clarice em rodadas espaçadas", () => {
  it("cenário da 261117: timeout na 1ª rodada, API volta na 2ª → Clarice aplicada e marcador removido", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      const clock = { t: 0 };
      const sleeps: number[] = [];
      const { runner, calls } = flakyRunner(1, clock);
      const { outcome, rounds } = resumeClariceSpaced(dir, runner, {
        edition: "261117",
        clock: () => clock.t,
        sleep: (ms) => { sleeps.push(ms); clock.t += ms; },
      });
      assert.equal(outcome.status, "resumed");
      assert.equal(calls.length, 2);
      assert.deepEqual(sleeps, [RESUME_SPACING_MS], "espera o intervalo antes da 2ª rodada");
      assert.equal(rounds.length, 2);
      assert.equal(rounds[0].exitCode, 3);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto corrigido\n");
      assert.equal(readClaricePending(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("2ª rodada ignora o cooldown da 1ª e o teto do filho cabe no orçamento de 9 min", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      const clock = { t: 0 };
      const { runner, calls } = flakyRunner(5, clock);
      const { outcome, rounds } = resumeClariceSpaced(dir, runner, {
        clock: () => clock.t,
        sleep: (ms) => { clock.t += ms; },
      });
      assert.equal(outcome.status, "failed", "não virou recently-attempted na 2ª rodada");
      assert.equal(calls.length, 2, "default de 2 rodadas");
      assert.equal(deadlineOf(calls[0]), RESUME_FIRST_ROUND_DEADLINE_MS);
      const d2 = deadlineOf(calls[1])!;
      assert.equal(d2, RESUME_SPACED_BUDGET_MS - 195_000 - RESUME_SPACING_MS);
      assert.ok(195_000 + RESUME_SPACING_MS + d2 <= RESUME_SPACED_BUDGET_MS, "pior caso cabe nos 9 min");
      assert.ok(RESUME_SPACED_BUDGET_MS < 600_000, "abaixo do teto de 10 min do Bash do harness");
      assert.equal(rounds.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Clarice segue fora: marcador diz que houve retry espaçado e o aviso final é claro", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      const clock = { t: Date.parse("2026-11-16T23:46:00Z") };
      const { runner } = flakyRunner(9, clock);
      const { rounds } = resumeClariceSpaced(dir, runner, {
        clock: () => clock.t,
        sleep: (ms) => { clock.t += ms; },
      });
      const marker = readClaricePending(dir);
      assert.equal(marker?.last_outcome, "failed:3");
      assert.match(marker?.last_reason ?? "", /não respondeu em 60s/);
      assert.match(marker?.last_reason ?? "", /2 rodadas espaçadas: 23:46, 23:51 UTC/);
      const msg = spacedFailureMessage(rounds);
      assert.match(msg ?? "", /segue fora depois de 2 rodadas/);
      assert.match(msg ?? "", /sem a revisão da Clarice/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha que não é de API (sem chave, exit 2) não ganha outra rodada nem espera", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      let calls = 0;
      let slept = false;
      const { outcome, rounds } = resumeClariceSpaced(dir, () => { calls++; return 2; }, {
        sleep: () => { slept = true; },
      });
      assert.equal(outcome.status, "failed");
      assert.equal(calls, 1);
      assert.equal(slept, false);
      assert.equal(spacedFailureMessage(rounds), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--rounds 1 mantém o comportamento antigo: uma chamada, sem --deadline-ms", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      const clock = { t: 0 };
      const { runner, calls } = flakyRunner(5, clock);
      resumeClariceSpaced(dir, runner, { rounds: 1, clock: () => clock.t, sleep: () => assert.fail("não espera") });
      assert.equal(calls.length, 1);
      assert.equal(deadlineOf(calls[0]), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem orçamento para uma 2ª rodada útil (1ª demorou), não espera à toa", () => {
    const dir = makePendingEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado\n");
      const clock = { t: 0 };
      const { runner, calls } = flakyRunner(5, clock, 400_000);
      resumeClariceSpaced(dir, runner, { clock: () => clock.t, sleep: () => assert.fail("não espera") });
      assert.equal(calls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
