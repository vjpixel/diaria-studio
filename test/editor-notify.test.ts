/**
 * test/editor-notify.test.ts (#7957 item 1)
 *
 * `notifyEditor` — portão único de notificação ao editor. Todas as chamadas
 * de rede (`gh`, envio de e-mail) são injetadas/mockadas — NUNCA toca `gh`
 * real nem envia e-mail de verdade (regra 1 do overnight-dispatch-rules.md:
 * editar código de publisher/notificação é ok, EXECUTAR é proibido).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import { notifyEditor, notifyEditorForOutcomes, resolveEmailPolicy, shouldEmailForIssueOutcome } from "../scripts/lib/editor-notify.ts";
import type { AlarmFindingOutcome, AlarmIssueResult } from "../scripts/lib/alarm-issues.ts";
import type { PushMessage } from "../scripts/lib/push-notify.ts";

function ghRunCreating(issueNumber = 42): (args: string[], cwd: string) => GhSpawnResult {
  return (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { status: 0, stdout: `https://github.com/vjpixel/diaria-studio/issues/${issueNumber}\n`, stderr: "" };
    }
    throw new Error(`unexpected gh call in test: ${args.join(" ")}`);
  };
}

/** Cache-hit de família "estado" sempre confirma via `gh issue view` antes
 * de reusar (#5989) — mock que responde OPEN pra esse round-trip. */
function ghRunConfirmingOpen(): (args: string[], cwd: string) => GhSpawnResult {
  return (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    throw new Error(`unexpected gh call in test: ${args.join(" ")}`);
  };
}

function withTmpPlatformConfig(contents: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "editor-notify-test-"));
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify(contents), "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("resolveEmailPolicy", () => {
  it("default 'legacy' quando o arquivo não existe", () => {
    assert.equal(resolveEmailPolicy("/path/inexistente/platform.config.json"), "legacy");
  });

  it("default 'legacy' quando a chave está ausente", () => {
    const { path, cleanup } = withTmpPlatformConfig({});
    try {
      assert.equal(resolveEmailPolicy(path), "legacy");
    } finally {
      cleanup();
    }
  });

  it("lê 'urgent_only' explicitamente", () => {
    const { path, cleanup } = withTmpPlatformConfig({ notifications: { email_policy: "urgent_only" } });
    try {
      assert.equal(resolveEmailPolicy(path), "urgent_only");
    } finally {
      cleanup();
    }
  });

  it("JSON malformado degrada pra 'legacy' (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-notify-test-"));
    const path = join(dir, "platform.config.json");
    writeFileSync(path, "{ not json", "utf8");
    try {
      assert.equal(resolveEmailPolicy(path), "legacy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("valor desconhecido degrada pra 'legacy'", () => {
    const { path, cleanup } = withTmpPlatformConfig({ notifications: { email_policy: "algo-nao-reconhecido" } });
    try {
      assert.equal(resolveEmailPolicy(path), "legacy");
    } finally {
      cleanup();
    }
  });
});

describe("shouldEmailForIssueOutcome", () => {
  const created: AlarmIssueResult = { issueNumber: 1, url: "u", action: "created" };
  const reused: AlarmIssueResult = { issueNumber: 1, url: "u", action: "reused" };
  const reopened: AlarmIssueResult = { issueNumber: 1, url: "u", action: "reopened" };
  const updated: AlarmIssueResult = { issueNumber: 1, url: "u", action: "updated" };
  const failed: AlarmIssueResult = { issueNumber: null, url: null, action: "failed", error: "x" };

  it("urgent_only: só 'urgente' + 'created' manda e-mail", () => {
    assert.equal(shouldEmailForIssueOutcome("urgente", created, "urgent_only"), true);
    assert.equal(shouldEmailForIssueOutcome("urgente", reused, "urgent_only"), false);
    assert.equal(shouldEmailForIssueOutcome("urgente", reopened, "urgent_only"), false);
    assert.equal(shouldEmailForIssueOutcome("urgente", updated, "urgent_only"), false);
    assert.equal(shouldEmailForIssueOutcome("acao", created, "urgent_only"), false);
  });

  it("legacy: 'acao'/'urgente' sempre manda e-mail (exceto action 'failed')", () => {
    assert.equal(shouldEmailForIssueOutcome("acao", reused, "legacy"), true);
    assert.equal(shouldEmailForIssueOutcome("urgente", reused, "legacy"), true);
    assert.equal(shouldEmailForIssueOutcome("acao", created, "legacy"), true);
  });

  it("nunca manda e-mail se a issue falhou, em nenhuma política", () => {
    assert.equal(shouldEmailForIssueOutcome("urgente", failed, "urgent_only"), false);
    assert.equal(shouldEmailForIssueOutcome("urgente", failed, "legacy"), false);
  });
});

