/**
 * test/render-halt-banner-push.test.ts (#3564, canal e-mail #5341)
 *
 * Testes de regressão pra notificação push (e-mail) acoplada ao halt banner
 * (`scripts/render-halt-banner.ts`, aceite #3 da issue: "halt banner
 * notifica com as ações no texto"). Cobre:
 *
 *   - notifyHaltViaPush chama o notifyFn com a mensagem formatada
 *     (stage/motivo/ação) na 1ª ocorrência de um halt.
 *   - dedup por arquivo (`data/.push-halt-dedup.json`) entre chamadas —
 *     o MESMO halt (stage+motivo+ação) dentro da janela não notifica 2x,
 *     mesmo sendo processos/invocações separadas (por isso o registro é
 *     lido/gravado em disco, não em memória).
 *   - um halt DIFERENTE (motivo mudou) notifica mesmo com um dedup recente
 *     registrado pra outro halt.
 *   - fail-soft: notifyFn retornando {ok:false} (auth/rede/timeout) não
 *     persiste dedup — próxima chamada tenta de novo — e nunca lança.
 *   - `data/` ausente (clone fresco, sessão cloud, #2643 label `local`) não
 *     impede a notificação nem lança — dedup degrada pra "sempre notifica".
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { notifyHaltViaPush } from "../scripts/render-halt-banner.ts";

const HALT_OPTS = {
  stage: "2b — Clarice review",
  reason: "mcp__clarice desconectado",
  action: "reconecte e responda 'retry', ou 'abort' para abortar",
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "halt-push-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("notifyHaltViaPush (#3564)", () => {
  it("chama notifyFn com a mensagem formatada (stage/motivo/ação) na 1ª ocorrência", async () => {
    const calls: { subject: string; body: string }[] = [];
    await notifyHaltViaPush(HALT_OPTS, {
      rootDir: dir,
      nowMs: 1_000_000,
      notifyFn: async (msg) => {
        calls.push(msg);
        return { ok: true };
      },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].subject, /2b — Clarice review/);
    assert.match(calls[0].body, /mcp__clarice desconectado/);
    assert.match(calls[0].body, /reconecte e responda 'retry'/);
  });

  it("dedup: o MESMO halt dentro da janela não notifica 2x (2 chamadas separadas, mesmo dir)", async () => {
    const calls: { subject: string; body: string }[] = [];
    const notifyFn = async (msg: { subject: string; body: string }) => {
      calls.push(msg);
      return { ok: true };
    };

    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 1_000_000, notifyFn });
    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 1_000_000 + 60_000, notifyFn });

    assert.equal(calls.length, 1, "2ª chamada dentro da janela de dedup não deve reinvocar notifyFn");
  });

  it("halt DIFERENTE (motivo mudou) notifica mesmo com dedup recente de outro halt", async () => {
    const calls: { subject: string; body: string }[] = [];
    const notifyFn = async (msg: { subject: string; body: string }) => {
      calls.push(msg);
      return { ok: true };
    };

    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 1_000_000, notifyFn });
    await notifyHaltViaPush(
      { ...HALT_OPTS, reason: "mcp__beehiiv desconectado" },
      { rootDir: dir, nowMs: 1_000_010, notifyFn },
    );

    assert.equal(calls.length, 2, "motivo diferente é um halt diferente — deve notificar");
  });

  it("FORA da janela de dedup, o mesmo halt notifica de novo", async () => {
    const calls: { subject: string; body: string }[] = [];
    const notifyFn = async (msg: { subject: string; body: string }) => {
      calls.push(msg);
      return { ok: true };
    };

    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 0, notifyFn });
    // 16 min depois — janela de dedup é 15 min.
    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 16 * 60_000, notifyFn });

    assert.equal(calls.length, 2);
  });

  it("persiste o dedup em disco (data/.push-halt-dedup.json) sob o rootDir", async () => {
    await notifyHaltViaPush(HALT_OPTS, {
      rootDir: dir,
      nowMs: 1_000_000,
      notifyFn: async () => ({ ok: true }),
    });
    const path = join(dir, "data", ".push-halt-dedup.json");
    assert.ok(existsSync(path), "esperava data/.push-halt-dedup.json criado");
    const record = JSON.parse(readFileSync(path, "utf8"));
    const key = `${HALT_OPTS.stage}|${HALT_OPTS.reason}|${HALT_OPTS.action}`;
    assert.equal(record[key], 1_000_000);
  });

  it("notifyFn retornando {ok:false} (auth/rede/timeout) NÃO persiste dedup — próxima chamada tenta de novo, e nunca lança", async () => {
    const calls: { subject: string; body: string }[] = [];
    const notifyFn = async (msg: { subject: string; body: string }) => {
      calls.push(msg);
      return { ok: false, error: "network down" };
    };

    await assert.doesNotReject(
      notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 1_000_000, notifyFn }),
    );
    await notifyHaltViaPush(HALT_OPTS, { rootDir: dir, nowMs: 1_000_001, notifyFn });

    assert.equal(calls.length, 2, "falha de rede não deve suprimir a próxima tentativa");
  });

  it("data/ ausente (rootDir sem a pasta) não lança — dedup degrada pra 'sempre notifica'", async () => {
    const emptyRoot = join(dir, "sem-data-aqui");
    // Não criamos `emptyRoot` — simula rootDir cujo `data/` (junction OneDrive,
    // #2643 label `local`) nunca foi criado, ex: clone fresco/sessão cloud.
    const calls: { subject: string; body: string }[] = [];
    const notifyFn = async (msg: { subject: string; body: string }) => {
      calls.push(msg);
      return { ok: true };
    };

    await assert.doesNotReject(
      notifyHaltViaPush(HALT_OPTS, { rootDir: emptyRoot, nowMs: 1_000_000, notifyFn }),
    );
    assert.equal(calls.length, 1, "sem data/ o dedup falha soft, mas ainda notifica");
  });
});
