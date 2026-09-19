/**
 * test/editor-notify-residual-7960.test.ts (#7960, 6ª e última fatia)
 *
 * Regressão dos 3 residuais da migração pro portão `notifyEditor`:
 *
 *   1. `worker-drift-check.ts` — 2 fluxos de notificação (drift issue-based
 *      + falha SUSTENTADA da Cloudflare API).
 *   2. Item 4 da #7957 — `ads-daily-digest.ts` vira relatório do Studio.
 *   3. Item 5 da #7957 — watchdog/gate/contínuo/halt banner.
 *
 * O eixo que TODOS os casos abaixo cobrem, porque é a armadilha da migração
 * inteira (achada por review nas fatias 4, 5 e de novo aqui):
 * **"nada chegou ao editor → o estado NÃO persiste"**. `sendGmailMessage`
 * LANÇAVA em falha de envio, abortando `main()` antes de qualquer gravação
 * de cursor — o retry na execução seguinte era garantido por ACIDENTE do
 * fluxo de controle. `notifyEditor`/`notifyEditorForOutcomes` nunca lançam
 * (fail-soft por desenho), então cada remetente migrado precisa decidir
 * isso EXPLICITAMENTE, e essa decisão precisa ser testável sem rede.
 *
 * Guard de publicação (regra 1 de `context/overnight-dispatch-rules.md`):
 * nenhum teste aqui toca rede — `gh`, envio de e-mail e `fetch` são todos
 * injetados. São testes sobre a DECISÃO de notificar, nunca sobre o envio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import {
  notifyEditor,
  notifyEditorResultReachedEditor,
  shouldPersistAlarmedState,
  type NotifyEditorResult,
} from "../scripts/lib/editor-notify.ts";
import { resolveNextAlarmedFingerprint } from "../scripts/lib/worker-drift-check.ts";
import { sendStallAlert } from "../scripts/overnight-watchdog.ts";
import { notifyHaltViaPush } from "../scripts/render-halt-banner.ts";
import { runPushNotifyTick } from "../scripts/studio-ui/studio-push-notify.ts";
import type { StudioState } from "../scripts/studio-ui/studio-state.ts";
import { createInMemoryNotifiedStore } from "../scripts/lib/push-notify.ts";
import { isReportKind } from "../scripts/studio-ui/studio-reports.ts";
import {
  resolveEmailPolicyInline,
  sendNotification,
} from "../.claude/hooks/notify-continuo-askuserquestion.mjs";

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "notify-residual-7960-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Escreve um `platform.config.json` mínimo com a política dada. */
function writePolicy(dir: string, policy: "legacy" | "urgent_only"): string {
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify({ notifications: { email_policy: policy } }), "utf8");
  return path;
}

function ghRunCreating(issueNumber: number): (args: string[], cwd: string) => GhSpawnResult {
  return (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      return { status: 0, stdout: `https://github.com/vjpixel/diaria-studio/issues/${issueNumber}\n`, stderr: "" };
    }
    throw new Error(`chamada gh inesperada no teste: ${args.join(" ")}`);
  };
}

/** `gh issue list` devolvendo uma issue ABERTA com o marcador do achado —
 * `ensureAlarmIssue` reusa em vez de criar (`action: "reused"`). */
