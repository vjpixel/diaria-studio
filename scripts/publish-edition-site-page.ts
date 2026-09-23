#!/usr/bin/env node
/**
 * scripts/publish-edition-site-page.ts (#6202, fatia do #467)
 *
 * Publica a página da edição recém-agendada no Worker `diaria-site`.
 *
 * ## Por que existe
 *
 * O Worker já serve `/p/{slug}` para as 253 páginas do acervo (#6167), mas o
 * acervo é **estático**: sem este passo, as edições novas nunca entram, e o
 * site que o cutover vai colocar no apex nasce parado no tempo.
 *
 * O editor amarrou o greenlight da janela de cutover a este passo
 * (comentário de 26/08 no #467) — enquanto ele não roda, a janela não abre.
 *
 * ## Onde roda, e por que ali
 *
 * Etapa 6, **antes** da parada única do gate (§6b-site, #8221 — movido de
 * depois do agendamento confirmado, espelhando o guard de slug do #8205).
 * Decisão explícita do editor (17/09/2026): o trade-off de a página do site
 * já estar publicada mesmo que o editor responda `abortar` no gate foi
 * aceito por escrito — a alternativa (separar validação-antes de
 * publicação-depois) foi apresentada e recusada em favor da versão simples
 * e simétrica ao guard de slug.
 *

 * ## O slug vem de `--slug`, nunca de `post_url` sozinho (#6202 review, problema 1)
 *
 * `_internal/05-published.json` nunca tem `post_url` populado no momento em
 * que este passo roda no Stage 6 — Stage 5 grava `draft_url`/`post_id`,
 * `verify-scheduled-post.ts` grava `status`/`published_at`, e o único
 * escritor de `post_url` é `refresh-dedup.ts:autoStampPublishedJson()`, que
 * exige `post.published_at` no cache da Beehiiv — só disponível no dia
 * seguinte. Sem `--slug`, toda execução normal caía no "nada a publicar",
 * em silêncio, permanentemente.
 *
 * O dado já está na mão: §6b-slug do orchestrator (que roda ANTES deste
 * passo, e antes do gate — #8205/#8221) já busca
 * `mcp__claude_ai_Beehiiv__get_post({ post_id })` → `web_settings.slug` —
 * então quando este passo roda, o slug real já foi apurado (divergência,
 * se houver, vira aviso no gate, não bloqueia). §6b-site recebe esse MESMO
 * valor via `--slug`.
 *
 * `--slug` ausente ainda é suportado (invocação ad-hoc pós-`refresh-dedup`,
 * quando `post_url` já foi carimbado) — mas dentro do Stage 6 normal, sempre
 * passar `--slug`.
 *
 * ## Fail-soft, sempre
 *
 * Publicar no site é ACESSÓRIO ao envio. Nenhuma falha aqui pode derrubar a
 * edição — todos os caminhos ruins viram exit != 0 com motivo, e a Etapa 6
 * trata como warning. É a mesma disciplina do canal Brevo (#5772) e do canal
 * Kit (#6126).
 *
 * ## #8636 (260921): o passo roda num worktree temporário, nunca no checkout compartilhado
*
* **O bug.** O guard do #7287 recusava o passo quando o checkout compartilhado
* estava em branch de trabalho (`HEAD != origin/master`) — e o passo roda no
* mesmo checkout onde outras sessões (overnight, develop, outro `continuo`)
* trocam de branch o tempo todo. Resultado: code 3, a página ficava só em
* disco, o gate mostrava um aviso, e o orchestrador tinha que rodar o passo
* de novo depois de sincronizar. O guard está **certo** — o problema é que o
* passo não deveria depender do estado do checkout compartilhado.
*
* **A correção.** `--worktree-dir <path>` (ou, por default, um temp em
* `tmpdir()`) faz o script criar um `git worktree add --detach` a partir de
* `origin/master` e rodar TODO o commit/push DENTRO do worktree (cwd =
* `worktreeDir`). O worktree nasce em `origin/master`, então "nascer de um
* master conhecido" é satisfeito por construção — o guard do #7287 é pulado
* (não verificado), e não há `checkout` de volta porque o checkout
* compartilhado nunca foi tocado. O worktree é removido no `finally`
* (`git worktree remove --force`, fail-soft) e `main` tem fallback de
* `rmSync` + `git worktree prune`.
*
* **O que muda e o que não muda.** `writePage` e `updateSitemapAndHome`
* continuam escrevendo em `rootDir` (o checkout compartilhado) — mas o
* worktree **não** enxerga esse conteúdo sozinho: o comando de worktree faz
* um checkout físico a partir de um REF (reflete só o que já está COMMITADO
* em `origin/master`), nunca arquivos untracked de outro working tree.
* Página nova (slug nunca commitado) e sitemap/home atualizados (rastreados,
* mas com conteúdo novo só em `rootDir`) ficam invisíveis pro worktree por
* padrão — foi exatamente essa suposição errada que causou a regressão P0
* do #8636 (reaberta 21/09/2026, reproduzida com git real). **Correção**:
* logo após o checkout dedicado dentro do worktree, `commitAndPushSitePage`
* copia (`cpSync`) de `rootDir` pro `worktreeDir` cada path que vai ser
* staged (`relPageDir` sempre; `optionalPaths` só os que existirem) — só
* então o add/status/commit do worktree enxergam o conteúdo certo. **Ressalva
* para paths que são DIRETÓRIOS** (ex: o acervo de #8645/#8664, quando essa
* branch mergear): `cpSync` recursivo é aditivo — não remove do worktree um
* arquivo que foi PODADO em `rootDir` (o worktree herdou esse arquivo do
* mesmo jeito de `origin/master`, então nunca é tocado). Pra esses paths, o
* bloco de cópia limpa `dest` por completo (`rmSync` recursivo) antes do
* `cpSync`, deixando `dest` byte-a-byte igual a `src` — nunca um merge
* aditivo dos dois. O merge lock cross-sessão (#6626) continua valendo no
* caminho do worktree também — ele serializa a abertura do PR, que é a única
* parte mesmo assim compartilhada. O caminho legado (sem `--worktree-dir`) é
* preservado byte a byte: os testes existentes de `commitAndPushSitePage`
* não mudam.
*
* **Quando usar.** Default do `main` (sem `--skip-publish` e sem
* `--worktree-dir` explícito) é SEMPRE o worktree — o checkout compartilhado
* nunca mais é o cwd do commit/push. `--skip-publish` (testes, ou rodada
* só-escrita) pula o worktree: a página fica em `rootDir`, sem git. Testes
* que precisam de um worktree já existente passam `--worktree-dir`.
*
* ## #8684 (260921): checkout desincronizado ainda podia acontecer via CÓDIGO
* velho no disco, não só via `origin/master` velho
*
* **O bug.** Edição 260922, Stage 6: `publish-edition-site-page.ts` saiu com
* `exit 3` — "checkout não está sincronizado com origin/master" (o guard
* legado do #7287, ver `commitAndPushSitePage`). O worktree default do
* #8636 já existia em `master` nesse momento, mas o checkout que rodou o
* script ainda não tinha puxado esse commit: a sessão de Stage 5/6 (#6171,
* sempre NOVA) nunca roda `sync-code.ts` (isso só acontece no Passo 0 de
* `/diaria-edicao`), então o script que de fato executou era a versão SEM
* worktree default — caiu no caminho legado (`!worktreeDir`) e bateu no
* guard que o #8636 existe justamente para tornar irrelevante.
*
* **2 correções, em camadas diferentes (nenhuma sozinha bastava).** (1)
* Sessão: `.claude/skills/diaria-5-publicacao/SKILL.md` ganhou um passo de
* sync-code no início, espelhando o Passo 0 de `/diaria-edicao` — garante
* que o CÓDIGO em disco (não só o conteúdo publicado) esteja atualizado
* antes de qualquer script deste stage rodar; sem isso, uma correção futura
* no PRÓPRIO `publish-edition-site-page.ts` teria o mesmo problema recursivo
* que o #8636 teve aqui. (2) Script: `commitAndPushSitePage` agora tenta
* `git fetch origin master` (best-effort, fail-soft) imediatamente antes do
* `git worktree add --detach <tmp> origin/master` — o worktree nasce do ref
* LOCAL de `origin/master`, que `git worktree add` sozinho nunca atualiza;
* sem um fetch fresco nesta mesma chamada, o worktree podia nascer de um
* `origin/master` desatualizado por horas (mesmo já rodando código pós-#8636
* correto) sempre que a sessão ficar muito tempo entre o sync inicial (1) e
* este passo — falha de fetch nunca lança, só avisa em stderr e segue com o
* ref já cacheado (nunca pior que o comportamento pré-#8684).
*
* ## #8645 (260921): backfill de SEO + reindexação do acervo NO PRÓPRIO publish
*
* **Os 2 gaps.** (a) `buildEditionArchivePost` (`edition-site-page.ts`) nunca
* seta `thumbnail_url` — sem ele, `buildArchivePageHtml` nunca preenche
* `image` no JSON-LD `NewsArticle` (og:image/twitter:image também ficam
* ausentes, mas nenhum teste de CI cobre isso hoje — só o `image` do
* JSON-LD, `test/discover-news-requisitos-8390.test.ts`). (b)
* `archive/{n}/index.html` (o índice paginado) só é regenerado por
* `gen-archive-index.ts`, chamado hoje só pelo cron diário
* `regen-home.yml` — sem isso, a edição nova nunca aparece linkada em
* nenhuma página do índice (`test/site-archive-index-8353.test.ts`).
*
* **A correção.** `backfillAndReindexArchive` (`PublishPageDeps`) roda
* DEPOIS de `updateSitemapAndHome` (precisa do `sitemap.xml` já com a
* entrada desta edição) e ANTES do commit único: (1)
* `runBackfill(..., { onlySlug: slug })` — o MESMO backfill que
* `backfill-archive-page-links-seo.ts` já usava em lote (#8352/#8353/
* #8359/#8390), agora restrito a 1 slug (ver docstring de `runBackfill`
* pra por que — rodar as ~270 páginas do acervo a cada publicação diária
* seria I/O desperdiçado); (2) `gen-archive-index.ts` `main()` importado e
* chamado em processo (nunca subprocesso) contra o MESMO sitemap/pages-dir
* já atualizados — regenera o índice inteiro (barato, ~9 páginas com
* `ARCHIVE_INDEX_PAGE_SIZE=30`), incluindo a poda de páginas órfãs e a
* limpeza do sitemap na MESMA execução (sem `--no-sitemap` — este publish
* já É o commit que vai levar essa mudança, ao contrário do cron diário).
* Ambos fail-soft: uma falha aqui vira aviso em stderr, nunca reverte a
* publicação da página em si.
*
* **Caveat herdado do worktree do #8636.** Assim como `updateSitemapAndHome`
* já fazia antes desta issue, `backfillAndReindexArchive` escreve em
* `rootDir` (o checkout onde este script roda), não em `worktreeDir` — e o
* `git add` do commit roda DENTRO do worktree (um clone `--detach` de
* `origin/master`, ver seção #8636 acima). Path já TRACKED em
* `origin/master` (`sitemap.xml`, `archive/`) existe no worktree, então
* `git add` não lança — mas o CONTEÚDO staged é o que já estava no
* worktree, não necessariamente o que acabou de ser escrito em `rootDir`
* fora dele. Este módulo não tenta resolver essa divergência (fora do
* escopo do #8645) — documentado aqui pra quem for investigar um commit de
* site-page cujo `archive/`/`sitemap.xml` não reflita a escrita local mais
* recente.
*
* ## Mecanismo de publicação: branch dedicada + PR, nunca push direto em `master` (#6598)
 *
 * **Histórico (#6202): este script fazia `git push` DIRETO em `master`.**
 * Em 260828 (#6598) uma regra de proteção de branch (`GH013`, ruleset
 * "Changes must be made through a pull request") foi ativada em `master`
 * no GitHub e o push direto passou a ser rejeitado — toda edição doravante
 * falharia esse passo (fail-soft, não bloqueia o pipeline, mas o acervo do
 * site para de crescer). Migrado para: `git checkout -B
 * site-publish/{slug}` a partir do checkout local (precondição revisada pelo
 * #7287: o checkout precisa estar SINCRONIZADO com `origin/master` — HEAD no
 * mesmo commit — antes de começar; não precisa se CHAMAR `master`. Garante
 * que a branch nasça de um ponto conhecido, não de um checkout divergente
 * de outra sessão), commit escopado ao
 * pathspec da página (mesma disciplina P1-A/P1-B de sempre), `git push
 * --force-with-lease -u origin site-publish/{slug}` (force-with-lease é
 * seguro aqui porque a branch é de propriedade exclusiva deste script —
 * recriada do zero a cada chamada via `-B`, nunca editada por humano), e
 * de volta pro `master` local (`finally`, mesmo em erro) — o checkout
 * compartilhado nunca fica preso numa branch de publicação de página.
 * Depois do push, `gh pr create` (reusando um PR já aberto pra essa
 * branch, se existir — `gh pr list --head ... --state open`) abre o PR;
 * **o script NUNCA mergeia** (decisão do editor, #6598: menos código novo,
 * e mergear automaticamente uma página de site foge do padrão
 * branch→CI→merge já estabelecido pra esta linha de skills — Stage 6 já é
 * gate humano, um PR extra pendente não atrasa a edição). O deploy real só
 * acontece quando alguém — o coordenador de uma próxima rodada
 * overnight/develop, ou o editor manualmente — mergear o PR
 * (`.github/workflows/deploy-site.yml` dispara em push a `master`).
 *
 * `wrangler deploy` local segue descartado pelo mesmo motivo de sempre:
 * publicaria estado NÃO-commitado e faria o worker em produção divergir do
 * que está no repo, todo dia, sem sinal.
 *
 * Fail-soft, inalterado: falha de checkout/commit/push/`gh pr create`
 * nunca lança pro chamador do módulo — vira `code: 3` com o motivo; a
 * página já está escrita localmente (e, se o commit teve sucesso antes de
 * algo mais adiante falhar, já commitada na branch) — a próxima
 * rodada/push manual a leva junto.
 *
 * ## Idempotência
 *
 * Escrever a mesma página duas vezes é inofensivo (mesmo conteúdo, mesmo
 * caminho). `commitAndPushSitePage` recria `site-publish/{slug}` do zero a
 * cada chamada (`checkout -B`, sempre a partir do `master` atual) — não há
 * estado local acumulando entre chamadas. Não gera commit vazio: se `git
 * status --porcelain` não acusar mudança no caminho da página, pula o
 * `commit` — mas SEMPRE tenta o `push` (#6202 review, problema P1-B: status
 * limpo significa "nada novo a commitar", não "nada a empurrar" — um commit
 * de uma rodada anterior pode ter ficado sem push por falha de rede/auth, e
 * só tentar de novo nessa 2ª chamada recupera isso). Reabrir um PR já aberto
 * pra mesma branch nunca duplica — `gh pr list --head ... --state open` é
 * checado antes de `gh pr create`. `--skip-publish` existe pra quando só a
 * escrita local importa; o resultado informa se o push está confirmado em
 * dia com o remoto (`published`) e, quando disponível, a URL do PR.
 *
 * Exit codes:
 *   0 — página escrita (e branch publicada + PR aberto/reusado — se pedido;
 *       o deploy real só acontece depois do PR ser mergeado, ver acima)
 *   1 — uso
 *   2 — pré-requisito AUSENTE: `_internal/newsletter-final.html` ou
 *       `_internal/05-published.json` ainda não existem. NÃO é erro, é "esta
 *       edição não tem o que publicar ainda".
 *   3 — falha ao escrever, comitar ou dar push
 *   4 — artefato PRESENTE porém inválido/inesperado (html vazio, título
 *       ausente, slug não-extraível de `post_url`, ou `post_url` ausente sem
 *       `--slug`) — diferente do `2`, isto é sintoma de bug num stage
 *       anterior e merece atenção, não silêncio.
 *   5 — GUARD (#6202): `buildArchivePageHtml` recusou o HTML por merge tag
 *       não resolvida (`UnresolvedMergeTagError`, guard do #6210/#6256 —
 *       mesma função que o gerador do acervo usa, `lib/site-archive-pages.ts`).
 *       Falha fechada: NADA é escrito nem commitado. **Não é o caminho comum**
 *       — a merge tag padrão do link de voto (`?email={{email}}`, presente em
 *       toda edição Beehiiv) já é sanitizada dentro de `buildArchivePageHtml`
 *       antes deste guard rodar; `5` só dispara pra tag DESCONHECIDA (ex:
 *       backend Kit, ou uma variante nova). Nomeia a(s) tag(s) na mensagem.
 *       Agnóstico à decisão pendente do #6210 (o que a página web deve fazer
 *       com o bloco de voto do É IA? — remover parâmetro, apontar pro
 *       `/jogar`, ou remover o bloco): este guard só recusa publicar o
 *       literal cru, não decide como resolvê-lo.
 *
 * Uso:
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir data/editions/AAMMDD --slug o-slug-do-post
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir ... --slug ... --skip-publish
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir ... --slug ... --sitemap workers/site/public/sitemap.xml
 *
 * #6454 (achado 04/09/2026: a flag existia desde a 1ª versão, mas só
 * STAGEAVA o arquivo pro commit — nada escrevia conteúdo nele, então o
 * sitemap nunca mudava de verdade e a home ficava congelada mesmo com
 * `--sitemap` passado): `--sitemap <path>` agora ATUALIZA `sitemap.xml` com
 * a entrada desta edição (`sitemapEntryFromPost`/`addSitemapEntry`,
 * idempotente — não duplica) e REGENERA `index.html` (a home) a partir do
 * feed resultante (`buildHomeFeed`/`buildIndexHtml`, mesmo miolo puro que
 * `gen-home-page.ts` usa) — ambos escritos localmente ANTES do
 * commit+push, no mesmo diretório público
 * (`workers/site/public/{sitemap.xml,index.html}`), então o mesmo deploy
 * que publica a página também serve o feed atualizado da home. A home
 * passa a se manter sozinha a cada edição publicada por este script — sem
 * depender de alguém rodar `gen-archive-pages.ts`/`gen-home-page.ts` à
 * mão, ou do cache Beehiiv (que edições publicadas pelo Kit nunca
 * alimentam — ver #6454 original). Falha nesta etapa é fail-soft: a
 * publicação da página em si nunca é bloqueada por um problema aqui.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, cpSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  buildArchivePageHtml,
  UnresolvedMergeTagError,
  sitemapEntryFromPost,
  addSitemapEntry,
  buildSitemapXml,
  type ArchivePost,
} from "./lib/site-archive-pages.ts";
import { buildEditionArchivePost, type EditionPageInputs } from "./lib/edition-site-page.ts";
import { buildHomeFeed, buildIndexHtml, ARCHIVE_CARD_LIMIT } from "./lib/site-home-page.ts";
import { evaluatePrChecksGate } from "./lib/pr-checks-gate.ts";
// #8645: backfill de SEO (image no JSON-LD a partir do hero) restrito a 1
// slug + regeneração do índice paginado do acervo — ambos rodam como parte
// deste próprio publish, ANTES do commit único (ver `backfillAndReindexArchive`).
import { runBackfill } from "./backfill-archive-page-links-seo.ts";
import { main as genArchiveIndexMain } from "./gen-archive-index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");

/** Sinaliza "artefato PRESENTE mas com conteúdo inválido" — vira `code: 4`. */
export class EditionInputsInvalid extends Error {}

