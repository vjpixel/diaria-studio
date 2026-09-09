/**
 * test/deploy-poll-waits-for-site.test.ts (#7755)
 *
 * Guard estático (sem rede, sem `wrangler deploy`) pro conserto do #7755:
 * `deploy-poll.yml` e `deploy-site.yml` disparam pelo mesmo push, em
 * grupos de concorrência separados, sem ordem garantida — `poll` serve uma
 * rota (`eia.diar.ia.br/confirmado`) cujo redirect aponta pra uma página
 * que `site` publica (#7737/PR #7751), então `poll` publicando ANTES de
 * `site` abre uma janela de 404 na confirmação de assinatura.
 *
 * O conserto adiciona um job `wait-for-site` em `deploy-poll.yml` que:
 * 1. Só espera quando este push TAMBÉM tocou `workers/site/**` (checagem
 *    determinística via `git diff` no próprio commit) — quando só `poll`
 *    mudou, não existe run de `deploy-site.yml` pra este SHA pra esperar,
 *    e o job segue sem atraso.
 * 2. Quando espera, usa `gh run watch --exit-status` sobre o run de
 *    `deploy-site.yml` filtrado por `head_sha` — propaga falha (nunca
 *    deploya `poll` depois de um `site` que falhou/foi cancelado).
 * 3. O job `deploy` (que de fato publica `poll`) declara `needs:
 *    wait-for-site` — sem essa aresta, o job de espera existiria mas não
 *    bloquearia nada.
 *
 * Este teste NÃO executa o workflow (não há rede/API do GitHub aqui) — é
 * um guard de ESTRUTURA sobre o YAML: confirma que as peças acima existem
 * no arquivo, na ordem/relação certa, contra regressão de alguém remover o
 * `needs:`, trocar `gh run watch` por algo que engole falha, ou remover a
 * checagem condicional e fazer `poll` esperar incondicionalmente (o que
 * travaria pushes que só tocam `workers/poll/**`, o "cuidado real" citado
 * na issue).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_POLL_PATH = resolve(ROOT, ".github", "workflows", "deploy-poll.yml");

function readDeployPoll(): string {
  return readFileSync(DEPLOY_POLL_PATH, "utf8");
}

describe("deploy-poll.yml espera deploy-site.yml só quando o push acopla os dois (#7755)", () => {
  it("declara um job wait-for-site", () => {
    const yaml = readDeployPoll();
    assert.match(yaml, /^\s*wait-for-site:\s*$/m, "job 'wait-for-site:' não encontrado em deploy-poll.yml");
  });

  it("checa deterministicamente (git diff) se este push tocou workers/site/**, sem waiting incondicional", () => {
    const yaml = readDeployPoll();
    assert.match(
      yaml,
      /git diff --name-only[^\n]*\|\s*grep -q\s*['"]?\^workers\/site\//,
      "não encontrei a checagem `git diff ... | grep '^workers/site/'` — sem ela, o job não sabe distinguir " +
        "'este push tocou site' de 'só poll mudou', e arrisca esperar incondicionalmente (o cuidado real da issue).",
    );
    // O passo de espera precisa ser CONDICIONAL a essa checagem, não sempre executado.
    assert.match(
      yaml,
      /if:\s*steps\.check\.outputs\.touched\s*==\s*['"]true['"]/,
      "o passo que espera deploy-site.yml precisa ser condicional a `steps.check.outputs.touched == 'true'` — " +
        "sem essa guarda, poll esperaria mesmo quando site não mudou neste push.",
    );
  });

  it("consulta os runs de deploy-site.yml filtrados pelo head_sha do próprio push (nunca um run genérico/antigo)", () => {
    const yaml = readDeployPoll();
    assert.match(
      yaml,
      /workflows\/deploy-site\.yml\/runs\?head_sha=/,
      "a consulta à API de runs precisa filtrar por head_sha do commit atual — sem isso poderia pegar um run " +
        "de deploy-site.yml de outro commit, tanto um antigo (falso 'já terminou') quanto um futuro.",
    );
  });

  it("usa `gh run watch --exit-status` (ou equivalente que propaga falha) — nunca ignora silenciosamente um site que falhou", () => {
    const yaml = readDeployPoll();
    assert.match(
      yaml,
      /gh run watch\s+"?\$?\w*"?\s+--repo\s+"?\$?\w*"?\s+--exit-status/,
      "esperava `gh run watch <run_id> --repo <repo> --exit-status` — sem `--exit-status`, o step de espera " +
        "sempre sai 0 independente do resultado do deploy de site, e o guard 'nunca deploya poll depois de um " +
        "site que falhou' vira decorativo.",
    );
  });

  it("o job deploy (que de fato publica poll) declara needs: wait-for-site", () => {
    const yaml = readDeployPoll();
    const deployJobMatch = /^\s{2}deploy:\s*\n((?:^\s{4}.*\n?)*)/m.exec(yaml);
    assert.ok(deployJobMatch, "job 'deploy:' não encontrado em deploy-poll.yml");
    assert.match(
      deployJobMatch![1],
      /needs:\s*wait-for-site/,
      "job 'deploy' precisa de `needs: wait-for-site` — sem essa aresta, o job de espera roda mas não " +
        "bloqueia o deploy de fato, e a janela de 404 do #7755 volta a existir.",
    );
    // Continua chamando o reusable workflow (#7118) — o guard não deve
    // regredir a convergência anterior.
    assert.match(
      deployJobMatch![1],
      /uses:\s*\.\/\.github\/workflows\/deploy-worker\.yml/,
      "job 'deploy' deveria continuar chamando o reusable deploy-worker.yml (#7118) — não reverter pra steps inline.",
    );
  });

  it("não usa workflow_run como trigger primário (preservaria push+paths, evitando quebrar pushes que só tocam poll)", () => {
    const yaml = readDeployPoll();
    // O trigger de topo (`on:`) precisa continuar sendo push+paths +
    // workflow_dispatch, como sempre foi — trocar por `workflow_run` faria
    // `poll` só disparar quando `site` rodasse, quebrando o caso comum de
    // push que mexe só em workers/poll/**.
    const onBlockMatch = /^on:\s*\n((?:^\s{2}.*\n?)*)/m.exec(yaml);
    assert.ok(onBlockMatch, "bloco 'on:' não encontrado em deploy-poll.yml");
    assert.match(onBlockMatch![1], /push:/, "trigger 'push:' precisa continuar existindo em deploy-poll.yml");
    assert.match(onBlockMatch![1], /workers\/poll\/\*\*/, "paths filter 'workers/poll/**' precisa continuar existindo");
    assert.doesNotMatch(
      onBlockMatch![1],
      /workflow_run:/,
      "o trigger de topo não deveria virar workflow_run — a ordenação é feita via job wait-for-site, não via trigger",
    );
  });
});
