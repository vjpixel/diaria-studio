/**
 * site-home-page.ts (#6375)
 *
 * Miolo puro do gerador da home (`/`) — porta a estrutura visual de
 * `V1Landing` (repo `diaria-design`, `v1-daily.jsx`, "Direção A · Edição
 * diária", já escolhida — ver corpo da issue #6375) de React/JSX pra HTML
 * estático servido por `workers/site/public/index.html`.
 *
 * ## Fonte de dado real (V1Feature + V1Archive)
 *
 * A issue pede que o destaque do dia e as edições anteriores usem a MESMA
 * fonte de dado real que já popula `/p/{slug}` — mas em vez de reler
 * `data/beehiiv-cache/posts/*.json` diretamente (que exige `data/` presente,
 * ausente em clone fresco/worktree isolado, ver CLAUDE.md item 2b), este
 * módulo lê o OUTPUT já commitado de `gen-archive-pages.ts`:
 * `workers/site/public/sitemap.xml` (ordem mais-recente-primeiro, mesma
 * ordenação de `selectPublishedPosts`/`sitemapEntriesForPosts` em
 * `site-archive-pages.ts`) + `workers/site/public/p/{slug}/index.html`
 * (título e description já resolvidos por `buildArchivePageHtml`). É a
 * MESMA edição confirmada mais recente e as mesmas anteriores que o acervo
 * público já serve — nunca mock — só a leitura é indireta (via artefato já
 * gerado, sempre presente no repo, em vez do cache bruto). Reduz o
 * acoplamento: quando `gen-archive-pages.ts` rodar de novo (cache
 * atualizado), basta rerodar `gen-home-page.ts` em seguida — mesma
 * disciplina "idempotente, regenera do zero" do gerador do acervo.
 */

import { stripHtmlBasic } from "./strip-html.ts";
import { escHtml } from "./html-escape.ts";
import { parseSitemap } from "./fetch-sitemap.ts";
import { HUB_META } from "../../workers/arquivo/src/hubs/meta.ts";
import { COLORS } from "./shared/design-tokens.ts";
import { WORDMARK_DISPLAY_SEGMENTS } from "./shared/brand-wordmark.ts";
import { GEO_AUTHOR } from "./shared/geo-faq.ts";
import { renderAnalyticsHead } from "./shared/seo-meta.ts"; // #6977: container GTM/GA4 — apex era o único host servido por Worker nosso sem instrumentação

/**
 * Converte um hex `#RRGGBB` do DS pra `rgba(r,g,b,alpha)` — usado só pra
 * derivar `--ink-soft`/`--ink-faint` de `COLORS.ink` (o DS não declara essas
 * duas variantes de opacidade como tokens de 1ª classe, ver docstring de
 * `design-tokens.ts`: "ink-soft/ink-faint → ink; não há cinzas na
 * paleta" — mas o CSS estático da home precisa de uma cor de texto
 * secundário/terciário mais fraca sobre `--paper`, então este módulo deriva
 * localmente).
 *
 * Fonte da #6986: até aqui os dois eram literais `rgba(23,17,15,…)` escritos
 * à mão, com os canais G/B TROCADOS em relação ao `--ink` real
 * (`#171411` = `rgb(23,20,17)`) — outra cor, não o mesmo tom com opacidade.
 * Derivar programaticamente do MESMO hex garante que nunca mais diverge.
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** `--ink-soft`/`--ink-faint` — sempre derivados de `COLORS.ink`, nunca hardcoded (#6986). */
const INK_SOFT = hexToRgba(COLORS.ink, 0.72);
const INK_FAINT = hexToRgba(COLORS.ink, 0.5);

/**
 * Cores semânticas (erro, acento de hover/foco) — item "decidir onde ficam"
 * da #6986. DECISÃO: mantidas LOCAIS a este módulo, **não** promovidas a
 * `design-tokens.ts`.
 *
 * Motivo: `design-tokens.ts` se declara "espelho fiel" do repo
 * `diaria-design` (a fonte da verdade da marca, ver a docstring do módulo) —
 * acrescentar tokens aqui que não existem lá faria esse espelho divergir
 * silenciosamente, na direção errada (o mirror lidera, nunca segue). Se/quando
 * a #6981 tocar as ~10 superfícies de formulário que vão precisar de
 * erro/sucesso, a promoção correta nasce no repo `diaria-design` primeiro
 * (PR lá + re-mirror pra cá), não direto neste módulo. Este comentário É o
 * registro que a issue #6986 pedia — a pior saída era o valor mágico sem
 * justificativa, que era o estado antes desta mudança.
 *
 * `TEAL_DEEP` não é "sucesso" formal — é a variante escurecida do brand teal
 * (`COLORS.brand`, `#00A0A0`) usada em contexto de TEXTO/hover/foco sobre
 * `--paper` (o teal cheio já é usado em fundos de botão/ícone via
 * `var(--teal)`; como cor de texto direto sobre papel claro ele fica
 * ofuscado — daí o tom mais escuro só pra esse uso). `ERROR_*` é o único par
 * erro claro/escuro do repo hoje, introduzido pela #6976 sem registro.
 */
const TEAL_DEEP = "#007a7a";
const ERROR_LIGHT = "#b3261e";
const ERROR_DARK = "#ffb3a8";

/**
 * Raio de canto dos "cards" da home (#7011, achado 3 do editor numa revisão
 * ao vivo). Antes desta constante, cada caixa da página usava um valor
 * DIFERENTE sem nenhuma decisão registrada: `.feature-media img` tinha 6px
 * "solto"; `.special-card`, `.archive-card` (que ganha capa nesta mesma PR,
 * ver `archiveCards` em `buildIndexHtml`) e `.faq-item` não tinham raio
 * nenhum (cantos retos). A
 * home inteira só usava, além disso, 999px em pílulas (botões/tags — 5
 * ocorrências). Uma constante única elimina esse terceiro valor arbitrário e
 * dá o mesmo raio a toda caixa de conteúdo.
 *
 * LOCAL a este módulo, não token de `design-tokens.ts` — mesmo motivo do
 * `TEAL_DEEP`/`ERROR_*` acima: o DS espelhado do repo `diaria-design` não
 * declara raio nenhum (`grep -nE "radius" design-tokens.ts` vazio), então
 * promover um valor aqui faria o mirror divergir na direção errada (ele
 * lidera, nunca segue). Se/quando `diaria-design` declarar um token de raio,
 * a promoção nasce lá primeiro, não direto neste módulo.
 *
 * 8px — o raio dominante da home Beehiiv (`diaria.beehiiv.com`, referência
 * visual já usada nas #6978/#6986/#6995/#7011), medida em 185 ocorrências
 * contra o único uso solto de 6px que existia aqui antes desta mudança.
 *
 * Aplicada a `.special-card` e `.faq-item` mesmo onde a caixa não tem
 * borda/fundo fechado hoje (`.faq-item` só tem `border-top` — o raio não
 * produz efeito visual sozinho ali) — decisão deliberada de consistência
 * antecipada: se uma borda/fundo completo entrar depois nesses seletores, o
 * raio já está certo, em vez de mais um ponto pra lembrar de sincronizar.
 */
const CARD_RADIUS = "8px";

