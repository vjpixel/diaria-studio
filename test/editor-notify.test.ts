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
import { notifyEditor, resolveEmailPolicy, shouldEmailForIssueOutcome } from "../scripts/lib/editor-notify.ts";
import type { AlarmIssueResult } from "../scripts/lib/alarm-issues.ts";
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
