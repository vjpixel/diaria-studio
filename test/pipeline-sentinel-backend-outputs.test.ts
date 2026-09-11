/**
 * test/pipeline-sentinel-backend-outputs.test.ts (#7963)
 *
 * Regressão: na edição 260911 (`publishing.newsletter.backend: "kit"`),
 * `_internal/.step-5-done.json` foi gravado com
 * `outputs: ["05-published.json", "newsletter-kit-published.json",
 * "06-social-published.json"]` — `05-published.json` NUNCA existe com
 * backend Kit (quem escreve é `publish-newsletter-kit.ts` →
 * `newsletter-kit-published.json`). Isso travou a pré-condição do Stage 6
 * (`pipeline-sentinel.ts assert --step 5`, exit 2 "outputs ausentes") apesar
 * de o Stage 5 ter completado e publicado/agendado tudo de verdade — o
 * playbook (`.claude/agents/orchestrator-stage-5.md` §5h) já branchava por
 * backend em PROSA desde o #6096/#464, mas nada mecânico impedia uma sessão
 * de copiar o exemplo genérico errado.
 *
 * Fix: `checkBackendOutputsForWrite` (exportada de `pipeline-sentinel.ts`,
 * consumindo `findWrongBackendNewsletterOutputs`/`loadNewsletterBackend` de
 * `scripts/lib/newsletter-backend.ts`) roda no `write` dos Stages 5 e 6 —
 * os únicos cujos outputs citam um artefato de newsletter específico de
 * backend — e recusa (exit 1, SEM bypass) quando `--outputs` cita o
 * artefato do backend OPOSTO ao ativo em `platform.config.json`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBackendOutputsForWrite } from "../scripts/pipeline-sentinel.ts";
import {
  findWrongBackendNewsletterOutputs,
  loadNewsletterBackend,
} from "../scripts/lib/newsletter-backend.ts";
import { assertSentinel } from "../scripts/lib/pipeline-state.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sentinelCli = join(repoRoot, "scripts", "pipeline-sentinel.ts");

/** Mesmo helper de test/pipeline-sentinel-invariant-gate.test.ts (#6194). */
function setupIsolatedCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-backend-cli-"));
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  return dir;
}

function runWrite(args: string[], cwd: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", sentinelCli, "write", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("findWrongBackendNewsletterOutputs (#7963) — pure", () => {
  it("backend kit: casa 05-published.json (com ou sem prefixo de diretório)", () => {
    assert.deepEqual(
      findWrongBackendNewsletterOutputs(
        ["05-published.json", "_internal/05-published.json", "06-social-published.json"],
        "kit",
      ),
      ["05-published.json", "_internal/05-published.json"],
    );
  });

  it("backend kit: newsletter-kit-published.json não é wrong-backend (é o certo)", () => {
    assert.deepEqual(
      findWrongBackendNewsletterOutputs(["_internal/newsletter-kit-published.json"], "kit"),
      [],
    );
  });

  it("backend beehiiv: casa newsletter-kit-published.json, não casa 05-published.json", () => {
    assert.deepEqual(
      findWrongBackendNewsletterOutputs(
        ["_internal/newsletter-kit-published.json", "_internal/05-published.json"],
        "beehiiv",
      ),
      ["_internal/newsletter-kit-published.json"],
    );
  });

  it("lista sem nenhum artefato de newsletter → sempre vazio", () => {
    assert.deepEqual(
      findWrongBackendNewsletterOutputs(["06-social-published.json"], "kit"),
      [],
    );
    assert.deepEqual(
      findWrongBackendNewsletterOutputs(["06-social-published.json"], "beehiiv"),
      [],
    );
  });
});

describe("checkBackendOutputsForWrite (#7963) — unit", () => {
  it("Stage 5, backend kit, outputs com 05-published.json → falha", () => {
    const result = checkBackendOutputsForWrite(
      5,
      ["05-published.json", "newsletter-kit-published.json", "06-social-published.json"],
      "kit",
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.wrongOutputs, ["05-published.json"]);
  });

  it("Stage 5, backend kit, outputs só com newsletter-kit-published.json → passa", () => {
    const result = checkBackendOutputsForWrite(
      5,
      ["_internal/newsletter-kit-published.json", "_internal/06-social-published.json"],
      "kit",
    );
    assert.equal(result.passed, true);
    assert.deepEqual(result.wrongOutputs, []);
  });

  it("Stage 5, backend beehiiv, outputs com newsletter-kit-published.json → falha", () => {
    const result = checkBackendOutputsForWrite(
      5,
      ["_internal/newsletter-kit-published.json"],
      "beehiiv",
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.wrongOutputs, ["_internal/newsletter-kit-published.json"]);
  });

  it("Stage 6 também é coberto (mesmo guard do Stage 5)", () => {
    const result = checkBackendOutputsForWrite(6, ["_internal/05-published.json"], "kit");
    assert.equal(result.passed, false);
  });

  it("Stage fora de 5/6 (ex: Stage 2) → sempre passa, guard não se aplica", () => {
    const result = checkBackendOutputsForWrite(2, ["05-published.json"], "kit");
    assert.equal(result.passed, true);
    assert.deepEqual(result.wrongOutputs, []);
  });
});