/**
 * Nº máximo de cards de "Edições anteriores" renderizados no HTML estático
 * da home (#7022 item 3). A Beehiiv mostra 6 + botão "Carregar mais"; nossa
 * renderizava 9 de uma vez — com as capas 2:1 do #7011 isso virou 9 imagens
 * no primeiro paint, boa parte do porquê de `scrollHeight` bater 4005 contra
 * 3070 da Beehiiv (medido na issue).
 *
 * DECISÃO (a issue pedia pra registrar o porquê, não só aplicar): a home é
 * **estática, gerada em build** (`gen-home-page.ts`) — não existe backend
 * pra paginar um "carregar mais" real. Duas saídas possíveis:
 *   (a) renderizar os 9 no HTML e revelar os últimos 3 via CSS/JS no clique
 *       — sem round-trip de rede, mas o documento continua carregando as
 *       9 imagens (só esconde visualmente; não resolve o `scrollHeight`
 *       nem o custo de paint que motivou o item);
 *   (b) limitar a render a 6 e mandar o resto pro acervo completo
 *       (`arquivo.diar.ia.br`, já existe, já é exatamente essa página).
 * Escolhida (b): a saída (a) duplicaria as MESMAS 9 edições em 2 lugares
 * (`arquivo.diar.ia.br` E a home, sem necessidade); (b) usa a superfície
 * que já existe pra esse fim, e resolve de fato o custo de paint/altura que
 * o item aponta — (a) só esconderia o sintoma no visual, mantendo o HTML
 * pesado. O link "Ver arquivo completo →" na régua da seção (item 4) já é
 * o caminho pra quem quer mais.
 *
 * `buildIndexHtml` corta em `ARCHIVE_CARD_LIMIT` DEFENSIVAMENTE (não confia
 * só em `gen-home-page.ts` já passar 6 entradas) — mesmo espírito do filtro
 * de `feature` duplicada na `archive` logo abaixo: a invariante fica
 * correta independente do que um caller futuro passar.
 */
const ARCHIVE_CARD_LIMIT = 6;

export interface HomeFeedEntry {
  slug: string;
  title: string;
  description: string;
  url: string;
  date: string | null;
  /** Src do primeiro `<img class="hero">` da página da edição — capa do D1
   *  (#6978 item 1). `null` quando a página não tem `img.hero`, o parse
   *  falha, ou o `src` vem vazio — a home nunca quebra por capa ausente,
   *  degrada pra layout só-texto (ver `extractHeroImage`). */
  image: string | null;
  /** Tempo de leitura estimado em minutos, arredondado (#7022 item 2).
   *  `null`/ausente quando o HTML não rende nenhuma palavra — o card
   *  omite o "N min de leitura" em vez de quebrar (ver
   *  `estimateReadingMinutes`). Opcional: fixtures de teste que constroem
   *  `HomeFeedEntry` à mão (fora de `buildHomeFeed`) não precisam setar. */
  readingMinutes?: number | null;
}

/**
 * Extrai o slug de uma URL canônica `https://diar.ia.br/p/{slug}` — `null`
 * se não casar o shape. `sitemap.xml` nunca carrega query string/fragment em
 * produção, mas parseia via `URL` (não regex sobre a string crua) pra ser
 * correto mesmo assim — achado do fleet review desta PR (#6375): o teste
 * original assumia (errado) que a regex ingênua já suportava isso.
 */
export function slugFromCanonicalUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const m = pathname.match(/\/p\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

/**
 * Lê `<title>` e `<meta name="description">` do HTML de uma página de
 * edição já gerada (`buildArchivePageHtml` sempre os injeta — ver
 * `site-archive-pages.ts`). Decodifica entidades (o HTML fonte usa
 * `escHtml`, que escapa `&<>"'`) pra devolver texto plano reutilizável em
 * outro contexto HTML (o template deste módulo escapa de novo na saída).
 */
export function extractPageMeta(html: string): { title: string; description: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  return {
    title: titleMatch ? stripHtmlBasic(titleMatch[1]) : "",
    description: descMatch ? stripHtmlBasic(descMatch[1]) : "",
  };
}

/**
 * Extrai o `src` do PRIMEIRO `<img class="hero">` do HTML de uma página de
 * edição já gerada (#6978 item 1) — é a capa do D1 (ver docstring de
 * `buildArchivePageHtml`/`site-archive-pages.ts`: o post sempre renderiza um
 * `img.hero` por destaque, na ordem D1→D2→D3, então o primeiro é sempre o
 * D1). Não há `og:image` nessas páginas, então `img.hero` é o único seletor
 * disponível.
 *
 * Nunca lança: sem `img.hero` no HTML, ou com `src` vazio, devolve `null` —
 * mesmo espírito de degradação de `extractPageMeta` (título vazio → `""`),
 * só que aqui o `null` NUNCA pula a entrada do feed (diferente de título
 * vazio) — `buildHomeFeed` só loga e segue, porque a home não pode quebrar
 * por causa de uma capa ausente.
 */
export function extractHeroImage(html: string): string | null {
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of imgTags) {
    if (!/\bclass=["']hero["']/i.test(tag)) continue;
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1]) return srcMatch[1];
  }
  return null;
}

/**
 * Velocidade de leitura usada por `estimateReadingMinutes` — 200
 * palavras/minuto é a mediana comumente citada pra leitura silenciosa em
 * adultos (não há benchmark PT-BR próprio neste repo; escolhida como
 * estimativa honesta, não como medição de precisão). Constante isolada e
 * exportada de propósito (#7022 item 2, "não invente 5 min fixo") — pra
 * ficar óbvio, no código e em teste, que o número por card É DERIVADO do
 * texto real de cada edição, nunca hardcoded.
 */
export const WORDS_PER_MINUTE = 200;

/**
 * Estima o tempo de leitura (minutos, arredondado, mínimo 1) a partir do
 * MESMO HTML de `/p/{slug}/index.html` que `extractPageMeta`/
 * `extractHeroImage` acima já leem — nenhuma leitura extra de disco.
 *
 * Remove `<script>`/`<style>`/`<svg>` inteiros antes de tirar as tags
 * restantes (via `stripHtmlBasic`): sem isso, JS/CSS/paths de ícone SVG
 * inflam a contagem de "palavras" com tokens que ninguém lê. O que sobra
 * ainda inclui nav/rodapé/botões de compartilhar do shell da Beehiiv além
 * do corpo da edição — um offset praticamente CONSTANTE entre edições
 * (mesmo shell em todas), então não distorce a comparação relativa entre
 * cards nem empurra o resultado pra fora de uma faixa plausível: medido
 * contra 5 edições reais do acervo (#7022), a estimativa saiu entre 5 e 8
 * minutos — perto da promessa de marca "5 minutos" precisamente porque
 * NÃO foi fixada nesse valor, e sim calculada.
 *
 * `null` só quando não sobra nenhuma palavra (HTML vazio/só markup) — o
 * card degrada omitindo o "N min de leitura", mesmo espírito de
 * `extractHeroImage` (nunca quebra a home por um dado ausente).
 */
export function estimateReadingMinutes(html: string): number | null {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  const text = stripHtmlBasic(withoutNoise);
  if (!text) return null;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (!wordCount) return null;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}

