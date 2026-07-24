/**
 * test/poll-leaderboard-head-3998.test.ts (#3998)
 *
 * Regressão: `GET /leaderboard` (raiz, sem slug) funcionava (200) mas `HEAD
 * /leaderboard` retornava 404 em produção — a guarda do router só aceitava
 * `request.method === "GET"`, e o `curl -sI` usado pra reproduzir a issue
 * envia HEAD por padrão (não GET). Link-preview generators, clientes de
 * e-mail e uptime checks costumam fazer HEAD antes de seguir/renderizar um
 * link — mesmo racional documentado no fix análogo de `/img/*` (#HEAD,
 * ver index.ts): o runtime do Workers descarta o body automaticamente em
 * respostas a HEAD, então basta aceitar o método na guarda do router.
 *
 * Cobre os 3 pontos de entrada afetados: `/leaderboard` (bare), o bloco
 * `startsWith("/leaderboard/")` (`/leaderboard/{YYYY-MM}` e
 * `/leaderboard/{YYYY}`), e `/leaderboard/top1`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import type { Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function headStatus(path: string, env: Env = makeEnv()): Promise<number> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`, { method: "HEAD" });
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  return res.status;
}

describe("#3998 — HEAD /leaderboard* não deve 404 (só GET era aceito antes do fix)", () => {
  it("HEAD /leaderboard (raiz, sem slug): 200, não 404", async () => {
    const status = await headStatus("/leaderboard");
    assert.equal(status, 200, `HEAD /leaderboard deveria ser 200 (regressão #3998), recebeu ${status}`);
  });

  it("HEAD /leaderboard/2026-03 (mês): 200, não 404", async () => {
    const status = await headStatus("/leaderboard/2026-03");
    assert.equal(status, 200, `HEAD /leaderboard/{YYYY-MM} deveria ser 200, recebeu ${status}`);
  });

  it("HEAD /leaderboard/2026 (ano): 200, não 404", async () => {
    const status = await headStatus("/leaderboard/2026");
    assert.equal(status, 200, `HEAD /leaderboard/{YYYY} deveria ser 200, recebeu ${status}`);
  });

  it("HEAD /leaderboard/top1: 200, não 404", async () => {
    const status = await headStatus("/leaderboard/top1");
    assert.equal(status, 200, `HEAD /leaderboard/top1 deveria ser 200, recebeu ${status}`);
  });

  it("HEAD /leaderboard?brand=clarice (leaderboardPeriod=year): 200, não 404", async () => {
    const status = await headStatus("/leaderboard?brand=clarice");
    assert.equal(status, 200, `HEAD /leaderboard?brand=clarice deveria ser 200, recebeu ${status}`);
  });
});
