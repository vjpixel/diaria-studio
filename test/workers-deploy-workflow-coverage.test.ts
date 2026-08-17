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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  // Regressão do deploy quebrado de 17/08/2026: workers/reativar tinha
  // workflow (o teste acima passava) mas nunca teve package-lock.json
  // commitado — o passo "Install reativar worker deps" (`npm ci` dentro do
  // worker) falhava com EUSAGE em TODA execução, então o deploy automático
  // que o #5337 entregou nunca chegou a rodar uma vez. `npm ci` exige
  // lockfile por definição; o único sinal era e-mail de run failed.
  it("todo worker com package.json tem package-lock.json commitado (npm ci no deploy)", () => {
    const workers = discoverWorkers();
    const missing: string[] = [];

    for (const worker of workers) {
      const dir = resolve(ROOT, "workers", worker.workerDir);
      if (!existsSync(resolve(dir, "package.json"))) continue;
      if (!existsSync(resolve(dir, "package-lock.json"))) missing.push(worker.workerDir);
    }

    assert.deepEqual(
      missing,
      [],
      `worker(s) com package.json mas sem package-lock.json: ${missing.join(", ")} — ` +
        "os deploy-*.yml rodam `npm ci` dentro do diretório do worker, que falha com EUSAGE sem lockfile. " +
        "Gerar com `npm install --package-lock-only` no diretório do worker e commitar.",
    );
  });
});