/**
 * Monta a lista de edições reais (mais recente primeiro) a partir do
 * `sitemap.xml` já commitado + um reader de página injetado (produção lê
 * `workers/site/public/p/{slug}/index.html`; teste injeta fixtures em
 * memória — mesmo padrão de dependency injection que o resto do repo usa
 * pra manter miolo puro testável sem tocar disco, ex: `beehiiv-publish-date.ts`).
 *
 * Entradas cujo slug não resolve (shape de URL inesperado), cuja página o
 * reader não encontra (`null`), ou cujo `<title>` não é extraível
 * (`extractPageMeta` devolve `""`) são puladas — nunca quebram o lote (mesmo
 * espírito de "degradar por post" de `generateArchivePages`, mas aqui é
 * sempre seguro pular: a home não é o acervo, uma edição a menos na grade
 * não é uma falha estrutural). Cada skip emite um `console.warn` — achado do
 * fleet review desta PR (#6375, silent-failure-hunter): sem log, um
 * `sitemap.xml`/`public/p/` desalinhado (ex: `slugFromCanonicalUrl` deixando
 * de casar um shape novo de URL) encolheria a home em silêncio, indistinguível
 * de "esta edição legitimamente não tem página ainda".
 */
export function buildHomeFeed(
  sitemapXml: string,
  readPageHtml: (slug: string) => string | null,
  limit = 10,
): HomeFeedEntry[] {
  const entries = parseSitemap(sitemapXml);
  const feed: HomeFeedEntry[] = [];
  for (const entry of entries) {
    if (feed.length >= limit) break;
    const slug = slugFromCanonicalUrl(entry.loc);
    if (!slug) {
      console.warn(`site-home-page: sitemap entry sem slug reconhecível: ${entry.loc}`);
      continue;
    }
    const html = readPageHtml(slug);
    if (!html) {
      console.warn(`site-home-page: página ausente pra slug "${slug}" — pulando do feed da home`);
      continue;
    }
    const { title, description } = extractPageMeta(html);
    if (!title) {
      console.warn(`site-home-page: <title> vazio/ilegível pra slug "${slug}" — pulando do feed da home`);
      continue;
    }
    const image = extractHeroImage(html);
    if (!image) {
      // Nunca pula a entrada por isso (diferente do <title> vazio acima) —
      // só loga: a home renderiza a edição sem capa, layout só-texto (#6978).
      console.warn(`site-home-page: sem <img class="hero"> pra slug "${slug}" — entrada do feed sem capa`);
    }
    const readingMinutes = estimateReadingMinutes(html);
    feed.push({ slug, title, description, url: entry.loc, date: entry.lastmod, image, readingMinutes });
  }
  return feed;
}

/**
 * Formata `YYYY-MM-DD` pra `dd mmm aaaa` em pt-BR minúsculo (mesmo estilo do
 * design de referência). Valida a FAIXA de `m`/`d`, não só a truthiness —
 * achado do fleet review desta PR (#6375, pr-test-analyzer): `m=13` é
 * truthy e indexava `months[12]` (`undefined`), renderizando literalmente
 * "01 undefined 2026" no card do arquivo. `sitemap.xml`/`lastmod` vêm de
 * `gen-archive-pages.ts` (sempre bem-formado hoje), mas esta função não
 * deve confiar nisso silenciosamente — degrada pra `""` em vez de vazar
 * `undefined` pro HTML.
 */
function formatDateLong(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const months = [
    "jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez",
  ];
  return `${String(d).padStart(2, "0")} ${months[m - 1]} ${y}`;
}

export interface BuildIndexHtmlOptions {
  /** Destaque do dia (V1Feature) — edição confirmada mais recente. `null` quando o acervo está vazio (nunca visto em produção, mas o template não deve quebrar). */
  feature: HomeFeedEntry | null;
  /** Edições anteriores (V1Archive) — já sem a `feature`, ordem mais-recente-primeiro. */
  archive: HomeFeedEntry[];
}

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "O que é a diar.ia.br?",
    a: "Uma newsletter diária e gratuita, em português, com notícias e tutoriais de inteligência artificial resumidos pra ler em 5 minutos — sem jargão, sem hype.",
  },
  {
    q: "Com que frequência ela chega?",
    a: "De segunda a sexta, direto no seu e-mail. Sem edição nos fins de semana.",
  },
  {
    q: "É realmente gratuita?",
    a: "Sim, sem custo e sem limite de tempo. Quem quiser apoiar o projeto pode se tornar apoiador — mas a edição diária nunca fica atrás de paywall.",
  },
  {
    q: "Posso cancelar quando quiser?",
    a: "Sim, com 1 clique, a qualquer momento, direto no rodapé de qualquer edição.",
  },
];

/**
 * Widget de inscrição — pill visual (input + botão) que resolve a inscrição
 * NO PRÓPRIO hero, sem tirar o visitante da home (#6976).
 *
 * Histórico: até o #6976 a pill inteira era um único `<a href="/assinar">`
 * com um `<span>` decorativo fingindo ser input (`aria-hidden="true"`) — o
 * visitante clicava, ia pra `/assinar` e digitava o e-mail de novo. Motivo
 * histórico (#6375: dependia do #6318, então em aberto — UTM/atribuição de
 * cadastro não estava fechada) deixou de valer com o #6427, que fechou esse
 * mecanismo em `/assinar` (`workers/site/public/assinar/index.html`) — e é
 * exatamente esse mecanismo que este widget agora REUSA, em vez de inventar
 * um novo: `<form method="POST" action="https://eia.diar.ia.br/jogar/subscribe">`
 * (cross-origin, `diar.ia.br` na allowlist `ALLOWED_ORIGINS` do worker
 * `poll`) progressivamente aprimorado por um script inline que faz fetch
 * JSON e mostra status sem sair da página — ver o `<script>` no fim de
 * `buildIndexHtml`.
 *
 * `source: "apex"` no payload (mesmo valor de `/assinar` — a home é a MESMA
 * família de superfície do apex) aceita `utm_source`/`utm_medium`/
 * `utm_campaign` DINÂMICOS lidos da própria query string da página (mesma
 * allowlist de prefixo `isAllowedClientUtmSource` do worker `poll`); os 3
 * campos ocultos nascem vazios e são populados no load pelo script.
 *
 * `id` distinto por chamada (masthead × footer) evita colisão — o script
 * nunca usa `getElementById` fixo, sempre `document.querySelectorAll(".signup")`
 * + uma função que recebe o form como argumento, então as duas instâncias na
 * mesma página se comportam de forma independente.
 *
 * A checkbox de opt-in (LGPD) é obrigatória no servidor pra QUALQUER
 * `source` (`optin_required`, ver `workers/poll/src/subscribe.ts`) — mesma
 * exigência que já existe em TODO outro form inline do repo (`/assinar`,
 * `livros-hero`/`livros-footer`, `arquivo`/`hub`). Fica fora da pill em si
 * (que continua pixel a pixel igual ao design existente — só input + botão)
 * pra não alterar sua geometria; entra como uma linha compacta abaixo dela,
 * antes do `.signup-reassure` que já existia.
 *
 * O campo `website` (honeypot, escondido em `.hp`) some no servidor, não
 * aqui: se vier preenchido, `validateSubscribeInput` (`workers/poll/src/
 * subscribe.ts`) responde 200 fake-success SEM assinar ninguém — pra não
 * sinalizar ao bot que foi pego. O widget não distingue esse caso do
 * sucesso real: quem preenche o honeypot vê a MESMA mensagem "Pronto!
 * Confira seu e-mail…" de uma inscrição de verdade (#6979, achado 3 do
 * review da PR #6976).
 */
