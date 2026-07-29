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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beehiivApiBase, resolveBeehiivConfig } from "../scripts/lib/beehiiv-config.ts";

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

describe("resolveBeehiivConfig (#4296) — versão pura, nunca process.exit", () => {
  // REGRESSÃO CENTRAL do #4296: o guard do Studio (`scripts/studio-ui/studio-utms.ts`)
  // reimplementou este contrato errado e passou a exigir BEEHIIV_PUBLICATION_ID
  // no env mesmo quando platform.config.json já resolve o fallback — a mesma
  // config que faz `loadBeehiivConfig` funcionar em ~20 scripts CLI. Este é o
  // cenário EXATO do bug: key presente, publicationId só no config.
  it("REGRESSÃO #4296: key presente + BEEHIIV_PUBLICATION_ID ausente do env → resolve via platform.config.json (sem erro falso)", () => {
    const result = resolveBeehiivConfig({ BEEHIIV_API_KEY: "test-key", BEEHIIV_PUBLICATION_ID: undefined });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.apiKey, "test-key");
      assert.ok(
        result.config.publicationId.startsWith("pub_"),
        `publicationId deveria vir do platform.config.json real (fallback), got: ${result.config.publicationId}`,
      );
    }
  });

  it("BEEHIIV_PUBLICATION_ID no env tem precedência sobre platform.config.json", () => {
    const result = resolveBeehiivConfig({
      BEEHIIV_API_KEY: "test-key",
      BEEHIIV_PUBLICATION_ID: "pub_from_env",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.publicationId, "pub_from_env");
  });

  it("key ausente → ok:false com motivo mencionando só a key (nunca lança, nunca exit)", () => {
    const result = resolveBeehiivConfig({ BEEHIIV_PUBLICATION_ID: "pub_x" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /BEEHIIV_API_KEY/);
      assert.doesNotMatch(result.reason, /publicationId/);
    }
  });

  it("key presente, publicationId ausente do env E platform.config.json sem beehiiv.publicationId → ok:false com o motivo específico", () => {
    const root = mkdtempSync(join(tmpdir(), "beehiiv-config-nofallback-"));
    const configPath = join(root, "platform.config.json");
    try {
      writeFileSync(configPath, JSON.stringify({ newsletter: "beehiiv" }), "utf8");
      const result = resolveBeehiivConfig({ BEEHIIV_API_KEY: "test-key" }, configPath);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /publicationId não resolvido/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("configPath inexistente → ok:false (nunca lança ENOENT)", () => {
    const result = resolveBeehiivConfig(
      { BEEHIIV_API_KEY: "test-key" },
      join(tmpdir(), "nao-existe-4296", "platform.config.json"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /não encontrado/);
  });
});