describe("notifyEditor", () => {
  it("severity 'silencio': só loga, nunca cria issue nem manda e-mail", async () => {
    const log = mock.fn();
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const result = await notifyEditor(
      { check: "codex-credential-alarm", fingerprint: "conta-x", severity: "silencio", subject: "s", body: "b" },
      { log, sendPush, emailPolicy: "urgent_only" },
    );
    assert.equal(result.emailSent, false);
    assert.equal(result.issue, undefined);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'info': só loga, nunca cria issue nem manda e-mail", async () => {
    const log = mock.fn();
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const result = await notifyEditor(
      { check: "ads-daily-digest", fingerprint: "2609-01", severity: "info", subject: "s", body: "b" },
      { log, sendPush, emailPolicy: "urgent_only" },
    );
    assert.equal(result.emailSent, false);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'info': logWriteOk é undefined quando o `log` injetado não devolve boolean (back-compat com mocks legados)", async () => {
    const log = mock.fn(); // não devolve nada — mesmo shape dos mocks pré-#8453
    const result = await notifyEditor(
      { check: "ads-daily-digest", fingerprint: "2609-01", severity: "info", subject: "s", body: "b" },
      { log, emailPolicy: "urgent_only" },
    );
    assert.equal(result.logWriteOk, undefined);
  });

  it("severity 'info': logWriteOk propaga true quando a escrita do run-log teve sucesso (#8453)", async () => {
    const log = mock.fn(() => true);
    const result = await notifyEditor(
      { check: "ads-daily-digest", fingerprint: "2609-01", severity: "info", subject: "s", body: "b" },
      { log, emailPolicy: "urgent_only" },
    );
    assert.equal(result.logWriteOk, true);
  });

  it("severity 'info': logWriteOk propaga false quando a escrita do run-log falhou em silêncio (#8453 — achado #7960/PR #8452)", async () => {
    const log = mock.fn(() => false);
    const result = await notifyEditor(
      { check: "ads-daily-digest", fingerprint: "2609-01", severity: "info", subject: "s", body: "b" },
      { log, emailPolicy: "urgent_only" },
    );
    assert.equal(result.emailSent, false);
    assert.equal(result.logWriteOk, false);
  });

  it("severity 'silencio': logWriteOk propaga false quando a escrita do run-log falhou em silêncio (#8453)", async () => {
    const log = mock.fn(() => false);
    const result = await notifyEditor(
      { check: "codex-credential-alarm", fingerprint: "conta-x", severity: "silencio", subject: "s", body: "b" },
      { log, emailPolicy: "urgent_only" },
    );
    assert.equal(result.logWriteOk, false);
  });

  it("severity 'acao': garante a issue, nunca manda e-mail sob 'urgent_only'", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const result = await notifyEditor(
      { check: "hub-drift-check", fingerprint: "hub-1", severity: "acao", subject: "Drift no hub", body: "detalhe" },
      { ghRun: ghRunCreating(101), sendPush, emailPolicy: "urgent_only" },
    );
    assert.equal(result.issue?.action, "created");
    assert.equal(result.issue?.issueNumber, 101);
    assert.equal(result.emailSent, false);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'urgente' + issue RECÉM-CRIADA: manda e-mail sob 'urgent_only'", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const result = await notifyEditor(
      {
        check: "check-brevo-diaria-guardrail",
        fingerprint: "suspensa",
        severity: "urgente",
        subject: "Brevo suspensa",
        body: "detalhe",
      },
      { ghRun: ghRunCreating(202), sendPush, emailPolicy: "urgent_only" },
    );
    assert.equal(result.issue?.action, "created");
    assert.equal(result.emailSent, true);
    assert.equal(sendPush.mock.callCount(), 1);
    const [message] = sendPush.mock.calls[0]!.arguments;
    assert.match((message as { subject: string }).subject, /Brevo suspensa/);
  });

  it("severity 'urgente' + issue JÁ EXISTENTE (reused): NÃO manda e-mail sob 'urgent_only'", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const cachedEntry = { issueNumber: 202, url: "https://github.com/vjpixel/diaria-studio/issues/202", closedAt: null };
    const result = await notifyEditor(
      {
        check: "check-brevo-diaria-guardrail",
        fingerprint: "suspensa",
        severity: "urgente",
        subject: "Brevo suspensa (de novo)",
        body: "detalhe",
      },
      {
        cachedEntry,
        ghRun: ghRunConfirmingOpen(),
        sendPush,
        emailPolicy: "urgent_only",
      },
    );
    assert.equal(result.issue?.action, "reused");
    assert.equal(result.emailSent, false);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'urgente' sob 'legacy': manda e-mail mesmo em reused (comportamento pré-#7957)", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const cachedEntry = { issueNumber: 303, url: "https://github.com/vjpixel/diaria-studio/issues/303", closedAt: null };
    const result = await notifyEditor(
      { check: "kit-subscriber-limit-alarm", fingerprint: "limite", severity: "urgente", subject: "s", body: "b" },
      { cachedEntry, ghRun: ghRunConfirmingOpen(), sendPush, emailPolicy: "legacy" },
    );
    assert.equal(result.issue?.action, "reused");
    assert.equal(result.emailSent, true);
  });

  it("ensureAlarmIssue falhando: nunca manda e-mail, resultado carrega action 'failed'", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const log = mock.fn();
    const result = await notifyEditor(
      { check: "x", fingerprint: "y", severity: "urgente", subject: "s", body: "b" },
      {
        log,
        sendPush,
        emailPolicy: "urgent_only",
        ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh: offline" }),
      },
    );
    assert.equal(result.issue?.action, "failed");
    assert.equal(result.emailSent, false);
    assert.equal(sendPush.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 1);
  });
});