/**
 * Lê `publishing.newsletter.backend` de `platform.config.json` (default
 * `"beehiiv"` — mesmo default usado por `publish-newsletter-kit.ts`).
 * Fail-soft: config ausente/ilegível nunca lança, cai no default — este
 * helper só é chamado dentro de um caminho que já é `code: 2` benigno por
 * padrão, então uma falha de leitura aqui não deve regredir isso pra pior.
 */
function readNewsletterBackend(rootDir: string): string {
  try {
    const raw = readFileSync(join(rootDir, "platform.config.json"), "utf8");
    const cfg = JSON.parse(raw) as { publishing?: { newsletter?: { backend?: string } } };
    return cfg.publishing?.newsletter?.backend ?? "beehiiv";
  } catch {
    return "beehiiv";
  }
}

/**
 * #7437: deriva um `publishedAtIso` pro caminho `--slug` (usado pelo backend
 * Kit, que nunca escreve `05-published.json`) — antes disto, o campo ficava
 * fixo em `null`, e esse `null` É consumido: `buildEditionArchivePost`
 * (`edition-site-page.ts`) usa pra `publish_date` → `sitemapEntryFromPost`
 * grava a `<url>` do sitemap SEM `<lastmod>` → `buildHomeFeed` (#7436, que
 * agora ordena por `lastmod`) trata a entrada como a mais antiga possível.
 * Toda edição publicada pelo caminho Kit saía sem data em lugar nenhum.
 *
 * Duas fontes, nesta ordem:
 * 1. `_internal/newsletter-kit-published.json` → `scheduled_at` (gravado por
 *    `publish-newsletter-kit.ts`, ver `KitNewsletterPublished`) — é o
 *    timestamp real do broadcast, quando disponível.
 * 2. Fallback: o `AAMMDD` do próprio nome do diretório da edição
 *    (`data/editions/{AAMM}/{AAMMDD}` desde #2463, ou o layout flat antigo —
 *    em ambos o basename é o `AAMMDD`), interpretado como meia-noite UTC.
 *    Menos preciso que 1, mas nunca deixa o campo vazio à toa.
 *
 * Fail-soft: qualquer arquivo ausente/malformado ou basename que não bata
 * `AAMMDD` cai silenciosamente pro próximo passo, terminando em `null` só se
 * NENHUMA fonte render uma data válida.
 */
