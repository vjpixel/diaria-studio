import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";

/**
 * Regressão de bug ao vivo (achado rodando /diaria-brevo-diaria numa máquina
 * Windows): 6 scripts (`brevo-diaria-run.ts`, `clarice-novos-run.ts`,
 * `clarice-envio-run.ts`, `clarice-envio-guard.ts`, `clarice-plan-wave.ts`,
 * `clarice-mv-ondemand.ts`) computavam a raiz do repo com
 * `resolve(new URL("..", import.meta.url).pathname)`. No Windows,
 * `URL.pathname` de um path com drive letter carrega uma barra inicial
 * ("/C:/Users/..."), e `path.resolve()` nesse formato prefixa o drive
 * ATUAL em vez de descartar a barra — produz "C:\C:\Users\..." (path
 * inexistente). Todo `spawnSync` que usava esse ROOT como `cwd` falhava com
 * ENOENT atribuído (de forma enganosa) ao binário do Node, não ao cwd
 * inválido — é um comportamento conhecido do libuv/CreateProcess no Windows.
 * O fix trocou pelo padrão já usado no resto do repo:
 * `resolve(dirname(fileURLToPath(import.meta.url)), "..")`.
 *
 * Este teste roda em QUALQUER SO (inclusive o CI, Linux) porque usa
 * `path.win32`, que implementa a semântica de path do Windows em JS puro,
 * independente da plataforma real — sem isso o bug nunca apareceria no CI
 * (só se manifesta com `path.resolve` nativo rodando de fato no Windows) nem
 * nos testes existentes desses 6 scripts, que mockam o `exec` e nunca
 * exercitam o `realExec`/ROOT de produção.
 */

const WINDOWS_FILE_URL = "file:///C:/Users/vjpix/Projects/diaria-studio/scripts/brevo-diaria-run.ts";

describe("resolução da raiz do repo em import.meta.url — path Windows", () => {
  it("padrão ANTIGO (new URL('..', url).pathname) dobra a drive letter — bug reproduzido", () => {
    const pathname = new URL("..", WINDOWS_FILE_URL).pathname;
    assert.equal(pathname, "/C:/Users/vjpix/Projects/diaria-studio/");

    const broken = win32.resolve(pathname);
    // "C:\C:\Users\..." — path inexistente, causa ENOENT em spawnSync que usa
    // isso como cwd.
    assert.equal(broken, "C:\\C:\\Users\\vjpix\\Projects\\diaria-studio");
  });

  it("padrão NOVO (dirname(fileURLToPath(url)), '..') resolve corretamente", () => {
    // `fileURLToPath` real depende de `process.platform`; para exercitar a
    // semântica Windows em qualquer SO, replicamos aqui a mesma operação que
    // `fileURLToPath` faz para um path com drive letter (decodifica a URL e
    // descarta a barra inicial), e resolvemos com `path.win32`.
    const decodedPath = decodeURIComponent(new URL(WINDOWS_FILE_URL).pathname).slice(1);
    const fixed = win32.resolve(win32.dirname(decodedPath), "..");
    assert.equal(fixed, "C:\\Users\\vjpix\\Projects\\diaria-studio");
  });
});