/**
 * `notifyEditorForOutcomes` (#7960) — helper pra scripts que já chamam
 * `applyAlarmReconciliation` eles mesmos (não `ensureAlarmIssue` direto):
 * decide/manda o e-mail a partir de outcomes JÁ PRODUZIDOS, sem tocar em
 * issue nenhuma. `outcomes` aqui são fixtures — nunca resultado de um
 * `ensureAlarmIssue` real (nenhum `gh` é chamado por este helper).
 */
describe("notifyEditorForOutcomes (#7960)", () => {
  function outcome(overrides: Partial<AlarmFindingOutcome> = {}): AlarmFindingOutcome {
    return {
      check: "linkedin-weekly-staleness",
      fingerprint: "26w32",
      issueNumber: 5404,
      url: "https://github.com/vjpixel/diaria-studio/issues/5404",
      action: "created",
      ...overrides,
    };
  }

  it("nenhum outcome (findingOutcomes vazio) — nunca manda e-mail, buildMessage nunca é chamado", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = mock.fn((_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" }));
    const result = await notifyEditorForOutcomes([], "acao", buildMessage, { sendPush, emailPolicy: "urgent_only" });
    assert.equal(result.emailSent, false);
    assert.deepEqual(result.qualifying, []);
    assert.equal(buildMessage.mock.callCount(), 0);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'acao' sob 'urgent_only': issue criada, mas NUNCA manda e-mail (tabela do #7957 — staleness/drift são issue-only)", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = mock.fn((_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" }));
    const result = await notifyEditorForOutcomes([outcome({ action: "created" })], "acao", buildMessage, {
      sendPush,
      emailPolicy: "urgent_only",
    });
    assert.equal(result.emailSent, false);
    assert.deepEqual(result.qualifying, []);
    assert.equal(buildMessage.mock.callCount(), 0);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'urgente' + action 'created' sob 'urgent_only': manda e-mail, buildMessage recebe só os outcomes qualificantes", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const created = outcome({ action: "created" });
    const reused = outcome({ fingerprint: "26w33", action: "reused", issueNumber: 5500 });
    const buildMessage = mock.fn((q: readonly AlarmFindingOutcome[]) => ({ subject: `${q.length} achado(s)`, body: "b" }));
    const result = await notifyEditorForOutcomes([created, reused], "urgente", buildMessage, {
      sendPush,
      emailPolicy: "urgent_only",
    });
    assert.equal(result.emailSent, true);
    assert.deepEqual(result.qualifying, [created]);
    assert.equal(buildMessage.mock.callCount(), 1);
    assert.deepEqual(buildMessage.mock.calls[0]!.arguments[0], [created]);
    const [message] = sendPush.mock.calls[0]!.arguments;
    assert.equal((message as PushMessage).subject, "1 achado(s)");
  });

  it("outcome 'failed' nunca qualifica, em nenhuma severidade/política", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = mock.fn((_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" }));
    const result = await notifyEditorForOutcomes(
      [outcome({ action: "failed", issueNumber: null, url: null, error: "gh indisponível" })],
      "urgente",
      buildMessage,
      { sendPush, emailPolicy: "legacy" },
    );
    assert.equal(result.emailSent, false);
    assert.deepEqual(result.qualifying, []);
    assert.equal(sendPush.mock.callCount(), 0);
  });

  it("severity 'acao' sob 'legacy' (rollback): manda e-mail (comportamento pré-#7957 preservado)", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = mock.fn((_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" }));
    const result = await notifyEditorForOutcomes([outcome({ action: "reused" })], "acao", buildMessage, {
      sendPush,
      emailPolicy: "legacy",
    });
    assert.equal(result.emailSent, true);
    assert.equal(result.qualifying.length, 1);
  });

  it("propaga emailError quando sendPush falha", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: false, error: "smtp indisponível" }));
    const buildMessage = () => ({ subject: "s", body: "b" });
    const result = await notifyEditorForOutcomes([outcome({ action: "created" })], "urgente", buildMessage, {
      sendPush,
      emailPolicy: "urgent_only",
    });
    assert.equal(result.emailSent, false);
    assert.equal(result.emailError, "smtp indisponível");
  });
});