function renderSignupForm(opts: { id: string; onDark?: boolean }): string {
  const dark = opts.onDark ?? false;
  const emailId = `${opts.id}-email`;
  return `<form class="signup${dark ? " signup--dark" : ""}" id="${opts.id}" method="POST" action="https://eia.diar.ia.br/jogar/subscribe" aria-label="Assinar diar.ia.br gratuitamente" novalidate>
    <input type="hidden" name="source" value="apex">
    <input type="hidden" name="utm_source" value="">
    <input type="hidden" name="utm_medium" value="">
    <input type="hidden" name="utm_campaign" value="">
    <div class="hp" aria-hidden="true">
      <label>Deixe em branco<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
    </div>
    <label class="signup-label" for="${emailId}">Seu e-mail</label>
    <span class="signup-pill">
      <input type="email" class="signup-input" id="${emailId}" name="email" placeholder="seu@email.com" required autocomplete="email">
      <button type="submit" class="signup-btn">Assinar grátis</button>
    </span>
    <label class="signup-optin">
      <input type="checkbox" name="optin" value="on" required>
      <span>Aceito receber a diar.ia.br por e-mail.</span>
    </label>
    <p class="signup-status" role="status" aria-live="polite"></p>
  </form>`;
}

/**
 * Renderiza `workers/site/public/index.html` completo — Nav → Masthead →
 * Feature → Specials → Archive → Faqs → Footer.
 *
 * Filtra `archive` pra excluir qualquer entrada com o mesmo `slug` de
 * `feature` — defensivo, não redundante: achado do fleet review desta PR
 * (#6375, type-design-analyzer), a invariante "`archive` já vem sem a
 * feature" hoje só é verdade porque o único caller (`gen-home-page.ts`) faz
 * `feed[0]`/`feed.slice(1)` corretamente; nada no TYPE impedia um 2º caller
 * (preview script, teste) de passar `archive` incluindo `feature` e duplicar
 * a mesma edição visivelmente na home pública. Filtrar aqui torna a função
 * correta independente do que um chamador futuro passar.
 */
/**
 * Bloco "Por tema" da home (#6411) — um link por hub publicado, derivado de
 * `HUB_META` (a MESMA fonte que o eixo `hub-link-missing` de
 * `scripts/lib/home-meta-check.ts` cruza contra o HTML da home).
 *
 * Derivar da fonte, em vez de listar os 7 slugs à mão aqui, é o ponto: o
 * "4º passo ao publicar um hub novo" (ver a docstring de
 * `workers/arquivo/src/hubs/meta.ts`) deixa de existir como passo. Hub que
 * entra em `HUB_META` ganha link na home na próxima regeneração, e o alarme
 * nunca mais dispara por esse eixo — antes o passo era manual (painel
 * Beehiiv), e foi por isso que os 7 hubs ficaram sem link de descoberta até
 * 28/08/2026, com o alarme reabrindo a mesma issue diariamente.
 *
 * Aponta pro host absoluto `arquivo.diar.ia.br` porque é ele quem serve
 * `/temas/{slug}` — no apex, esse path é 404. `detectMissingHubLinks` casa o
 * path independente de host, então as duas formas satisfariam o eixo; só a
 * absoluta de fato funciona pro leitor.
 */
/**
 * Wordmark de display "diar.ia.br" (nav `.logo` + `<h1>` do masthead, #7010)
 * — consome a ESTRUTURA canônica de `WORDMARK_DISPLAY_SEGMENTS`
 * (`brand-wordmark.ts`) em vez de escrever "diar" + "." + "ia" + ".br" à mão
 * de novo aqui (foi assim que o #7010 nasceu: o markup duplicado só tinha os
 * PONTOS em teal, nunca o ".br" inteiro). A classe `.dot` é LOCAL a este
 * módulo (`.logo .dot`/`.masthead h1 .dot`, ver `<style>` abaixo) — o
 * canônico exporta só QUAIS letras são teal, nunca HTML pronto, porque
 * `applyBrandWordmark` (a outra saída do módulo) injeta `<strong>`/`style`
 * inline pensado pra prosa corrida, não pro tamanho de fonte `clamp(...)`
 * gigante do display.
 */
function renderWordmark(): string {
  return WORDMARK_DISPLAY_SEGMENTS.map((seg) => {
    const cls = seg.teal ? ' class="dot"' : "";
    const hidden = seg.decorative ? ' aria-hidden="true"' : "";
    return `<span${cls}${hidden}>${escHtml(seg.text)}</span>`;
  }).join("");
}

function renderTopicLinks(): string {
  return HUB_META.map(
    (hub) =>
      `        <a href="https://arquivo.diar.ia.br/temas/${escHtml(hub.slug)}">${escHtml(hub.label)}</a>`,
  ).join("\n");
}

/**
 * Timeout do fetch de inscrição no hero/rodapé da home (#6979, achado 1 do
 * review da PR #6976). Sem `AbortController`+timeout, uma promise que nunca
 * resolve (DNS travado, proxy/firewall engolindo o POST cross-origin pra
 * `eia.diar.ia.br`, Worker pendurado) deixa o botão desabilitado e
 * "Enviando…" pra sempre — sem erro visível, sem caminho de retry a não ser
 * recarregar a página, e o visitante acha que assinou.
 *
 * 12s (dentro da faixa 10–15s pedida no review): dá margem sobre o pior caso
 * conhecido do lado SERVIDOR — `SUBSCRIBE_FETCH_TIMEOUT_MS` (8s,
 * `workers/poll/src/subscribe.ts`) é o timeout do próprio Worker pro fetch
 * upstream Beehiiv/Kit — mais o overhead de parse/rate-limit (KV) antes
 * disso, sem deixar o visitante esperando 15s+ numa falha de rede real que
 * já devia ter caído no `.catch()`.
 */
export const SIGNUP_FORM_FETCH_TIMEOUT_MS = 12_000;

/**
 * Script (IIFE) que resolve a inscrição no próprio hero (masthead + rodapé,
 * #6976) — fatorado numa função exportada e testável (#6979, achado 2 do
 * review da PR #6976: até aqui só havia asserção de MARKUP sobre o HTML
 * gerado, nada exercitava a lógica de submit). Mesma técnica de
 * `identityFormScript` em `workers/poll/src/jogar.ts` (ver
 * `test/poll-jogar-identify-native-submit-4031.test.ts`): o teste extrai o
 * corpo JS de dentro de `<script>…</script>` e roda via
 * `new Function("window", "document", body)` sobre um DOM mínimo.
 *
 * `wireSignupForm` nunca usa `getElementById` fixo, sempre recebe o `<form>`
 * como argumento — as 2 instâncias na mesma página (masthead × footer, ids
 * distintos) se comportam de forma independente.
 *
 * Estado de sucesso alinhado com `workers/site/public/assinar/index.html`
 * (#6979, achado 4): desabilita E ESCONDE todos os campos, não só o botão —
 * sem isso, o `input`/checkbox continuavam visíveis, habilitados e (por
 * causa do `form.reset()`) em branco de novo, logo ao lado da mensagem de
 * sucesso — inconsistência evitável entre as 2 instâncias do mesmo
 * mecanismo. Decisão: reusar o padrão já existente em vez de documentar a
 * divergência.
 */
