/**
 * linkedin-api-version-parity-12171.test.ts (#12171)
 *
 * O Worker `linkedin-cron` não importa de `scripts/lib` (bundle do
 * Cloudflare), então a regra do `LinkedIn-Version` default vive em duas
 * cópias: `scripts/lib/linkedin-personal.ts` (perfil pessoal, página via
 * OAuth) e `workers/linkedin-cron/src/linkedin-api-version.ts` (carrossel e
 * documento da página). Este teste trava que as duas devolvem a mesma versão
 * para cada mês de um intervalo de vários anos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultLinkedInApiVersion as scriptsVersion } from "../scripts/lib/linkedin-personal.ts";
import { defaultLinkedInApiVersion as workerVersion } from "../workers/linkedin-cron/src/linkedin-api-version.ts";

describe("defaultLinkedInApiVersion — paridade scripts/lib x Worker (#12171)", () => {
  it("as duas cópias concordam em todo mês de 2025 a 2030 (início, meio e fim do mês)", () => {
    for (let year = 2025; year <= 2030; year++) {
      for (let month = 0; month < 12; month++) {
        const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        for (const day of [1, 15, lastDay]) {
          for (const hour of [0, 23]) {
            const now = new Date(Date.UTC(year, month, day, hour, 30));
            assert.equal(workerVersion(now), scriptsVersion(now), `divergiu em ${now.toISOString()}`);
          }
        }
      }
    }
  });
});
