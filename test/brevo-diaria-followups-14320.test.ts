/**
 * test/brevo-diaria-followups-14320.test.ts (#14320, follow-up da #13981)
 *
 * Três regressões:
 *  1. dispatch de madrugada (antes das 05:30) com o marcador de ontem limpo
 *     saía com aviso; agora só avisa com marcador ausente, de outro dia ou
 *     com avisos, e repassa os avisos de ontem;
 *  2. o exit 105 da task 05:30 era decidido pela saída inteira do `--apply`:
 *     `fetch failed` de um passo fail-soft + abort determinístico de outro
 *     passo reagendava. Agora decide o `failedStep` do JSON final;
 *  3. `applyAlreadyRanToday` era type guard e estreitava o ramo falso para
 *     `null`, onde também cai o marcador de outro dia (asserção de TIPO,
 *     validada por `npx tsc -p tsconfig.test.json --noEmit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skipRapidoApplyWarnings } from "../scripts/brevo-diaria-stage5-dispatch.ts";
import { parseRunFailedStep, resolveFailureExitCode } from "../scripts/brevo-diaria-daily-apply.ts";
import { failedStepJson, runBrevoDiaria, type ExecFn, type StepResult } from "../scripts/brevo-diaria-run.ts";
import { PARTIAL_FAILURE_EXIT_CODE } from "../scripts/evaluate-brevo-diaria.ts";
import { applyAlreadyRanToday, type DailyApplyMarker } from "../scripts/lib/brevo-diaria-daily-apply.ts";
import { TRANSIENT_NETWORK_EXIT_CODE } from "../scripts/lib/transient-network-failure.ts";

/** Terça 24/11/2026, 04:00 BRT (antes da task das 05:30). */
const TUE_0400 = new Date("2026-11-24T07:00:00Z");
/** Terça 24/11/2026, 00:10 BRT — sessão do /diaria-publica que passou da meia-noite. */
const TUE_0010 = new Date("2026-11-24T03:10:00Z");

const marker = (over: Partial<DailyApplyMarker> = {}): DailyApplyMarker => ({
  day: "2026-11-23",
  at: "2026-11-23T08:35:00.000Z",
  by: "task-05:30",
  warnings: [],
  ...over,
});

describe("item 1 — aviso antes das 05:30 só quando o de ontem não está limpo (#14320)", () => {
  it("REGRESSÃO: marcador de ontem limpo ⇒ nenhum aviso (04:00 e 00:10)", () => {
    assert.deepEqual(skipRapidoApplyWarnings(marker(), TUE_0400), []);
    assert.deepEqual(skipRapidoApplyWarnings(marker(), TUE_0010), []);
  });

  it("marcador ausente ⇒ aviso, sem avisos de ontem", () => {
    const w = skipRapidoApplyWarnings(null, TUE_0400);
    assert.equal(w.length, 1);
    assert.match(w[0], /ainda não rodou.*nenhum --apply registrado/);
  });

  it("marcador de anteontem ⇒ aviso citando o dia, sem repassar os avisos velhos", () => {
    const w = skipRapidoApplyWarnings(marker({ day: "2026-11-22", warnings: ["velho"] }), TUE_0400);
    assert.equal(w.length, 1);
    assert.match(w[0], /2026-11-22/);
  });

  it("marcador de ontem COM avisos ⇒ aviso + os avisos de ontem repassados", () => {
    const w = skipRapidoApplyWarnings(marker({ warnings: ["sync-kit-frio: Kit 503", "pool Kit: 429"] }), TUE_0400);
    assert.deepEqual(w.slice(1), ["--apply de ontem (task-05:30): sync-kit-frio: Kit 503", "--apply de ontem (task-05:30): pool Kit: 429"]);
    assert.match(w[0], /ainda não rodou.*2026-11-23/);
  });

  it("marcador do dia continua mandando antes das 05:30 (dispatch de madrugada já rodou)", () => {
    assert.deepEqual(skipRapidoApplyWarnings(marker({ day: "2026-11-24", warnings: ["x"] }), TUE_0400), ["--apply de hoje (task-05:30): x"]);
  });
});

function fakeExec(handlers: Record<string, StepResult>): ExecFn {
  return (script) => handlers[script] ?? { code: 0, stdout: "", stderr: "" };
}

/** Mesma linha JSON que o CLI do `brevo-diaria-run.ts` imprime. */
function cliStdout(r: ReturnType<typeof runBrevoDiaria>): string {
  return JSON.stringify({ code: r.code, mode: r.mode, summary: r.summary, steps: [], warnings: r.warnings, failedStep: failedStepJson(r.failedStep) });
}