export function signupFormScript(): string {
  return `<script>
  (function () {
    function wireSignupForm(form) {
      if (!form) return;
      var qs = new URLSearchParams(window.location.search);
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (key) {
        var el = form.querySelector('input[name="' + key + '"]');
        var v = qs.get(key);
        if (el && v) el.value = v;
      });

      var status = form.querySelector(".signup-status");
      function setStatus(msg, ok) {
        if (!status) return;
        status.style.display = "block";
        status.textContent = msg;
        status.className = "signup-status" + (ok ? " ok" : " err");
      }
      function val(sel) {
        var el = form.querySelector(sel);
        return el ? el.value : "";
      }
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var optin = form.querySelector('input[name="optin"]');
        if (!optin || !optin.checked) {
          setStatus("Marque a caixinha de consentimento pra assinar.", false);
          return;
        }
        var email = (val('input[name="email"]') || "").trim();
        if (!email || email.indexOf("@") < 0) {
          setStatus("Digite um e-mail válido.", false);
          return;
        }
        var btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        setStatus("Enviando…", true);
        var payload = {
          email: email,
          optin: true,
          website: val('input[name="website"]') || "",
          source: "apex",
          utm_source: val('input[name="utm_source"]'),
          utm_medium: val('input[name="utm_medium"]'),
          utm_campaign: val('input[name="utm_campaign"]'),
        };
        if (typeof window.fetch !== "function") {
          // Sem fetch: deixa o form nativo submeter normalmente
          // (progressive enhancement) — ev.preventDefault() já foi chamado,
          // então reenvia.
          form.submit();
          return;
        }
        // #6979 achado 1: aborta o fetch depois de SIGNUP_FORM_FETCH_TIMEOUT_MS
        // e cai no MESMO .catch() de erro de rede abaixo (mesma mensagem,
        // botão reabilitado) — nunca deixa "Enviando…" pendurado pra sempre.
        var timeoutId = null;
        var controller = typeof window.AbortController === "function" ? new window.AbortController() : null;
        if (controller) {
          timeoutId = setTimeout(function () {
            controller.abort();
          }, ${SIGNUP_FORM_FETCH_TIMEOUT_MS});
        }
        var fetchOpts = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        };
        if (controller) fetchOpts.signal = controller.signal;
        window
          .fetch(form.getAttribute("action"), fetchOpts)
          .then(function (res) {
            if (timeoutId) clearTimeout(timeoutId);
            return res.json().then(
              function (d) {
                return { status: res.status, body: d };
              },
              function () {
                return { status: res.status, body: null };
              },
            );
          })
          .then(function (r) {
            if (r.status === 200 && r.body && r.body.ok) {
              form.reset();
              setStatus("Pronto! Confira seu e-mail pra confirmar a assinatura.", true);
              // #6979 achado 4: mesmo tratamento de sucesso de /assinar —
              // desabilita E esconde os campos, não só o botão.
              var fields = form.querySelectorAll("input, button");
              for (var i = 0; i < fields.length; i++) {
                fields[i].disabled = true;
                fields[i].style.display = "none";
              }
            } else if (r.status === 429) {
              setStatus("Muitas tentativas. Tente de novo mais tarde.", false);
              if (btn) btn.disabled = false;
            } else if (r.status === 503) {
              setStatus("Cadastro indisponível agora. Tente de novo em instantes.", false);
              if (btn) btn.disabled = false;
            } else {
              setStatus("Não deu pra assinar agora. Confira o e-mail e tente de novo.", false);
              if (btn) btn.disabled = false;
            }
          })
          .catch(function () {
            if (timeoutId) clearTimeout(timeoutId);
            setStatus("Erro de conexão. Tente de novo.", false);
            if (btn) btn.disabled = false;
          });
      });
    }

    var forms = document.querySelectorAll("form.signup");
    for (var i = 0; i < forms.length; i++) wireSignupForm(forms[i]);
  })();
  </script>`;
}

