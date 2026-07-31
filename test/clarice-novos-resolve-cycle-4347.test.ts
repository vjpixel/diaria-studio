/**
 * test/clarice-novos-resolve-cycle-4347.test.ts (#4347 Etapa 3a)
 *
 * A lógica pura (`resolveLatestMonthlyCycle`) já tem cobertura completa em
 * test/resolve-latest-monthly-cycle.test.ts. Aqui só a integração da CLI
 * contra o disco real (sem fixtures no repo → nenhum ciclo pronto → erro
 * determinístico, exit 1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../scripts/clarice-novos-resolve-cycle.ts";
import { detectExecMode } from "../scripts/lib/exec-mode.ts";

// #4347: `monthlyDir`/`MONTHLY_BASE` não são injetáveis (path fixo,
// `data/monthly/`) — testar main() ponta-a-ponta contra fixtures exigiria
// escrever no disco REAL de produção numa máquina local (junction OneDrive).
// Este teste só roda em modo `cloud` (sem o junction `data/`), onde
// `data/monthly/` certamente não existe e o resultado é determinístico
// (nenhum ciclo pronto → erro). Em `local`, pula — o disco real pode ter
// ciclos genuinamente prontos, o que tornaria a asserção de erro falsa.
const skipLocal = detectExecMode() === "local";

test("main: sem nenhum ciclo mensal pronto no disco -> erro claro, exit 1 (nunca lança sem tratamento)", { skip: skipLocal }, () => {
  const errs: string[] = [];
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode: number | undefined;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  // @ts-expect-error stub
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error("mock-exit"), { __mockExit: true });
  };
  try {
    main([]);
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    console.error = origErr;
    process.exit = origExit;
  }
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /nenhum ciclo/.test(e)));
});
