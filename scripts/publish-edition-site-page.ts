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
 * Etapa 6, **depois** do agendamento confirmado. Não antes: publicar a página
 * de uma edição que ainda pode mudar no gate criaria divergência entre o que
 * o leitor vê no site e o que recebe por e-mail.
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
 * O dado já está na mão: §6d do orchestrator (que roda ANTES deste passo)
 * já busca `mcp__claude_ai_Beehiiv__get_post({ post_id })` →
 * `web_settings.slug` e, desde #4570, esse slug é GATE-BLOCKING (o guard do
 * bloco WhatsApp já para o Stage 6 se ele não bater) — então quando este
 * passo roda, o slug real já foi confirmado. §6d-site recebe esse MESMO
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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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
  /** Commit + push. Nunca é `wrangler deploy` — ver docstring do módulo. */
  publish(slug: string, sitemapRelPath?: string): PublishResult;
  log(line: string): void;
}

export type PublishPageResult =
  | { code: 0; slug: string; bytes: number; published: boolean; prUrl?: string }
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
  // prática isso significava que o workaround documentado em §6d-site
  // ("passe --slug explicitamente") nunca funcionava de verdade pra Kit —
  // apenas trocava um `code: 4` silencioso por um `code: 2` igualmente mudo.
  // Com `slugOverride`, ignoramos `05-published.json` por completo (nem
  // tentamos lê-lo) — a URL vem só do slug, e `publishedAtIso` fica `null`
  // (nenhum consumidor downstream trata isso como erro, é só metadado).
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
      publishedAtIso: null,
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
          "e nenhum --slug foi passado. Passe --slug explicitamente (ver §6d-site em orchestrator-stage-6.md).",
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
        "no Stage 6 normal, §6d-site deve receber --slug com o valor confirmado via " +
        "get_post em §6d (o mesmo slug que o guard do bloco WhatsApp já verificou).",
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
 * Corpo do PR de publicação de página — documenta a decisão do #6598 (PR
 * fica ABERTO, nunca auto-merge) diretamente no PR, pro coordenador de uma
 * rodada overnight/develop futura (ou o editor) entender o porquê sem
 * precisar caçar a issue.
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
    "**Este PR fica aberto de propósito (#6598, decisão do editor):** o script " +
      "NUNCA mergeia sozinho — mergear página de site fora do fluxo normal de " +
      "branch→CI→merge desta linha de skills (overnight/develop) foge do padrão " +
      "estabelecido, e Stage 6 já é gate humano, então um PR extra pendente não " +
      "atrasa a edição. Merge manual (ou pela próxima rodada overnight/develop) é " +
      "o que falta pro deploy real acontecer " +
      "(`.github/workflows/deploy-site.yml` dispara em push a `master`).",
    "",
    "Refs #6202, #6598",
  ].join("\n");
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
 */