export function buildIndexHtml(opts: BuildIndexHtmlOptions): string {
  const { feature } = opts;
  const topicLinks = renderTopicLinks();
  const archive = feature ? opts.archive.filter((entry) => entry.slug !== feature.slug) : opts.archive;

  // Capa do destaque (#6978 item 1) — só monta o grid 2 colunas quando a
  // edição TEM `image` (ver `extractHeroImage`). Sem imagem, cai pro layout
  // só-texto de sempre (nenhuma quebra, nenhum bloco vazio no lugar da capa).
  const featureBody = feature
    ? `<a class="feature-title-link" href="${escHtml(feature.url)}">
        <h2 class="feature-title">${escHtml(feature.title)}</h2>
      </a>
      <p class="feature-dek">${escHtml(feature.description)}</p>
      <div class="feature-actions">
        <a class="btn btn-ink" href="${escHtml(feature.url)}">Ler edição</a>
        <span class="feature-hint">ou pelo email →</span>
      </div>`
    : `<p class="feature-dek">Nenhuma edição publicada ainda.</p>`;

  const featureHtml =
    feature && feature.image
      ? `<div class="feature-grid">
        <div class="feature-body">${featureBody}</div>
        <a class="feature-media" href="${escHtml(feature.url)}" tabindex="-1" aria-hidden="true">
          <img src="${escHtml(feature.image)}" alt="${escHtml(feature.title)}" loading="lazy">
        </a>
      </div>`
      : featureBody;

  // Capa por card (#7011) — mesma degradação do destaque (`featureHtml`
  // acima): `entry.image` vem de `extractHeroImage`/`buildHomeFeed`, `null`
  // quando a página não tem `img.hero` — o card cai pro layout só-texto de
  // sempre, nunca quebra por capa ausente. `loading="lazy"` obrigatório
  // aqui (nunca no destaque, que é sempre a 1ª imagem visível da página):
  // são até ARCHIVE_CARD_LIMIT cards, e sem lazy a home carregaria todas de
  // uma vez.
  const archiveCards = archive
    .slice(0, ARCHIVE_CARD_LIMIT)
    .map((entry) => {
      const media = entry.image
        ? `<a class="archive-media" href="${escHtml(entry.url)}" tabindex="-1" aria-hidden="true">
          <img src="${escHtml(entry.image)}" alt="${escHtml(entry.title)}" loading="lazy">
        </a>`
        : "";
      // Meta line (#7022 item 2) — data + tempo de leitura estimado
      // (`estimateReadingMinutes`, derivado do texto real, nunca "5 min"
      // fixo) + autoria (`GEO_AUTHOR`, o mesmo identificador nomeado e
      // verificável já usado em livros/cursos/arquivo — `geo-faq.ts`; sem
      // avatar porque não existe nenhum asset de avatar no repo hoje).
      // Segmentos ausentes (data inválida, HTML sem palavra nenhuma) são
      // omitidos em vez de vazar string vazia/"undefined".
      const metaParts: string[] = [];
      const dateLabel = formatDateLong(entry.date);
      if (dateLabel) metaParts.push(escHtml(dateLabel));
      if (entry.readingMinutes) metaParts.push(`${entry.readingMinutes} min de leitura`);
      metaParts.push(`Por <a href="${escHtml(GEO_AUTHOR.url)}" rel="author">${escHtml(GEO_AUTHOR.name)}</a>`);
      const metaHtml = metaParts.join(' <span aria-hidden="true">·</span> ');
      return `<article class="archive-card">
        ${media}
        <div class="archive-meta">${metaHtml}</div>
        <h3 class="archive-title"><a href="${escHtml(entry.url)}">${escHtml(entry.title)}</a></h3>
        <p class="archive-dek">${escHtml(entry.description)}</p>
      </article>`;
    })
    .join("\n");

  const faqItems = FAQS.map(
    (f, i) => `<div class="faq-item">
      <div class="faq-num">0${i + 1}</div>
      <div>
        <h3 class="faq-q">${escHtml(f.q)}</h3>
        <p class="faq-a">${escHtml(f.a)}</p>
      </div>
    </div>`,
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diar.ia.br</title>
<meta name="description" content="5 minutos diários pra se manter atualizado e usar melhor as IAs.">
<link rel="canonical" href="https://diar.ia.br/">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1080 1080'%3E%3Ccircle cx='540' cy='540' r='540' fill='%2300A0A0'/%3E%3Cg transform='translate(540 540) scale(1.2000) translate(-540 -540)'%3E%3Cpath transform='translate(310 700) scale(0.229492 -0.229492)' d='M1351 21 858 -8 843 6V98L836 100Q787 47 703.5 7.5Q620 -32 535 -32Q333 -32 202.0 118.0Q71 268 71 506Q71 717 217.5 868.0Q364 1019 572 1019Q654 1019 726.0 1000.5Q798 982 841 957V1284Q841 1321 826.0 1353.5Q811 1386 786 1404Q755 1426 708.5 1435.5Q662 1445 615 1449V1522L1155 1548L1170 1532V221Q1170 183 1182.5 157.0Q1195 131 1223 116Q1244 105 1284.5 100.0Q1325 95 1351 94ZM841 199V764Q834 787 821.5 815.0Q809 843 787 868Q767 889 733.5 905.0Q700 921 658 921Q558 921 494.0 808.0Q430 695 430 489Q430 408 441.5 343.5Q453 279 482 226Q511 173 556.5 143.0Q602 113 666 113Q727 113 767.0 136.5Q807 160 841 199Z' fill='%23FFFFFF'/%3E%3Ccircle cx='699' cy='662' r='45' fill='%23FFFFFF'/%3E%3Ccircle cx='824' cy='662' r='45' fill='%23FFFFFF'/%3E%3C/g%3E%3C/svg%3E">
<meta property="og:type" content="website">
<meta property="og:site_name" content="diar.ia.br">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="diar.ia.br">
<meta property="og:description" content="5 minutos diários pra se manter atualizado e usar melhor as IAs.">
<meta property="og:url" content="https://diar.ia.br/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="diar.ia.br">
<meta name="twitter:description" content="5 minutos diários pra se manter atualizado e usar melhor as IAs.">
${renderAnalyticsHead()}
<style>
:root {
  --teal: ${COLORS.brand};
  --teal-deep: ${TEAL_DEEP};
  --ink: ${COLORS.ink};
  --ink-soft: ${INK_SOFT};
  --ink-faint: ${INK_FAINT};
  --paper: ${COLORS.paper};
  --paper-alt: ${COLORS.paperAlt};
  --rule: ${COLORS.rule};
}
* { box-sizing: border-box; }
body {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; margin: 0; }
.mono { font-family: 'Geist Mono', 'JetBrains Mono', ui-monospace, monospace; }
.kicker { font-family: 'Geist Mono', 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ink-soft); }
.kicker--teal { color: var(--teal-deep); }
.rule { height: 1px; background: var(--ink); opacity: 0.18; border: 0; margin: 0; }
.rule--thick { height: 2px; opacity: 1; }

/* Nav */
.nav { padding: 18px 0; border-bottom: 1px solid var(--rule); }
.nav .wrap { display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.logo { font-family: 'Geist', sans-serif; font-weight: 600; font-size: 20px; letter-spacing: -0.02em; }
.logo .dot { color: var(--teal); }
.nav-links { display: flex; gap: 22px; font-size: 13px; color: var(--ink-soft); flex-wrap: wrap; }
.nav-cta { display: flex; gap: 10px; align-items: center; }
.btn { display: inline-block; padding: 9px 18px; border-radius: 999px; font-size: 13px; font-weight: 500; }
.btn-ink { background: var(--ink); color: var(--paper); }
.btn-outline { border: 1px solid var(--rule); color: var(--ink); }

/* Masthead */
.masthead { padding: 56px 0 48px; }
.masthead-meta { display: flex; justify-content: space-between; font-size: 11px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ink-soft); margin-bottom: 20px; flex-wrap: wrap; gap: 8px; }
.masthead h1 { font-size: clamp(48px, 11vw, 140px); line-height: 0.9; letter-spacing: -0.03em; font-weight: 500; text-align: center; margin: 20px 0 0; }
.masthead h1 .dot { color: var(--teal); font-weight: 400; }
.masthead-sub { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 14px; flex-wrap: wrap; gap: 8px; }
.masthead-grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 48px; margin-top: 44px; align-items: start; }
.lede { font-family: Georgia, serif; font-size: clamp(18px, 2.4vw, 28px); line-height: 1.3; font-style: italic; }
.lede .accent { color: var(--teal-deep); font-style: normal; }

/* Signup pill (masthead + footer) — #6976: form real, mesma geometria da pill antiga */
.signup { display: block; margin-top: 14px; }
.signup-pill { display: flex; border: 1px solid var(--ink); border-radius: 999px; padding: 4px; background: var(--paper); overflow: hidden; }
.signup-input {
  flex: 1; min-width: 0; padding: 10px 16px; font-size: 14px; color: var(--ink);
  font-family: inherit; line-height: inherit; border: 0; outline: 0; background: transparent;
  appearance: none; -webkit-appearance: none;
}
.signup-input::placeholder { color: var(--ink-faint); opacity: 1; }
.signup-input:focus-visible { outline: 2px solid var(--teal-deep); outline-offset: -2px; border-radius: 999px; }
.signup-btn {
  background: var(--ink); color: var(--paper); padding: 10px 20px; border-radius: 999px;
  font-size: 14px; font-weight: 500; white-space: nowrap; border: 0; cursor: pointer;
  font-family: inherit; appearance: none; -webkit-appearance: none;
}
.signup-btn:focus-visible { outline: 2px solid var(--teal-deep); outline-offset: -3px; }
.signup-btn:disabled { opacity: 0.6; cursor: default; }
.signup--dark .signup-pill { border-color: rgba(244,239,226,0.3); background: transparent; }
.signup--dark .signup-input { color: rgba(244,239,226,0.92); }
.signup--dark .signup-input::placeholder { color: rgba(244,239,226,0.55); }
.signup--dark .signup-btn { background: var(--paper); color: var(--ink); }
.signup-label {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.signup-optin { display: flex; gap: 6px; align-items: flex-start; margin-top: 8px; font-size: 11px; line-height: 1.35; color: var(--ink-faint); }
.signup-optin input { margin-top: 2px; flex-shrink: 0; }
.signup--dark .signup-optin { color: rgba(244,239,226,0.55); }
.signup-status { margin-top: 8px; font-size: 12px; display: none; }
.signup-status.ok { color: var(--teal-deep); display: block; }
.signup-status.err { color: ${ERROR_LIGHT}; display: block; }
.signup--dark .signup-status.ok { color: var(--paper); }
.signup--dark .signup-status.err { color: ${ERROR_DARK}; }
.signup-reassure { display: flex; gap: 16px; margin-top: 14px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); flex-wrap: wrap; }
.signup--dark + .signup-reassure { color: rgba(244,239,226,0.55); }