function ghRunReusing(issueNumber: number): (args: string[], cwd: string) => GhSpawnResult {
  return (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: issueNumber,
            url: `https://github.com/vjpixel/diaria-studio/issues/${issueNumber}`,
            title: "[diar.ia.br overnight] STALL detectado — rodada 260919",
            state: "OPEN",
            body: "<!-- alarm-finding: overnight-watchdog-stall:overnight:260919 -->",
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "edit" || args[1] === "view")) {
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    throw new Error(`chamada gh inesperada no teste: ${args.join(" ")}`);
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. worker-drift-check.ts
// ───────────────────────────────────────────────────────────────────────────

describe("#7960 worker-drift-check — cursor de drift não avança quando o alarme se perde", () => {
  it("alarme NÃO chegou ao editor → preserva o fingerprint ANTERIOR (o drift volta a alarmar)", () => {
    // O caso que a migração quase introduziu: com `sendGmailMessage` a
    // exceção abortava main() antes do saveState; `notifyEditorForOutcomes`
    // nunca lança, então sem esta decisão o cursor avançaria e ESTE drift
    // nunca mais seria reportado.
    assert.equal(
      resolveNextAlarmedFingerprint({
        previousFingerprint: "drift-antigo",
        pending: true,
        computedFingerprint: "drift-novo",
        alarmReachedEditor: false,
      }),
      "drift-antigo",
    );
  });

  it("alarme chegou → avança pro fingerprint do conjunto atual", () => {
    assert.equal(
      resolveNextAlarmedFingerprint({
        previousFingerprint: "drift-antigo",
        pending: true,
        computedFingerprint: "drift-novo",
        alarmReachedEditor: true,
      }),
      "drift-novo",
    );
  });

  it("sem drift pendente e nada a notificar → zera o cursor (comportamento pré-#7960 preservado)", () => {
    assert.equal(
      resolveNextAlarmedFingerprint({
        previousFingerprint: "drift-antigo",
        pending: false,
        computedFingerprint: null,
        alarmReachedEditor: true,
      }),
      null,
    );
  });

  it("gh falhou pra TODOS os achados → também conta como 'não chegou' (nenhuma issue, nenhum e-mail)", () => {
    // `shouldPersistAlarmedState` é a fonte de `alarmReachedEditor` no
    // script — reusada, nunca reimplementada (achado do review da #8363).
    const alarmReachedEditor = shouldPersistAlarmedState(false, 0, false);
    assert.equal(alarmReachedEditor, false);
    assert.equal(
      resolveNextAlarmedFingerprint({
        previousFingerprint: "drift-antigo",
        pending: true,
        computedFingerprint: "drift-novo",
        alarmReachedEditor,
      }),
      "drift-antigo",
    );
  });

  it("política suprimiu o e-mail de propósito (urgent_only) → CONTA como chegou (issue registrada)", () => {
    // Supressão deliberada não é falha de infra: a issue existe, o editor
    // tem onde ver. Confundir os dois faria o alarme re-notificar pra sempre
    // sob `urgent_only`.
    assert.equal(shouldPersistAlarmedState(true, 0, false), true);
  });
});

describe("#7960 worker-drift-check — série de falha SUSTENTADA da API Cloudflare", () => {
  const FINDING = {
    check: "worker-drift-api-error",
    fingerprint: "cloudflare-workers-api-sustained-failure",
    severity: "acao" as const,
    subject: "[diar.ia.br] Não consigo checar drift de Workers há muito tempo",
    body: "corpo",
  };

  it("push falhou → `notifyEditorResultReachedEditor` é false (série NÃO marcada como avisada)", async () => {
    // Este é o caminho que mais dói neste script: `shouldAlarmApiError` só
    // volta a disparar depois de um SUCESSO resetar `firstApiErrorAt`, então
    // marcar a série como avisada sem nada ter saído a silencia pra sempre.
    const result = await withTmpDir(async (dir) => {
      return notifyEditor(FINDING, {
        cwd: dir,
        rootDir: dir,
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunCreating(7001),
        sendPush: async () => ({ ok: false, error: "rede fora" }),
        log: () => {},
      });
    });
    assert.equal(result.emailSent, false);
    assert.equal(notifyEditorResultReachedEditor(result), false);
  });

  it("gh falhou → também é false (sem issue e sem e-mail, nada chegou)", async () => {
    const result = await withTmpDir(async (dir) =>
      notifyEditor(FINDING, {
        cwd: dir,
        rootDir: dir,
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh: offline" }),
        sendPush: async () => {
          throw new Error("sendPush não deveria ser chamado quando a issue falha");
        },
        log: () => {},
      }),
    );
    assert.equal(notifyEditorResultReachedEditor(result), false);
  });

  it("issue criada + push ok → true", async () => {
    const result = await withTmpDir(async (dir) =>
      notifyEditor(FINDING, {
        cwd: dir,
        rootDir: dir,
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunCreating(7002),
        sendPush: async () => ({ ok: true }),
        log: () => {},
      }),
    );
    assert.equal(result.emailSent, true);
    assert.equal(notifyEditorResultReachedEditor(result), true);
  });

  it("sob urgent_only a issue nasce e o e-mail é suprimido de propósito → true", async () => {
    const result = await withTmpDir(async (dir) =>
      notifyEditor(FINDING, {
        cwd: dir,
        rootDir: dir,
        platformConfigPath: writePolicy(dir, "urgent_only"),
        ghRun: ghRunCreating(7003),
        sendPush: async () => {
          throw new Error("severity 'acao' nunca e-mailia sob urgent_only");
        },
        log: () => {},
      }),
    );
    assert.equal(result.emailSent, false);
    assert.equal(result.emailError, undefined);
    assert.equal(notifyEditorResultReachedEditor(result), true);
  });

  it("`severity: 'info'`/'silencio' nunca produzem issue → false (não há cursor de alarme a avançar)", () => {
    const infoResult: NotifyEditorResult = { severity: "info", emailPolicy: "legacy", emailSent: false };
    assert.equal(notifyEditorResultReachedEditor(infoResult), false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Item 4 — ads-daily-digest vira relatório do Studio
// ───────────────────────────────────────────────────────────────────────────

describe("#7960 item 4 — ads-daily-digest registra relatório em vez de e-mailar", () => {
  it('"ads-digest" é um ReportKind válido (senão o registro cai no fail-soft e o digest some)', () => {
    assert.equal(isReportKind("ads-digest"), true);
  });

  it("nenhum caminho do script importa sendGmailMessage (guard do #7957 item 2, reforçado aqui)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../scripts/ads-daily-digest.ts", import.meta.url), "utf8"),
    );
    assert.equal(src.includes("sendGmailMessage"), false);
    assert.match(src, /registerReport/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Item 5 — watchdog / halt banner / gate do Studio / hook do contínuo
// ───────────────────────────────────────────────────────────────────────────

describe("#7960 item 5 — overnight-watchdog: 1 issue por rodada, não e-mail recorrente", () => {
  const SUBJECT = "[diar.ia.br overnight] STALL detectado — rodada 260919";

  it("1ª detecção da rodada (issue criada) → e-mail sai sob legacy", async () => {
    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunCreating(9001),
        sendPush: async (msg) => {
          sent.push(msg.subject);
          return { ok: true };
        },
        log: () => {},
      });
      assert.deepEqual(sent, [SUBJECT]);
    });
  });

  it("detecção SEGUINTE da MESMA rodada (issue reusada) → nenhum e-mail novo", async () => {
    // O ponto do item 5: sem `legacyResendIntent: "dedupe-new-occurrences-only"`
    // o default `"resend-every-run"` reemitiria e-mail a cada detecção,
    // que é exatamente o "e-mail recorrente" que esta issue elimina.
    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunReusing(9001),
        sendPush: async (msg) => {
          sent.push(msg.subject);
          return { ok: true };
        },
        log: () => {},
      });
      assert.deepEqual(sent, [], "issue reusada não deve reemitir e-mail");
    });
  });

  it("nunca lança, nem quando o gh falha (fail-soft TOTAL — watchdog não pode morrer)", async () => {
    await withTmpDir(async (dir) => {
      await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh: offline" }),
        sendPush: async () => ({ ok: true }),
        log: () => {},
      });
    });
  });
});

