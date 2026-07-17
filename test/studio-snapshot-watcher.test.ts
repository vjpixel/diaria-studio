/**
 * test/studio-snapshot-watcher.test.ts (#3565)
 *
 * Cobre scripts/studio-ui/studio-snapshot-watcher.ts: dispara `pushFn`
 * (injetado — nunca a versão real de rede) imediatamente + periodicamente,
 * é fail-soft mesmo quando `pushFn` REJEITA ou LANÇA de forma inesperada
 * (invariante do arquivo: falha de rede/Cloudflare nunca pode derrubar o
 * Studio local), e `close()` para o timer de forma idempotente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchAndPushStudioSnapshot } from "../scripts/studio-ui/studio-snapshot-watcher.ts";
import type { PushStudioSnapshotResult } from "../scripts/studio-snapshot-push.ts";

function fakeResult(pushed: boolean): PushStudioSnapshotResult {
  return {
    snapshot: {
      generated_at: new Date().toISOString(),
      current_edition: null,
      current_stage: "unknown",
      stage_label: "Desconhecido",
      gates_pending_count: 0,
      chat_gates_pending_count: 0,
      overnight: null,
      develop: null,
    },
    pushed,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("watchAndPushStudioSnapshot (#3565)", () => {
  it("dispara pushFn imediatamente ao iniciar (sem esperar o 1º intervalo)", async () => {
    let calls = 0;
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 10_000, // bem maior que a janela de espera do teste
      pushFn: async () => {
        calls++;
        return fakeResult(true);
      },
    });
    try {
      await wait(20);
      assert.equal(calls, 1, "deve chamar pushFn 1x imediatamente, sem esperar intervalMs");
    } finally {
      handle.close();
    }
  });

  it("dispara pushFn periodicamente a cada intervalMs", async () => {
    let calls = 0;
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 25,
      pushFn: async () => {
        calls++;
        return fakeResult(true);
      },
    });
    try {
      await wait(150); // margem generosa (CI lento): ~6 intervalos de 25ms
      assert.ok(calls >= 3, `esperava >=3 chamadas em ~150ms com intervalMs=25, teve ${calls}`);
    } finally {
      handle.close();
    }
  });

  it("close() para o timer — nenhuma chamada nova depois", async () => {
    let calls = 0;
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 25,
      pushFn: async () => {
        calls++;
        return fakeResult(true);
      },
    });
    await wait(40);
    handle.close();
    const callsAtClose = calls;
    await wait(120);
    assert.equal(calls, callsAtClose, "close() deve parar novas chamadas de pushFn");
  });

  it("close() é idempotente (chamar 2x não lança)", () => {
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 10_000,
      pushFn: async () => fakeResult(true),
    });
    assert.doesNotThrow(() => {
      handle.close();
      handle.close();
    });
  });

  it("fail-soft: pushFn REJEITA → onPush recebe pushed:false+error, watcher continua vivo", async () => {
    const seen: Array<PushStudioSnapshotResult | { pushed: false; error: string }> = [];
    let attempt = 0;
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 25,
      pushFn: async () => {
        attempt++;
        if (attempt === 1) throw new Error("rede indisponível (simulado)");
        return fakeResult(true);
      },
      onPush: (result) => seen.push(result),
    });
    try {
      await wait(100);
      assert.ok(seen.length >= 2, "deve ter observado pelo menos a falha + 1 sucesso subsequente");
      assert.equal(seen[0].pushed, false);
      assert.match((seen[0] as { error: string }).error, /rede indisponível/);
      // Watcher sobreviveu à falha — próxima tentativa reportou sucesso.
      assert.ok(seen.some((r) => r.pushed === true), "watcher deve seguir tentando após uma falha");
    } finally {
      handle.close();
    }
  });

  it("onPush não é chamado depois de close() mesmo se um tick já estava em voo", async () => {
    let onPushCalls = 0;
    const handle = watchAndPushStudioSnapshot("/fake/root", {
      intervalMs: 10_000,
      pushFn: async () => {
        await wait(30); // em voo quando close() for chamado abaixo
        return fakeResult(true);
      },
      onPush: () => {
        onPushCalls++;
      },
    });
    // Fecha ANTES do tick imediato resolver.
    handle.close();
    await wait(60);
    assert.equal(onPushCalls, 0, "onPush não deve disparar pra um tick que só resolveu depois do close()");
  });
});
