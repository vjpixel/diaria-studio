/**
 * dashboard-diaria.ts (#3563 — fatia 9 do epic #3554 "Studio UI", endereça #3550)
 *
 * Reusa a lógica de agregação (`buildDashboardData`, de
 * `scripts/build-diaria-dashboard-data.ts`) e de render (`renderDashboardHtml`,
 * de `workers/diaria-dashboard/src/index.ts`) do dashboard operacional diário
 * para servir o MESMO HTML como painel local do studio-server — zero fork de
 * template, sem tocar KV/Cloudflare, lendo direto de `data/` (sempre fresco).
 *
 * A aba "É IA?" (`renderPollEiaSection`, dentro de `renderDashboardHtml`) já
 * vem embutida a partir de `data/poll-eia-summary.json` — cobre o pedido de
 * embed do dashboard "poll" (#3563) sem view separada: o poll é uma ABA do
 * MESMO documento, não um painel à parte. `data/poll-eia-summary.json` é
 * populado por `npx tsx scripts/build-poll-eia-data.ts --push` (fora do
 * escopo desta fatia rodar isso automaticamente — o painel só LÊ o arquivo se
 * ele existir, graceful caso contrário, mesmo comportamento do Worker).
 *
 * Limitação conhecida (documentada, não uma regressão nova desta fatia):
 * `buildDashboardData()` (e os builders que ela chama) resolvem `data/`
 * relativo ao `process.cwd()` do PROCESSO, capturado 1x na IMPORTAÇÃO do
 * módulo `build-diaria-dashboard-data.ts` (consts `ROOT`/`DATA_DIR` no topo
 * do arquivo) — não por chamada, e não parametrizável por `rootDir`. Isso é
 * IDÊNTICO à limitação já existente do CLI standalone
 * (`npx tsx scripts/build-diaria-dashboard-data.ts --dry-run`, que também só
 * funciona rodado a partir da raiz do repo). Requer que o studio-server rode
 * com cwd == a raiz real do projeto — o caso normal (`npm run studio`/
 * `npx tsx scripts/studio-ui/server.ts` a partir da raiz). Com `data/`
 * ausente (sessão cloud, sem o junction OneDrive — label `local`, #2643), o
 * dashboard renderiza normalmente com todas as seções em estado "sem dados"
 * — graceful, `buildDashboardData()` nunca lança nesse caso (mesmos guards
 * `existsSync`/`loadHealth` "gracioso se não existir" documentados no
 * próprio arquivo).
 *
 * Nota técnica: `renderDashboardHtml` é importado via `import()` DINÂMICO
 * (não `import { ... } from "..."` estático) — reproduzido em isolamento:
 * um `import` estático de `workers/diaria-dashboard/src/index.ts` (só ESSE
 * arquivo especificamente; `brevo-api.ts`/`sections-core.ts` do outro worker
 * NÃO têm o mesmo problema) falha em runtime sob `node --import tsx` com
 * `SyntaxError: ... does not provide an export named 'renderDashboardHtml'`,
 * mesmo a função existindo (`export function renderDashboardHtml`) — um
 * quirk do loader ESM do Node ao analisar estaticamente esse arquivo
 * específico (é o entrypoint do Worker, `export default { async fetch... }`).
 * `import()` dinâmico contorna o problema (mesmo padrão já usado em TODO o
 * `test/build-diaria-dashboard-data.test.ts` para importar deste mesmo
 * arquivo — convenção pré-existente do repo, não uma decisão nova desta
 * fatia).
 */

import { buildDashboardData } from "../build-diaria-dashboard-data.ts";

let renderDashboardHtmlPromise: Promise<(data: ReturnType<typeof buildDashboardData>) => string> | null = null;

function loadRenderDashboardHtml(): Promise<(data: ReturnType<typeof buildDashboardData>) => string> {
  if (!renderDashboardHtmlPromise) {
    renderDashboardHtmlPromise = import("../../workers/diaria-dashboard/src/index.ts").then(
      (mod) => mod.renderDashboardHtml,
    );
  }
  return renderDashboardHtmlPromise;
}

/**
 * Agrega + renderiza o dashboard operacional diário completo (Visão geral,
 * Saúde das fontes, CTR, Top links, Use Melhor, É IA?, Audiência) como HTML
 * autocontido (documento `<html>` completo, com seu próprio `<style>`) —
 * pronto para ser servido diretamente ou embutido via `<iframe>` same-origin
 * no studio-server (sem CSP/frame-ancestors a configurar: mesma origem).
 */
export async function buildDiariaDashboardHtml(): Promise<string> {
  const data = buildDashboardData();
  const renderDashboardHtml = await loadRenderDashboardHtml();
  return renderDashboardHtml(data);
}