describe("#7960 item 5 — render-halt-banner respeita email_policy", () => {
  const HALT = {
    stage: "2b — Clarice review",
    reason: "mcp__clarice desconectado",
    action: "reconecte e responda 'retry', ou 'abort' para abortar",
  };

  it("urgent_only → banner fica só no terminal: nenhum envio E nenhum dedup gravado", () => {
    return withTmpDir(async (dir) => {
      writePolicy(dir, "urgent_only");
      let called = 0;
      await notifyHaltViaPush(HALT, {
        rootDir: dir,
        nowMs: 1_000_000,
        notifyFn: async () => {
          called += 1;
          return { ok: true };
        },
      });
      assert.equal(called, 0);
      // "nada chegou ao editor → estado NÃO persiste": gravar o dedup aqui
      // marcaria como notificado um halt que ninguém recebeu, e um rollback
      // pra `legacy` dentro da janela ficaria mudo.
      assert.equal(existsSync(join(dir, "data", ".push-halt-dedup.json")), false);
    });
  });

  it("legacy → comportamento inalterado (envia)", () => {
    return withTmpDir(async (dir) => {
      writePolicy(dir, "legacy");
      let called = 0;
      await notifyHaltViaPush(HALT, {
        rootDir: dir,
        nowMs: 1_000_000,
        notifyFn: async () => {
          called += 1;
          return { ok: true };
        },
      });
      assert.equal(called, 1);
    });
  });
});