function deriveFallbackPublishedAtIso(editionDir: string): string | null {
  const kitPublishedPath = join(editionDir, "_internal", "newsletter-kit-published.json");
  if (existsSync(kitPublishedPath)) {
    try {
      const raw = JSON.parse(readFileSync(kitPublishedPath, "utf8")) as { scheduled_at?: unknown };
      if (typeof raw.scheduled_at === "string" && !Number.isNaN(Date.parse(raw.scheduled_at))) {
        return raw.scheduled_at;
      }
    } catch {
      // segue pro fallback abaixo
    }
  }

  const m = basename(editionDir).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const iso = `20${yy}-${mm}-${dd}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Resultado de `publish()`: `pushed` indica se o push da branch
 * `site-publish/{slug}` está CONFIRMADAMENTE em dia com o remoto ao final da
 * chamada (#6202 review P1-B, mantido no #6598 mesmo com o mecanismo trocado
 * de push-direto-em-master pra branch+PR) — verdadeiro tanto quando este
 * `publish()` de fato empurrou algo quanto quando não havia nada pendente a
 * empurrar. `prUrl`/`prNumber` só vêm preenchidos quando `gh pr create`/`gh
 * pr list` tiveram sucesso — ausentes não significam falha (o push pode ter
 * confirmado e a etapa de abrir/reusar o PR ainda assim lançar, o que
 * `publish()` propaga como qualquer outra falha). `prCreated` distingue "PR
 * novo aberto nesta chamada" de "PR já existente reusado" — só informativo
 * pro log, nunca decide comportamento. `publish()` lança em qualquer falha
 * (branch base errada, commit/push/gh com erro) — nunca retorna `pushed:
 * false` como forma de reportar erro.
 */
export interface PublishResult {
  pushed: boolean;
  prUrl?: string;
  prNumber?: number;
  prCreated: boolean;
  /**
   * #8158: revoga o #6598 — o PR deixou de "ficar aberto de propósito".
   * `true` quando `waitAndMergeSitePagePr` confirmou CI verde e mergeou;
   * `false` quando não mergeou (CI vermelho/bloqueado/timeout, ou nenhum
   * `prNumber` disponível pra tentar) — o PR fica aberto pra revisão manual
   * nesse caso, mesmo fallback que era o comportamento ÚNICO pré-#8158.
   * `mergeReason` sempre populado junto, mesmo quando `merged: true`.
   */
  merged?: boolean;
  mergeReason?: string;
}

export interface PublishPageDeps {
  readEditionInputs(editionDir: string, slugOverride?: string): EditionPageInputs | null;
  writePage(slug: string, html: string): void;
  /**
   * #6454: atualiza `sitemap.xml` (idempotente — só adiciona a entrada se
   * ainda não estiver lá) e regenera `index.html` a partir do feed
   * resultante, ambos alongside da página (mesmo diretório público que o
   * commit/push de `publish()` abaixo empurra). Só chamado quando
   * `--sitemap` é passado — opcional pra não quebrar deps de teste que não
   * exercitam esse caminho.
   */
  updateSitemapAndHome?(post: ArchivePost, sitemapRelPath: string): { sitemapChanged: boolean };
  /**
   * #8645: roda DEPOIS de `updateSitemapAndHome` (precisa do `sitemap.xml`
   * já refletindo a entrada desta edição) e ANTES do commit único — fecha
   * os 2 gaps documentados na issue: (a) backfill de SEO restrito a este
   * slug (`image` no JSON-LD `NewsArticle`, a partir do `<img class="hero">`
   * do próprio corpo — `buildEditionArchivePost` nunca seta `thumbnail_url`,
   * então `buildArchivePageHtml` sozinho nunca preenche isso pra edição
   * nova) e (b) regeneração do índice paginado do acervo (`archive/{n}`),
   * senão a edição nova nunca aparece linkada em nenhuma página dele.
   * Fail-soft no CALLER (`publishEditionSitePage`) — uma falha aqui não
   * pode reverter a publicação da página em si, que já aconteceu. Optional
   * pra não quebrar deps de teste que não exercitam esse caminho.
   */
  backfillAndReindexArchive?(
    slug: string,
    sitemapRelPath: string,
  ): { seoImageAdded: boolean; archiveIndexRegenerated: boolean };
  /** Commit + push. Nunca é `wrangler deploy` — ver docstring do módulo. */
  publish(slug: string, sitemapRelPath?: string): PublishResult;
  log(line: string): void;
}

export type PublishPageResult =
  | { code: 0; slug: string; bytes: number; published: boolean; prUrl?: string; merged?: boolean; mergeReason?: string }
  | { code: 2; reason: string }
  | { code: 3; reason: string }
  | { code: 4; reason: string }
  | { code: 5; reason: string; tags: string[] };

/**
 * Lê os artefatos da edição.
 *
 * `slugOverride`, quando presente, DETERMINA o slug — não depende de
 * `post_url` estar populado em `05-published.json` (nunca está, no momento
 * em que o Stage 6 chama este passo — ver docstring do módulo). Sem
 * `slugOverride`, mantém o caminho antigo: lê `post_url` de
 * `05-published.json` (invocação ad-hoc pós-`refresh-dedup`).
 *
 * Retorna `null` só quando os ARQUIVOS estão ausentes (`code: 2`, benigno).
 * Lança `EditionInputsInvalid` quando os arquivos existem mas o conteúdo é
 * inválido/inesperado (`code: 4` — ex: sem `post_url` e sem `slugOverride`).
 *
 * @param rootDirForBackend Raiz onde ler `platform.config.json` pra detectar
 *   `publishing.newsletter.backend` (ver P2-F abaixo). Default `ROOT` (raiz
 *   real do projeto); parâmetro só existe pra permitir teste isolado sem
 *   depender/mutar o `platform.config.json` real do repo.
 */
export function readEditionInputs(
  editionDir: string,
  slugOverride?: string,
  rootDirForBackend: string = ROOT,
): EditionPageInputs | null {
  const htmlPath = join(editionDir, "_internal", "newsletter-final.html");
  const publishedPath = join(editionDir, "_internal", "05-published.json");
  const htmlExists = existsSync(htmlPath);
  const publishedExists = existsSync(publishedPath);

  if (!htmlExists) return null;

  // #7420 (achado ao vivo, edição 260904): `slugOverride` DETERMINA o slug e
  // não deveria depender de `05-published.json` existir — mas até aqui, com
  // backend Kit (que nunca escreve esse arquivo), passar `--slug` ainda caía
  // no `code: 2` benigno logo abaixo, porque o guard exigia os DOIS
  // (`htmlExists && publishedExists`) antes mesmo de olhar `slugOverride`. Na
  // prática isso significava que o workaround documentado em §6b-site
  // ("passe --slug explicitamente") nunca funcionava de verdade pra Kit —
  // apenas trocava um `code: 4` silencioso por um `code: 2` igualmente mudo.
  // Com `slugOverride`, ignoramos `05-published.json` por completo (nem
  // tentamos lê-lo) — a URL vem só do slug. `publishedAtIso` (#7437) vem de
  // `deriveFallbackPublishedAtIso` — ver docstring dela: é metadado
  // consumido (sitemap `<lastmod>` + data do card na home), não decorativo,
  // então nunca fica fixo em `null` quando existe alguma fonte disponível.
  if (slugOverride) {
    const reviewedPath = join(editionDir, "02-reviewed.md");
    let title = "";
    let subtitle: string | null = null;
    if (existsSync(reviewedPath)) {
      const md = readFileSync(reviewedPath, "utf8");
      title = extractBloco(md, "TÍTULO") ?? "";
      subtitle = extractBloco(md, "SUBTÍTULO");
    }
    return {
      html: readFileSync(htmlPath, "utf8"),
      // URL sintética — só serve pra extractSlugFromPostUrl/web_url; a
      // convenção de domínio é a mesma usada em todo o resto do módulo
      // (ver EditionPageInputs em edition-site-page.ts).
      postUrl: `https://diar.ia.br/p/${slugOverride}`,
      title,
      subtitle,
      publishedAtIso: deriveFallbackPublishedAtIso(editionDir),
    };
  }

  if (!publishedExists) {
    // #6202 review, problema P2-F: o caminho Kit nunca escreve
    // `05-published.json` (escreve `newsletter-kit-published.json`) —
    // pré-render (Stage 4) É backend-agnóstico, então `newsletter-final.html`
    // existe mesmo em edição Kit. Sem esta checagem, backend Kit caía pra
    // sempre no `code: 2` benigno ("nada a publicar ainda"), indistinguível
    // do caso normal "edição ainda não chegou no Stage 4/6" — a mesma doença
    // do P0 original, só que no outro backend.
    if (readNewsletterBackend(rootDirForBackend) === "kit") {
      throw new EditionInputsInvalid(
        "backend Kit selecionado (publishing.newsletter.backend) — newsletter-final.html existe, mas " +
          "05-published.json (única fonte de slug do caminho Beehiiv) nunca é escrito por edições Kit, " +
          "e nenhum --slug foi passado. Passe --slug explicitamente (ver §6b-site em orchestrator-stage-6.md).",
      );
    }
    return null;
  }

  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as {
    post_url?: string;
    scheduled_at?: string;
    published_at?: string;
  };

  if (!published.post_url) {
    throw new EditionInputsInvalid(
      "05-published.json existe mas não tem post_url, e nenhum --slug foi passado — " +
        "no Stage 6 normal, §6b-site deve receber --slug com o valor confirmado via " +
        "get_post em §6b-slug (o mesmo slug que o guard do bloco WhatsApp já verificou).",
    );
  }

  // Título/subtítulo saem do bloco TÍTULO/SUBTÍTULO do markdown revisado —
  // a mesma fonte que os publishers já usam pra assunto e preview.
  const reviewedPath = join(editionDir, "02-reviewed.md");
  let title = "";
  let subtitle: string | null = null;
  if (existsSync(reviewedPath)) {
    const md = readFileSync(reviewedPath, "utf8");
    title = extractBloco(md, "TÍTULO") ?? "";
    subtitle = extractBloco(md, "SUBTÍTULO");
  }

  return {
    html: readFileSync(htmlPath, "utf8"),
    postUrl: published.post_url,
    title,
    subtitle,
    publishedAtIso: published.published_at ?? published.scheduled_at ?? null,
  };
}

/** Primeira linha não-vazia após o rótulo — mesmo formato do #916. */
function extractBloco(md: string, rotulo: string): string | null {
  const linhas = md.split("\n");
  const i = linhas.findIndex((l) => l.trim() === rotulo);
  if (i === -1) return null;
  for (let j = i + 1; j < linhas.length; j++) {
    const v = linhas[j].trim();
    if (v) return v;
  }
  return null;
}

/** Roda `git`, síncrono, capturando stdout como string. Injetável pra teste. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

/** Roda `gh`, síncrono, capturando stdout como string. Injetável pra teste. */
export type GhRunner = (args: string[], cwd: string) => string;

const defaultGhRunner: GhRunner = (args, cwd) =>
  execFileSync("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

/** Nome da branch dedicada de publicação de página, sempre determinístico a partir do slug. */
function sitePublishBranch(slug: string): string {
  return `site-publish/${slug}`;
}

/**
 * #6454: `index.html` da home mora sempre no MESMO diretório de
 * `sitemap.xml` (ambos em `workers/site/public/`) — deriva o path relativo
 * um do outro em vez de aceitar um 2º parâmetro de CLI/flag redundante.
 * Puro, forward-slash sempre (mesma convenção do resto do módulo — ver
 * comentário de `pathsToStage` em `commitAndPushSitePage`).
 */
export function homePageRelPathFromSitemap(sitemapRelPath: string): string {
  const lastSlash = sitemapRelPath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : sitemapRelPath.slice(0, lastSlash + 1);
  return `${dir}index.html`;
}

/**
 * #8645: `archive/` (o índice paginado do acervo — `gen-archive-index.ts`)
 * mora sempre no MESMO diretório de `sitemap.xml`, mesma convenção de
 * `homePageRelPathFromSitemap` logo acima. Devolve o diretório inteiro (não
 * um arquivo) — `commitAndPushSitePage` faz `git add` num pathspec de
 * diretório, que cobre novas páginas do índice E remoções (poda de páginas
 * órfãs, ver `gen-archive-index.ts`).
 */
export function archiveIndexRelDirFromSitemap(sitemapRelPath: string): string {
  const lastSlash = sitemapRelPath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : sitemapRelPath.slice(0, lastSlash + 1);
  return `${dir}archive`;
}

/**
 * Roda `npx tsx scripts/lib/session-registry.ts merge-lock-*`, síncrono,
 * mesmo mecanismo/script que `merge-train-live.ts` usa pro merge lock
 * cross-sessão (#6626). Nunca lança em "denied" (exit 1 — outra sessão
 * segura o lock, concorrência esperada) — só em erro genuíno de spawn/I/O
 * (script ausente, `npx`/`tsx` quebrado). Injetável pra teste (nunca chama
 * o subprocesso de verdade fora de `defaultLockRunner`).
 */
export type LockRunner = (args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string };

/** Mesmo timeout individual por chamada que `merge-train-live.ts:107` usa
 * pro runner real (`spawnSync(..., { timeout: 60_000 })`) — sem isso, o
 * retry loop bounded (3 tentativas) de `acquireSitePublishLock` não é de
 * fato bounded: uma única chamada travada (`npx`/`tsx` pendurado) bloqueia
 * pra sempre (#6630). */
const LOCK_RUNNER_TIMEOUT_MS = 60_000;

/** Assinatura mínima de `execFileSync` usada por `createExecFileSyncLockRunner` —
 * injetável pra teste de regressão do #6630 sem tocar o subprocesso real. */
type ExecFileSyncFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; timeout: number; shell?: boolean },
) => Buffer | string;

/**
 * Deriva `shell: true` pro `execFileSync` de `npx` — puro e testável sem
 * depender de `process.platform` real (#6899). No Windows, `npx` resolve
 * pra `npx.cmd`, não um executável direto: `execFileSync("npx", ...)` sem
 * `shell: true` lança `ENOENT` (Windows CreateProcess não sabe rodar um
 * `.cmd` como se fosse `.exe`) — e `execFileSync("npx.cmd", ...)` sem shell
 * lança `EINVAL` (Windows exige o shell pra interpretar batch files
 * corretamente). A única combinação que funciona nos dois SOs é manter
 * `cmd: "npx"` e ligar `shell: true` só no win32; em POSIX (`linux`/`darwin`,
 * onde `npx` já é um executável/symlink direto) `shell: true` é
 * desnecessário e reintroduziria o risco de escaping do shell à toa.
 */
