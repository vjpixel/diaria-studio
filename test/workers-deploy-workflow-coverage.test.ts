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
 * O 2º teste (#5531, reescrito no #7117) cobre a classe seguinte, que a
 * primeira não pega: o workflow EXISTE mas morre no passo de instalação —
 * até o #7117, cada worker tinha SEU PRÓPRIO `package-lock.json` e o
 * `npm ci` rodava dentro de `workers/{worker}/`; agora `workers/` é um npm
 * workspace (`workspaces: ["workers/*"]` na raiz) com UM lockfile só na
 * raiz, e o `npm ci` dentro do worker foi removido de todo `deploy-*.yml`
 * (o `npm ci` na raiz já cobre o workspace inteiro). O teste original
 * checava package.json+lockfile do worker em sincronia; a versão pós-#7117
 * checa a mesma coisa contra o SHAPE do lockfile unificado (`packages["workers/{dir}"]`
 * no lockfile raiz) e, como regressão do drift que motivou o #7117, garante
 * que nenhum worker reintroduziu um `package-lock.json` próprio.
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

  // #7117: `workers/` virou npm workspace — regressão de dois ângulos que o
  // teste original (#5531, package.json+lockfile POR WORKER) não cobre mais
  // porque o lockfile por worker não existe: (1) ninguém reintroduziu um
  // `package-lock.json` dentro de um worker (voltaria o drift de 19.550
  // linhas que motivou o #7117); (2) o lockfile RAIZ unificado tem uma
  // entrada em sincronia (`packages["workers/{dir}"]`) para cada worker —
  // mesma checagem de fundo do teste original (declared === locked), só que
  // contra o shape do lockfile de workspace em vez do lockfile solo.
  it("nenhum worker tem package-lock.json próprio (unificado no lockfile raiz desde #7117)", () => {
    const workers = discoverWorkers();
    const reintroduced = workers
      .map((w) => w.workerDir)
      .filter((dir) => existsSync(resolve(ROOT, "workers", dir, "package-lock.json")));

    assert.deepEqual(
      reintroduced,
      [],
      `worker(s) com package-lock.json PRÓPRIO: ${reintroduced.join(", ")} — ` +
        "desde #7117 workers/ é um npm workspace com lockfile único na raiz; " +
        "rodar `npm install` na raiz (nunca `npm install`/`npm ci` dentro do worker) " +
        "e remover o lockfile solo reintroduzido.",
    );
  });

  it("todo worker coberto por `npm ci` (raiz, via workspace) tem package.json em sincronia com o lockfile raiz", () => {
    const workers = discoverWorkers();
    const workflowContents = readWorkflowContents();
    const broken: string[] = [];

    const rootLockPath = resolve(ROOT, "package-lock.json");
    assert.ok(existsSync(rootLockPath), "package-lock.json da raiz não existe — rodar `npm install` antes.");
    const rootLock = JSON.parse(readFileSync(rootLockPath, "utf8"));

    for (const worker of workers) {
      // Só cobra worker de fato deployado via `npm run deploy` num
      // deploy-*.yml — pular em silêncio quem não tem workflow seria
      // recriar, pro package.json do workspace, o mesmo buraco que a
      // versão pré-#7117 deste teste fechava pro lockfile solo.
      const isDeployed = workflowContents.some(
        (content) => content.includes(`working-directory: workers/${worker.workerDir}`) && content.includes("npm run deploy"),
      );
      if (!isDeployed) continue;

      const pkgPath = resolve(ROOT, "workers", worker.workerDir, "package.json");
      if (!existsSync(pkgPath)) {
        broken.push(`${worker.workerDir} (sem package.json)`);
        continue;
      }

      const lockEntry = rootLock.packages?.[`workers/${worker.workerDir}`];
      if (!lockEntry) {
        broken.push(`${worker.workerDir} (sem entrada "workers/${worker.workerDir}" no package-lock.json raiz — rodar \`npm install\` na raiz)`);
        continue;
      }

      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      for (const field of ["dependencies", "devDependencies"] as const) {
        const declared = JSON.stringify(pkg[field] ?? {});
        const locked = JSON.stringify(lockEntry[field] ?? {});
        if (declared !== locked) {
          broken.push(`${worker.workerDir} (${field} fora de sincronia: package.json ${declared} vs lock ${locked})`);
        }
      }
    }

    assert.deepEqual(
      broken,
      [],
      `worker(s) fora de sincronia com o lockfile raiz: ${broken.join("; ")} — ` +
        "rodar `npm install` na RAIZ do repo (nunca dentro do worker) e commitar o package-lock.json atualizado.",
    );
  });
});