describe("pipeline-sentinel write — guard de backend do Stage 5 (#7963) — CLI", () => {
  it("backend kit: write --step 5 com 05-published.json em --outputs é recusado (exit 1, sentinel não gravado, sem bypass)", () => {
    const aammdd = "919013";
    const isolatedCwd = setupIsolatedCwd();
    const editionDir = join(isolatedCwd, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      // Simula o estado real da edição 260911: o artefato Kit existe (Stage 5
      // rodou de verdade), mas quem escreveu o sentinel usou o exemplo do
      // backend errado (Beehiiv) em --outputs.
      writeFileSync(
        join(editionDir, "_internal", "newsletter-kit-published.json"),
        JSON.stringify({ status: "scheduled", broadcast_id: 1 }),
      );

      const { status, stderr } = runWrite(
        [
          "--edition", aammdd, "--step", "5",
          "--outputs", "_internal/05-published.json,_internal/newsletter-kit-published.json",
          "--bypass-reason", "tentando contornar o guard de backend — não deve funcionar",
        ],
        isolatedCwd,
      );

      assert.equal(status, 1);
      assert.match(stderr, /backend ERRADO/);
      assert.match(stderr, /#7963/);
      assert.equal(
        existsSync(join(editionDir, "_internal", ".step-5-done.json")),
        false,
        "sentinel não deve ser gravado — guard de backend não tem bypass",
      );
    } finally {
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("backend kit: write --step 5 só com newsletter-kit-published.json passa o guard de backend (falha, se falhar, só por check-invariants — não por #7963)", () => {
    const aammdd = "919014";
    const isolatedCwd = setupIsolatedCwd();
    const editionDir = join(isolatedCwd, "data", "editions", aammdd.slice(0, 4), aammdd);
    try {
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", "newsletter-kit-published.json"),
        JSON.stringify({ status: "scheduled", broadcast_id: 1 }),
      );

      const { status, stderr } = runWrite(
        [
          "--edition", aammdd, "--step", "5",
          "--outputs", "_internal/newsletter-kit-published.json",
          "--bypass-reason", "isolar o guard de backend do check-invariants nesta unidade de teste",
        ],
        isolatedCwd,
      );

      assert.doesNotMatch(stderr, /backend ERRADO/);
      assert.equal(status, 0, `esperava write bem-sucedido (--bypass-reason cobre invariantes); stderr: ${stderr}`);
      assert.equal(existsSync(join(editionDir, "_internal", ".step-5-done.json")), true);
    } finally {
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("cenário completo do #7963: sentinel Stage 5 correto (backend kit) faz assertSentinel --step 5 passar (pré-condição do Stage 6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-backend-e2e-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "newsletter-kit-published.json"),
        JSON.stringify({ status: "scheduled", broadcast_id: 1 }),
      );
      writeFileSync(join(dir, "_internal", "06-social-published.json"), JSON.stringify({ posts: [] }));

      // Simula o write correto (backend-aware) do §5h — outputs só com o
      // artefato que o backend Kit de fato escreve.
      const backendCheck = checkBackendOutputsForWrite(
        5,
        ["_internal/newsletter-kit-published.json", "_internal/06-social-published.json"],
        "kit",
      );
      assert.equal(backendCheck.passed, true);

      // grava o sentinel diretamente (sem passar pelo gate de
      // check-invariants, que exige muito mais estado de edição do que
      // este teste precisa simular — o que importa aqui é o `outputs`
      // gravado, que é exatamente o que assertSentinel consulta depois).
      writeFileSync(
        join(dir, "_internal", ".step-5-done.json"),
        JSON.stringify({
          step: 5,
          completed_at: new Date().toISOString(),
          outputs: ["_internal/newsletter-kit-published.json", "_internal/06-social-published.json"],
        }),
      );

      const result = assertSentinel(dir, 5);
      assert.deepEqual(result, { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cenário do bug reportado: sentinel com outputs da edição 260911 (sem prefixo _internal/) sob backend kit faz assertSentinel --step 5 falhar", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-backend-bug-repro-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      // Sentinel exatamente como foi gravado na edição 260911 (bug real) —
      // outputs relativos ao editionDir SEM prefixo `_internal/`, e
      // `05-published.json` listado mas nunca escrito pelo Kit (só
      // `newsletter-kit-published.json` existe, e mesmo esse não bate o
      // path relativo gravado — reproduz o outputs_missing real).
      writeFileSync(
        join(dir, "_internal", ".step-5-done.json"),
        JSON.stringify({
          step: 5,
          completed_at: new Date().toISOString(),
          outputs: [
            "05-published.json",
            "newsletter-kit-published.json",
            "06-social-published.json",
          ],
        }),
      );

      const result = assertSentinel(dir, 5);
      assert.equal(result.ok, false);
      if (!result.ok && result.reason === "outputs_missing") {
        assert.ok(
          result.missingOutputs.includes("05-published.json"),
          `esperava 05-published.json entre os outputs ausentes, recebeu: ${JSON.stringify(result.missingOutputs)}`,
        );
      } else {
        assert.fail(`esperava reason=outputs_missing, recebeu: ${JSON.stringify(result)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadNewsletterBackend (#7963) — smoke", () => {
  it("nunca lança e sempre devolve 'beehiiv' ou 'kit'", () => {
    const backend = loadNewsletterBackend();
    assert.ok(backend === "beehiiv" || backend === "kit");
  });

  it("config path override (só teste): lê backend de um platform.config.json arbitrário", () => {
    const dir = mkdtempSync(join(tmpdir(), "newsletter-backend-cfg-"));
    try {
      const cfgPath = join(dir, "platform.config.json");
      writeFileSync(cfgPath, JSON.stringify({ publishing: { newsletter: { backend: "kit" } } }));
      assert.equal(loadNewsletterBackend(cfgPath), "kit");

      writeFileSync(cfgPath, JSON.stringify({ publishing: { newsletter: { backend: "beehiiv" } } }));
      assert.equal(loadNewsletterBackend(cfgPath), "beehiiv");

      writeFileSync(cfgPath, JSON.stringify({}));
      assert.equal(loadNewsletterBackend(cfgPath), "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config ausente → default beehiiv", () => {
    assert.equal(loadNewsletterBackend("/path/that/does/not/exist/platform.config.json"), "beehiiv");
  });
});