export function needsShellForNpx(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** Fábrica do `LockRunner` real, parametrizada pela função de exec (default
 * `execFileSync` de `node:child_process`) só pra permitir o teste de
 * regressão do #6630/#6899 inspecionar as opções passadas sem invocar
 * processo de verdade. `defaultLockRunner` abaixo é
 * `createExecFileSyncLockRunner()` — nenhum comportamento de produção muda.
 * `platform` é injetável pelo mesmo motivo (default `process.platform`
 * real; teste passa `"win32"`/`"linux"` explícito pra ser determinístico
 * em qualquer SO que rode o CI). */
export function createExecFileSyncLockRunner(
  exec: ExecFileSyncFn = execFileSync,
  platform: NodeJS.Platform = process.platform,
): LockRunner {
  const shell = needsShellForNpx(platform);
  return (args, cwd) => {
    try {
      const stdout = exec("npx", ["tsx", "scripts/lib/session-registry.ts", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: LOCK_RUNNER_TIMEOUT_MS,
        ...(shell ? { shell: true } : {}),
      }).toString("utf8");
      return { ok: true, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        ok: false,
        stdout: err.stdout ? err.stdout.toString() : "",
        stderr: err.stderr ? err.stderr.toString() : "",
      };
    }
  };
}

const defaultLockRunner: LockRunner = createExecFileSyncLockRunner();

/**
 * Pausa síncrona real (`Atomics.wait` sobre um `SharedArrayBuffer` — não
 * precisa de `node:timers/promises`, então o retry de lock continua
 * síncrono como o resto de `commitAndPushSitePage`, sem forçar a função
 * inteira a virar `async`). Injetável pra teste — a suíte nunca dorme de
 * verdade.
 */
export type SleepFn = (ms: number) => void;

const defaultSleep: SleepFn = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// #6626: bounded e curto — mesma disciplina do `MAX_LOCK_RETRIES`/
// `LOCK_RETRY_DELAY_MS` de `merge-train-live.ts`, mas pra uma janela bem
// mais curta (troca de checkout, não um merge inteiro), então o retry
// também é mais curto.
const SITE_PUBLISH_LOCK_RETRY_ATTEMPTS = 3;
const SITE_PUBLISH_LOCK_RETRY_DELAY_MS = 5_000;

/**
 * Adquire o merge lock cross-sessão (#6626) antes de mexer no checkout
 * compartilhado — mesma classe de proteção que `merge-train-live.ts` já usa
 * em torno de "manipular o checkout compartilhado temporariamente pra uma
 * ação git ligada a `master`" (ver docblock de `commitAndPushSitePage`).
 *
 * A identidade usada aqui (`sessionId`) é local a ESTA chamada
 * (`randomUUID`, gerada uma vez em `commitAndPushSitePage`) — não precisa
 * ser a sessão real do coordenador: o lock serializa qualquer contestante
 * que tente adquiri-lo, não só quem sabe o session-id de quem o detém, e
 * não há reentrância dentro desta função (1 acquire, 1 release, sempre o
 * mesmo id).
 *
 * Retry curto e bounded só pro caso comum de contenção transitória
 * (`merge-lock-acquire` nega quando OUTRA sessão segura o lock — não é
 * erro, é concorrência esperada); lança se esgotar as tentativas, antes de
 * tocar qualquer arquivo/branch.
 *
 * #6703 achado 1: `res.ok === false` conflava dois casos bem diferentes —
 * "negado, outra sessão detém o lock" (exit 1 do script, esperado sob
 * concorrência) e "erro de infra" (crash do `npx tsx`, script ausente,
 * timeout de 60s do `LockRunner` — ver `LOCK_RUNNER_TIMEOUT_MS`). A
 * mensagem final SEMPRE afirmava a 1ª causa, mesmo quando o erro real era
 * infra quebrada. Mesma discriminação denied-vs-infra-error que
 * `merge-train-live.ts` (`mergeTrainBatch`/`mergeSoloPr`) já faz via regex
 * `/denied/i` em stdout/stderr — reusada aqui em vez de reinventada.
 */
function acquireSitePublishLock(rootDir: string, sessionId: string, lock: LockRunner, sleep: SleepFn): void {
  let lastDenied = false;
  let lastDetail = "sem detalhe";
  for (let attempt = 1; attempt <= SITE_PUBLISH_LOCK_RETRY_ATTEMPTS; attempt++) {
    const res = lock(["merge-lock-acquire", "--session-id", sessionId], rootDir);
    if (res.ok) return;
    lastDenied = /denied/i.test(res.stdout) || /denied/i.test(res.stderr);
    lastDetail = res.stderr || res.stdout || "sem detalhe";
    if (attempt < SITE_PUBLISH_LOCK_RETRY_ATTEMPTS) sleep(SITE_PUBLISH_LOCK_RETRY_DELAY_MS);
  }
  if (lastDenied) {
    throw new Error(
      `merge lock não adquirido após ${SITE_PUBLISH_LOCK_RETRY_ATTEMPTS} tentativas (#6626) — outra sessão detém ` +
        "o checkout compartilhado agora. Commit/push de site-page abortado antes de tocar qualquer arquivo/branch.",
    );
  }
  throw new Error(
    `merge-lock-acquire falhou após ${SITE_PUBLISH_LOCK_RETRY_ATTEMPTS} tentativas por erro de infra (#6703) — ` +
      `não é contenção de outra sessão, causa não identificada: ${lastDetail}. Commit/push de site-page ` +
      "abortado antes de tocar qualquer arquivo/branch.",
  );
}

/**
 * Libera o merge lock adquirido por `acquireSitePublishLock`. Fail-soft de
 * propósito: uma falha ao liberar nunca deve mascarar o resultado real do
 * commit/push que já aconteceu (o `finally` que chama isto não pode lançar
 * por cima de um erro genuíno em curso) — loga em stderr e segue. Um lock
 * preso expira sozinho pelo TTL do `session-registry` (mesma rede de
 * segurança que qualquer outro consumidor do merge lock já depende).
 */
function releaseSitePublishLock(rootDir: string, sessionId: string, lock: LockRunner): void {
  const res = lock(["merge-lock-release", "--session-id", sessionId], rootDir);
  if (!res.ok) {
    process.stderr.write(
      `[site-page] aviso: merge-lock-release falhou (${res.stderr || res.stdout || "sem detalhe"}) — o TTL expira sozinho.\n`,
    );
  }
}

/**
 * Renova o TTL do lock adquirido por `acquireSitePublishLock` (#6703 achado
 * 2). `MERGE_LOCK_TTL_MS` (2min, `session-registry.ts`) foi dimensionado
 * pra "gh pr merge + git pull" — a janela protegida aqui é mais longa
 * (`checkout -B` + `add` + `commit` + `push --force-with-lease` + `gh pr
 * list` + `gh pr create` + `checkout` de volta, múltiplos round-trips de
 * rede), podendo ultrapassar o TTL original. `renewMergeLock`
 * (`session-registry.ts merge-lock-renew`) só estende um hold que a PRÓPRIA
 * sessão já detém — nunca cria um hold novo, nunca rouba lock alheio (ver
 * docblock de `renewMergeLock`). Fail-soft, mesmo padrão de
 * `releaseSitePublishLock`: uma falha de renovação não pode abortar a
 * janela no meio (deixaria o checkout preso em `site-publish/{slug}` sem
 * nunca voltar pro branch original) — loga em stderr e segue; o pior caso é
 * a mesma corrida que o TTL já aceitava antes de existir renovação.
 */
function renewSitePublishLock(rootDir: string, sessionId: string, lock: LockRunner): void {
  const res = lock(["merge-lock-renew", "--session-id", sessionId], rootDir);
  if (!res.ok) {
    process.stderr.write(
      `[site-page] aviso: merge-lock-renew falhou (${res.stderr || res.stdout || "sem detalhe"}) — TTL pode ` +
        "expirar antes do fim da janela protegida.\n",
    );
  }
}

/**
 * Pura: extrai o número do PR de uma URL `https://github.com/{org}/{repo}/pull/{N}`
 * (o formato que `gh pr create` imprime em stdout) — evita uma 2ª chamada de
 * rede (`gh pr view`/`gh pr list`) só pra descobrir o número que a própria
 * URL já carrega. `undefined` pra qualquer entrada que não bata o formato
 * (URL ausente, malformada, ou de outro path do GitHub) — nunca lança.
 */
export function parsePrNumberFromUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : undefined;
}

/**
 * Corpo do PR de publicação de página — documenta o mecanismo atual
 * (#8158, revoga o #6598) diretamente no PR, pro coordenador de uma rodada
 * overnight/develop futura (ou o editor) entender o porquê sem precisar
 * caçar a issue, mesmo que o auto-merge abaixo não confirme a tempo e o PR
 * acabe ficando aberto de qualquer forma.
 */
function buildSitePagePrBody(slug: string): string {
  return [
    `Publica a página \`/p/${slug}\` no acervo do site (Worker \`diaria-site\`).`,
    "",
    "Gerado automaticamente por `scripts/publish-edition-site-page.ts` (Stage 6).",
    "",
    "**Mecanismo (#6598):** branch dedicada + PR, nunca push direto em `master` — " +
      "`master` passou a exigir PR (ruleset `GH013`) em 260828, e o push direto que " +
      "este script fazia antes (#6202) começou a ser rejeitado.",
    "",
    "**Auto-merge (#8158, revoga o #6598):** o próprio script espera o CI e mergeia " +
      "sozinho quando fica verde — o diff é sempre 100% artefato gerado por template " +
      "(HTML + 1 linha de `sitemap.xml`), sem julgamento editorial, mesma categoria de " +
      "isenção de review do PR-trem/PR de resgate. Se o CI não convergir a tempo ou " +
      "vier vermelho, o PR fica aberto pra revisão manual — mesmo fallback que era o " +
      "comportamento único antes do #8158.",
    "",
    "Refs #6202, #6598, #8158",
  ].join("\n");
}

/**
 * #8158 (revoga #6598): espera o CI do PR ficar verde e mergeia sozinho —
 * fecha o laço que antes exigia ação humana/de outra sessão pra um diff que
 * é sempre 100% artefato gerado por template (HTML da página + 1 linha de
 * `sitemap.xml`), nunca conteúdo com julgamento editorial. Reusa a mesma
 * lógica pura (`evaluatePrChecksGate`, #6225) que o gate de merge autônomo
 * do overnight/develop já usa — `gh pr view --json statusCheckRollup` em vez
 * de `gh pr checks --json`, que não existe no `gh` 2.46.0 do `300`.
 *
 * Poll simples (sem lock — a janela protegida de `commitAndPushSitePage` já
 * terminou e o checkout já voltou pro branch original; `gh pr merge` é
 * operação remota via API, não precisa do checkout na branch do PR).
 * `maxWaitMs`/`pollIntervalMs` (2min/5s default) refletem a duração real
 * medida na issue (#8158: 19-44s por check, ~10 checks, historicamente
 * sempre convergindo em menos de 1min) com folga generosa.
 *
 * **Sempre fail-soft**: qualquer desfecho que não seja "CI verde + merge
 * confirmado" devolve `merged: false` com o motivo — o PR fica aberto,
 * exatamente o comportamento único que existia antes do #8158. Nunca lança
 * (uma falha aqui não pode derrubar a publicação da página em si, que já
 * aconteceu com sucesso antes deste passo rodar).
 */
