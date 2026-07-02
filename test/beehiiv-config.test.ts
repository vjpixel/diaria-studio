/**
 * test/beehiiv-config.test.ts (#2850)
 *
 * Regressão: `beehiivApiBase()` precisa ser um getter LAZY (função), não uma
 * const de módulo avaliada no import. Uma const capturaria `BEEHIIV_API_URL`
 * antes de scripts que carregam env via chamada de função `loadProjectEnv()`
 * (não `import "dotenv/config"` como side-effect) terem a chance de povoar
 * `process.env` — override silenciosamente ignorado (ver fix-post-slug.ts,
 * verify-scheduled-post.ts, prep-manual-publish.ts).
 *
 * Este teste simula exatamente esse cenário: importa o módulo primeiro (como
 * um import estático faria, antes de qualquer `loadProjectEnv()` no caller),
 * SÓ DEPOIS muta `process.env.BEEHIIV_API_URL`, e afirma que o getter reflete
 * o novo valor. Uma const de módulo falharia este teste (capturaria o valor
 * de antes da mutação).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beehiivApiBase } from "../scripts/lib/beehiiv-config.ts";

describe("beehiivApiBase (#2850)", () => {
  it("sem BEEHIIV_API_URL → default oficial da API pública", () => {
    const saved = process.env.BEEHIIV_API_URL;
    try {
      delete process.env.BEEHIIV_API_URL;
      assert.equal(beehiivApiBase(), "https://api.beehiiv.com/v2");
    } finally {
      if (saved !== undefined) process.env.BEEHIIV_API_URL = saved;
      else delete process.env.BEEHIIV_API_URL;
    }
  });

  it("regressão: mutar process.env.BEEHIIV_API_URL APÓS o import é refletido no getter", () => {
    // O módulo já foi importado no topo deste arquivo (estático, como qualquer
    // caller faria) — a mutação abaixo acontece estritamente depois disso,
    // reproduzindo a ordem real: import primeiro, loadProjectEnv() depois.
    const saved = process.env.BEEHIIV_API_URL;
    try {
      process.env.BEEHIIV_API_URL = "https://mock.example.test/v2";
      assert.equal(
        beehiivApiBase(),
        "https://mock.example.test/v2",
        "getter deve refletir o env mutado pós-import — uma const de módulo falharia aqui",
      );

      // Segunda mutação, pra deixar claro que não há caching indevido.
      process.env.BEEHIIV_API_URL = "https://mock2.example.test/v2";
      assert.equal(beehiivApiBase(), "https://mock2.example.test/v2");
    } finally {
      if (saved !== undefined) process.env.BEEHIIV_API_URL = saved;
      else delete process.env.BEEHIIV_API_URL;
    }
  });
});