export function commitAndPushSitePage(
  rootDir: string,
  slug: string,
  git: GitRunner = defaultGitRunner,
  sitemapRelPath?: string,
  gh: GhRunner = defaultGhRunner,
  lock: LockRunner = defaultLockRunner,
  sleep: SleepFn = defaultSleep,
): { committed: boolean; pushed: boolean; prUrl?: string; prNumber?: number; prCreated: boolean } {
  const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir).trim();
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
        `\`git fetch origin && git pull\` (ou usar um worktree em ${originMasterCommit || "origin/master"}) ` +
        `resolve (#5156, #6202/#6598, #7287).`,
    );
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
  const optionalPaths = new Set<string>();
  if (sitemapRelPath) {
    const homeRelPath = homePageRelPathFromSitemap(sitemapRelPath);
    pathsToStage.push(sitemapRelPath, homeRelPath);
    optionalPaths.add(sitemapRelPath);
    optionalPaths.add(homeRelPath);
  }

  let committed = false;
  let pushed = false;
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let prCreated = false;

  // #6626: id local a esta chamada — ver docblock de `acquireSitePublishLock`.
  const lockSessionId = `site-publish-${randomUUID()}`;
  acquireSitePublishLock(rootDir, lockSessionId, lock, sleep);

  try {
    // -B (não -b): sempre recria a branch a partir do master atual, mesmo se
    // uma chamada anterior a deixou pra trás localmente — elimina qualquer
    // estado acumulado entre chamadas (idempotência, ver docstring do módulo).
    git(["checkout", "-B", branchName], rootDir);

    for (const p of pathsToStage) {
      // #6454 self-review: sitemap.xml/index.html (`optionalPaths`) podem
      // não existir em disco se `updateSitemapAndHome` tiver falhado antes
      // de escrevê-los (fail-soft, ver caller) — sem este guard, `git add`
      // de um pathspec inexistente lança e a página em si, já escrita com
      // sucesso, é reportada como falha de publicação. `relPageDir` nunca
      // passa por este guard — é sempre staged incondicionalmente, como
      // antes (é a própria página, `writePage` já rodou por definição).
      if (optionalPaths.has(p) && !existsSync(resolve(rootDir, p))) {
        continue;
      }
      git(["add", "--", p], rootDir);
    }

    const status = git(["status", "--porcelain", "--", ...pathsToStage], rootDir);
    committed = status.trim().length > 0;

    if (committed) {
      const stagedFiles = git(["diff", "--cached", "--name-only"], rootDir)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const outsidePathspec = stagedFiles.filter(
        (f) => !pathsToStage.includes(f) && !pathsToStage.some((p) => f.startsWith(p + "/")),
      );
      if (outsidePathspec.length > 0) {
        throw new Error(
          `git add deixou ${outsidePathspec.length} arquivo(s) alheio(s) staged fora do ` +
            `pathspec — provável mudança concorrente no mesmo checkout compartilhado (#5156, #6202 review ` +
            `problema P1-A). Commit abortado, nada foi commitado: ${outsidePathspec.join(", ")}`,
        );
      }
      const commitPaths = pathsToStage.map((p) => ["--", p]).flat();
      git(
        ["commit", "-m", `chore(site): publica página da edição /p/${slug}\n\nRefs #6202, #6598`, ...commitPaths],
        rootDir,
      );
    }

    // #6703 achado 2: renova o TTL antes de cada round-trip de rede restante
    // — push, e (mais adiante) gh pr list/create — pra janela protegida não
    // exceder o TTL de 2min dimensionado pra uma operação bem mais curta.
    renewSitePublishLock(rootDir, lockSessionId, lock);
    git(["push", "--force-with-lease", "-u", "origin", branchName], rootDir);
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
    }
  } finally {
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
    // #6626: libera o lock só DEPOIS da tentativa de checkout de volta — a
    // janela protegida cobre a troca inteira, não só metade dela.
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
): PublishPageDeps {
  return {
    readEditionInputs,
    writePage: (slug, html) => {
      const dir = join(resolve(rootDir, "workers", "site", "public", "p"), slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html, "utf8");
    },
    updateSitemapAndHome: (post, sitemapRelPath) => {
      const sitemapAbsPath = resolve(rootDir, sitemapRelPath);
      const homeAbsPath = resolve(rootDir, homePageRelPathFromSitemap(sitemapRelPath));
      const pagesDir = resolve(rootDir, "workers", "site", "public", "p");

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
    publish: (slug, sitemapPath?: string) => {
      const { pushed, prUrl, prNumber, prCreated } = commitAndPushSitePage(
        rootDir,
        slug,
        git,
        sitemapPath,
        gh,
        lock,
        sleep,
      );
      return { pushed, prUrl, prNumber, prCreated };
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
    const prNote = publishResult.prUrl
      ? ` — PR ${publishResult.prCreated ? "aberto" : "reusado"}: ${publishResult.prUrl} (merge pendente pro deploy)`
      : " — push confirmado, mas gh pr create/list não retornou URL";
    deps.log(`publicado — branch site-publish/${built.post.slug} em dia com o remoto${prNote}`);
    return { code: 0, slug: built.post.slug, bytes: html.length, published: true, prUrl: publishResult.prUrl };
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
 * só a prosa de `orchestrator-stage-6.md` §6d-site instrui um agente LLM a
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
      "uso: npx tsx scripts/publish-edition-site-page.ts --edition-dir <dir> [--slug <slug>] [--skip-publish] [--sitemap <path>]",
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
  let result: PublishPageResult;
  try {
    result = publishEditionSitePage(editionDirAbs, productionDeps(), {
      skipPublish: hasFlag(argv, "skip-publish"),
      slug,
      sitemap: getArg(argv, "sitemap"),
    });
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
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