/**
 * `legacyResendIntent` (#8271) — regressão achada no review consolidado da
 * rodada `/diaria-overnight` 260917b sobre a migração #8251: sob
 * `email_policy: "legacy"`, `shouldEmailForIssueOutcome` tratava
 * `action: "reused"` igual a `"created"`, reintroduzindo o e-mail duplicado
 * que a dedup POR-SCRIPT (`lastAlarmedCycle`/`lastAlarmedDay`) impedia antes
 * de `linkedin-weekly-staleness-alarm.ts`/`meta-capi-staleness-alarm.ts`
 * migrarem pro portão. Ao mesmo tempo, `on-hold-vencimento-alarm.ts`/
 * `route-marker-staleness-alarm.ts` (citados nominalmente na #7960) DEPENDEM
 * de reenvio periódico intencional em `"reused"` — o fix não pode
 * silenciá-los.
 */
describe("shouldEmailForIssueOutcome + legacyResendIntent (#8271)", () => {
  const created: AlarmIssueResult = { issueNumber: 1, url: "u", action: "created" };
  const reused: AlarmIssueResult = { issueNumber: 1, url: "u", action: "reused" };
  const reopened: AlarmIssueResult = { issueNumber: 1, url: "u", action: "reopened" };
  const updated: AlarmIssueResult = { issueNumber: 1, url: "u", action: "updated" };

  it("default (sem legacyResendIntent) preserva o comportamento histórico: 'reused' ainda e-mailia sob legacy", () => {
    assert.equal(shouldEmailForIssueOutcome("acao", reused, "legacy"), true);
    assert.equal(shouldEmailForIssueOutcome("acao", updated, "legacy"), true);
  });

  it("'dedupe-new-occurrences-only': só 'created'/'reopened' e-mailiam sob legacy, 'reused'/'updated' não", () => {
    assert.equal(shouldEmailForIssueOutcome("acao", created, "legacy", "dedupe-new-occurrences-only"), true);
    assert.equal(shouldEmailForIssueOutcome("acao", reopened, "legacy", "dedupe-new-occurrences-only"), true);
    assert.equal(shouldEmailForIssueOutcome("acao", reused, "legacy", "dedupe-new-occurrences-only"), false);
    assert.equal(shouldEmailForIssueOutcome("acao", updated, "legacy", "dedupe-new-occurrences-only"), false);
  });

  it("'resend-every-run' explícito é equivalente ao default", () => {
    assert.equal(shouldEmailForIssueOutcome("acao", reused, "legacy", "resend-every-run"), true);
  });

  it("legacyResendIntent não afeta 'urgent_only' (já é dedupe por construção)", () => {
    assert.equal(shouldEmailForIssueOutcome("urgente", created, "urgent_only", "dedupe-new-occurrences-only"), true);
    assert.equal(shouldEmailForIssueOutcome("urgente", reused, "urgent_only", "resend-every-run"), false);
  });
});