export function waitAndMergeSitePagePr(
  rootDir: string,
  prNumber: number,
  gh: GhRunner = defaultGhRunner,
  sleep: SleepFn = defaultSleep,
  maxWaitMs: number = 120_000,
  pollIntervalMs: number = 5_000,
): { merged: boolean; reason: string } {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    let payload: unknown;
    try {
      const raw = gh(["pr", "view", String(prNumber), "--json", "statusCheckRollup,mergeable"], rootDir);
      payload = JSON.parse(raw);
    } catch (e) {
      return {
        merged: false,
        reason: `gh pr view falhou (${(e as Error).message}) — PR #${prNumber} fica aberto pra revisão manual`,
      };
    }
    const rollup = (payload as { statusCheckRollup?: unknown }).statusCheckRollup;
    const mergeable = (payload as { mergeable?: string }).mergeable;
    const result = evaluatePrChecksGate(rollup, { mergeable });

    if (result.verdict === "pass") {
      try {
        // #8158 fleet review, finding 2: SEM `--delete-branch` de propósito.
        // Essa flag também apaga a branch LOCAL `site-publish/{slug}` no
        // checkout compartilhado — e este merge roda DEPOIS que
        // `acquireSitePublishLock`/`releaseSitePublishLock` já liberou a
        // janela protegida (`gh pr merge` em si é operação remota via API,
        // não precisa do checkout na branch, mas a deleção local É uma
        // mutação do checkout que o lock existe pra proteger, #6626/#6703).
        // Uma 2ª chamada concorrente pro MESMO slug (retry de sessão
        // interrompida, Stage 6 rodado 2x) poderia colidir com essa
        // deleção fora de qualquer proteção. Deletar a branch remota fica
        // pro GitHub decidir sozinho (settings do repo) ou pra um cleanup
        // separado — `git checkout -B` já recria a branch do zero a cada
        // chamada de qualquer forma, então uma branch local órfã não
        // acumula problema real.
        gh(["pr", "merge", String(prNumber), "--squash"], rootDir);
        return { merged: true, reason: "CI verde — mergeado automaticamente (#8158, revoga #6598)" };
      } catch (e) {
        return {
          merged: false,
          reason: `CI verde mas gh pr merge falhou (${(e as Error).message}) — PR #${prNumber} fica aberto pra revisão manual`,
        };
      }
    }
    if (result.verdict === "fail" || result.verdict === "blocked_by_conflict" || result.verdict === "error") {
      return {
        merged: false,
        reason: `CI ${result.verdict} — PR #${prNumber} fica aberto pra revisão manual (${result.reason})`,
      };
    }
    // "pending": ainda rodando — continua até o timeout.
    if (Date.now() >= deadline) {
      return {
        merged: false,
        reason: `CI não convergiu em ${maxWaitMs}ms — PR #${prNumber} fica aberto pra revisão manual (fail-soft, mesmo comportamento pré-#8158)`,
      };
    }
    sleep(pollIntervalMs);
  }
}

/**
 * `git checkout -B` numa branch dedicada + (`git commit` condicional) +
 * `git push` + `gh pr create` (reusando PR aberto existente, se houver) — e
 * de volta pro branch original.
 *
 * #6598: NUNCA `git push` em `master` — desde 260828 uma regra de proteção
 * (`GH013`) rejeita push direto. Mecanismo atual: `checkout -B
 * site-publish/{slug}` a partir do branch de origem (precisa ser `master` —
 * ver guard abaixo), commit escopado, `push --force-with-lease` (seguro
 * porque a branch é recriada do zero a cada chamada, propriedade exclusiva
 * deste script), `gh pr create`/reuse, e `checkout` de volta pro branch
 * original em `finally` — o checkout compartilhado nunca fica preso numa
 * branch de publicação de página, mesmo se algo no meio lançar.
 *
 * #6202 review, problema P1-C — REVISADO pelo #7287: recusa rodar fora de um
 * checkout SINCRONIZADO com `origin/master`. A branch nova precisa nascer de
 * um ponto conhecido — commitar a partir de um checkout divergente (checkout
 * compartilhado com sessões overnight/develop concorrentes, #5156) produziria
 * uma página divergente do `master` real. Lança — o chamador
 * (`publishEditionSitePage`) converte em `code: 3`.
 *
 * **O guard compara COMMIT, não NOME de branch (#7287).** A versão original
 * comparava `git rev-parse --abbrev-ref HEAD` contra a string `"master"` —
 * mas o invariante que a docstring do módulo sempre descreveu é sobre o
 * CONTEÚDO do checkout ("a branch de publicação de página precisa nascer de
 * um master conhecido"), não sobre como a branch local se chama. Medido ao
 * vivo em 03/09/2026: com 5+ sessões concorrentes, o nome `master` fica
 * tomado por um worktree boa parte do tempo (`git worktree` não permite a
 * mesma branch em dois lugares) — um checkout com o conteúdo EXATO de
 * `origin/master` falhava aqui só porque a branch local se chamava diferente
 * (ex: outra sessão criou `site-publish-master` pra contornar exatamente
 * este defeito). Quatro edições consecutivas (31/08–03/09) perderam a
 * página do acervo por isso. Comparar `HEAD` contra `origin/master` (via
 * `git rev-parse HEAD origin/master`, 1 chamada, 2 revs) preserva o
 * invariante real e para de recusar um checkout que já está no ponto certo,
 * só porque o nome local não é `"master"`.
 *
 * #6202 review, problema P1-A (mantido): `commit` é escopado ao MESMO
 * pathspec do `add`/`status` (nunca commita o índice inteiro) — e antes de
 * commitar, confirma que NADA além do pathspec da página está staged. Um
 * `git add` alheio (sessão concorrente no mesmo checkout compartilhado)
 * entraria no commit sem review; a checagem lança em vez de commitar
 * silenciosamente por cima.
 *
 * #6202 review, problema P1-B (mantido): `status --porcelain` limpo
 * significa "nada NOVO a commitar" — não "nada a empurrar". Por isso o
 * `push` roda SEMPRE (não só quando há commit novo nesta chamada).
 *
 * `git`/`gh` injetados — não roda comando de verdade fora de `productionDeps`.
 *
 * #6626: a janela inteira entre `checkout -B site-publish/{slug}` e o
 * `checkout` de volta pro branch original é protegida pelo merge lock
 * cross-sessão (`acquireSitePublishLock`/`releaseSitePublishLock`, mesmo
 * mecanismo de `merge-train-live.ts`) — sem isso, uma sessão concorrente no
 * mesmo checkout compartilhado podia observar/operar na branch errada
 * durante essa janela (achado do review consolidado da rodada 260828f).
 * `lock`/`sleep` injetados — mesmo padrão de `git`/`gh` acima.
 *
 * **#8636 (260921): caminho isolado por `git worktree`.** Quando
 * `worktreeDir` é passado, esta função NUNCA toca o checkout compartilhado:
 * todas as chamadas de `git` roda com `cwd = worktreeDir` (um worktree
 * temporário que `main` criou a partir de `origin/master` em `--detach`),
 * o guard do #7287 é pulado (o worktree NASCE em `origin/master`, então
 * "nascer de um master conhecido" é satisfeito por construção — e o guard
 * era exatamente o que bloqueava o passo quando outra sessão tinha o
 * checkout em branch de trabalho, o caso real do #8636), e o `finally`
 * descarta o worktree (`git worktree remove --force`, fail-soft) em vez de
 * fazer `checkout` de volta. O merge lock continua valendo no caminho do
 * worktree também — ele serializa o `gh pr create` cross-sessão, que é a
 * única parte mesmo assim compartilhada. O caminho legado (sem
 * `worktreeDir`) é preservado byte a byte.
 */
