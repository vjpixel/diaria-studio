/**
 * test/build-hub-page-fact-check-5102.test.ts (#5102, follow-up do #5060)
 *
 * Cobre o call site novo de `scripts/build-hub-page.ts --check-facts`: o
 * gate MECÂNICO (`checkHubFacts`) já existia antes desta issue e roda sempre
 * (dentro de `renderHubPage`/`validateHubContent`); o que faltava era
 * conectar o gate BLOQUEANTE do agente `fact-checker mode:hub` (#5060 Parte
 * B2) a um caller real — este arquivo cobre esse caller.
 *
 * Dois blocos:
 *  - `decideHubFactCheckGate` — a decisão PURA (sem I/O, sem `process.exit`),
 *    testada isolada com fixtures sintéticas.
 *  - CLI `--check-facts` via subprocess (`spawnSync`, mesmo padrão de
 *    `test/apply-gate-edits.test.ts`) — cobre o fluxo real ponta a ponta
 *    (extract-hub-facts.ts rodado via runTsx + leitura de
 *    report/approvals + `process.exit(2)` nos 2 ramos de bloqueio).
 *    SEMPRE roda com `--check` junto — sem isso, `buildOne` escreveria por
 *    cima do `.generated.ts` REAL commitado do hub usado no teste.
 *    `--fact-check-dir <tmp>` aponta o gate pra um dir temporário — nunca
 *    toca `data/hub-fact-check/` real (que numa máquina local é a junction
 *    OneDrive).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideHubFactCheckGate } from "../scripts/build-hub-page.ts";
import type { HubFactGateClaim, HubFactGateContradiction } from "../scripts/lib/shared/hub-fact-gate.ts";

// ---------------------------------------------------------------------------
// decideHubFactCheckGate — pure
// ---------------------------------------------------------------------------

describe("decideHubFactCheckGate (#5102) — pure", () => {
  const SUSTAINED: HubFactGateClaim = { claim_id: "s0p0c0", verdict: "SUSTAINED" };
  const DIVERGENT_UNAPPROVED: HubFactGateClaim = { claim_id: "s0p1c0", verdict: "DIVERGENT" };
  const NO_CONTRADICTIONS: HubFactGateContradiction[] = [];

  it("sem relatório + sem --skip-fact-check → abort_missing_verification (reason: no_report)", () => {
    const decision = decideHubFactCheckGate({
      reportExists: false,
      reportIsFresh: false,
      claims: [],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: false,
    });
    assert.deepEqual(decision, { action: "abort_missing_verification", reason: "no_report" });
  });

  it("sem relatório + --skip-fact-check → warn_and_proceed (reason: no_report) — nunca silencioso, mas prossegue", () => {
    const decision = decideHubFactCheckGate({
      reportExists: false,
      reportIsFresh: false,
      claims: [],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: true,
    });
    assert.deepEqual(decision, { action: "warn_and_proceed", reason: "no_report" });
  });

  it("relatório existe mas está STALE (mais antigo que o manifesto atual) + sem --skip-fact-check → abort_missing_verification (reason: stale_report), mesmo com claims todos SUSTAINED", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: false,
      claims: [SUSTAINED],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: false,
    });
    assert.deepEqual(decision, { action: "abort_missing_verification", reason: "stale_report" });
  });

  it("relatório STALE + --skip-fact-check → warn_and_proceed (reason: stale_report)", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: false,
      claims: [DIVERGENT_UNAPPROVED],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: true,
    });
    assert.deepEqual(decision, { action: "warn_and_proceed", reason: "stale_report" });
  });

  it("relatório FRESCO com gate.blocked=true (claim DIVERGENT não aprovado) → abort_blocked, independente de --skip-fact-check", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: true,
      claims: [SUSTAINED, DIVERGENT_UNAPPROVED],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: false,
    });
    assert.equal(decision.action, "abort_blocked");
    assert.deepEqual((decision as { blockingItems: string[] }).blockingItems, ["s0p1c0"]);
  });

  it("relatório FRESCO com claim DIVERGENT mas APROVADO explicitamente → proceed (gate.blocked=false depois da aprovação)", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: true,
      claims: [SUSTAINED, DIVERGENT_UNAPPROVED],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: ["s0p1c0"],
      skipFactCheck: false,
    });
    assert.deepEqual(decision, { action: "proceed" });
  });

  it("relatório FRESCO com gate.blocked=false (tudo SUSTAINED, sem contradições) → proceed", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: true,
      claims: [SUSTAINED],
      contradictions: NO_CONTRADICTIONS,
      approvedClaimIds: [],
      skipFactCheck: false,
    });
    assert.deepEqual(decision, { action: "proceed" });
  });

  it("relatório FRESCO com contradição não aprovada → abort_blocked (independente de resolvable_with_source_url, mesma regra de recomputeHubFactGate)", () => {
    const decision = decideHubFactCheckGate({
      reportExists: true,
      reportIsFresh: true,
      claims: [SUSTAINED],
      contradictions: [{ claim_id: "contradiction0", resolvable_with_source_url: "https://fonte.example/resolve" }],
      approvedClaimIds: [],
      skipFactCheck: false,
    });
    assert.equal(decision.action, "abort_blocked");
    assert.deepEqual((decision as { blockingItems: string[] }).blockingItems, ["contradiction0"]);
  });
});

// ---------------------------------------------------------------------------
// CLI --check-facts (subprocess, mesmo padrão de test/apply-gate-edits.test.ts)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "build-hub-page.ts");
// Hub real qualquer (precisa de {slug}-sources.generated.json existente em
// scripts/lib/hubs/) — extract-hub-facts.ts falha sem ele. --check (não só
// --check-facts) é OBRIGATÓRIO em toda invocação deste bloco: sem ele
// buildOne escreveria por cima do .generated.ts REAL commitado do hub.
const TEST_HUB = "meta-ai";

function runCli(args: string[], timeout = 30000) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout,
  });
}

function withTempFactCheckDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hub-fact-check-5102-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CLI build-hub-page.ts --check-facts (#5102)", () => {
  it("--hub <inexistente> --check-facts → exit 2, stderr com mensagem clara (não stack trace cru) — runFactCheckGate trata a falha do subprocess extract-hub-facts.ts", () => {
    withTempFactCheckDir((dir) => {
      const result = runCli(["--hub", "hub-que-nao-existe", "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /\[build-hub-page\] hub-que-nao-existe: extract-hub-facts\.ts falhou/);
      // Não é um stack trace Node cru (TypeError/at Object.../node:internal) —
      // é a mensagem tratada do catch em runFactCheckGate.
      assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/);
      assert.doesNotMatch(result.stderr, /node:internal/);
    });
  });

  it("sem relatório + sem --skip-fact-check → exit 2, stderr avisa que o gate não foi verificado", () => {
    withTempFactCheckDir((dir) => {
      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /nenhum relatório de fact-check encontrado/);
      assert.match(result.stderr, /--skip-fact-check/);
      // O manifesto FOI preparado (extract-hub-facts.ts rodou) mesmo sem
      // relatório — só o build do asset é que fica bloqueado.
      assert.ok(existsSync(join(dir, `${TEST_HUB}-facts.json`)), "manifesto deveria ter sido escrito mesmo sem relatório");
    });
  });

  it("sem relatório + --skip-fact-check → exit 0, avisa mas prossegue (--check impede escrita real do asset)", () => {
    withTempFactCheckDir((dir) => {
      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--skip-fact-check", "--fact-check-dir", dir]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /AVISO/);
      assert.match(result.stderr, /nenhum relatório de fact-check encontrado/);
    });
  });

  it("relatório FRESCO com gate.blocked=true (claim DIVERGENT não aprovado) → exit 2, stderr cita BLOQUEADO + o claim_id", () => {
    withTempFactCheckDir((dir) => {
      // 1ª chamada só pra gerar o manifesto (sem relatório ainda) — exit 2
      // esperado aqui, ignorado; o objetivo é só materializar o manifesto
      // com um mtime conhecido pra poder colocar o relatório depois dele.
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      assert.ok(existsSync(manifestPath), "pré-condição: manifesto deveria existir após a 1ª chamada");
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [
            { claim_id: "s0p0c0", verdict: "SUSTAINED" },
            { claim_id: "s0p1c0", verdict: "DIVERGENT" },
          ],
          contradictions: [],
          summary: {},
          gate: { blocked: false, blocking_items: [] }, // #573: deliberadamente ERRADO — o caller nunca confia nisso
        }),
      );
      // Garante determinismo: relatório 10s depois do manifesto (fresco),
      // sem depender de resolução de mtime do filesystem/timing de teste.
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /BLOQUEADO/);
      assert.match(result.stderr, /s0p1c0/);
    });
  });

  it("relatório FRESCO com gate.blocked=false (tudo SUSTAINED) → exit 0, prossegue normal (--check confirma sem escrever o asset real)", () => {
    withTempFactCheckDir((dir) => {
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [{ claim_id: "s0p0c0", verdict: "SUSTAINED" }],
          contradictions: [],
          summary: {},
          gate: { blocked: true, blocking_items: ["s0p0c0"] }, // #573: deliberadamente ERRADO também nesse sentido — recompute deve IGNORAR isso
        }),
      );
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /--check-facts OK/);
    });
  });

  it("relatório FRESCO com claim DIVERGENT, mas aprovado via {slug}-approvals.json → exit 0 (override via arquivo real, não só via decideHubFactCheckGate direto)", () => {
    withTempFactCheckDir((dir) => {
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [
            { claim_id: "s0p0c0", verdict: "SUSTAINED" },
            { claim_id: "s0p1c0", verdict: "DIVERGENT" },
          ],
          contradictions: [],
          summary: {},
          gate: { blocked: true, blocking_items: ["s0p1c0"] },
        }),
      );
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const approvalsPath = join(dir, `${TEST_HUB}-approvals.json`);
      writeFileSync(approvalsPath, JSON.stringify({ approved_claim_ids: ["s0p1c0"], note: "confirmado por outro canal" }));

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /--check-facts OK/);
    });
  });

  it("relatório FRESCO com contradições[] não aprovadas → exit 2, stderr cita BLOQUEADO + o claim_id da contradição (via CLI, não só a função pura)", () => {
    withTempFactCheckDir((dir) => {
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [{ claim_id: "s0p0c0", verdict: "SUSTAINED" }],
          contradictions: [{ claim_id: "contradiction0", resolvable_with_source_url: null }],
          summary: {},
          gate: { blocked: false, blocking_items: [] }, // #573: deliberadamente ERRADO — o caller nunca confia nisso
        }),
      );
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /BLOQUEADO/);
      assert.match(result.stderr, /contradiction0/);
    });
  });

  it("relatório existe mas está STALE (mais antigo que o manifesto atual) → exit 2, mensagem de desatualizado (não BLOQUEADO) mesmo com gate.blocked=false no arquivo", () => {
    withTempFactCheckDir((dir) => {
      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [{ claim_id: "s0p0c0", verdict: "SUSTAINED" }],
          contradictions: [],
          summary: {},
          gate: { blocked: false, blocking_items: [] },
        }),
      );
      // Relatório escrito ANTES do manifesto existir — a próxima chamada
      // regenera o manifesto com um mtime necessariamente mais novo.
      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /desatualizado/);
      assert.doesNotMatch(result.stderr, /BLOQUEADO/);
    });
  });

  it("{slug}-report.json com JSON malformado (vírgula sobrando) → exit 2, stderr nomeia o path exato — não SyntaxError cru", () => {
    withTempFactCheckDir((dir) => {
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      // Vírgula sobrando antes do `}` — erro plausível de edição manual, não hipotético.
      writeFileSync(reportPath, `{"hub": "${TEST_HUB}", "claims": [],}`);
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /não é JSON válido/);
      assert.match(result.stderr, new RegExp(`${TEST_HUB}-report\\.json`));
      assert.doesNotMatch(result.stderr, /SyntaxError: Unexpected/); // mensagem tratada, não o erro Node cru sem contexto
    });
  });

  it("{slug}-approvals.json com JSON malformado (chave não fechada) → exit 2, stderr nomeia o path exato — não SyntaxError cru", () => {
    withTempFactCheckDir((dir) => {
      runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      const manifestPath = join(dir, `${TEST_HUB}-facts.json`);
      const manifestMtimeMs = statSync(manifestPath).mtimeMs;

      const reportPath = join(dir, `${TEST_HUB}-report.json`);
      writeFileSync(
        reportPath,
        JSON.stringify({
          hub: TEST_HUB,
          checked_at: new Date().toISOString(),
          claims: [{ claim_id: "s0p0c0", verdict: "SUSTAINED" }],
          contradictions: [],
          summary: {},
          gate: { blocked: false, blocking_items: [] },
        }),
      );
      const fresh = new Date(manifestMtimeMs + 10_000);
      utimesSync(reportPath, fresh, fresh);

      const approvalsPath = join(dir, `${TEST_HUB}-approvals.json`);
      // Chave não fechada — erro plausível de edição manual, não hipotético.
      writeFileSync(approvalsPath, `{"approved_claim_ids": ["s0p0c0"`);

      const result = runCli(["--hub", TEST_HUB, "--check", "--check-facts", "--fact-check-dir", dir]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /não é JSON válido/);
      assert.match(result.stderr, new RegExp(`${TEST_HUB}-approvals\\.json`));
      assert.doesNotMatch(result.stderr, /SyntaxError: Unexpected/); // mensagem tratada, não o erro Node cru sem contexto
    });
  });
});
