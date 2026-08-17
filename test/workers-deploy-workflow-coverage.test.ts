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
 *
 * O 2º teste (#5531) cobre a classe seguinte, que a primeira não pega: o
 * workflow EXISTE mas morre no `npm ci` do próprio worker — lockfile
 * ausente ou dessincronizado do package.json. Mesmo desfecho (deploy
 * automático que nunca roda, drift só visível pelo alarme ou por e-mail de
 * run failed), origem diferente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverWorkers } from "../scripts/worker-drift-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = resolve(ROOT, ".github", "workflows");

function readWorkflowContents(): string[] {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  return files.map((f) => readFileSync(resolve(WORKFLOWS_DIR, f), "utf8"));
}

describe("cobertura de deploy workflow por worker (#5337)", () => {
  it("todo worker descoberto tem um .github/workflows/*.yml que referencia workers/{dir}/**", () => {
    const workers = discoverWorkers();
    assert.ok(workers.length > 0, "discoverWorkers() não encontrou nenhum worker — algo está errado na varredura");

    const workflowContents = readWorkflowContents();

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
  //
  // O teste cobre as 3 formas de quebrar esse mesmo passo: package.json
  // ausente, lockfile ausente, e lockfile fora de sincronia com o
  // package.json (o caso do próximo bump de dependência — `npm ci` aborta
  // igual). Nenhuma delas pode ser pulada em silêncio.
  it("todo worker coberto por `npm ci` no deploy tem package.json E package-lock.json em sincronia", () => {
    const workers = discoverWorkers();
    const workflowContents = readWorkflowContents();
    const broken: string[] = [];

    for (const worker of workers) {
      // Só cobra os arquivos de quem de fato tem um passo `npm ci` rodando
      // dentro do diretório do worker — pular em silêncio quem tem o passo
      // seria recriar, pro package.json, o mesmo buraco que este teste
      // fecha pro lockfile (nenhum deploy-*.yml guarda esse passo com `if:`).
      const runsNpmCi = workflowContents.some(
        (content) => content.includes(`working-directory: workers/${worker.workerDir}`) && content.includes("npm ci"),
      );
      if (!runsNpmCi) continue;

      const dir = resolve(ROOT, "workers", worker.workerDir);
      const pkgPath = resolve(dir, "package.json");
      const lockPath = resolve(dir, "package-lock.json");

      if (!existsSync(pkgPath)) {
        broken.push(`${worker.workerDir} (sem package.json)`);
        continue;
      }
      if (!existsSync(lockPath)) {
        broken.push(`${worker.workerDir} (sem package-lock.json)`);
        continue;
      }

      // `npm ci` também aborta quando o lockfile existe mas está DESSINCRONIZADO
      // do package.json — o caso do próximo bump de dependência em qualquer
      // worker. `packages[""]` do lockfileVersion >= 2 espelha os ranges
      // declarados, então a comparação é exata e não precisa de rede.
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const lockRoot = lock.packages?.[""] ?? {};

      for (const field of ["dependencies", "devDependencies"] as const) {
        const declared = JSON.stringify(pkg[field] ?? {});
        const locked = JSON.stringify(lockRoot[field] ?? {});
        if (declared !== locked) {
          broken.push(`${worker.workerDir} (${field} fora de sincronia: package.json ${declared} vs lock ${locked})`);
        }
      }
    }

    assert.deepEqual(
      broken,
      [],
      `worker(s) que quebram o \`npm ci\` do próprio deploy: ${broken.join("; ")} — ` +
        "regenerar com `npm install --package-lock-only` no diretório do worker e commitar. " +
        "Se falhar com ERESOLVE (wrangler >4.101 exige `@cloudflare/workers-types@^5.x` via peerOptional), " +
        "bumpar workers-types pra `^5.x` antes, como workers/livros e workers/reativar já fazem.",
    );
  });
});