/* Feature */
.feature { padding: 56px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.feature-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; flex-wrap: wrap; gap: 8px; }
.feature-title-link { display: block; }
.feature-title { font-size: clamp(28px, 5vw, 52px); line-height: 1.02; letter-spacing: -0.02em; font-weight: 500; }
.feature-title:hover { color: var(--teal-deep); }
.feature-dek { font-family: Georgia, serif; font-size: 18px; line-height: 1.45; color: var(--ink-soft); font-style: italic; margin-top: 20px; max-width: 62ch; }
.feature-actions { display: flex; align-items: center; gap: 14px; margin-top: 28px; flex-wrap: wrap; }
.feature-hint { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.feature-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 40px; align-items: center; }
.feature-media { display: block; }
.feature-media img { display: block; width: 100%; height: auto; border-radius: ${CARD_RADIUS}; }

/* Specials */
.specials { padding: 64px 0 72px; background: var(--paper-alt); border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.specials-head h2 { font-size: clamp(32px, 6vw, 56px); font-weight: 500; letter-spacing: -0.02em; line-height: 1; margin: 10px 0 32px; }
.specials-head h2 .accent { font-style: italic; color: var(--teal-deep); }
.specials-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.special-card { padding: 30px; border: 1px solid var(--rule); background: var(--paper); display: flex; flex-direction: column; gap: 14px; border-radius: ${CARD_RADIUS}; }
.special-card--dark { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.special-card h3 { font-size: 34px; font-weight: 500; letter-spacing: -0.02em; line-height: 1; }
.special-card p { font-size: 14px; line-height: 1.5; color: var(--ink-soft); margin: 0; }
.special-card--dark p { color: rgba(244,239,226,0.7); }
.special-card .btn { align-self: flex-start; }
.special-card--dark .btn-ink { background: var(--teal); color: var(--ink); }

/* Archive */
.archive { padding: 64px 0; }
.archive-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.archive-head h2 { font-size: clamp(28px, 5vw, 40px); font-weight: 500; letter-spacing: -0.02em; }
.archive-head a { font-size: 13px; text-decoration: underline; text-underline-offset: 4px; }
.archive-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px 28px; margin-top: 32px; }
.archive-card { display: flex; flex-direction: column; gap: 10px; border-radius: ${CARD_RADIUS}; }
/* Capa do card (#7011) — topo, mesma proporção 2:1 do crop de destaque
   (04-{d}-2x1.jpg, ver extractHeroImage/HomeFeedEntry.image).
   aspect-ratio + object-fit: cover (em vez de height: auto como
   .feature-media) porque aqui são até ~10 thumbnails pequenas lado a lado
   na mesma grade — sem uma proporção fixa, uma imagem com crop levemente
   diferente desalinharia a grade verticalmente entre colunas. */
.archive-media { display: block; }
.archive-media img { display: block; width: 100%; aspect-ratio: 2 / 1; object-fit: cover; border-radius: ${CARD_RADIUS}; }
.archive-meta { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
.archive-meta a { color: inherit; text-decoration: none; }
.archive-meta a:hover { color: var(--teal-deep); text-decoration: underline; text-underline-offset: 3px; }
.archive-title { font-size: 20px; line-height: 1.15; letter-spacing: -0.01em; font-weight: 500; }
.archive-title a:hover { color: var(--teal-deep); }
.archive-dek { font-family: Georgia, serif; font-size: 13px; line-height: 1.4; color: var(--ink-soft); font-style: italic; margin: 0; }

/* Temas (#6411) */
.topics { padding: 0 0 64px; }
.topics-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.topics-head h2 { font-size: clamp(28px, 5vw, 40px); font-weight: 500; letter-spacing: -0.02em; }
.topics-head a { font-size: 13px; text-decoration: underline; text-underline-offset: 4px; }
.topics-list { display: flex; flex-wrap: wrap; gap: 10px 12px; margin-top: 24px; }
.topics-list a { font-size: 14px; line-height: 1; padding: 10px 14px; border: 1px solid var(--rule); border-radius: 999px; color: var(--ink-soft); }
.topics-list a:hover { color: var(--teal-deep); border-color: var(--teal-deep); }

/* Faqs */
.faqs { padding: 64px 0; }
.faqs .wrap { display: grid; grid-template-columns: 1fr 1.4fr; gap: 48px; }
.faqs h2 { font-size: clamp(30px, 5vw, 44px); font-weight: 500; letter-spacing: -0.02em; margin-top: 10px; }
.faq-item { border-top: 1px solid var(--rule); padding: 20px 0; display: grid; grid-template-columns: 28px 1fr; gap: 14px; border-radius: ${CARD_RADIUS}; }
.faq-num { font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--ink-faint); padding-top: 4px; }
.faq-q { font-size: 18px; font-weight: 500; }
.faq-a { font-size: 14px; line-height: 1.5; color: var(--ink-soft); margin: 8px 0 0; }

/* Footer */
.footer { padding: 56px 0 32px; background: var(--ink); color: var(--paper); }
.footer-top { display: grid; grid-template-columns: 1.1fr 1fr; gap: 48px; align-items: end; }
.footer-headline { font-size: clamp(32px, 6vw, 56px); line-height: 0.95; letter-spacing: -0.02em; font-weight: 500; }
.footer-headline .accent { font-style: italic; color: var(--teal); }
.footer-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.16em; color: rgba(244,239,226,0.6); }
.footer .rule { background: rgba(244,239,226,0.2); opacity: 1; margin-top: 48px; }
.footer-bottom { display: flex; justify-content: space-between; margin-top: 20px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(244,239,226,0.55); flex-wrap: wrap; gap: 10px; }
.footer-bottom a { text-decoration: none; color: var(--teal); }
.footer-bottom a:hover { text-decoration: underline; }
.footer-bottom a + a { margin-left: 8px; }

