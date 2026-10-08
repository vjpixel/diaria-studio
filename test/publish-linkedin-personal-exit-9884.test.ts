/**
 * #9884: `publish-linkedin-personal.ts` não pode chamar `process.exit`.
 *
 * No Windows (Node 24), `process.exit()` logo depois de um `fetch` cai no
 * assert do libuv `!(handle->flags & UV_HANDLE_CLOSING)` e o processo sai com
 * 127 em vez do código pedido — reproduzido isolado: `fetch` + `process.exit(4)`
 * → 127, `fetch` + `process.exitCode = 4` → 4. O Stage 6 decide pelo exit code
 * de `--check`/`--arm`, então `main()` devolve o código e só o entry point
 * grava `process.exitCode`. O assert só reproduz no Windows; no CI Linux este
 * teste trava a forma (nenhum `process.exit(` no arquivo) e o contrato de
 * `main()` (devolve o código sem encerrar o processo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARM_EXIT, main } from "../scripts/publish-linkedin-personal.ts";
import { LINKEDIN_PERSONAL_ENV } from "../scripts/lib/linkedin-personal.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/publish-linkedin-personal.ts");

describe("publish-linkedin-personal exit code (#9884)", () => {
  it("o arquivo não chama process.exit( fora de comentário", () => {
    const code = readFileSync(SRC, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.equal(/process\.exit\(/.test(code), false);
  });

  it("main() devolve ARM_EXIT.error pra flag desconhecida, sem encerrar o processo", async () => {
    assert.equal(await main(["--nada"]), ARM_EXIT.error);
  });

  it("main() devolve ARM_EXIT.error pra --arm sem --edition-dir", async () => {
    assert.equal(await main(["--arm"]), ARM_EXIT.error);
  });

  it("main(--check) sem credencial devolve ARM_EXIT.unavailable (3), o código que o Stage 6 lê", async () => {
    const saved = { t: process.env[LINKEDIN_PERSONAL_ENV.accessToken], u: process.env[LINKEDIN_PERSONAL_ENV.personUrn] };
    // string vazia: loadProjectEnv não sobrescreve var já presente, então um
    // .env/Doppler local com o token não transforma o teste em chamada de rede.
    process.env[LINKEDIN_PERSONAL_ENV.accessToken] = "";
    process.env[LINKEDIN_PERSONAL_ENV.personUrn] = "";
    try {
      assert.equal(await main(["--check"]), ARM_EXIT.unavailable);
    } finally {
      for (const [k, v] of [[LINKEDIN_PERSONAL_ENV.accessToken, saved.t], [LINKEDIN_PERSONAL_ENV.personUrn, saved.u]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
