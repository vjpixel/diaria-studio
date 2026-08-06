/**
 * test/clarice-sync-brevo-exit-4689.test.ts (#4689)
 *
 * Regressão: `scripts/clarice-sync-brevo.ts` chamava `process.exit(2)` no
 * `catch` do pool de fetch da Brevo (Fase 2 — per-id GET) — mesma classe
 * libuv Windows já corrigida em `verify-scheduled-post.ts` (#4638/#1401) e em
 * 4 outros scripts Brevo (#4651): `process.exit()` depois de um `await`
 * fetch pode derrubar o processo pelo libuv (UV_HANDLE_CLOSING) antes do
 * flush do log — justamente no caminho de erro, quando mais se precisa do
 * diagnóstico (`data/clarice-subscribers/.brevo-sync-daily.log`, testemunha
 * única da task desassistida `Diaria-Clarice-Sync`).
 *
 * Fix: process.exitCode + return no branch pós-await; o único outro
 * `process.exit()` do arquivo (BREVO_CLARICE_API_KEY ausente, linha ~174)
 * roda ANTES de qualquer await — seguro, fica como está (positive control).
 *
 * Mesmo molde estático (grep sobre o texto de `main()`, sem executar nada)
 * de `test/publish-daily-brevo-4266.test.ts` §"exit semantics (#4651)".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "clarice-sync-brevo.ts",
);

function readMainBody(): string {
  const source = readFileSync(SCRIPT, "utf8");
  const sourceNoComments = source.replace(/\/\/.*$/gm, "");
  const mainMatch = sourceNoComments.match(
    /export async function main\([^]*?\n\}\n\nif \(isMainModule/,
  );
  assert.ok(mainMatch, "main() não encontrada em clarice-sync-brevo.ts");
  return mainMatch[0];
}

function readIsMainModuleBlock(): string {
  const source = readFileSync(SCRIPT, "utf8");
  const sourceNoComments = source.replace(/\/\/.*$/gm, "");
  const blockMatch = sourceNoComments.match(/if \(isMainModule\([^]*$/);
  assert.ok(blockMatch, "bloco isMainModule não encontrado em clarice-sync-brevo.ts");
  return blockMatch[0];
}

describe("clarice-sync-brevo.ts exit semantics (#4689, mesma classe libuv do #4651/#4638/#1401)", () => {
  it("catch do pool de fetch (pós-await) usa process.exitCode = 2 + return, não process.exit(2)", () => {
    const mainBody = readMainBody();
    assert.equal(
      /process\.exit\(2\)/.test(mainBody),
      false,
      "process.exit(2) não deveria mais existir em main() — usar process.exitCode (#4689 Windows crash)",
    );
    assert.match(
      mainBody,
      /process\.exitCode = 2;\s*\n\s*return;/,
      "process.exitCode = 2 seguido de return deveria existir no branch pós-await (catch do pool)",
    );
  });

  it("guard pré-await (BREVO_CLARICE_API_KEY ausente, exit 1) continua com process.exit — sem risco libuv", () => {
    // Positive control: nenhum await fetch rodou ainda antes deste ponto
    // (só loadProjectEnv, síncrono) — manter process.exit() ali é seguro.
    const mainBody = readMainBody();
    assert.match(
      mainBody,
      /process\.exit\(1\)/,
      "process.exit(1) deveria continuar existindo (guard pré-await de BREVO_CLARICE_API_KEY, seguro)",
    );
  });

  it("nenhum outro process.exit() sobrevive em main() além do guard pré-await (exit 1)", () => {
    const mainBody = readMainBody();
    const exits = [...mainBody.matchAll(/process\.exit\((\d+)\)/g)].map((m) => m[1]);
    assert.deepEqual(
      exits,
      ["1"],
      "único process.exit() esperado em main() é o guard pré-await de exit 1 — qualquer outro precisa da mesma conversão pra process.exitCode",
    );
  });

  it("main() é chamada com .catch() no bloco isMainModule (mesma classe do #4651)", () => {
    // Se algo lançar FORA do try/catch interno de main() (ex: enumerateContacts
    // na Fase 1, antes do try; ou recomputeDerived/db.close() pós-sucesso),
    // uma chamada nua `main();` derruba o processo por unhandled rejection,
    // sem mensagem amigável nem controle de exit code.
    const block = readIsMainModuleBlock();
    assert.doesNotMatch(
      block,
      /\bmain\(\);/,
      "main() não deveria ser chamada sem .catch() — mesma classe de risco do #4651",
    );
    assert.match(
      block,
      /main\(\)\.catch\(/,
      "main() deveria ser chamada com .catch(e => { ...; process.exitCode = 1; }) igual aos scripts irmãos (#4651)",
    );
  });
});
