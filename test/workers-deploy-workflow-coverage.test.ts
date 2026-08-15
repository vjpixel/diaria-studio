/**
 * test/workers-deploy-workflow-coverage.test.ts (#5337)
 *
 * Regressão pra classe de bug já recorrente 3x (#3268 brevo-dashboard, #3399
 * poll, #5337 reativar): um Worker novo (ou um Worker antigo que nunca
 * ganhou workflow) fica sem deploy automático, e o único jeito de descobrir
 * é o alarme `Diaria-Worker-Drift-Check` disparar dias depois — ou um
 * incidente em produção.
 *
 * Este teste garante, deterministicamente e sem rede, que TODO worker
 * descoberto por `discoverWorkers()` (a mesma varredura de
 * `workers/*​/wrangler.toml`/`.jsonc` usada por `worker-drift-check.ts`, sem
 * lista hardcoded) tem pelo menos um workflow em `.github/workflows/*.yml`
 * cujo `paths:` referencia `workers/{workerDir}/**`. Um Worker novo sem
 * workflow correspondente quebra o CI imediatamente, em vez de esperar até
 * 6h (cadência do alarme) ou até um incidente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverWorkers } from "../scripts/worker-drift-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = resolve(ROOT, ".github", "workflows");

describe("cobertura de deploy workflow por worker (#5337)", () => {
  it("todo worker descoberto tem um .github/workflows/*.yml que referencia workers/{dir}/**", () => {
    const workers = discoverWorkers();
    assert.ok(workers.length > 0, "discoverWorkers() não encontrou nenhum worker — algo está errado na varredura");

    const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    const workflowContents = workflowFiles.map((f) => readFileSync(resolve(WORKFLOWS_DIR, f), "utf8"));

    const missing: string[] = [];
    for (const worker of workers) {
      const needle = `workers/${worker.workerDir}/**`;
      const covered = workflowContents.some((content) => content.includes(needle));
      if (!covered) missing.push(worker.workerDir);
    }

    assert.deepEqual(
      missing,
      [],
      `worker(s) sem workflow de deploy correspondente em .github/workflows/: ${missing.join(", ")} — ` +
        "criar um deploy-{worker}.yml espelhando deploy-poll.yml/deploy-reativar.yml (push em master " +
        `tocando "workers/{worker}/**" + workflow_dispatch).`,
    );
  });
});