describe("item 2 — 105 decidido pelo passo duro que falhou (#14320)", () => {
  it("REGRESSÃO: fetch failed no evaluate (exit 3, fail-soft) + guard de custo do MV ⇒ exit do passo, NÃO 105", () => {
    const r = runBrevoDiaria(
      ["--apply"],
      {
        rootDir: "/fake",
        exec: fakeExec({
          "scripts/evaluate-brevo-diaria.ts": { code: PARTIAL_FAILURE_EXIT_CODE, stdout: "", stderr: "contato a@x.com: TypeError: fetch failed" },
          "scripts/verify-pending-emails-mv.ts": { code: 1, stdout: "", stderr: "guard de custo MV: 900 contatos acima do teto, rode com --confirm" },
        }),
      },
    );
    assert.equal(r.code, 1);
    assert.equal(r.failedStep?.script, "scripts/verify-pending-emails-mv.ts");
    assert.match(r.failedStep?.stderrTail ?? "", /guard de custo/);
    // A saída inteira tem a assinatura de rede (stderr do evaluate repassado):
    const exec = { code: 1, stdout: cliStdout(r), stderr: "contato a@x.com: TypeError: fetch failed\nguard de custo MV" };
    assert.equal(resolveFailureExitCode(exec), 1);
  });

  it("passo duro falhando por rede ⇒ 105", () => {
    const r = runBrevoDiaria(["--apply"], {
      rootDir: "/fake",
      exec: fakeExec({ "scripts/sync-pending-to-brevo.ts": { code: 1, stdout: "", stderr: "Brevo POST /contacts: TypeError: fetch failed" } }),
    });
    assert.equal(r.failedStep?.script, "scripts/sync-pending-to-brevo.ts");
    assert.equal(resolveFailureExitCode({ code: 1, stdout: cliStdout(r), stderr: "" }), TRANSIENT_NETWORK_EXIT_CODE);
  });

  it("evaluate abortando (exit 1) também vira failedStep", () => {
    const r = runBrevoDiaria(["--apply"], {
      rootDir: "/fake",
      exec: fakeExec({ "scripts/evaluate-brevo-diaria.ts": { code: 1, stdout: "", stderr: "getaddrinfo EAI_AGAIN api.brevo.com" } }),
    });
    assert.equal(r.failedStep?.script, "scripts/evaluate-brevo-diaria.ts");
    assert.equal(resolveFailureExitCode({ code: 1, stdout: cliStdout(r), stderr: "" }), TRANSIENT_NETWORK_EXIT_CODE);
  });

  it("sucesso e abort de args ⇒ failedStep null; null com exit ≠ 0 nunca vira 105", () => {
    const ok = runBrevoDiaria(["--apply"], { rootDir: "/fake", exec: fakeExec({}) });
    assert.equal(ok.code, 0);
    assert.equal(ok.failedStep, null);
    const bad = runBrevoDiaria(["--apply", "--preflight"], { rootDir: "/fake", exec: fakeExec({}) });
    assert.equal(bad.code, 1);
    assert.equal(bad.failedStep, null);
    assert.equal(resolveFailureExitCode({ code: 1, stdout: cliStdout(bad), stderr: "fetch failed" }), 1);
  });

  it("sem JSON ou sem o campo ⇒ vale a saída inteira (evaluate do kill switch, processo morto)", () => {
    assert.equal(parseRunFailedStep("lixo"), undefined);
    assert.equal(parseRunFailedStep(JSON.stringify({ code: 1, warnings: [] })), undefined);
    assert.equal(parseRunFailedStep(JSON.stringify({ failedStep: { code: "x" } })), undefined);
    assert.equal(resolveFailureExitCode({ code: 1, stdout: "", stderr: "TypeError: fetch failed" }), TRANSIENT_NETWORK_EXIT_CODE);
    assert.equal(resolveFailureExitCode({ code: 1, stdout: "", stderr: "boom" }), 1);
  });
});

describe("item 3 — applyAlreadyRanToday não estreita o ramo falso (#14320)", () => {
  it("REGRESSÃO (tipo): marcador de outro dia segue tipado como marcador no ramo falso", () => {
    // IIFE para o tipo declarado ser a união (sem estreitamento pela atribuição).
    const m = ((): DailyApplyMarker | null => marker({ day: "2026-11-22" }))();
    if (!applyAlreadyRanToday(m, "2026-11-24")) {
      // Com o type guard antigo, `m` virava `null` aqui e `m.day` (após o
      // `!== null`) era erro de tipo em `never`.
      const day: string | undefined = m !== null ? m.day : undefined;
      assert.equal(day, "2026-11-22");
    } else {
      assert.fail("marcador de outro dia não é do dia");
    }
  });

  it("runtime: null e outro dia ⇒ false; mesmo dia ⇒ true", () => {
    assert.equal(applyAlreadyRanToday(null, "2026-11-24"), false);
    assert.equal(applyAlreadyRanToday(marker(), "2026-11-24"), false);
    assert.equal(applyAlreadyRanToday(marker({ day: "2026-11-24" }), "2026-11-24"), true);
  });
});