export function commitAndPushSitePage(
  rootDir: string,
  slug: string,
  git: GitRunner = defaultGitRunner,
  sitemapRelPath?: string,
  gh: GhRunner = defaultGhRunner,
  lock: LockRunner = defaultLockRunner,
  sleep: SleepFn = defaultSleep,
  worktreeDir?: string,
): { committed: boolean; pushed: boolean; prUrl?: string; prNumber?: number; prCreated: boolean } {
  // #8636: no caminho legado, salva o branch original pra voltar depois.
  let originalBranch = "";
  if (!worktreeDir) {
    originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir).trim();
    // #7287: 1 chamada, 2 revs — `git rev-parse` imprime um SHA por linha, na
    // ordem dos argumentos. Guard compara COMMIT (o invariante real — "nasce
    // de um master conhecido"), não o NOME da branch local (ver docblock).
    const [headCommit, originMasterCommit] = git(["rev-parse", "HEAD", "origin/master"], rootDir)
      .trim()
      .split("\n")
      .map((l) => l.trim());
    if (!headCommit || !originMasterCommit || headCommit !== originMasterCommit) {
      throw new Error(
        `checkout não está sincronizado com origin/master (HEAD ${headCommit || "?"}, origin/master ` +
          `${originMasterCommit || "?"}, branch local '${originalBranch}') — commit/push abortado antes de ` +
          `tocar qualquer arquivo. A branch de publicação de página precisa nascer de um master conhecido; ` +
          `commitar a partir de um checkout divergente produziria uma página divergente do master real. ` +
          `Provável sessão concorrente com o checkout desatualizado ou em branch de trabalho — ` +
          `\`git fetch origin && git pull\` (ou passar --worktree-dir pra este script, #8636) ` +
          `resolve (#5156, #6202/#6598, #7287).`,
      );
    }
  }

  const branchName = sitePublishBranch(slug);

  // Forward-slash sempre — git normaliza pathspecs assim mesmo no Windows, e
  // é o formato em que `git status --porcelain`/`git diff --name-only`
  // devolvem paths (necessário pra comparação exata abaixo).
  const relPageDir = ["workers", "site", "public", "p", slug].join("/");
  const pathsToStage = [relPageDir];
  // #6454: sitemap.xml E index.html (a home regenerada a partir dele) são
  // escritos juntos por `updateSitemapAndHome` ANTES desta função rodar —
  // aqui só precisam entrar no mesmo commit/push da página. Rastreados à
  // parte (`optionalPaths`) porque, ao contrário de `relPageDir`, podem não
  // existir em disco se `updateSitemapAndHome` tiver falhado antes de
  // escrevê-los (ver guard de `existsSync` no loop de `git add` abaixo).
  // #8645: `archive/` (índice paginado regenerado por
  // `backfillAndReindexArchive`, também ANTES desta função) entra na mesma
  // lista — é um DIRETÓRIO, então `git add -- <dir>` cobre tanto páginas
  // novas/modificadas quanto páginas podadas (removidas) por
  // `gen-archive-index.ts` num único pathspec.
  const optionalPaths = new Set<string>();
  if (sitemapRelPath) {
    const homeRelPath = homePageRelPathFromSitemap(sitemapRelPath);
    const archiveRelDir = archiveIndexRelDirFromSitemap(sitemapRelPath);
    pathsToStage.push(sitemapRelPath, homeRelPath, archiveRelDir);
    optionalPaths.add(sitemapRelPath);
    optionalPaths.add(homeRelPath);
    optionalPaths.add(archiveRelDir);
  }

  let committed = false;
  let pushed = false;
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let prCreated = false;

  // #6626: id local a esta chamada — ver docblock de `acquireSitePublishLock`.
  const lockSessionId = `site-publish-${randomUUID()}`;
  acquireSitePublishLock(rootDir, lockSessionId, lock, sleep);

  // #8636: `gitCwd` é o cwd de TODAS as operações git de commit/push — no
  // caminho legado é `rootDir` (o checkout compartilhado, como antes); no
  // caminho do worktree é `worktreeDir` (um clone isolado de origin/master).
  // O `rootDir` continua sendo o cwd do lock, do `gh` (o PR é global, não
  // depende do worktree) e do `existsSync` de `optionalPaths` (a fonte da
  // verdade do que foi escrito em disco pelo `writePage`).
  const gitCwd = worktreeDir ?? rootDir;

  try {
    // #8636: caminho isolado por worktree. `main` cria um worktree temporário
    // a partir de `origin/master` em `--detach` ANTES de chamar esta função e
    // passa o path em `worktreeDir`; aqui só usamos ele como `cwd` de toda a
    // operação. `--detach` (não `-b`) porque um `site-publish/{slug}` já
    // existente no repositório (rodada interrompida) tornaria o `-b` um
    // `checkout -b` em branch já existente — o `--detach` pula isso: o
    // worktree nasce sem branch, e o `checkout -B` abaixo cria a branch de
    // publicação de qualquer estado. O worktree é descartado no `finally`.
    //
    // #8684: `git fetch origin master` ANTES do `worktree add` — best-effort,
    // fail-soft. O worktree nasce do ref LOCAL `origin/master` (`git
    // worktree add` não faz rede sozinho); sem um fetch recente nesta mesma
    // chamada, esse ref pode estar tão desatualizado quanto o pior caso do
    // guard legado do #7287 (que este caminho pula por construção) — a
    // única diferença seria não LANÇAR, mas ainda assim publicar uma página
    // a partir de um master conhecido só POR NOME, não de fato o mais
    // recente. Não lançar em falha de fetch (offline, rede instável): o
    // pior caso é idêntico ao comportamento pré-#8684 (usa o ref já
    // cacheado), nunca pior — mesma disciplina fail-soft do resto do
    // módulo (#6202, ver docstring).
    if (worktreeDir) {
      try {
        git(["fetch", "origin", "master"], rootDir);
      } catch (e) {
        process.stderr.write(
          `[site-page] aviso: 'git fetch origin master' falhou (${(e as Error).message}) — seguindo com o ` +
            `ref local de origin/master, que pode estar desatualizado (#8684).\n`,
        );
      }
      git(["worktree", "add", "--detach", worktreeDir, "origin/master"], rootDir);
    }

    // -B (não -b): sempre recria a branch a partir do master atual, mesmo se
    // uma chamada anterior a deixou pra trás localmente — elimina qualquer
    // estado acumulado entre chamadas (idempotência, ver docstring do módulo).
    // No worktree, o "master atual" é o `origin/master` que o worktree nasceu
    // (o #7287 é satisfeito por construção, não por verificação).
    git(["checkout", "-B", branchName], worktreeDir ?? rootDir);

    // #8636 REGRESSÃO (achado 21/09/2026, reabertura P0): a suposição
    // original de que "o worktree é um clone completo de origin/master,
    // então a página já está lá" é FALSA para conteúdo recém-escrito.
    // `git worktree add` faz um checkout físico a partir de um REF — reflete
    // só o que já está COMMITADO naquele ref, nunca arquivos untracked de
    // outro working tree. Como `relPageDir` é sempre um slug NOVO (nunca
    // commitado em `origin/master`), o worktree simplesmente não o tem: um
    // `git add` incondicional nele lançava `pathspec did not match any
    // files` — reproduzido com git real, 3x independentes (ver PR/issue
    // #8636). `sitemapRelPath`/`homeRelPath` (`optionalPaths`) são piores
    // ainda: COMO já existem em `origin/master` (arquivos rastreados), o
    // `git add` não lançava — silenciosamente staged o conteúdo VELHO que o
    // worktree herdou do ref, não o conteúdo atualizado que
    // `updateSitemapAndHome` acabou de escrever em `rootDir`.
    //
    // Correção (opção A da issue): antes de `git add`, copiar do `rootDir`
    // (onde `writePage`/`updateSitemapAndHome` sempre escrevem, worktree ou
    // não) pro `worktreeDir` os MESMOS paths que serão staged — sempre
    // `relPageDir` (a página é staged incondicionalmente, então precisa
    // existir), e cada `optionalPaths` que de fato exista em `rootDir` (os
    // que não existirem seguem pulados pelo guard de `existsSync` logo
    // abaixo, igual antes). Depois da cópia, o `git add`/`status`/`commit`
    // dentro do worktree enxergam o conteúdo certo — commitando exatamente o
    // que foi escrito nesta chamada, nunca o herdado de `origin/master`.
    // Rejeitada a opção B (escrever direto no worktree): exigiria que
    // `writePage`/`updateSitemapAndHome`/o backfill do acervo (#8645/#8664)
    // conhecessem `worktreeDir` — mas o worktree só existe DEPOIS que `main`
    // já decidiu usá-lo, e essas funções rodam antes de `commitAndPushSitePage`
    // ser chamada (ver `publishEditionSitePage`); inverter essa ordem
    // tocaria mais call sites pra um ganho que não paga o risco.
    if (worktreeDir) {
      for (const p of pathsToStage) {
        const src = resolve(rootDir, p);
        // Guard genérico ao loop (cobre relPageDir também, ainda que na
        // prática nunca dispare pra ele — a página sempre existe em rootDir
        // por definição): sem ele, um optionalPaths ausente (ex:
        // sitemap.xml se updateSitemapAndHome falhou antes de escrevê-lo)
        // lançaria em `statSync` abaixo.
        if (!existsSync(src)) continue;
        const dest = resolve(worktreeDir, p);
        mkdirSync(dirname(dest), { recursive: true });
        // #8636 REGRESSÃO 2 (achado no fleet review da PR, 21/09/2026):
        // cpSync com recursive:true é ADITIVO — copia o que existe/mudou em
        // `src`, mas nunca remove de `dest` um arquivo que deixou de existir
        // em `src`. Inofensivo para os paths de arquivo único (a página,
        // sitemap.xml, index.html — sempre reescritos do zero pelo caller).
        // Mas um path que seja um DIRETÓRIO em pathsToStage/optionalPaths
        // (ex: o acervo de #8645/#8664) pode ter arquivos PODADOS em rootDir
        // (gen-archive-index.ts remove páginas órfãs) — o worktree nasceu
        // com esse diretório idêntico ao HEAD de origin/master, então o
        // arquivo removido em rootDir nunca é tocado pelo cpSync (não é
        // criação nem alteração) e sobrevive intacto no worktree: `git add`
        // não vê remoção nenhuma, e a poda nunca chega ao commit —
        // silencioso, sem exceção, sucesso aparente. Correção: para um `src`
        // que é diretório, limpar `dest` por completo (rmSync recursivo)
        // ANTES do cpSync, de modo que `dest` fique byte-a-byte igual a
        // `src` (nunca um merge aditivo dos dois). Para um `src` que é
        // arquivo, o cpSync sozinho já basta — sobrescreve o arquivo inteiro,
        // sem resíduo possível.
        if (statSync(src).isDirectory()) {
          rmSync(dest, { recursive: true, force: true });
        }
        cpSync(src, dest, { recursive: true });
      }
    }

    // #8645 REGRESSÃO (achado ao vivo, 21/09/2026, integração com #8636 no
    // merge dos dois): o `git commit -- <pathspec>` mais abaixo usava
    // `pathsToStage` inteiro, sem filtrar os paths que o guard logo acima
    // pulou por não existirem. `git commit -- <path>` (diferente de `git
    // add`, que só reclama se NADA casar) exige que TODO pathspec passado
    // exista (staged OU no working tree) — antes do #8645 os dois
    // `optionalPaths` (sitemap.xml/index.html) já eram sempre paths
    // TRACKED de edições anteriores, então mesmo "ausentes por falha do
    // updateSitemapAndHome" o `git commit --` nunca via um pathspec
    // genuinamente inexistente. `archive/` quebra essa premissa: numa
    // publicação genuinamente nova (ou no teste `#8636-worktree-real-git`,
    // que simula um repo sem histórico de acervo) o diretório pode nunca
    // ter existido — `git commit -- workers/site/public/archive` lança
    // `pathspec ... did not match any file(s) known to git`, revertendo o
    // que seria um publish bem-sucedido. Correção: montar `stagedPathspecs`
    // só com os paths que de fato passaram pelo guard (mesmo critério do
    // loop de `git add`), e usar essa lista — nunca `pathsToStage` bruto —
    // tanto no `git status` quanto no `git commit`.
    const stagedPathspecs: string[] = [];
    for (const p of pathsToStage) {
      // #6454 self-review: sitemap.xml/index.html (`optionalPaths`) podem
      // não existir em disco se `updateSitemapAndHome` tiver falhado antes
      // de escrevê-los (fail-soft, ver caller) — sem este guard, `git add`
      // de um pathspec inexistente lança e a página em si, já escrita com
      // sucesso, é reportada como falha de publicação. `relPageDir` nunca
      // passa por este guard — é sempre staged incondicionalmente, como
      // antes (é a própria página, `writePage` já rodou por definição).
      // #8636 (corrigido 21/09/2026): a existência é sempre checada em
      // `rootDir` (a fonte da verdade do que foi escrito) — no caminho do
      // worktree, o bloco de cópia acima já replicou pro `worktreeDir`
      // qualquer path que exista em `rootDir`, então o `git add` abaixo
      // (que roda em `gitCwd`) sempre encontra o que este guard deixar
      // passar.
      if (optionalPaths.has(p) && !existsSync(resolve(rootDir, p))) {
        continue;
      }
      git(["add", "--", p], gitCwd);
      stagedPathspecs.push(p);
    }

    const status = git(["status", "--porcelain", "--", ...stagedPathspecs], gitCwd);
    committed = status.trim().length > 0;

    if (committed) {
      const stagedFiles = git(["diff", "--cached", "--name-only"], gitCwd)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const outsidePathspec = stagedFiles.filter(
        (f) => !stagedPathspecs.includes(f) && !stagedPathspecs.some((p) => f.startsWith(p + "/")),
      );
      if (outsidePathspec.length > 0) {
        throw new Error(
          `git add deixou ${outsidePathspec.length} arquivo(s) alheio(s) staged fora do ` +
            `pathspec — provável mudança concorrente no mesmo checkout (#5156, #6202 review ` +
            `problema P1-A). No caminho do worktree (#8636) isso é impossível por construção ` +
            `(o worktree é clone isolado de origin/master, sem sessão concorrente nele), ` +
            `mas o guard continua valendo no caminho legado. Commit abortado, nada foi commitado: ` +
            `${outsidePathspec.join(", ")}`,
        );
      }
      git(
        [
          "commit",
          "-m",
          `chore(site): publica página da edição /p/${slug}\n\nRefs #6202, #6598`,
          "--",
          ...stagedPathspecs,
        ],
        gitCwd,
      );
    }

    // #6703 achado 2: renova o TTL antes de cada round-trip de rede restante
    // — push, e (mais adiante) gh pr list/create — pra janela protegida não
    // exceder o TTL de 2min dimensionado pra uma operação bem mais curta.
    renewSitePublishLock(rootDir, lockSessionId, lock);
    git(["push", "--force-with-lease", "-u", "origin", branchName], gitCwd);
    pushed = true;

    renewSitePublishLock(rootDir, lockSessionId, lock);
    const existingRaw = gh(
      ["pr", "list", "--head", branchName, "--state", "open", "--json", "number,url"],
      rootDir,
    );
    let existing: Array<{ number: number; url: string }> = [];
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (Array.isArray(parsed)) existing = parsed as Array<{ number: number; url: string }>;
    } catch {
      existing = [];
    }

    if (existing.length > 0) {
      prNumber = existing[0].number;
      prUrl = existing[0].url;
      prCreated = false;
    } else {
      renewSitePublishLock(rootDir, lockSessionId, lock);
      const createOut = gh(
        [
          "pr",
          "create",
          "--base",
          "master",
          "--head",
          branchName,
          "--title",
          `chore(site): publica página da edição /p/${slug} (#6598)`,
          "--body",
          buildSitePagePrBody(slug),
        ],
        rootDir,
      );
      // `gh pr create` imprime a URL do PR criado como última linha do stdout.
      prUrl = createOut
        .trim()
        .split("\n")
        .pop()
        ?.trim();
      prCreated = true;
      // #8158 (achado ao implementar o auto-merge): até aqui `prNumber`
      // NUNCA era populado neste ramo (só no ramo `existing`, que lê
      // `--json number` de `gh pr list`) — `gh pr create` só imprime a URL.
      // Sem isso, `waitAndMergeSitePagePr` (que precisa do NÚMERO, não da
      // URL, pra chamar `gh pr view`/`gh pr merge`) nunca rodaria no caso
      // comum (1ª publicação de cada edição, que sempre CRIA o PR — reuso
      // só acontece se uma chamada anterior já tiver criado e a atual
      // rodar de novo antes do merge). A URL sempre termina em
      // `/pull/{número}` — extrai dali em vez de outra chamada de rede.
      prNumber = parsePrNumberFromUrl(prUrl);
    }
  } finally {
    // #8636: no caminho do worktree, o checkout compartilhado NUNCA foi
    // tocado (todas as chamadas de `git` rodaram com `cwd = worktreeDir`) —
    // o que sobra é descartar o worktree temporário. O `checkout` de volta
    // pro branch original era o risco do #6703 (checkout compartilhado
    // preso em `site-publish/{slug}`); no worktree não há esse risco, e o
    // `git worktree remove --force` é fail-soft: se falhar (já removido,
    // path desaparecido, permissão), loga e segue — o worktree é temp,
    // `main` tem fallback de `rmSync` + `git worktree prune`, e o custo de
    // deixar um worktree órfão é um `git worktree list` mais longo, nunca
    // um checkout corrompido.
    if (worktreeDir) {
      try {
        git(["worktree", "remove", "--force", worktreeDir], rootDir);
      } catch (e) {
        process.stderr.write(
          `[site-page] aviso: remoção do worktree temporário '${worktreeDir}' falhou (${(e as Error).message}) — ` +
            `use 'git worktree prune' ou remova manualmente (#8636).\n`,
        );
      }
    } else {
      // Sempre volta pro branch original, mesmo em erro — o checkout
      // compartilhado nunca fica preso numa branch de publicação de página.
      // #6703 achado 3: o `checkout` de volta em si pode lançar (conflito,
      // I/O, branch original removida por outra sessão) — sem este try/catch,
      // essa exceção pulava DIRETO pro topo do `finally`, e
      // `releaseSitePublishLock` NUNCA rodava (o lock só sairia pelo TTL) E o
      // checkout compartilhado ficava preso em `site-publish/{slug}`. O
      // release precisa rodar independente do checkout de volta ter lançado
      // ou não — por isso vira um `catch` que só loga, nunca relança (não
      // pode mascarar o erro real que já estava em curso e propagando por
      // cima deste `finally`).
      try {
        git(["checkout", originalBranch], rootDir);
      } catch (e) {
        process.stderr.write(
          `[site-page] aviso: checkout de volta para '${originalBranch}' falhou (${(e as Error).message}) — ` +
            `checkout compartilhado pode ter ficado preso em '${branchName}'.\n`,
        );
      }
    }
    // #6626: libera o lock só DEPOIS da tentativa de checkout de volta (ou, no
    // caminho do worktree, da remoção do worktree) — a janela protegida cobre
    // a troca inteira, não só metade dela. No worktree, o lock continua
    // valendo porque o `gh pr create` cross-sessão é a única parte mesmo
    // assim compartilhada.
    releaseSitePublishLock(rootDir, lockSessionId, lock);
  }

  return { committed, pushed, prUrl, prNumber, prCreated };
}

