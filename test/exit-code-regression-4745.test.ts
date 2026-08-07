/**
 * test/exit-code-regression-4745.test.ts (#4745)
 *
 * Regressão do #4653: `scripts/check-brevo-diaria-guardrail.ts`,
 * `scripts/worker-drift-check.ts` e `scripts/postmaster-campaign-spam-report.ts`
 * tinham reintroduzido `process.exit(1)` no catch handler do bloco
 * `isMainModule(import.meta.url)` — esse catch roda DEPOIS de awaits de rede
 * (fetch pra Brevo/Cloudflare/Postmaster/Gmail), o cenário exato da classe de
 * bug UV_HANDLE_CLOSING no Windows (#1401/#4638/#4651/#4653):
 * `process.exit()` força o shutdown do libuv antes dos sockets keep-alive do
 * fetch fecharem. Fix: `process.exitCode = 1` (sem `process.exit` depois — é
 * a última instrução do `.catch()`), mesmo padrão já usado em
 * `scripts/sync-pending-to-brevo.ts`/`scripts/inject-poll-token-brevo.ts`.
 *
 * Mesma técnica de asserção por regex sobre o código-fonte usada em
 * `test/sync-pending-to-brevo-4266.test.ts`/`test/inject-poll-token-brevo-4517.test.ts`
 * — os 3 scripts fazem chamadas de rede reais em `main()`, então o teste não
 * invoca `main()` (nem mocka process.exit/process.exitCode do runner real);
 * ele verifica estaticamente que o catch handler não usa `process.exit(`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extrai o corpo do bloco `if (isMainModule(import.meta.url)) { ... }` no
 * final do arquivo (após remover comentários de linha, que podem conter a
 * string "process.exit" em prosa explicativa e falsear o match).
 */
function readIsMainModuleCatchBody(scriptRelPath: string): string {
  const source = readFileSync(resolve(ROOT, scriptRelPath), "utf8");
  const sourceNoComments = source.replace(/\/\/.*$/gm, "");
  const match = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
  assert.ok(match, `bloco isMainModule() não encontrado em ${scriptRelPath}`);
  return match[0];
}

const SCRIPTS_UNDER_TEST = [
  "scripts/check-brevo-diaria-guardrail.ts",
  "scripts/worker-drift-check.ts",
  "scripts/postmaster-campaign-spam-report.ts",
];

describe("catch handler do isMainModule() usa process.exitCode, não process.exit (#4745, regressão #4653)", () => {
  for (const scriptRelPath of SCRIPTS_UNDER_TEST) {
    it(`${scriptRelPath}: catch handler NÃO chama process.exit()`, () => {
      const catchBody = readIsMainModuleCatchBody(scriptRelPath);
      assert.equal(
        /process\.exit\s*\(/.test(catchBody),
        false,
        `catch de main() em ${scriptRelPath} não pode chamar process.exit() — usar process.exitCode ` +
          "(#4745 Windows UV_HANDLE_CLOSING, mesma classe #1401/#4638/#4651/#4653)",
      );
    });

    it(`${scriptRelPath}: catch handler SETA process.exitCode = 1`, () => {
      const catchBody = readIsMainModuleCatchBody(scriptRelPath);
      assert.match(
        catchBody,
        /process\.exitCode\s*=\s*1/,
        `catch de main() em ${scriptRelPath} deve setar process.exitCode = 1`,
      );
    });
  }
});