describe("#7960 item 5 — studio-push-notify respeita email_policy", () => {
  /** Só o campo que `runPushNotifyTick` lê — o resto de `StudioState` exige
   * `data/` real, que este teste não tem (nem deve ter). */
  const buildStateStub = (): StudioState => ({ gatesPending: [{ edition: "260919", stage: 4 }] }) as unknown as StudioState;

  it("urgent_only → nenhum e-mail de gate pendente E a chave não entra no dedup", () => {
    return withTmpDir(async (dir) => {
      writePolicy(dir, "urgent_only");
      const store = createInMemoryNotifiedStore();
      let called = 0;
      const notified = await runPushNotifyTick(dir, store, {
        buildStateFn: buildStateStub,
        notifyFn: async () => {
          called += 1;
          return { ok: true };
        },
      });
      assert.equal(called, 0);
      assert.deepEqual(notified, []);
      // Idem ao halt banner: marcar como notificado o que não saiu faria o
      // gate ficar mudo pra sempre depois de um rollback pra `legacy`.
      assert.deepEqual(store.keys(), []);
    });
  });

  it("legacy → comportamento inalterado (notifica e deduplica)", () => {
    return withTmpDir(async (dir) => {
      writePolicy(dir, "legacy");
      const store = createInMemoryNotifiedStore();
      let called = 0;
      const notified = await runPushNotifyTick(dir, store, {
        buildStateFn: buildStateStub,
        notifyFn: async () => {
          called += 1;
          return { ok: true };
        },
      });
      assert.equal(called, 1);
      assert.deepEqual(notified, ["edition-gate:260919:4"]);
    });
  });
});

describe("#7960 item 5 — hook do contínuo respeita email_policy", () => {
  it("resolveEmailPolicyInline concorda com resolveEmailPolicy do portão (as duas não podem divergir)", () => {
    withTmpDir((dir) => {
      writePolicy(dir, "urgent_only");
      assert.equal(resolveEmailPolicyInline(dir), "urgent_only");
    });
    withTmpDir((dir) => {
      writePolicy(dir, "legacy");
      assert.equal(resolveEmailPolicyInline(dir), "legacy");
    });
    // Fail-soft NA DIREÇÃO DE NOTIFICAR: config ausente/corrompido nunca
    // pode silenciar o hook que existe justamente pra o editor não perder
    // um AskUserQuestion bloqueante.
    withTmpDir((dir) => {
      assert.equal(resolveEmailPolicyInline(dir), "legacy");
    });
    withTmpDir((dir) => {
      writeFileSync(join(dir, "platform.config.json"), "{ nao é json", "utf8");
      assert.equal(resolveEmailPolicyInline(dir), "legacy");
    });
  });

  it("urgent_only → sendNotification não faz NENHUM fetch (nem refresh de token)", () => {
    return withTmpDir(async (dir) => {
      writePolicy(dir, "urgent_only");
      await sendNotification({ subject: "s", body: "b" }, dir, () => {
        throw new Error("nenhum fetch deveria acontecer sob urgent_only");
      });
    });
  });
});