@media (max-width: 860px) {
  .masthead-grid, .specials-grid, .faqs .wrap, .footer-top, .feature-grid { grid-template-columns: 1fr; }
  .archive-grid { grid-template-columns: repeat(2, 1fr); }
  .nav-links { order: 3; width: 100%; }
}
@media (max-width: 560px) {
  .archive-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
  <nav class="nav" id="nav">
    <div class="wrap">
      <div class="logo">${renderWordmark()}</div>
      <div class="nav-links">
        <a href="https://arquivo.diar.ia.br/">Edições</a>
        <a href="https://especial.diar.ia.br/">Especiais</a>
        <a href="https://livros.diar.ia.br/">Livros</a>
        <a href="https://cursos.diar.ia.br/">Cursos</a>
        <a href="https://eia.diar.ia.br/leaderboard">É IA?</a>
      </div>
      <div class="nav-cta">
        <a class="btn btn-ink" href="/assinar">Assinar</a>
      </div>
    </div>
  </nav>

  <header class="masthead" id="masthead">
    <div class="wrap">
      <!-- #7010 achado 4: par esquerda/direita nas 2 réguas, mesma estrutura
           da home Beehiiv (diaria.beehiiv.com) — layout é escopo desta PR, a
           COPY é decisão do editor, então os 4 textos abaixo são os da
           própria Beehiiv (transcritos ao vivo pelo editor), não inventados
           aqui. .masthead-meta/.masthead-sub já eram display:flex;
           justify-content:space-between antes desta mudança — só tinham 1
           filho cada, então o espaço vazio à direita nunca aparecia. -->
      <div class="masthead-meta">
        <span class="mono">NOTÍCIAS · PESQUISAS · TENDÊNCIAS · TUTORIAIS</span>
        <span class="mono">DE SEGUNDA A SEXTA</span>
      </div>
      <hr class="rule rule--thick">
      <h1>${renderWordmark()}</h1>
      <div class="masthead-sub">
        <span class="kicker">A IA JÁ ESTÁ MUDANDO O SEU TRABALHO.</span>
        <span class="kicker">MELHOR SABER USAR.</span>
      </div>
      <hr class="rule rule--thick">
      <div class="masthead-grid">
        <p class="lede">Um resumo diário das principais pesquisas, notícias, tendências e insights — para ler em 5 minutos, se manter atualizado e usar IA <span class="accent">melhor</span>.</p>
        <div>
          <span class="kicker kicker--teal">Comece a receber hoje</span>
          ${renderSignupForm({ id: "masthead-form" })}
          <div class="signup-reassure">
            <span>✓ Seg–Sex</span><span>✓ 5 min</span><span>✓ Cancelar quando quiser</span>
          </div>
        </div>
      </div>
    </div>
  </header>

  <section class="feature" id="feature">
    <div class="wrap">
      <div class="feature-head">
        <span class="kicker kicker--teal">● Edição de hoje</span>
      </div>
      ${featureHtml}
    </div>
  </section>

  <section class="specials" id="specials">
    <div class="wrap">
      <div class="specials-head">
        <span class="kicker kicker--teal">Cadernos especiais · curadoria contínua</span>
        <h2>O que <span class="accent">não cabe</span> em 5 minutos.</h2>
      </div>
      <!-- #7022 itens 1/5/6: título numa linha só (sem quebra) e sem
           itálico/teal — decisão do editor no triage da issue (item 5): a
           Beehiiv usa itálico/teal na 2ª metade do título e quebra em duas
           linhas, mas o editor preferiu texto plano numa linha só (mantém
           o span class=accent em "Cursos" sem NENHUMA regra CSS escopada a
           special-card h3 accent — é inerte de propósito, não um esqueleto
           de itálico/teal esquecido). Os 2 cards seguem caixa fechada com
           kicker (item 6, decisão do editor: manter a NOSSA versão, não a
           da Beehiiv, que deixa "Livros" solto sem card). O bug de
           acessibilidade do item 1 (quebra de linha sem espaço grudava as
           palavras no texto extraído) segue corrigido — só que aqui a
           correção é REMOVER a quebra de linha (não mais duas linhas), não
           adicionar espaço antes dela. -->
      <div class="specials-grid">
        <div class="special-card">
          <span class="kicker kicker--teal">● Lista aberta</span>
          <h3>Livros sobre IA.</h3>
          <p>Iniciantes, profissionais e quem quer ir a fundo — curadoria contínua por nível, autor e ano de publicação.</p>
          <a class="btn btn-ink" href="https://livros.diar.ia.br/">Acessar a estante completa →</a>
        </div>
        <div class="special-card special-card--dark">
          <span class="kicker" style="color: var(--teal)">● Para assinantes</span>
          <h3>Cursos <span class="accent">gratuitos.</span></h3>
          <p>Selecionados entre os melhores cursos abertos sobre IA. Atualizamos toda semana.</p>
          <a class="btn btn-ink" href="https://cursos.diar.ia.br/">Ver todos os cursos →</a>
        </div>
      </div>
    </div>
  </section>

  <section class="archive" id="archive">
    <div class="wrap">
      <div class="archive-head">
        <h2>Edições anteriores</h2>
        <a href="https://arquivo.diar.ia.br/">Ver arquivo completo →</a>
      </div>
      <hr class="rule">
      <div class="archive-grid">
${archiveCards}
      </div>
    </div>
  </section>

  <section class="topics" id="topics">
    <div class="wrap">
      <div class="topics-head">
        <h2>Por tema</h2>
        <a href="https://arquivo.diar.ia.br/">Ver arquivo completo →</a>
      </div>
      <hr class="rule">
      <div class="topics-list">
${topicLinks}
      </div>
    </div>
  </section>

  <section class="faqs" id="faqs">
    <div class="wrap">
      <div>
        <span class="kicker">Antes de assinar</span>
        <h2>Perguntas <br>frequentes.</h2>
      </div>
      <div>
${faqItems}
        <hr class="rule">
      </div>
    </div>
  </section>

  <footer class="footer" id="footer">
    <div class="wrap">
      <div class="footer-top">
        <div class="footer-headline">5 minutos. <br><span class="accent">Toda manhã.</span></div>
        <div>
          <span class="footer-label">Assine grátis</span>
          ${renderSignupForm({ id: "footer-form", onDark: true })}
          <div class="signup-reassure">
            <span>Seg–Sex · 8h</span><span>Sem spam</span><span>Cancele quando quiser</span>
          </div>
        </div>
      </div>
      <hr class="rule">
      <div class="footer-bottom">
        <span>&copy; ${new Date().getUTCFullYear()} diar.ia.br · São Paulo, Brasil</span>
        <span><a href="https://eia.diar.ia.br/leaderboard">É IA?</a><a href="https://arquivo.diar.ia.br/">Arquivo</a><a href="https://especial.diar.ia.br/">Especial</a></span>
      </div>
    </div>
  </footer>
  <script>
  // #6427: repassa a query string ATUAL (UTM da Clarice News, tráfego pago,
  // etc — ver withClariceUtm em scripts/lib/mensal/monthly-render.ts) pro
  // CTA "Assinar" do nav antes de o visitante clicar. Um anchor
  // href="/assinar" estático NUNCA carrega o utm_source=... da URL atual
  // sozinho (resolução de URL relativa não herda query de referência
  // absoluta-por-path) — sem isto, a atribuição morreria aqui mesmo com a
  // página /assinar (workers/site/public/assinar/) pronta pra recebê-la.
  // #6976: os 2 pills de masthead/footer deixaram de ser anchors (viraram
  // <form>, ver signupFormScript() logo abaixo) — este bloco agora só toca
  // o CTA do nav, que continua um link simples pra /assinar.
  (function () {
    if (!window.location.search) return;
    var ctas = document.querySelectorAll('a[href="/assinar"]');
    for (var i = 0; i < ctas.length; i++) {
      ctas[i].setAttribute("href", "/assinar" + window.location.search);
    }
  })();
  </script>
${signupFormScript()}
</body>
</html>
`;
}
