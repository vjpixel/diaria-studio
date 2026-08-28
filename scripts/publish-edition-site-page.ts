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
 * site-publish/{slug}` a partir do `master` local (precondição inalterada:
 * o checkout precisa estar em `master` antes de começar — garante que a
 * branch nasça de um ponto conhecido, não de uma branch alheia que por
 * acaso esteja em uso no checkout compartilhado), commit escopado ao
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
 * #6454: `--sitemap` atualiza o `sitemap.xml` alongside da página (mesmo
 * commit+push). O sitemap é lido e reescrito no mesmo diretório público
 * (`workers/site/public/sitemap.xml`), então o mesmo deploy que publica a
 * página também serve a entrada nova. Sem isso, o sitemap continua com a
 * lista de edições do `gen-archive-pages.ts` (que lê do cache Beehiiv, e
 * edições publicadas pelo Kit nunca entram nele — ver #6454).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { buildArchivePageHtml, UnresolvedMergeTagError } from "./lib/site-archive-pages.ts";
import { buildEditionArchivePost, type EditionPageInputs } from "./lib/edition-site-page.ts";

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

  if (!htmlExists || !publishedExists) {
    // #6202 review, problema P2-F: o caminho Kit nunca escreve
    // `05-published.json` (escreve `newsletter-kit-published.json`) —
    // pré-render (Stage 4) É backend-agnóstico, então `newsletter-final.html`
    // existe mesmo em edição Kit. Sem esta checagem, backend Kit caía pra
    // sempre no `code: 2` benigno ("nada a publicar ainda"), indistinguível
    // do caso normal "edição ainda não chegou no Stage 4/6" — a mesma doença
    // do P0 original, só que no outro backend (#464 ainda não liga o
    // dispatch, mas quando ligar isto teria voltado a ser um no-op mudo).
    if (htmlExists && !publishedExists && !slugOverride && readNewsletterBackend(rootDirForBackend) === "kit") {
      throw new EditionInputsInvalid(
        "backend Kit selecionado (publishing.newsletter.backend) — newsletter-final.html existe, mas " +
          "05-published.json (única fonte de slug do caminho Beehiiv) nunca é escrito por edições Kit, " +
          "e §6d-site ainda não tem uma fonte de slug própria pro Kit. Não é um bug de estado, é lacuna " +
          "de wiring: passe --slug explicitamente (ver §6d-site em orchestrator-stage-6.md) até o #464 " +
          "ligar o dispatch Kit com uma fonte dedicada.",
      );
    }
    return null;
  }

  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as {
    post_url?: string;
    scheduled_at?: string;
    published_at?: string;
  };

  let postUrl: string;
  if (slugOverride) {
    // URL sintética — só serve pra extractSlugFromPostUrl/web_url; a
    // convenção de domínio é a mesma usada em todo o resto do módulo
    // (ver EditionPageInputs em edition-site-page.ts).
    postUrl = `https://diar.ia.br/p/${slugOverride}`;
  } else if (published.post_url) {
    postUrl = published.post_url;
  } else {
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
    postUrl,
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
 * #6202 review, problema P1-C (mantido): recusa rodar fora de `master`. A
 * branch nova precisa nascer de um ponto conhecido — commitar a partir de
 * uma branch errada (checkout compartilhado com sessões overnight/develop
 * concorrentes, #5156) produziria uma página divergente do `master` real.
 * Lança — o chamador (`publishEditionSitePage`) converte em `code: 3`.
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
 */
export function commitAndPushSitePage(
  rootDir: string,
  slug: string,
  git: GitRunner = defaultGitRunner,
  sitemapRelPath?: string,
  gh: GhRunner = defaultGhRunner,
): { committed: boolean; pushed: boolean; prUrl?: string; prNumber?: number; prCreated: boolean } {
  const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], rootDir).trim();
  if (originalBranch !== "master") {
    throw new Error(
      `checkout não está em master (branch atual: '${originalBranch}') — commit/push abortado antes de ` +
        `tocar qualquer arquivo. A branch de publicação de página precisa nascer de um master conhecido; ` +
        `commitar a partir de outra branch produziria uma página divergente do master real. Provável ` +
        `sessão concorrente trocou de branch neste checkout compartilhado (#5156, #6202/#6598).`,
    );
  }

  const branchName = sitePublishBranch(slug);

  // Forward-slash sempre — git normaliza pathspecs assim mesmo no Windows, e
  // é o formato em que `git status --porcelain`/`git diff --name-only`
  // devolvem paths (necessário pra comparação exata abaixo).
  const relPageDir = ["workers", "site", "public", "p", slug].join("/");
  const pathsToStage = [relPageDir];
  if (sitemapRelPath) pathsToStage.push(sitemapRelPath);

  let committed = false;
  let pushed = false;
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let prCreated = false;

  try {
    // -B (não -b): sempre recria a branch a partir do master atual, mesmo se
    // uma chamada anterior a deixou pra trás localmente — elimina qualquer
    // estado acumulado entre chamadas (idempotência, ver docstring do módulo).
    git(["checkout", "-B", branchName], rootDir);

    for (const p of pathsToStage) {
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

    git(["push", "--force-with-lease", "-u", "origin", branchName], rootDir);
    pushed = true;

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
    git(["checkout", originalBranch], rootDir);
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
 */
export function productionDeps(
  rootDir: string = ROOT,
  git: GitRunner = defaultGitRunner,
  gh: GhRunner = defaultGhRunner,
): PublishPageDeps {
  return {
    readEditionInputs,
    writePage: (slug, html) => {
      const dir = join(resolve(rootDir, "workers", "site", "public", "p"), slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html, "utf8");
    },
    publish: (slug, sitemapPath?: string) => {
      const { pushed, prUrl, prNumber, prCreated } = commitAndPushSitePage(rootDir, slug, git, sitemapPath, gh);
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

  if (opts.skipPublish) {
    deps.log("publicação pulada (--skip-publish) — a página só existe localmente.");
    return { code: 0, slug: built.post.slug, bytes: html.length, published: false };
  }

  // #6454: sitemapRelPath é o caminho relativo do sitemap.xml a ser
  // atualizado alongside da página. O caller (main) passa --sitemap;
  // em testes é undefined.
  const sitemapRelPath = opts.sitemap;

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
  let result: PublishPageResult;
  try {
    result = publishEditionSitePage(resolve(ROOT, editionDir), productionDeps(), {
      skipPublish: hasFlag(argv, "skip-publish"),
      slug,
      sitemap: getArg(argv, "sitemap"),
    });
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}

export { SITE_PAGES_DIR };
