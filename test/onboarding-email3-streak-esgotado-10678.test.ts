/**
 * test/onboarding-email3-streak-esgotado-10678.test.ts (#10678)
 *
 * `consecutive_email3_failures` só era atualizado em rodada que TENTOU
 * `email3_campaign`, mas o `EMAIL3_CHECK` do `onboarding-continuity-alarm.ts`
 * avalia o valor gravado toda rodada. Depois do flip pro Kit (#7922) as
 * escadas Brevo se esgotam: se as 2 últimas tentativas falharam e o cohort
 * restante virou `skipped_backlog_descartado`, não há mais tentativa, o streak
 * congela em ≥2 e a issue do alarme fica aberta pra sempre.
 *
 * Fix: rodada sem tentativa zera o streak quando não sobra e-mail 3 da Brevo
 * alcançável; com e-mail 3 Brevo ainda pendente, mantém (a próxima tentativa
 * decide). Subprocesso real contra mock HTTP local do Kit (molde do #7670).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  hasReachableBrevoEmail3,
  nextEmail3FailureStreak,
  EMAIL3_FAILURE_ALARM_THRESHOLD_RUNS,
  type OnboardingEntry,
} from "../scripts/lib/onboarding-state.ts";
import { evaluateContinuityRound, EMAIL3_CHECK } from "../scripts/onboarding-continuity-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "onboarding-welcome-run.ts");
const DAY = 86_400;

function spawnScript(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { env, timeout: 30_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", rej);
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

function startMockKit(): Promise<{ server: Server; url: string }> {
  return new Promise((res) => {
    const server = createServer((req, rsp) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      rsp.setHeader("content-type", "application/json");
      if (parsed.pathname === "/subscribers") {
        rsp.writeHead(200);
        rsp.end(
          JSON.stringify({
            subscribers: [],
            pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
          }),
        );
        return;
      }
      const m = /^\/subscribers\/(\d+)(\/stats)?$/.exec(parsed.pathname);
      if (m) {
        rsp.writeHead(200);
        if (m[2]) rsp.end(JSON.stringify({ subscriber: { stats: { total_unique_opens: 1 } } }));
        else
          rsp.end(
            JSON.stringify({
              subscriber: { id: Number(m[1]), email_address: `${m[1]}@example.com`, state: "active", created_at: "2026-10-01T12:00:00Z", fields: {} },
            }),
          );
        return;
      }
      rsp.writeHead(404);
      rsp.end(JSON.stringify({ error: `rota inesperada ${parsed.pathname}` }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function env(kitUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_API_URL: kitUrl,
    KIT_API_KEY: "test-kit-key-10678",
    BEEHIIV_API_KEY: "",
    BEEHIIV_PUBLICATION_ID: "",
    BREVO_DIARIA_API_KEY: "test-brevo-key-10678",
  };
}

function entry(id: number, ageDays: number, over: Partial<OnboardingEntry> = {}): OnboardingEntry {
  const nowSec = Math.floor(Date.now() / 1000);
  const iso = new Date((nowSec - ageDays * DAY) * 1000).toISOString();
  return {
    subscription_id: String(id),
    email: `${id}@example.com`,
    status_detectado: "active",
    created_at: nowSec - ageDays * DAY,
    detected_at: iso,
    email1_sent_at: iso,
    email1_brevo_id: null,
    email2_sent_at: iso,
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
    kit_subscriber_id: id,
    ...over,
  } as OnboardingEntry;
}

function fixture(dir: string, entries: OnboardingEntry[]) {
  const nowSec = Math.floor(Date.now() / 1000);
  const configPath = resolve(dir, "platform.config.json");
  const storePath = resolve(dir, "store.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      onboarding: {
        enabled: true,
        snippets_dir: resolve(dir, "snippets"), // inexistente: nenhum envio é planejado
        store_path: storePath,
        email3_days: 10,
        sender_email: "oi@example.com",
        sender_name: "teste",
        kit_transport: { enabled: true },
      },
      publishing: { newsletter: { subscriber_backend: "kit" } },
    }),
  );
  writeFileSync(
    storePath,
    JSON.stringify({
      version: 1,
      last_detection_cursor: nowSec - 60,
      last_detection_backend: "kit",
      d10_brevo_list_id: null,
      consecutive_email3_failures: 2,
      last_email3_error: "Folder id is missing",
      entries: Object.fromEntries(entries.map((e) => [e.subscription_id, e])),
    }),
  );
  return { configPath, storePath };
}

const cohortEsgotado = () => [
  // Cohort Brevo das tentativas que falharam: descartado (#10603), terminal.
  entry(6100000001, 40, { email1_transport: "brevo", email3_state: "skipped_backlog_descartado", email3_decided_at: "2026-10-20T12:00:00.000Z" }),
  // E-mail 3 pendente, mas do KIT: não é tentativa possível da Brevo.
  entry(6100000002, 15, { email1_transport: "kit" }),
  // Cadastro sem confirmação (sem âncora da régua): o gate do e-mail 3 nunca abre.
  entry(6100000003, 2, { status_detectado: "inactive", email1_sent_at: null, email2_sent_at: null }),
];

async function runSend(entries: OnboardingEntry[]) {
  const { server, url } = await startMockKit();
  const dir = mkdtempSync(resolve(tmpdir(), "diaria-10678-"));
  try {
    const { configPath, storePath } = fixture(dir, entries);
    const r = await spawnScript(["--config", configPath, "--store", storePath, "--send"], env(url));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    return JSON.parse(readFileSync(storePath, "utf8"));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("streak do e-mail 3 com o cohort Brevo esgotado (#10678)", () => {
  it("REGRESSÃO: streak 2 + rodada sem cohort possível → streak 0 e o alarme fecha", async () => {
    const store = await runSend(cohortEsgotado());
    assert.equal(store.consecutive_email3_failures, 0, "sem tentativa possível o streak não pode ficar congelado");
    assert.equal(store.last_email3_error, null);

    const round = evaluateContinuityRound({ storeExists: true, corrupted: false, store, cfgRead: { enabled: true, error: null } });
    assert.ok(round.evaluatedChecks.has(EMAIL3_CHECK), "o check é avaliado (store lido) — é o que fecha a issue aberta");
    assert.ok(!round.findings.some((f) => f.check === EMAIL3_CHECK), "sem achado do e-mail 3");
  });

  it("com e-mail 3 da Brevo ainda pendente (cohort pode vir), o streak é mantido", async () => {
    // D+5: âncora existe, e-mail 3 ainda não venceu — sem tentativa HOJE.
    const store = await runSend([...cohortEsgotado(), entry(6100000004, 5, { email1_transport: "brevo" })]);
    assert.equal(store.consecutive_email3_failures, 2);
    assert.equal(store.last_email3_error, "Folder id is missing");
    const round = evaluateContinuityRound({ storeExists: true, corrupted: false, store, cfgRead: { enabled: true, error: null } });
    assert.ok(round.findings.some((f) => f.check === EMAIL3_CHECK), "falha real ainda pode se repetir — alarme segue aberto");
  });
});

describe("helpers puros (#10678)", () => {
  it("nextEmail3FailureStreak", () => {
    assert.equal(nextEmail3FailureStreak(2, "failed", true), 3);
    assert.equal(nextEmail3FailureStreak(2, "ok", true), 0);
    assert.equal(nextEmail3FailureStreak(2, "no_attempt", true), 2);
    assert.equal(nextEmail3FailureStreak(EMAIL3_FAILURE_ALARM_THRESHOLD_RUNS, "no_attempt", false), 0);
  });

  it("hasReachableBrevoEmail3 ignora terminal, dono Kit e entrada sem âncora", () => {
    assert.equal(hasReachableBrevoEmail3(cohortEsgotado(), true), false);
    assert.equal(hasReachableBrevoEmail3([entry(1, 5, { email1_transport: "brevo" })], true), true);
    // Rollback (switch desligado): a Brevo volta a ser dona do e-mail 3 do Kit.
    assert.equal(hasReachableBrevoEmail3([entry(1, 15, { email1_transport: "kit" })], false), true);
  });
});
