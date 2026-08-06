/**
 * test/clarice-novos-html-state-4347.test.ts (#4347 Etapa 4, D12)
 *
 * `clarice-novos-html-state.ts` — a lógica de decisão (`shouldSendTest`,
 * round-trip do state) já tem cobertura completa em
 * test/clarice-novos-state.test.ts. Aqui cobrimos só a integração da CLI:
 * resolução do HTML via `monthlyDir` (path fixo — `MONTHLY_BASE` não é
 * injetável, mesmo padrão de `clarice-schedule-group.ts`, então testamos
 * contra o erro determinístico de HTML ausente em vez de reescrever o
 * pipeline de resolução de path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main, runReconcile } from "../scripts/clarice-novos-html-state.ts";

function captureAll(fn: () => void): { logs: string[]; errs: string[]; exitCode: number | undefined } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode: number | undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  // @ts-expect-error stub
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error("mock-exit"), { __mockExit: true });
  };
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode };
}

/**
 * Variante async de `captureAll` — necessária pra `runReconcile` (#4670):
 * chamar uma função `async` NUNCA lança sincronamente pro caller mesmo que o
 * `process.exit` mockado lance dentro do prefixo síncrono da função (semântica
 * de `async function` — qualquer throw antes do 1º `await` vira Promise
 * rejeitada, não um throw síncrono). `main()` continua síncrono de propósito
 * (ver docstring do CLI) — só `runReconcile` precisa desta variante.
 */
async function captureAllAsync(fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode: number | undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  // @ts-expect-error stub
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error("mock-exit"), { __mockExit: true });
  };
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { logs, errs, exitCode };
}

test("main: --cycle ausente -> erro claro, exit 1", () => {
  const { exitCode, errs } = captureAll(() => main([]));
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /--cycle/.test(e)));
});

test("main: ciclo cujo HTML não existe -> erro claro, exit 1 (nunca lança exceção não tratada)", () => {
  // "9901-02" é uma forma VÁLIDA de ciclo ({YYMM}-{MM}, envio=conteúdo+1) que
  // certamente não existe em data/monthly/ — exercita o branch de HTML
  // ausente sem depender de nenhum fixture real no disco.
  const { exitCode, errs } = captureAll(() => main(["--cycle", "9901-02"]));
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /HTML não encontrado/.test(e)));
});

// ---------------------------------------------------------------------------
// --finalize-scheduled (#4670) — mesma limitação de fixture que os testes
// acima (`monthlyDir`/`MONTHLY_BASE` não são injetáveis): só o branch
// determinístico de HTML ausente é exercitado aqui; a lógica de estado em si
// (`buildFinalizeScheduledState`) já tem cobertura completa e isolada em
// test/clarice-novos-state.test.ts.
// ---------------------------------------------------------------------------

test("main: --finalize-scheduled com ciclo sem HTML -> mesmo erro determinístico (falha ANTES de tocar o state)", () => {
  const { exitCode, errs } = captureAll(() =>
    main(["--cycle", "9901-02", "--finalize-scheduled", "--campaign-id", "120", "--list-id", "106", "--scheduled-at", "2026-08-06T10:00:00-03:00"]),
  );
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /HTML não encontrado/.test(e)));
});

// ---------------------------------------------------------------------------
// runReconcile (#4670) — só os branches que NÃO tocam a rede são testados
// aqui (instrução explícita: nunca chamar a Brevo ao vivo nestes testes). O
// branch "há pendingSend, consulta a Brevo" é coberto pela lógica pura
// `reconcilePendingSend` (fetchStatus injetado/mockado) em
// test/clarice-novos-state.test.ts — nunca pela CLI.
// ---------------------------------------------------------------------------

test("runReconcile: sem state file -> 'no-pending', sem tentar rede (não precisa de API key)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-reconcile-empty-"));
  const savedClarice = process.env.BREVO_CLARICE_API_KEY;
  const savedBase = process.env.BREVO_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_API_KEY;
  try {
    const { exitCode, logs, errs } = await captureAllAsync(() => runReconcile(["--data-root", dir]));
    assert.equal(exitCode, undefined); // nunca chegou a checar API key, muito menos abortar
    assert.ok(errs.some((e) => /nada a reconciliar/.test(e)));
    assert.ok(logs.some((l) => /"action": "no-pending"/.test(l)));
  } finally {
    if (savedClarice !== undefined) process.env.BREVO_CLARICE_API_KEY = savedClarice;
    if (savedBase !== undefined) process.env.BREVO_API_KEY = savedBase;
  }
});

test("runReconcile: state SEM pendingSend -> 'no-pending', mesmo sem API key definida", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-reconcile-no-pending-"));
  // Grava um state válido, mas sem pendingSend (rodada imediata normal).
  const { writeNovosState } = await import("../scripts/lib/clarice-novos-state.ts");
  writeNovosState(
    {
      lastRunAt: "2026-08-01T00:00:00.000Z",
      lastHtmlSha256: "sha-x",
      lastCycle: "2606-07",
      lastListId: 1,
      lastCampaignId: 2,
      sentCount: 50,
      pendingSend: null,
    },
    dir,
  );
  const savedClarice = process.env.BREVO_CLARICE_API_KEY;
  const savedBase = process.env.BREVO_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_API_KEY;
  try {
    const { exitCode, errs } = await captureAllAsync(() => runReconcile(["--data-root", dir]));
    assert.equal(exitCode, undefined);
    assert.ok(errs.some((e) => /nada a reconciliar/.test(e)));
  } finally {
    if (savedClarice !== undefined) process.env.BREVO_CLARICE_API_KEY = savedClarice;
    if (savedBase !== undefined) process.env.BREVO_API_KEY = savedBase;
  }
});

test("runReconcile: state COM pendingSend mas SEM API key -> aborta ANTES de tentar a rede", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-reconcile-no-key-"));
  const { writeNovosState } = await import("../scripts/lib/clarice-novos-state.ts");
  writeNovosState(
    {
      lastRunAt: "2026-08-05T12:00:00.000Z",
      lastHtmlSha256: "sha-agendado",
      lastCycle: "2607-08",
      lastListId: 10,
      lastCampaignId: 20,
      sentCount: 200,
      pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
    },
    dir,
  );
  const savedClarice = process.env.BREVO_CLARICE_API_KEY;
  const savedBase = process.env.BREVO_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_API_KEY;
  try {
    const { exitCode, errs } = await captureAllAsync(() => runReconcile(["--data-root", dir]));
    assert.equal(exitCode, 1);
    assert.ok(errs.some((e) => /BREVO_CLARICE_API_KEY/.test(e)));
  } finally {
    if (savedClarice !== undefined) process.env.BREVO_CLARICE_API_KEY = savedClarice;
    if (savedBase !== undefined) process.env.BREVO_API_KEY = savedBase;
  }
});