describe("notifyEditorForOutcomes + legacyResendIntent (#8271) — critério de pronto da issue", () => {
  function outcome(overrides: Partial<AlarmFindingOutcome> = {}): AlarmFindingOutcome {
    return {
      check: "meta-capi-staleness",
      fingerprint: "stale",
      issueNumber: 7001,
      url: "https://github.com/vjpixel/diaria-studio/issues/7001",
      action: "created",
      ...overrides,
    };
  }

  it("2 execuções seguidas do MESMO alarme na MESMA janela sob 'legacy': 1 e-mail só (piloto dedupe)", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = (_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" });
    const deps = { sendPush, emailPolicy: "legacy" as const, legacyResendIntent: "dedupe-new-occurrences-only" as const };

    // 1ª execução: issue recém-criada -> e-mail.
    const first = await notifyEditorForOutcomes([outcome({ action: "created" })], "acao", buildMessage, deps);
    assert.equal(first.emailSent, true);

    // 2ª execução, mesma janela: mesmo fingerprint reusa a issue -> SEM e-mail.
    const second = await notifyEditorForOutcomes([outcome({ action: "reused" })], "acao", buildMessage, deps);
    assert.equal(second.emailSent, false);
    assert.deepEqual(second.qualifying, []);

    assert.equal(sendPush.mock.callCount(), 1, "e-mail deveria ter sido enviado exatamente 1 vez nas 2 execuções");
  });

  it("remetente de reenvio periódico intencional (default, sem legacyResendIntent) continua reenviando em 'reused' sob legacy", async () => {
    const sendPush = mock.fn(async (_message: PushMessage) => ({ ok: true }));
    const buildMessage = (_q: readonly AlarmFindingOutcome[]) => ({ subject: "s", body: "b" });
    // Sem legacyResendIntent — mesmo padrão de on-hold-vencimento-alarm.ts/
    // route-marker-staleness-alarm.ts, que chamam notifyEditor() sem passar
    // o campo (fingerprint derivado do CONJUNTO de achados; achado que
    // persiste semana após semana produz o mesmo fingerprint -> "reused").
    const deps = { sendPush, emailPolicy: "legacy" as const };

    const week1 = await notifyEditorForOutcomes(
      [outcome({ check: "route-marker-staleness-alarm", fingerprint: "conjunto-x", action: "created" })],
      "acao",
      buildMessage,
      deps,
    );
    assert.equal(week1.emailSent, true);

    const week2 = await notifyEditorForOutcomes(
      [outcome({ check: "route-marker-staleness-alarm", fingerprint: "conjunto-x", action: "reused" })],
      "acao",
      buildMessage,
      deps,
    );
    assert.equal(week2.emailSent, true, "achado ainda pendente na semana seguinte deve continuar e-mailiando");

    assert.equal(sendPush.mock.callCount(), 2);
  });
});
