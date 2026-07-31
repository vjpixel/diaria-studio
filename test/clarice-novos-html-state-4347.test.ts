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
import { main } from "../scripts/clarice-novos-html-state.ts";

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
