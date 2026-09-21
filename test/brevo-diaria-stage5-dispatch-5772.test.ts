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

describe("runStage5BrevoDispatch — addedActual distingue intenção de resultado (#5839)", () => {
  it("#6793: sem cap, maxAdd é só informativo — 0 contatos de fato adicionados → addedActual=0, status ainda 'ok', sem warning de 'vaga pedida'", () => {
    const contacts = Array.from({ length: 92 }, (_, i) => ({ email: `u${i}@x.com`, status: "in_brevo" })) as unknown as readonly BrevoDiariaContact[];
    const deps = makeDeps({
      // `--apply` não mutou nada de fato (todos os candidatos foram excluídos
      // por SparkLoop/etc) — readContacts() devolve a MESMA contagem antes e
      // depois do apply, simulando o cenário real da issue.
      readContacts: () => contacts,
      readPublished: (() => {
        let n = 0;
        return () => (++n === 1 ? null : { campaign_id: 27 });
      })(),
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;
    let result: ReturnType<typeof runStage5BrevoDispatch>;
    try {
      result = runStage5BrevoDispatch(EDITION_DIR, deps);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.addedActual, 0, "0 contatos de fato adicionados, distinto de maxAdd (198)");
      assert.equal(result.maxAdd, 290 - 92); // 198
    }
    // #6793: sem cap, não há mais warning de "vaga(s) pedida(s)" — só o log
    // informativo de total_atual/target, sem aplicar nenhum teto real.
    assert.doesNotMatch(stderrOutput, /vaga\(s\) pedida\(s\)/);
    assert.match(stderrOutput, /total_atual=92 target-informativo=290 \(sem teto aplicado, #6793/);
  });

  it("addedActual === maxAdd (todos os candidatos entraram) → sem warning", () => {
    let call = 0;
    const deps = makeDeps({
      readContacts: () => {
        call++;
        // 1ª leitura (cálculo de totalAtual, pré-apply): 0 contatos.
        // 2ª leitura (recontagem pós-apply, #5839): os 5 pedidos entraram.
        const n = call === 1 ? 0 : 5;
        return Array.from({ length: n }, (_, i) => ({ email: `u${i}@x.com`, status: "in_brevo" })) as unknown as readonly BrevoDiariaContact[];
      },
      readPlatformConfig: () => ({ brevo_diaria: { stage5_target_total: 5 } }),
      readPublished: (() => {
        let n = 0;
        return () => (++n === 1 ? null : { campaign_id: 1 });
      })(),
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = "";
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;
    let result: ReturnType<typeof runStage5BrevoDispatch>;
    try {
      result = runStage5BrevoDispatch(EDITION_DIR, deps);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.addedActual, 5);
    assert.doesNotMatch(stderrOutput, /preenchida/);
  });
});

describe("runStage5BrevoDispatch — args passados aos sub-scripts (#5772)", () => {
  it("#6793: NÃO passa mais --max-add (freio de volume removido) — só --apply, edition-dir correto no publish", () => {
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
    assert.deepEqual(applyCall!.args, ["--apply"]);
    const publishCall = calls.find((c) => c.script === "scripts/publish-daily-brevo.ts");
    assert.ok(publishCall);
    assert.deepEqual(publishCall!.args, [EDITION_DIR, "--i-reviewed-the-copy"]);
  });
});

describe("runStage5BrevoDispatch — Passo 1 evaluate-brevo-diaria parcialmente falho não aborta o rascunho Brevo (#8686)", () => {
  // Pina o SINTOMA exato reportado na issue #8686 no nível ONDE ele foi
  // observado (`runStage5BrevoDispatch`), não só nas camadas de baixo
  // (`evaluate-brevo-diaria.ts`/`brevo-diaria-run.ts`, já cobertas em
  // `test/evaluate-brevo-diaria-exit-code-8686.test.ts`/
  // `test/brevo-diaria-run.test.ts`). Antes do fix do #8686,
  // `brevo-diaria-run.ts --apply` abortava a sequência inteira quando o
  // Passo 1 tinha falha/skip por contato individual — `applyResult.code`
  // chegava não-zero a este dispatcher, que retornava `status: "failed"`
  // sem nunca chamar `publish-daily-brevo.ts`, deixando a edição sem
  // rascunho Brevo. Depois do fix, `brevo-diaria-run.ts` reporta esse
  // caso como `code: 0` + `warnings` não-vazio (mesmo padrão do pool Kit
  // inactive, #8192) — este teste garante que o dispatcher continua o
  // fluxo normal (chama `publish-daily-brevo.ts`, retorna `"ok"`) em vez
  // de reintroduzir a regressão se `brevo-diaria-run.ts` voltar a tratar
  // isso como falha no futuro.
  const PARTIAL_FAILURE_WARNING =
    "⚠️ Passo 1 — evaluate-brevo-diaria --push: falha/skip em contato(s) individual(is) (exit 3, #8686) — store " +
    "atualizado normalmente (quando --push), sequência prossegue; ver stderr do passo pro detalhe por contato: " +
    "4 falha(s).";

  it("brevo-diaria-run --apply com code:0 + warnings (fail-soft do #8686) → dispatch continua e cria o rascunho Brevo normalmente", () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const deps = makeDeps({
      calls,
      exec: (script, args) => {
        calls.push({ script, args });
        if (script === "scripts/brevo-diaria-run.ts") {
          // Simula exatamente o JSON que `runBrevoDiaria`/CLI imprime
          // quando o Passo 1 sai PARTIAL_FAILURE_EXIT_CODE (#8686): `code:
          // 0` (a sequência inteira, incluindo Passos 2-4, rodou até o
          // fim), `warnings` não-vazio.
          return ok(
            JSON.stringify({
              code: 0,
              mode: "apply",
              summary: `apply concluído — 7 passo(s) rodado(s) na ordem fixa do Passo 4 (sem --max-add, sem teto). AVISOS: ${PARTIAL_FAILURE_WARNING}`,
              steps: [{ label: "Passo 1 — evaluate-brevo-diaria --push", code: 3 }],
              warnings: [PARTIAL_FAILURE_WARNING],
            }),
          );
        }
        return ok();
      },
      readPublished: (() => {
        let n = 0;
        return () => (++n === 1 ? null : { campaign_id: 314 });
      })(),
    });

    const result = runStage5BrevoDispatch(EDITION_DIR, deps);

    assert.equal(result.status, "ok", "sucesso parcial em contato(s) individual(is) não pode virar status:failed no dispatch");
    if (result.status === "ok") {
      assert.equal(result.campaignId, 314);
      assert.deepEqual(result.warnings, [PARTIAL_FAILURE_WARNING]);
    }
    assert.ok(
      calls.some((c) => c.script === "scripts/publish-daily-brevo.ts"),
      "publish-daily-brevo.ts precisa ser invocado mesmo com falha/skip parcial no Passo 1 — é exatamente o rascunho que a issue #8686 relatou como nunca criado",
    );
  });
});
