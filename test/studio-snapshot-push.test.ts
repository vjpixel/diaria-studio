/**
 * test/studio-snapshot-push.test.ts (#3565)
 *
 * Cobre scripts/studio-snapshot-push.ts:
 *   - buildStudioSnapshot: função PURA que monta o payload compacto a partir
 *     de um StudioState — incluindo o aceite explícito da issue #3565
 *     "Snapshot sem PII (teste)": nenhum email, token, ou texto de pergunta
 *     AskUserQuestion (`firstQuestion`) sobrevive no snapshot, mesmo quando
 *     presente no StudioState de entrada.
 *   - pushStudioSnapshot: ramos --dry-run e credenciais ausentes (fail-soft,
 *     sem tocar rede — ver cloudflare-kv-upload.test.ts pro mesmo padrão de
 *     não fazer chamada de rede real em teste unitário).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStudioSnapshot,
  pushStudioSnapshot,
  STUDIO_SNAPSHOT_KV_KEY,
} from "../scripts/studio-snapshot-push.ts";
import type { StudioState } from "../scripts/studio-ui/studio-state.ts";

function fakeState(overrides: Partial<StudioState> = {}): StudioState {
  return {
    generatedAt: "2026-07-16T12:00:00.000Z",
    rootDir: "C:\\Users\\vjpix\\Projects\\diaria-studio",
    currentEdition: "260716",
    editions: [
      {
        edition: "260716",
        editionDir: "data/editions/260716",
        currentStage: 4,
        stageLabel: "Revisão",
        gatesPending: [4],
        hasStageStatus: true,
      },
    ],
    gatesPending: [{ edition: "260716", stage: 4 }],
    overnight: {
      sessionId: "260715",
      path: "data/overnight/260715/plan.json",
      startedAt: "2026-07-15T22:00:00.000Z",
      totalIssues: 5,
      counts: { merged: 3, draft: 1, pulada: 1 },
    },
    develop: null,
    chatPermissionsPending: [
      {
        toolUseId: "toolu_abc123XYZ",
        toolName: "AskUserQuestion",
        askedAt: 1752670800000,
        firstQuestion: "Qual token secreto vjpixel@gmail.com devo usar pra publicar no LinkedIn?",
      },
    ],
    ...overrides,
  };
}

describe("buildStudioSnapshot (#3565)", () => {
  it("monta o snapshot compacto a partir do StudioState", () => {
    const snapshot = buildStudioSnapshot(fakeState(), new Date("2026-07-16T12:05:00.000Z"));
    assert.equal(snapshot.generated_at, "2026-07-16T12:05:00.000Z");
    assert.equal(snapshot.current_edition, "260716");
    assert.equal(snapshot.current_stage, 4);
    assert.equal(snapshot.stage_label, "Revisão");
    assert.equal(snapshot.gates_pending_count, 1);
    assert.equal(snapshot.chat_gates_pending_count, 1);
    assert.deepEqual(snapshot.overnight, {
      sessionId: "260715",
      totalIssues: 5,
      counts: { merged: 3, draft: 1, pulada: 1 },
    });
    assert.equal(snapshot.develop, null);
  });

  it("edição corrente null → stage 'unknown'/'Desconhecido', contagens zeradas", () => {
    const snapshot = buildStudioSnapshot(
      fakeState({ currentEdition: null, editions: [], gatesPending: [], chatPermissionsPending: [] }),
    );
    assert.equal(snapshot.current_edition, null);
    assert.equal(snapshot.current_stage, "unknown");
    assert.equal(snapshot.stage_label, "Desconhecido");
    assert.equal(snapshot.gates_pending_count, 0);
    assert.equal(snapshot.chat_gates_pending_count, 0);
  });

  it("'done' propaga como current_stage quando a edição corrente já terminou", () => {
    const state = fakeState({
      editions: [
        {
          edition: "260716",
          editionDir: "data/editions/260716",
          currentStage: "done",
          stageLabel: "Concluída",
          gatesPending: [],
          hasStageStatus: true,
        },
      ],
    });
    const snapshot = buildStudioSnapshot(state);
    assert.equal(snapshot.current_stage, "done");
    assert.equal(snapshot.stage_label, "Concluída");
  });

  it("#3565 aceite — Snapshot sem PII: nenhum email, token, texto de pergunta, ou path local sobrevive", () => {
    const state = fakeState();
    // Confirma que o INPUT de fato carrega o dado sensível (senão o teste
    // não provaria nada — precisa existir na fonte pra provar que foi
    // filtrado, não que nunca existiu).
    assert.match(state.chatPermissionsPending[0].firstQuestion!, /@/);
    assert.match(state.rootDir, /vjpix/);

    const snapshot = buildStudioSnapshot(state);
    const json = JSON.stringify(snapshot);

    // Nenhum email (regex simples, cobre o formato usado no fixture acima).
    assert.doesNotMatch(json, /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/, "snapshot não deve conter email");
    // Nenhum vestígio do texto da pergunta AskUserQuestion.
    assert.doesNotMatch(json, /token secreto/i, "snapshot não deve conter texto de pergunta AskUserQuestion");
    assert.doesNotMatch(json, /firstQuestion/, "snapshot não deve ter a chave firstQuestion");
    assert.doesNotMatch(json, /toolUseId/, "snapshot não deve ter a chave toolUseId (id de gate)");
    // Nenhum path absoluto/local (rootDir) — pode revelar username da máquina.
    assert.doesNotMatch(json, /vjpix/, "snapshot não deve conter fragmento de path local (username)");
    assert.doesNotMatch(json, /rootDir/, "snapshot não deve ter a chave rootDir");
    assert.doesNotMatch(json, /C:\\\\Users/, "snapshot não deve conter path absoluto Windows");

    // Shape final é só o conjunto de campos esperado (nenhum campo extra
    // vazou de StudioState pro payload público).
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "chat_gates_pending_count",
      "current_edition",
      "current_stage",
      "develop",
      "gates_pending_count",
      "generated_at",
      "overnight",
      "stage_label",
    ]);
  });
});

describe("pushStudioSnapshot — dry-run e credenciais (#3565, sem tocar rede)", () => {
  function setupRoot(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "studio-snapshot-push-"));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("--dry-run: monta o snapshot mas não tenta push", async () => {
    const { root, cleanup } = setupRoot();
    try {
      const result = await pushStudioSnapshot(root, { dryRun: true });
      assert.equal(result.pushed, false);
      assert.equal(result.skippedReason, "dry-run");
      assert.equal(result.error, undefined);
      assert.equal(result.snapshot.current_edition, null); // root vazio, sem edições
    } finally {
      cleanup();
    }
  });

  // #3565 (test-safety): opts.accountId/token/kvNamespaceId undefined caem
  // pro fallback `process.env.CLOUDFLARE_*`/`DASHBOARD_KV_NAMESPACE_ID` —
  // reais nesta máquina de dev (ver CLAUDE.md, usados por outros scripts de
  // push). Sem limpar o env explicitamente, estes 2 testes tentariam um
  // push de VERDADE contra o KV de produção. save/restore mesmo padrão de
  // cloudflare-kv-upload.test.ts.
  function withClearedCloudflareEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = {
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_WORKERS_TOKEN,
      ns: process.env.DASHBOARD_KV_NAMESPACE_ID,
    };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    delete process.env.DASHBOARD_KV_NAMESPACE_ID;
    return fn().finally(() => {
      if (saved.account !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
      if (saved.token !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = saved.token;
      if (saved.ns !== undefined) process.env.DASHBOARD_KV_NAMESPACE_ID = saved.ns;
    });
  }

  it("credenciais ausentes → skippedReason='missing-credentials', nunca lança, nunca toca rede", async () => {
    const { root, cleanup } = setupRoot();
    try {
      await withClearedCloudflareEnv(async () => {
        const result = await pushStudioSnapshot(root, {
          accountId: undefined,
          token: undefined,
          kvNamespaceId: undefined,
        });
        assert.equal(result.pushed, false);
        assert.equal(result.skippedReason, "missing-credentials");
        assert.equal(result.error, undefined);
      });
    } finally {
      cleanup();
    }
  });

  it("kvNamespaceId ausente mesmo com accountId+token → ainda 'missing-credentials', nunca toca rede", async () => {
    const { root, cleanup } = setupRoot();
    try {
      await withClearedCloudflareEnv(async () => {
        const result = await pushStudioSnapshot(root, {
          accountId: "acc",
          token: "tok",
          kvNamespaceId: undefined,
        });
        assert.equal(result.skippedReason, "missing-credentials");
      });
    } finally {
      cleanup();
    }
  });

  it("STUDIO_SNAPSHOT_KV_KEY é a chave estável usada pelo Worker (não 'dashboard')", () => {
    assert.equal(STUDIO_SNAPSHOT_KV_KEY, "studio:snapshot");
  });
});
