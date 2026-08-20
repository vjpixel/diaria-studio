/**
 * test/brevo-diaria-stage5-dispatch-5772.test.ts (#5772)
 *
 * Cobre `scripts/brevo-diaria-stage5-dispatch.ts` — dispatch do canal Brevo
 * diária dentro da Etapa 5, em paralelo com os demais publicadores. Nenhum
 * spawn/I/O real: `exec`/`readPublished`/`readContacts`/`readPlatformConfig`
 * são injetados (mesmo padrão de `test/brevo-diaria-run.test.ts`, #5192).
 *
 * Cobertura pedida pela issue (#5772):
 *   - falha do sub-script não deriva num throw (fail-soft — o caller
 *     decide o que fazer com `status: "failed"`, nunca aborta os demais
 *     canais da Etapa 5 por conta própria);
 *   - idempotência em resume: campanha já registrada → no-op, nunca re-roda
 *     `brevo-diaria-run.ts --apply` nem cria 2ª campanha.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runStage5BrevoDispatch,
  type ExecFn,
  type ExecResult,
  type Stage5BrevoDeps,
} from "../scripts/brevo-diaria-stage5-dispatch.ts";
import type { BrevoDiariaContact } from "../scripts/lib/brevo-diaria-store.ts";

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr: string): ExecResult {
  return { code: 1, stdout: "", stderr };
}

function makeDeps(overrides: Partial<Stage5BrevoDeps> & { calls?: Array<{ script: string; args: string[] }> } = {}): Stage5BrevoDeps {
  const calls: Array<{ script: string; args: string[] }> = overrides.calls ?? [];
  const handlers: Record<string, ExecResult> = {
    "scripts/brevo-diaria-run.ts": ok(),
    "scripts/publish-daily-brevo.ts": ok(),
  };
  const exec: ExecFn =
    overrides.exec ??
    ((script, args) => {
      calls.push({ script, args });
      return handlers[script] ?? ok();
    });
  return {
    rootDir: "/fake/root",
    exec,
    storeExists: overrides.storeExists ?? (() => true),
    readContacts: overrides.readContacts ?? (() => [] as readonly BrevoDiariaContact[]),
    readPlatformConfig: overrides.readPlatformConfig ?? (() => ({ brevo_diaria: { stage5_target_total: 290 } })),
    readPublished: overrides.readPublished ?? (() => null),
  };
}

const EDITION_DIR = "/fake/root/data/editions/2608/260820";

describe("runStage5BrevoDispatch — idempotência em resume (#5772)", () => {
  it("campanha já registrada → 'already_done', NUNCA re-roda brevo-diaria-run/publish-daily-brevo", () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const deps = makeDeps({
      calls,
      readPublished: () => ({ campaign_id: 42 }),
    });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.deepEqual(result, { status: "already_done", campaignId: 42 });
    assert.equal(calls.length, 0, "nenhum sub-script deveria ter sido invocado numa 2ª invocação idempotente");
  });
});

describe("runStage5BrevoDispatch — fail-soft (#5772)", () => {
  it("config brevo_diaria ausente → 'skipped', nunca lança", () => {
    const deps = makeDeps({ readPlatformConfig: () => ({}) });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "skipped");
  });

  it("store ausente → 'skipped' com motivo (nunca assume 0 nem o teto cheio)", () => {
    const deps = makeDeps({ storeExists: () => false });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") assert.match(result.reason, /store ausente/);
  });

  it("stage5_target_total ausente → 'skipped' com motivo", () => {
    const deps = makeDeps({ readPlatformConfig: () => ({ brevo_diaria: {} }) });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") assert.match(result.reason, /stage5_target_total/);
  });

  it("brevo-diaria-run --apply falha → 'failed' com step/reason, nunca lança", () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const deps = makeDeps({
      calls,
      exec: (script, args) => {
        calls.push({ script, args });
        if (script === "scripts/brevo-diaria-run.ts") return fail("erro simulado no apply");
        return ok();
      },
    });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.step, "brevo-diaria-run --apply");
      assert.match(result.reason, /erro simulado/);
    }
    // publish-daily-brevo.ts nunca deveria rodar se o passo anterior já falhou.
    assert.equal(calls.some((c) => c.script === "scripts/publish-daily-brevo.ts"), false);
  });

  it("publish-daily-brevo falha → 'failed' com step/reason, nunca lança", () => {
    const deps = makeDeps({
      exec: (script) => {
        if (script === "scripts/publish-daily-brevo.ts") return fail("assunto vazio");
        return ok();
      },
    });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.step, "publish-daily-brevo");
      assert.match(result.reason, /assunto vazio/);
    }
  });

  it("sucesso total → 'ok' com campaignId + max-add derivado", () => {
    const deps = makeDeps({
      readContacts: () => [{ email: "a@x.com", status: "in_brevo" }] as unknown as readonly BrevoDiariaContact[],
      readPublished: (() => {
        let calls = 0;
        return () => {
          calls++;
          // 1ª chamada (idempotência): nenhuma campanha ainda. 2ª chamada
          // (após publish-daily-brevo rodar): campanha criada.
          return calls === 1 ? null : { campaign_id: 99 };
        };
      })(),
    });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.campaignId, 99);
      assert.equal(result.targetTotal, 290);
    }
  });

  it("publish-daily-brevo retorna ok mas brevo-diaria-published.json não confirma campaign_id → 'failed'", () => {
    const deps = makeDeps({ readPublished: () => null });
    const result = runStage5BrevoDispatch(EDITION_DIR, deps);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.step, "publish-daily-brevo");
  });
});

describe("runStage5BrevoDispatch — args passados aos sub-scripts (#5772)", () => {
  it("passa --max-add derivado e edition-dir corretos", () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const deps = makeDeps({
      calls,
      readContacts: () =>
        Array.from({ length: 100 }, (_, i) => ({ email: `u${i}@x.com`, status: "in_brevo" })) as unknown as readonly BrevoDiariaContact[],
      readPublished: (() => {
        let n = 0;
        return () => (++n === 1 ? null : { campaign_id: 7 });
      })(),
    });
    runStage5BrevoDispatch(EDITION_DIR, deps);
    const applyCall = calls.find((c) => c.script === "scripts/brevo-diaria-run.ts");
    assert.ok(applyCall);
    assert.deepEqual(applyCall!.args, ["--apply", "--max-add", "190"]); // 290 - 100
    const publishCall = calls.find((c) => c.script === "scripts/publish-daily-brevo.ts");
    assert.ok(publishCall);
    assert.deepEqual(publishCall!.args, [EDITION_DIR, "--i-reviewed-the-copy"]);
  });
});