/**
 * @param git Injetável (#6202 review, problema P2-G) — permite exercitar a
 *   amarração de `publish` com um `GitRunner` controlado, sem depender de um
 *   repositório git real. Default: `defaultGitRunner` (git de verdade).
 * @param gh Injetável (#6598, mesmo motivo do `git` acima) — permite
 *   exercitar `gh pr create`/`gh pr list` sem depender do CLI `gh` real.
 *   Default: `defaultGhRunner` (gh de verdade).
 * @param lock Injetável (#6626, mesmo motivo do `git`/`gh` acima) — permite
 *   exercitar o merge lock sem depender de `session-registry.ts` real.
 *   Default: `defaultLockRunner` (subprocesso de verdade).
 * @param sleep Injetável (#6626) — pausa entre retries de lock. Default:
 *   `defaultSleep` (sono real via `Atomics.wait`).
 */
export function productionDeps(
  rootDir: string = ROOT,
  git: GitRunner = defaultGitRunner,
  gh: GhRunner = defaultGhRunner,
  lock: LockRunner = defaultLockRunner,
  sleep: SleepFn = defaultSleep,
  worktreeDir?: string,
): PublishPageDeps {
  return {
    readEditionInputs,
    // #8636 (comentário atualizado 21/09/2026, pós-regressão): `writePage`
    // escreve SEMPRE em `rootDir` (o checkout compartilhado, onde o
    // orchestrator lê os artefatos) — isso não muda. O que mudou é a
    // suposição sobre o worktree: ele NÃO é um espelho automático do que
    // acabou de ser escrito aqui. `git worktree add` faz checkout físico a
    // partir de um ref (`origin/master`) e só reflete o que já está
    // COMMITADO lá — conteúdo untracked escrito em `rootDir` por esta
    // chamada (a página é sempre um slug novo) não aparece no worktree por
    // conta própria. No caminho do worktree, é `commitAndPushSitePage` quem
    // copia (`cpSync`, ou `rmSync`+`cpSync` para diretórios — ver comentário
    // no bloco de cópia) o conteúdo de `rootDir` pro `worktreeDir` antes do
    // `git add`, não este `writePage`. Manter o write só em `rootDir` (nunca
    // duplicado aqui) continua correto — só a explicação de por que o
    // worktree o enxerga mudou.
    writePage: (slug, html) => {
      const dir = join(resolve(rootDir, "workers", "site", "public", "p"), slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html, "utf8");
    },
    updateSitemapAndHome: (post, sitemapRelPath) => {
      const baseDir = worktreeDir ?? rootDir;
      const sitemapAbsPath = resolve(baseDir, sitemapRelPath);
      const homeAbsPath = resolve(baseDir, homePageRelPathFromSitemap(sitemapRelPath));
      const pagesDir = resolve(baseDir, "workers", "site", "public", "p");

      let existingXml: string;
      try {
        existingXml = readFileSync(sitemapAbsPath, "utf8");
      } catch (e) {
        // Sitemap ainda não existe (1ª edição publicada por este caminho,
        // ou diretório recém-criado) — nasce vazio, mesmo formato que
        // `buildSitemapXml` já produz pro gerador em lote. Mas ENOENT é o
        // ÚNICO erro que essa leitura tolera silenciosamente — qualquer
        // outro (permissão negada, etc.) é um erro genuíno de leitura, não
        // "sitemap ausente", e recriar vazio nesse caso apagaria entradas
        // que na verdade existem em disco (#6454 self-review).
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(
            `[site-page] aviso: leitura de ${sitemapAbsPath} falhou com erro diferente de ENOENT ` +
              `(${(e as Error).message}) — seguindo com sitemap vazio mesmo assim.\n`,
          );
        }
        existingXml = buildSitemapXml([]);
      }
      const newXml = addSitemapEntry(existingXml, sitemapEntryFromPost(post));
      const sitemapChanged = newXml !== existingXml;
      if (sitemapChanged) {
        mkdirSync(dirname(sitemapAbsPath), { recursive: true });
        writeFileSync(sitemapAbsPath, newXml, "utf8");
      }

      // Regenera a home sempre que este passo roda — idempotente e barato
      // (lê arquivos já em disco), e cobre o caso em que a entrada já
      // estava no sitemap mas `index.html` ficou pra trás por uma falha
      // anterior no meio do commit/push.
      const readPageHtml = (s: string): string | null => {
        const p = join(pagesDir, s, "index.html");
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      const feed = buildHomeFeed(newXml, readPageHtml, ARCHIVE_CARD_LIMIT + 1);
      const homeHtml = buildIndexHtml({ feature: feed[0] ?? null, archive: feed.slice(1) });
      mkdirSync(dirname(homeAbsPath), { recursive: true });
      writeFileSync(homeAbsPath, homeHtml, "utf8");

      return { sitemapChanged };
    },
    // #8645: roda DEPOIS de `updateSitemapAndHome` (o sitemap já reflete a
    // entrada desta edição) e ANTES do commit único — ver docstring do
    // campo em `PublishPageDeps` pros 2 gaps que isto fecha.
    backfillAndReindexArchive: (slug, sitemapRelPath) => {
      const baseDir = worktreeDir ?? rootDir;
      const sitemapAbsPath = resolve(baseDir, sitemapRelPath);
      const pagesDirAbs = resolve(baseDir, "workers", "site", "public", "p");
      const outDirAbs = resolve(baseDir, dirname(sitemapRelPath));

      let seoImageAdded = false;
      try {
        const sitemapXml = readFileSync(sitemapAbsPath, "utf8");
        // `onlySlug` (#8645): restringe o backfill a ESTA página — rodar o
        // lote inteiro (~270 páginas) a cada publicação seria I/O
        // desperdiçado, ver docstring de `runBackfill`.
        const result = runBackfill(pagesDirAbs, sitemapXml, { onlySlug: slug });
        seoImageAdded = result.jsonLdImageChanged > 0;
      } catch (e) {
        process.stderr.write(
          `[site-page] aviso: backfill de SEO (#8645) falhou pra /p/${slug} (${(e as Error).message}) — ` +
            "página segue publicada, mas pode faltar `image` no JSON-LD.\n",
        );
      }

      let archiveIndexRegenerated = false;
      try {
        // Regenera o índice paginado inteiro (`archive/{n}`) a partir do
        // MESMO sitemap.xml/pages-dir já atualizados acima — barato (~9
        // páginas com `ARCHIVE_INDEX_PAGE_SIZE=30`), mesmo custo que o cron
        // `regen-home.yml` diário já paga. Sem `--no-sitemap`: poda de
        // páginas órfãs e limpeza do sitemap acontecem na MESMA execução
        // (ver docstring de `gen-archive-index.ts`) — este publish já É o
        // commit que vai levar essa mudança.
        const code = genArchiveIndexMain([
          "--sitemap",
          sitemapAbsPath,
          "--pages-dir",
          pagesDirAbs,
          "--out-dir",
          outDirAbs,
        ]);
        archiveIndexRegenerated = code === 0;
        if (code !== 0) {
          process.stderr.write(
            `[site-page] aviso: gen-archive-index (#8645) saiu com code ${code} — índice paginado do acervo ` +
              "pode estar sem a página nova.\n",
          );
        }
      } catch (e) {
        process.stderr.write(
          `[site-page] aviso: gen-archive-index (#8645) falhou (${(e as Error).message}) — índice paginado ` +
            "do acervo pode estar sem a página nova.\n",
        );
      }

      return { seoImageAdded, archiveIndexRegenerated };
    },
    publish: (slug, sitemapPath?: string) => {
      const { pushed, prUrl, prNumber, prCreated } = commitAndPushSitePage(
        rootDir,
        slug,
        git,
        sitemapPath,
        gh,
        lock,
        sleep,
        worktreeDir,
      );
      // #8158 (revoga #6598): só tenta mergear quando há um PR de verdade
      // pra checar — `prNumber` ausente (gh pr create/list não devolveu URL
      // parseável) não é motivo pra lançar aqui, é motivo pra não tentar.
      if (prNumber === undefined) {
        return { pushed, prUrl, prNumber, prCreated, merged: false, mergeReason: "sem prNumber — nada a mergear" };
      }
      const { merged, reason: mergeReason } = waitAndMergeSitePagePr(rootDir, prNumber, gh, sleep);
      return { pushed, prUrl, prNumber, prCreated, merged, mergeReason };
    },
    log: (line) => process.stderr.write(`[site-page] ${line}\n`),
  };
}

