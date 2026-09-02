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
 *
 * #7118: 8 dos 12 `deploy-*.yml` viraram callers finos de
 * `.github/workflows/deploy-worker.yml` (`uses: ./.github/workflows/
 * deploy-worker.yml` + `with: worker: {dir}`) — o literal `working-
 * directory: workers/{dir}` + `npm run deploy` que o 3º teste procurava
 * não aparece mais no CALLER (só existe, templatizado via `${{ inputs.worker
 * }}`, dentro do reusable). `isDeployedViaWorker()` reconhece esse 2º
 * formato: caller com `uses: ./.github/workflows/deploy-worker.yml` +
 * `with:` contendo `worker: {dir}` conta como "deployado" tanto quanto o
 * padrão antigo (inline, ainda usado pelos 4 workers com pós-processamento
 * divergente: arquivo, artigos, cursos, livros).
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
  return readWorkflowFiles().map((f) => f.content);
}

function readWorkflowFiles(): { name: string; content: string }[] {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  return files.map((f) => ({ name: f, content: readFileSync(resolve(WORKFLOWS_DIR, f), "utf8") }));
}

/** #7118: um worker é "deployado" tanto pelo padrão antigo — steps de
 *  deploy inline no próprio deploy-{worker}.yml, `working-directory:
 *  workers/{dir}` + `npm run deploy` no mesmo arquivo (os 4 workers com
 *  pós-processamento divergente) — quanto pelo novo — um caller fino que
 *  chama `deploy-worker.yml` via `workflow_call` passando `worker: {dir}`
 *  (os 8 workers convergidos). */
function isDeployedViaWorker(workerDir: string, workflowFiles: { name: string; content: string }[]): boolean {
  const inlinePattern = (content: string) =>
    content.includes(`working-directory: workers/${workerDir}`) && content.includes("npm run deploy");

  const callsReusableFor = (content: string) => {
    if (!content.includes("./.github/workflows/deploy-worker.yml")) return false;
    // `with: worker: {dir}` — casar a linha inteira evita que "poll" case
    // dentro de "poll-2" ou que um prefixo comum entre dois worker dirs
    // produza falso positivo.
    const workerLine = new RegExp(`^\\s*worker:\\s*${workerDir}\\s*$`, "m");
    return workerLine.test(content);
  };

  return workflowFiles.some(({ content }) => inlinePattern(content) || callsReusableFor(content));
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
    const workflowFiles = readWorkflowFiles();
    const broken: string[] = [];

    const rootLockPath = resolve(ROOT, "package-lock.json");
    assert.ok(existsSync(rootLockPath), "package-lock.json da raiz não existe — rodar `npm install` antes.");
    const rootLock = JSON.parse(readFileSync(rootLockPath, "utf8"));

    for (const worker of workers) {
      // Só cobra worker de fato deployado — inline (`npm run deploy` +
      // `working-directory: workers/{dir}` no próprio deploy-*.yml) OU via
      // caller fino de deploy-worker.yml (#7118, ver isDeployedViaWorker
      // acima) — pular em silêncio quem não tem workflow seria recriar, pro
      // package.json do workspace, o mesmo buraco que a versão pré-#7117
      // deste teste fechava pro lockfile solo.
      const isDeployed = isDeployedViaWorker(worker.workerDir, workflowFiles);
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

  // #7118: os 8 callers finos de deploy-worker.yml (draft, poll,
  // linkedin-cron, site, artigo-mensal, diaria-dashboard, reativar,
  // brevo-dashboard) passam `worker: {dir}` via `with:` — um copy-paste que
  // colar o worker ERRADO num arquivo (ex: deploy-poll.yml passando
  // `worker: draft`) não quebraria os 2 testes acima (o worker "draft"
  // continuaria coberto, só que 2x, e "poll" ficaria descoberto por um
  // arquivo cujo `paths:` ainda aponta certo) — guard dedicado, self-review
  // do PR #7118 nomeado na issue.
  it("cada caller de deploy-worker.yml passa worker: {dir} correspondente ao próprio nome do arquivo (#7118)", () => {
    const workflowFiles = readWorkflowFiles();
    const callers = workflowFiles.filter(({ content }) => content.includes("./.github/workflows/deploy-worker.yml"));

    assert.ok(callers.length > 0, "nenhum caller de deploy-worker.yml encontrado — reusable workflow ficou órfão?");

    const mismatched: string[] = [];
    for (const { name, content } of callers) {
      const expectedWorker = name.replace(/^deploy-/, "").replace(/\.ya?ml$/, "");
      const workerLine = new RegExp(`^\\s*worker:\\s*(\\S+)\\s*$`, "m").exec(content);
      if (!workerLine) {
        mismatched.push(`${name} (chama deploy-worker.yml mas não passa 'worker:' em with:)`);
        continue;
      }
      if (workerLine[1] !== expectedWorker) {
        mismatched.push(`${name} (passa worker: ${workerLine[1]}, esperava worker: ${expectedWorker} pelo próprio nome do arquivo)`);
      }
    }

    assert.deepEqual(
      mismatched,
      [],
      `caller(s) de deploy-worker.yml com worker: divergente do nome do arquivo: ${mismatched.join("; ")}`,
    );
  });
});
