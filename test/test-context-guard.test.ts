/**
 * test/test-context-guard.test.ts (#8290)
 *
 * Regressão do incidente #8287: `main()` de um `*-alarm.ts` chamado de
 * dentro de um teste, sem `--dry-run` e sem nenhum mock injetado, não pode
 * conseguir abrir issue nem mandar e-mail de verdade — a barreira precisa
 * ser mecânica (`scripts/lib/test-context-guard.ts`), não prosa.
 *
 * NENHUM teste aqui toca `gh`/Gmail reais: os testes de
 * `defaultAlarmGhRun`/`sendPushNotification` abaixo dependem da barreira
 * recusar ANTES de tocar rede — o próprio ponto do teste é provar que essa
 * recusa acontece. Se a barreira estivesse quebrada, o pior caso seria
 * `defaultAlarmGhRun(["--version"], ...)` (leitura local, sem rede/mutação)
 * — nunca um argumento que crie/altere estado real (regra "nunca reproduza
 * o incidente ao testar a correção dele", CLAUDE.md via prompt de
 * dispatch).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isNodeTestContext, testContextRefusalMessage } from "../scripts/lib/test-context-guard.ts";
import { defaultAlarmGhRun } from "../scripts/lib/alarm-issues.ts";
import { sendPushNotification } from "../scripts/lib/push-notify.ts";
import { notifyEditor } from "../scripts/lib/editor-notify.ts";
import { main, loadState, saveState } from "../scripts/check-acquisition-health.ts";
import { emptyAcquisitionHealthState } from "../scripts/lib/acquisition-health.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";

describe("isNodeTestContext (#8290) — pura", () => {
  it("true quando NODE_TEST_CONTEXT está presente", () => {
    assert.equal(isNodeTestContext({ NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv), true);
  });

  it("false quando ausente ou vazio", () => {
    assert.equal(isNodeTestContext({} as NodeJS.ProcessEnv), false);
    assert.equal(isNodeTestContext({ NODE_TEST_CONTEXT: "" } as NodeJS.ProcessEnv), false);
  });

  it("true sob o processo REAL deste arquivo de teste (npx tsx --test)", () => {
    // Confirma que a detecção nativa (sem override de env) reconhece o
    // próprio test runner que está executando este arquivo — é essa
    // detecção, e não a versão com env injetado acima, que protege
    // defaultAlarmGhRun/sendPushNotification em produção.
    assert.equal(isNodeTestContext(), true);
  });
});

describe("testContextRefusalMessage (#8290) — pura", () => {
  it("mensagem cita #8290 e o detalhe passado", () => {
    const msg = testContextRefusalMessage("gh issue create");
    assert.match(msg, /#8290/);
    assert.match(msg, /gh issue create/);
    assert.match(msg, /RECUSADO/);
  });
});

describe("defaultAlarmGhRun (#8290) — recusa sob contexto de teste", () => {
  it("nunca chama gh de verdade: devolve status!=0 com o motivo em stderr", () => {
    // --version é leitura local inofensiva — só seria de fato executada se
    // a barreira estivesse quebrada (pior caso aceitável pra este teste).
    const result = defaultAlarmGhRun(["--version"], ".");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RECUSADO/);
    assert.match(result.stderr, /#8290/);
    assert.equal(result.stdout, "");
  });
});

describe("sendPushNotification (#8290) — recusa sob contexto de teste quando sendFn não é injetado", () => {
  it("sem sendFn: nunca chama sendGmailMessage de verdade, devolve {ok:false, error}", async () => {
    const result = await sendPushNotification({ subject: "s", body: "b" }, { to: "editor@example.com" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /RECUSADO/);
    assert.match(result.error ?? "", /#8290/);
  });

  it("com sendFn injetado (mock): a barreira não interfere — comportamento normal preservado", async () => {
    let called = false;
    const result = await sendPushNotification(
      { subject: "s", body: "b" },
      {
        to: "editor@example.com",
        sendFn: (async () => {
          called = true;
          return { id: "1", threadId: "1" };
        }) as any,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(called, true);
  });
});

describe("notifyEditor (#8290) — sem ghRun/sendPush injetados, sob contexto de teste", () => {
  it("severity 'urgente' sem nenhum mock: nunca cria issue nem manda e-mail, action vira 'failed'", async () => {
    const log = mock.fn();
    const result = await notifyEditor(
      { check: "x-alarm-8290", fingerprint: "y", severity: "urgente", subject: "s", body: "b" },
      { log, emailPolicy: "urgent_only" },
    );
    assert.equal(result.issue?.action, "failed");
    assert.match(result.issue?.error ?? "", /RECUSADO/);
    assert.equal(result.emailSent, false);
    // ensureAlarmIssue falhando é logado (comportamento pré-existente do
    // portão) — confirma que a recusa não é silenciosa.
    assert.equal(log.mock.callCount(), 1);
  });
});

function sub(overrides: Partial<BeehiivBackupSubscriber> = {}): BeehiivBackupSubscriber {
  return {
    email: "x@example.com",
    status: "active",
    created: 1_700_000_000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: 30, total_unique_clicked: 1 },
    ...overrides,
  };
}

describe("check-acquisition-health.ts main() (#8290, reprodução do incidente #8287)", () => {
  it("chamado SEM --dry-run e SEM nenhum mock, com um achado real: lança em vez de abrir issue/e-mail real", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "acq-health-8290-"));
    try {
      const beehiivConfigPath = join(tmpRoot, "platform.config.beehiiv.json");
      writeFileSync(beehiivConfigPath, JSON.stringify({ publishing: { newsletter: { subscriber_backend: "beehiiv" } } }));

      const root = join(tmpRoot, "root-newchannel");
      const statePath = join(tmpRoot, "state-newchannel.json");

      mkdirSync(join(root, "2026-08-02"), { recursive: true });
      writeFileSync(
        join(root, "2026-08-02", "subscribers.jsonl"),
        `${JSON.stringify(sub({ email: "a@x.com", utm_source: "google-ads" }))}\n`,
      );
      mkdirSync(join(root, "2026-08-09"), { recursive: true });
      writeFileSync(
        join(root, "2026-08-09", "subscribers.jsonl"),
        [sub({ email: "a@x.com", utm_source: "google-ads" }), sub({ email: "c@x.com", utm_source: "sparkloop-novo" })]
          .map((s) => JSON.stringify(s))
          .join("\n") + "\n",
      );

      // Seed state como se a 1ª rodada já tivesse rodado sobre 2026-08-02
      // — reproduz exatamente o setup do teste "2 snapshots com canal novo
      // aparecendo" (test/check-acquisition-health-script.test.ts), só que
      // desta vez SEM --dry-run — é essa combinação (achado real + sem
      // --dry-run + sem mock) que abriu a #8287.
      saveState(
        { ...emptyAcquisitionHealthState(), knownChannels: ["google-ads"], lastCheckedSnapshotDate: "2026-08-02" },
        statePath,
      );

      await assert.rejects(
        () => main(["--root", root, "--state", statePath, "--config", beehiivConfigPath]), // sem --dry-run, de propósito
        /RECUSADO|#8290/,
      );

      // state.json nunca avança como se o alarme tivesse sido tratado —
      // mesmo comportamento de qualquer outra falha de ensureAlarmIssue
      // (fail-soft do #5112: cursor só avança em sucesso).
      const state = loadState(statePath);
      assert.equal(state.lastCheckedSnapshotDate, "2026-08-02");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