export function publishEditionSitePage(
  editionDir: string,
  deps: PublishPageDeps,
  opts: { skipPublish?: boolean; slug?: string; sitemap?: string } = {},
): PublishPageResult {
  let inputs: EditionPageInputs | null;
  try {
    inputs = deps.readEditionInputs(editionDir, opts.slug);
  } catch (e) {
    if (e instanceof EditionInputsInvalid) {
      deps.log(`artefato presente mas inválido: ${e.message}`);
      return { code: 4, reason: e.message };
    }
    const reason = `artefatos da edição ilegíveis: ${(e as Error).message}`;
    deps.log(reason);
    return { code: 3, reason };
  }
  if (!inputs) {
    const reason = "edição sem newsletter-final.html ou sem 05-published.json — nada a publicar ainda";
    deps.log(reason);
    return { code: 2, reason };
  }

  const built = buildEditionArchivePost(inputs);
  if (!built.ok) {
    deps.log(`artefato presente mas inválido: ${built.reason}`);
    return { code: 4, reason: built.reason };
  }

  let html: string;
  try {
    html = buildArchivePageHtml(built.post);
  } catch (e) {
    if (e instanceof UnresolvedMergeTagError) {
      // #6202 guard: recusa fechada, ANTES de qualquer write/commit/push.
      // `e.tags` já vem deduplicado (ver docstring de UnresolvedMergeTagError
      // em lib/site-archive-pages.ts). Não é sintoma de bug de config — é o
      // caminho esperado até o #6210 decidir o que a página web faz com o
      // bloco de voto (ver docstring do módulo pro exit code 5).
      const reason =
        `página de /p/${built.post.slug} recusada — merge tag não resolvida: ${e.tags.join(", ")}. ` +
        `newsletter-final.html é insumo de E-MAIL (o ESP expande a merge tag só no ENVIO); uma página ` +
        `web estática nunca passa por essa expansão. Nada foi escrito/commitado. Resolver via #6210 ` +
        `(o que a página web faz com o bloco de voto do É IA?), não neste passo.`;
      deps.log(`GUARD (#6202): ${reason}`);
      return { code: 5, reason, tags: e.tags };
    }
    const reason = `render da página falhou: ${(e as Error).message}`;
    deps.log(reason);
    return { code: 3, reason };
  }

  try {
    deps.writePage(built.post.slug, html);
  } catch (e) {
    const reason = `escrita da página falhou: ${(e as Error).message}`;
    deps.log(reason);
    return { code: 3, reason };
  }
  deps.log(`página escrita: /p/${built.post.slug} (${html.length} bytes)`);

  // #6454: sitemapRelPath é o caminho relativo do sitemap.xml a ser
  // atualizado alongside da página. O caller (main) passa --sitemap; em
  // testes é undefined. Roda ANTES do check de --skip-publish — escrever
  // localmente (sitemap + home) é parte de "escrita", não de "publicar"
  // (commit/push), mesma distinção que `writePage` já faz acima.
  const sitemapRelPath = opts.sitemap;
  if (sitemapRelPath && deps.updateSitemapAndHome) {
    try {
      const { sitemapChanged } = deps.updateSitemapAndHome(built.post, sitemapRelPath);
      deps.log(
        sitemapChanged
          ? `sitemap.xml atualizado com /p/${built.post.slug} (${sitemapRelPath}); home regenerada (${homePageRelPathFromSitemap(sitemapRelPath)})`
          : `sitemap.xml já continha /p/${built.post.slug} — home regenerada mesmo assim (idempotente)`,
      );
    } catch (e) {
      // Fail-soft, mesma disciplina do módulo inteiro: a página em si já
      // foi escrita e segue sendo publicada normalmente — o feed da home
      // ficar desatualizado nesta rodada não pode derrubar a edição.
      deps.log(
        `aviso: atualização de sitemap.xml/home falhou (${(e as Error).message}) — página do acervo segue publicada normalmente.`,
      );
    }

    // #8645: precisa do `sitemap.xml` já atualizado acima (a entrada desta
    // edição precisa estar lá pro backfill resolver vizinhos e pro índice
    // paginado incluir a página nova) — por isso roda DEPOIS, mas ainda
    // ANTES do commit único (a mesma disciplina de "escrita local antes de
    // publicar" do bloco acima). Fail-soft: nunca pode reverter a
    // publicação da página em si, que já aconteceu.
    if (deps.backfillAndReindexArchive) {
      try {
        const { seoImageAdded, archiveIndexRegenerated } = deps.backfillAndReindexArchive(
          built.post.slug,
          sitemapRelPath,
        );
        deps.log(
          `backfill/reindex do acervo (#8645): ${seoImageAdded ? "image adicionada ao JSON-LD" : "JSON-LD já tinha image (ou página sem hero)"}; ` +
            `${archiveIndexRegenerated ? "índice paginado regenerado" : "índice paginado NÃO regenerado (ver aviso acima)"}`,
        );
      } catch (e) {
        deps.log(
          `aviso: backfill/reindex do acervo (#8645) falhou (${(e as Error).message}) — página do acervo segue publicada normalmente.`,
        );
      }
    }
  }

  if (opts.skipPublish) {
    deps.log("publicação pulada (--skip-publish) — a página só existe localmente.");
    return { code: 0, slug: built.post.slug, bytes: html.length, published: false };
  }

  let publishResult: PublishResult;
  try {
    publishResult = deps.publish(built.post.slug, sitemapRelPath);
  } catch (e) {
    // A página JÁ está escrita (e pode já estar commitada, se só o push
    // falhou) — a próxima rodada/push manual a leva junto. Por isso a
    // falha de publicação não invalida o trabalho, só adia.
    const reason = `commit/push falhou (a página ficou escrita localmente): ${(e as Error).message}`;
    deps.log(reason);
    return { code: 3, reason };
  }

  // #6202 review, problema P1-B: `published` só é `true` quando `publish()`
  // confirma o push (de fato ocorreu, ou já estava em dia com o remoto) —
  // nunca inferido do sucesso de `deps.writePage`/da ausência de exceção.
  // #6598: `published: true` não significa mais "já no próximo deploy" —
  // significa "branch pushada, PR aberto/reusado, aguardando merge".
  if (publishResult.pushed) {
    // #8158 (revoga #6598): "merge pendente pro deploy" só é verdade quando
    // `waitAndMergeSitePagePr` não conseguiu mergear sozinho — o caso comum
    // agora é `merged: true`, e o log precisa refletir isso (senão o editor
    // lê "merge pendente" numa edição que já foi deployada).
    let prNote: string;
    if (!publishResult.prUrl) {
      prNote = " — push confirmado, mas gh pr create/list não retornou URL";
    } else if (publishResult.merged) {
      prNote = ` — PR ${publishResult.prCreated ? "aberto" : "reusado"} e MERGEADO automaticamente: ${publishResult.prUrl} (${publishResult.mergeReason})`;
    } else {
      prNote = ` — PR ${publishResult.prCreated ? "aberto" : "reusado"}: ${publishResult.prUrl} — NÃO mergeado (${publishResult.mergeReason ?? "motivo desconhecido"}), fica pra revisão manual`;
    }
    deps.log(`publicado — branch site-publish/${built.post.slug} em dia com o remoto${prNote}`);
    return {
      code: 0,
      slug: built.post.slug,
      bytes: html.length,
      published: true,
      prUrl: publishResult.prUrl,
      merged: publishResult.merged,
      // #8158 fleet review, finding 1: `mergeReason` (o PORQUÊ de merged:false —
      // CI vermelho vs. bloqueado por conflito vs. timeout vs. erro de `gh`, cada
      // um com texto distinto) estava sendo descartado aqui, sobrando só o
      // booleano em `_internal/site-page-published.json`. Quem auditar esse
      // arquivo depois não conseguia distinguir os motivos.
      mergeReason: publishResult.mergeReason,
    };
  }
  deps.log(`git commit/push rodou sem lançar mas não confirmou push — /p/${built.post.slug} não tem branch pushada ainda`);
  return { code: 0, slug: built.post.slug, bytes: html.length, published: false };
}

/**
 * Grava o resultado desta chamada em `_internal/site-page-published.json`
 * (#7283) — estado determinístico, escrito pelo PRÓPRIO script, sem depender
 * de o orchestrator lembrar de chamar `log-event.ts` com o nível certo
 * (prosa, não reforçado por código — mesma classe de falha do #4574: sem
 * isto, nada em CÓDIGO verifica que o passo rodou nem qual foi o resultado,
 * só a prosa de `orchestrator-stage-6.md` §6b-site instrui um agente LLM a
 * logar; se ele pular/errar isso, a falha vira silêncio absoluto — foi
 * exatamente o que aconteceu nas 4 edições do #7283/#7266). O invariant
 * `site-page-published` (`scripts/lib/invariant-checks/stage-6.ts`) lê este
 * arquivo pra acusar em `check-invariants.ts --stage 6` (severity: warning —
 * nunca bloqueia, o fail-soft do #6202 continua intocado) quando a página do
 * acervo não foi de fato publicada.
 *
 * Sempre sobrescreve (1 arquivo por edição, reflete a ÚLTIMA tentativa) —
 * mesma convenção de `05-published.json`/`brevo-diaria-published.json`.
 * Fail-soft: uma falha ao ESCREVER este arquivo de estado nunca pode mascarar
 * o `result` real já computado — loga em stderr e segue, nunca lança.
 */
export function writeSitePageState(editionDirAbs: string, result: PublishPageResult): void {
  const path = join(editionDirAbs, "_internal", "site-page-published.json");
  const state = {
    code: result.code,
    slug: "slug" in result ? result.slug : undefined,
    published: "published" in result ? result.published : false,
    reason: "reason" in result ? result.reason : undefined,
    prUrl: "prUrl" in result ? result.prUrl : undefined,
    // #8158 (revoga #6598): `undefined` (sem PR nenhum, ou publicação nem
    // chegou nesse ponto) é distinto de `false` (PR aberto mas NÃO
    // mergeado — CI vermelho/timeout) — o invariant do #7283 pode usar essa
    // distinção pra só alarmar no 2º caso.
    merged: "merged" in result ? result.merged : undefined,
    mergeReason: "mergeReason" in result ? result.mergeReason : undefined,
    checked_at: new Date().toISOString(),
  };
  try {
    mkdirSync(join(editionDirAbs, "_internal"), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    process.stderr.write(
      `[site-page] aviso: falha ao gravar _internal/site-page-published.json (${(e as Error).message}) — ` +
        "o invariant do #7283 pode não detectar este resultado.\n",
    );
  }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionDir = getArg(argv, "edition-dir");
  if (!editionDir) {
    console.error(
      "uso: npx tsx scripts/publish-edition-site-page.ts --edition-dir <dir> [--slug <slug>] [--skip-publish] [--sitemap <path>] [--worktree-dir <path>]",
    );
    process.exitCode = 1;
    return;
  }
  // #6202 review, problema P2-E: `getArg` colapsa "--slug ausente" e "--slug
  // presente mas vazio/sem valor" no mesmo `""` — um `--slug ""` acidental
  // virava silenciosamente "nenhum slug passado", com o diagnóstico
  // resultante apontando pro lugar errado. `getStringArg` distingue os dois
  // (lança em `--slug` sem valor, `--slug=`, ou valor vazio/whitespace após
  // `.trim()`) e devolve `undefined` só quando a flag está genuinamente
  // ausente.
  let slug: string | undefined;
  try {
    slug = getStringArg(argv, "slug", { example: "titulo-da-edicao" });
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const editionDirAbs = resolve(ROOT, editionDir);
  // #8636: worktree temporário. Cria ANTES de chamar publishEditionSitePage
  // (que chama productionDeps → commitAndPushSitePage) e passa o path em
  // `worktreeDir`. `--skip-publish` não precisa de worktree (não roda git,
  // a página fica só em `rootDir`); nem `--worktree-dir` explícito (testes
  // injetam um path já existente). Fallback de limpeza: se o worktree não
  // for removido pelo `finally` de `commitAndPushSitePage` (ex: crash antes
  // do finally), `main` own cleanup cobre — `rmSync` + `git worktree prune`.
  const explicitWorktreeDir = getStringArg(argv, "worktree-dir");
  let worktreeDir: string | undefined;
  if (!hasFlag(argv, "skip-publish") && !explicitWorktreeDir) {
    worktreeDir = mkdtempSync(join(tmpdir(), "diaria-site-page-wt-"));
  }
  let result: PublishPageResult;
  try {
    result = publishEditionSitePage(
      editionDirAbs,
      productionDeps(undefined, undefined, undefined, undefined, undefined, worktreeDir ?? explicitWorktreeDir),
      {
        skipPublish: hasFlag(argv, "skip-publish"),
        slug,
        sitemap: getArg(argv, "sitemap"),
      },
    );
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
  } finally {
    // #8636: cleanup own. `commitAndPushSitePage` já remove o worktree no
    // `finally` dele (fail-soft) — este trecho só é reached quando o worktree
    // NÃO foi criado por `commitAndPushSitePage` (ex: `--skip-publish`, ou
    // `publishEditionSitePage` retornou code 2/4/5 antes de chamar
    // `deps.publish`), ou quando a remoção dele falhou. `force: true` cobre
    // worktree já removido; o `git worktree prune` é o fallback de registry
    // (entries órfãos de worktrees que sumiram sem `git worktree remove`).
    if (worktreeDir) {
      try {
        rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // fail-soft — ver docstring do `finally` de `commitAndPushSitePage`.
      }
      try {
        // `shell: true` porque `execSync` não aceita array de args (a
        // assinatura é `(command: string, options?)`); o mesmo `git worktree
        // prune` que o `git` injetado em `commitAndPushSitePage` rodaria se o
        // `finally` dele não tiver limpado o worktree.
        execSync("git worktree prune", { cwd: ROOT, shell: "bash", stdio: "ignore" });
      } catch {
        // fail-soft: `git worktree prune` é higiene, nunca bloqueio.
      }
    }
  }
  // #7283: grava sempre que chegou até aqui com um `editionDirAbs` resolvido
  // (ou seja, depois dos 2 early-return de erro de USO acima — `--edition-dir`
  // ausente não tem onde escrever, `--slug` malformado é erro de invocação,
  // não resultado de publish desta edição) — nunca depende de o orchestrator
  // lembrar de logar certo. Ver docblock de writeSitePageState.
  writeSitePageState(editionDirAbs, result);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}

export { SITE_PAGES_DIR };
