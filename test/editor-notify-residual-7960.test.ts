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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
        alarmReachedEditor: true,
      }),
      null,
    );
  });

  it("gh falhou pra TODOS os achados → também conta como 'não chegou' (nenhuma issue, nenhum e-mail)", () => {
    // `shouldPersistAlarmedState` é a fonte de `alarmReachedEditor` no
    // script — reusada, nunca reimplementada (achado do review da #8363).
    const alarmReachedEditor = shouldPersistAlarmedState({ anyIssueSucceeded: false, qualifyingCount: 0, emailSent: false });
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
    assert.equal(shouldPersistAlarmedState({ anyIssueSucceeded: true, qualifyingCount: 0, emailSent: false }), true);
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

  it("nenhum caminho do script importa sendGmailMessage (guard do #7957 item 2, reforçado aqui)", () => {
    const src = readFileSync(new URL("../scripts/ads-daily-digest.ts", import.meta.url), "utf8");
    assert.equal(src.includes("sendGmailMessage"), false);
    assert.match(src, /registerReport/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Item 5 — watchdog / halt banner / gate do Studio / hook do contínuo
// ───────────────────────────────────────────────────────────────────────────

describe("#7960 item 5 — overnight-watchdog: 1 e-mail ENTREGUE por rodada, não recorrente", () => {
  const SUBJECT = "[diar.ia.br overnight] STALL detectado — rodada 260919";

  it("1ª detecção da rodada (issue criada, nada entregue ainda) → e-mail sai e reporta entrega", async () => {
    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      const reached = await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", false, {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunCreating(9001),
        sendPush: async (msg) => {
          sent.push(msg.subject);
          return { ok: true };
        },
        log: () => {},
      });
      assert.deepEqual(sent, [SUBJECT]);
      assert.equal(reached, true, "o caller usa isto pra gravar `plan.stall_alert_delivered`");
    });
  });

  it("detecção SEGUINTE com o alerta JÁ entregue (issue reusada) → nenhum e-mail novo", async () => {
    // O ponto do item 5: 1 e-mail por rodada, não um a cada detecção.
    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", true, {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunReusing(9001),
        sendPush: async (msg) => {
          sent.push(msg.subject);
          return { ok: true };
        },
        log: () => {},
      });
      assert.deepEqual(sent, [], "alerta já entregue nesta rodada não deve reemitir e-mail");
    });
  });

  it("push falhou → reporta NÃO-entrega, e a detecção seguinte TENTA de novo mesmo com a issue reusada", async () => {
    // O achado do silent-failure-hunter: gatear o resend por `issue.action`
    // conflaria "issue reusada" com "e-mail entregue". Se o 1º e-mail
    // falhasse de verdade, a rodada ficaria muda pro resto da vida dela —
    // justo a rodada que travou.
    await withTmpDir(async (dir) => {
      const reached = await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", false, {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunCreating(9001),
        sendPush: async () => ({ ok: false, error: "rede fora" }),
        log: () => {},
      });
      assert.equal(reached, false, "push falho NÃO pode marcar a rodada como notificada");
    });

    await withTmpDir(async (dir) => {
      const sent: string[] = [];
      // `alreadyDeliveredThisRound: false` porque o marcador não avançou
      // acima — e agora a issue está REUSADA. Tem que tentar de novo.
      await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", false, {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: ghRunReusing(9001),
        sendPush: async (msg) => {
          sent.push(msg.subject);
          return { ok: true };
        },
        log: () => {},
      });
      assert.deepEqual(sent, [SUBJECT], "com o alerta ainda não entregue, issue reusada DEVE retentar o e-mail");
    });
  });

  it("sob urgent_only a issue é o canal: nenhum e-mail, mas CONTA como entregue", async () => {
    await withTmpDir(async (dir) => {
      const reached = await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", false, {
        platformConfigPath: writePolicy(dir, "urgent_only"),
        ghRun: ghRunCreating(9001),
        sendPush: async () => {
          throw new Error("severity 'acao' nunca e-mailia sob urgent_only");
        },
        log: () => {},
      });
      assert.equal(reached, true, "supressão deliberada pela política não é falha de infra");
    });
  });

  it("gh falhou → NÃO-entrega, e nunca lança (fail-soft TOTAL — watchdog não pode morrer)", async () => {
    await withTmpDir(async (dir) => {
      const reached = await sendStallAlert(dir, "overnight", "260919", SUBJECT, "corpo", false, {
        platformConfigPath: writePolicy(dir, "legacy"),
        ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh: offline" }),
        sendPush: async () => ({ ok: true }),
        log: () => {},
      });
      assert.equal(reached, false);
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

// O hook do contínuo (`.claude/hooks/notify-continuo-askuserquestion.mjs`)
// é testado em `test/notify-continuo-askuserquestion.test.ts`, junto com o
// resto do hook — e não aqui — porque importar um `.mjs` sem declaração de
// tipos a partir de um arquivo NOVO acrescentaria um TS7016 ao
// `tsc-baseline.json` (`Typecheck ratchet`, #6217). Aquele arquivo já
// carrega a entrada de baseline desse import; este não precisa criar outra.

// ───────────────────────────────────────────────────────────────────────────
// Guard de WIRING: worker-drift-check.ts (achado P2 do pr-test-analyzer)
// ───────────────────────────────────────────────────────────────────────────

describe("#7960 worker-drift-check — o wiring de main() usa as decisões, não um literal", () => {
  // `main()` de `scripts/worker-drift-check.ts` é privada e só roda sob o
  // guard `isMainModule` — exercitá-la exigiria `CLOUDFLARE_*` ao vivo e
  // chamadas reais a `gh`/Gmail, que a regra 1 de
  // `context/overnight-dispatch-rules.md` proíbe. Sem este guard, as 3
  // decisões puras acima ficariam cobertas isoladamente enquanto o CALL
  // SITE poderia contorná-las (hardcodar `alarmReachedEditor: true`, ou
  // esquecer de threadar a variável) sem nenhum teste reclamar — o padrão
  // "asserção sobre helper puro que o call site pode burlar".
  //
  // Scan estático do fonte, mesmo estilo de `test/editor-notify-boundary.test.ts`
  // (regex sobre texto, nunca execução): trava o WIRING, não a implementação.
  const src = (): string => readFileSync(new URL("../scripts/worker-drift-check.ts", import.meta.url), "utf8");

  it("`driftAlarmReachedEditor` vem de `shouldPersistAlarmedState`, nunca de um literal", () => {
    assert.match(
      src(),
      /driftAlarmReachedEditor = shouldPersistAlarmedState\(\{/,
      "a decisão de persistir o cursor precisa vir do helper compartilhado (reusar, nunca reimplementar)",
    );
  });

  it("`resolveNextAlarmedFingerprint` recebe a variável, não `true`", () => {
    assert.match(
      src(),
      /alarmReachedEditor: driftAlarmReachedEditor/,
      "hardcodar `alarmReachedEditor: true` faria o cursor avançar com o alarme perdido — o bug que esta fatia corrige",
    );
    assert.doesNotMatch(src(), /alarmReachedEditor: true/);
  });

  it("o cursor gravado é o resolvido, não `computeDriftFingerprint` cru", () => {
    assert.match(src(), /const nextFingerprint = resolveNextAlarmedFingerprint\(/);
    assert.match(src(), /saveState\(advanceState\(nextFingerprint,/);
  });

  it("a série de falha da API só é marcada como avisada via `notifyEditorResultReachedEditor`", () => {
    assert.match(
      src(),
      /if \(notifyEditorResultReachedEditor\(apiResult\)\) \{\s*\n\s*nextApiErrorState\.lastApiErrorAlarmedAt/,
      "marcar a série sem checar se algo chegou ao editor a silenciaria PARA SEMPRE (shouldAlarmApiError só rearma após um sucesso)",
    );
  });
});

describe("#7960 — `emailError` é autoritativo sobre `emailSent` (review type-design)", () => {
  it("o par contraditório {emailSent: true, emailError} falha pro lado do RETRY", () => {
    // `notifyEditor` nunca produz esse par, mas a interface flat
    // `NotifyEditorResult` permite — um dublê de teste ou um refactor que
    // preencha `emailError` antes da tentativa cairia no caminho otimista
    // e mascararia uma falha real de envio.
    const contraditorio: NotifyEditorResult = {
      severity: "acao",
      emailPolicy: "legacy",
      emailSent: true,
      emailError: "rede fora",
      issue: { issueNumber: 1, url: "u", action: "created" },
    };
    assert.equal(notifyEditorResultReachedEditor(contraditorio), false);
  });
});
