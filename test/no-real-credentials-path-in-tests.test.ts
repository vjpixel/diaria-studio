/**
 * test/no-real-credentials-path-in-tests.test.ts (#4344)
 *
 * Regressão: `test/drive-sync.test.ts`, `test/drive-helpers.test.ts` e
 * `test/inbox-drain.test.ts` escreviam credenciais OAuth FAKE diretamente no
 * path REAL de `data/.credentials.json` (gitignored, compartilhado via
 * OneDrive entre máquinas) em `beforeEach`/`afterEach`, contando com um dance
 * de "salvar conteúdo original → sobrescrever com fake → restaurar" que só é
 * seguro se NADA mais tocar o mesmo arquivo durante a janela do teste.
 *
 * `node --test` roda arquivos de teste em paralelo (múltiplos processos) —
 * se outro processo de teste (ou uma sessão real na mesma máquina) tocasse o
 * arquivo durante essa janela, ou se a run fosse morta entre o `beforeEach` e
 * o `afterEach` (timeout, Ctrl-C), o arquivo REAL ficava permanentemente
 * corrompido com o conteúdo fake — sem nenhum erro visível na hora, porque os
 * testes em si passam (testam contra o fake que acabaram de escrever).
 * Aconteceu de verdade em 260730 (#4344): `data/.credentials.json` da máquina
 * do editor virou `{"client_id":"fake",...}` e quebrou Drive sync,
 * inbox-drain e upload de imagens sociais até re-autenticação manual.
 *
 * O fix (#4344) trocou os 3 arquivos acima pra escrever o fake num dir
 * temporário próprio (`mkdtempSync`) e apontar `google-auth.ts` pra lá via
 * `CREDENTIALS_PATH_TEST_OVERRIDE_ENV` (env var, resolvido dinamicamente a
 * cada chamada dentro do módulo — nunca um `const` capturado no import).
 *
 * Este teste é a rede ESTÁTICA e GENÉRICA (mesmo padrão de
 * `test/scheduled-task-registration.test.ts`, #3764): varre TODO
 * `test/*.test.ts` (não uma lista fixa) e reprova qualquer `writeFileSync`
 * que aponte pro path literal de `data/.credentials.json` fora de um dir
 * `mkdtempSync`'d — assim um arquivo de teste FUTURO não reabre a mesma
 * classe de bug (e o gap não fica restrito aos 3 arquivos corrigidos agora,
 * do jeito que #3764 achou o mesmo bug do #3560/#3757 intocado em outros 2
 * scripts que a lista fixa original não cobria).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");
// Este próprio arquivo cita os padrões ofensores (em regex e em prosa) pra
// documentar o que procura — exclui-se do próprio scan pra não se auto-acusar.
const SELF = resolve(fileURLToPath(import.meta.url));

/** Lista .test.ts recursivamente sob test/ (mesmo padrão de ps1FilesUnder em scheduled-task-registration.test.ts). */
function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...testFilesUnder(full));
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Remove comentários `//` e `/* *\/` pra não confundir o scan com prosa/exemplos. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Acha variáveis declaradas apontando pro path REAL de `data/.credentials.json`
 * (ex: `const CREDS_PATH = resolve(ROOT, "data", ".credentials.json");`).
 * A declaração em si não é a violação — só usá-la como alvo de `writeFileSync` é.
 */
function realCredentialsPathVarNames(source: string): string[] {
  const re =
    /(?:const|let)\s+(\w+)\s*=\s*(?:resolve|join)\([^;]*?["'`]data["'`][^;]*?\.credentials\.json[^;]*?\)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

describe("nenhum test/*.test.ts escreve fake creds no data/.credentials.json REAL (#4344)", () => {
  const files = testFilesUnder(TEST_DIR).filter((f) => resolve(f) !== SELF);

  it("sanity: encontrou vários arquivos test/*.test.ts (senão o scan está quebrado)", () => {
    assert.ok(
      files.length > 5,
      `esperava vários .test.ts sob ${TEST_DIR}, achou ${files.length} — este teste deixaria de proteger silenciosamente.`,
    );
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
    const rawSource = readFileSync(file, "utf8");
    const source = stripComments(rawSource);

    it(`${rel}: nunca escreve em data/.credentials.json REAL via writeFileSync`, () => {
      const offenders: string[] = [];
      let m: RegExpExecArray | null;

      // 1. Construção inline: writeFileSync(resolve(ROOT, "data", ".credentials.json"), ...)
      const inlineRe =
        /writeFileSync\(\s*(?:resolve|join)\([^)]*?["'`]data["'`][^)]*?\.credentials\.json[^)]*?\)/g;
      while ((m = inlineRe.exec(source))) offenders.push(m[0]);

      // 2. Literal puro: writeFileSync("data/.credentials.json", ...) ou "data\.credentials.json"
      const literalRe = /writeFileSync\(\s*["'`][^"'`]*data[\\/]\.credentials\.json["'`]/g;
      while ((m = literalRe.exec(source))) offenders.push(m[0]);

      // 3. Via variável declarada com o path real (ex: const CREDS_PATH = resolve(...))
      for (const varName of realCredentialsPathVarNames(source)) {
        const varRe = new RegExp(`writeFileSync\\(\\s*${varName}\\b`, "g");
        while ((m = varRe.exec(source))) offenders.push(m[0]);
      }

      assert.deepEqual(
        offenders,
        [],
        `escrita direta em data/.credentials.json REAL detectada em ${rel} — use ` +
          `mkdtempSync + CREDENTIALS_PATH_TEST_OVERRIDE_ENV (scripts/google-auth.ts) em vez ` +
          `disso (ver test/drive-sync.test.ts pro padrão, #4344). Ofensores:\n${offenders.join("\n")}`,
      );
    });
  }
});
