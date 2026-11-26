/**
 * google-auth.ts
 *
 * #14001: a autenticação OAuth do Google mora em `scripts/lib/google-auth.ts`.
 * Este caminho fica como reexport para os CLIs, testes e docs que já o citam.
 * Código de `scripts/lib/` importa `./google-auth.ts` direto (regra 5 de
 * `test/lib-boundary.test.ts`).
 */

export * from "./lib/google-auth.ts";
