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

export interface HomeFeedEntry {
  slug: string;
  title: string;
  description: string;
  url: string;
  date: string | null;
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
    feed.push({ slug, title, description, url: entry.loc, date: entry.lastmod });
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
function renderTopicLinks(): string {
  return HUB_META.map(
    (hub) =>
      `        <a href="https://arquivo.diar.ia.br/temas/${escHtml(hub.slug)}">${escHtml(hub.label)}</a>`,
  ).join("\n");
}

export function buildIndexHtml(opts: BuildIndexHtmlOptions): string {
  const { feature } = opts;
  const topicLinks = renderTopicLinks();
  const archive = feature ? opts.archive.filter((entry) => entry.slug !== feature.slug) : opts.archive;

  const featureHtml = feature
    ? `<a class="feature-title-link" href="${escHtml(feature.url)}">
        <h2 class="feature-title">${escHtml(feature.title)}</h2>
      </a>
      <p class="feature-dek">${escHtml(feature.description)}</p>
      <div class="feature-actions">
        <a class="btn btn-ink" href="${escHtml(feature.url)}">Ler edição</a>
        <span class="feature-hint">ou pelo email →</span>
      </div>`
    : `<p class="feature-dek">Nenhuma edição publicada ainda.</p>`;

  const archiveCards = archive
    .map(
      (entry) => `<article class="archive-card">
        <div class="archive-meta">
          <span>${escHtml(formatDateLong(entry.date))}</span>
        </div>
        <h3 class="archive-title"><a href="${escHtml(entry.url)}">${escHtml(entry.title)}</a></h3>
        <p class="archive-dek">${escHtml(entry.description)}</p>
      </article>`,
    )
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
<style>
:root {
  --teal: #00A0A0;
  --teal-deep: #007a7a;
  --ink: #171411;
  --ink-soft: rgba(23,17,15,0.72);
  --ink-faint: rgba(23,17,15,0.5);
  --paper: #FBFAF6;
  --paper-alt: #EBE5D0;
  --rule: rgba(23,20,17,0.18);
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
.signup-pill { display: flex; border: 1px solid var(--ink); border-radius: 999px; padding: 4px; background: #fff; overflow: hidden; }
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
.signup-status.err { color: #b3261e; display: block; }
.signup--dark .signup-status.ok { color: var(--paper); }
.signup--dark .signup-status.err { color: #ffb3a8; }
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

/* Specials */
.specials { padding: 64px 0 72px; background: var(--paper-alt); border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.specials-head h2 { font-size: clamp(32px, 6vw, 56px); font-weight: 500; letter-spacing: -0.02em; line-height: 1; margin: 10px 0 32px; }
.specials-head h2 .accent { font-style: italic; color: var(--teal-deep); }
.specials-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.special-card { padding: 30px; border: 1px solid var(--rule); background: var(--paper); display: flex; flex-direction: column; gap: 14px; }
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
.archive-card { display: flex; flex-direction: column; gap: 10px; }
.archive-meta { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
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
.faq-item { border-top: 1px solid var(--rule); padding: 20px 0; display: grid; grid-template-columns: 28px 1fr; gap: 14px; }
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
  .masthead-grid, .specials-grid, .faqs .wrap, .footer-top { grid-template-columns: 1fr; }
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
      <div class="logo"><span>diar</span><span class="dot" aria-hidden="true">.</span><span>ia</span><span class="dot" aria-hidden="true">.</span><span>br</span></div>
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
      <div class="masthead-meta">
        <span class="mono">Diário · de segunda a sexta · São Paulo, BR</span>
      </div>
      <hr class="rule rule--thick">
      <h1>diar<span class="dot" aria-hidden="true">.</span>ia<span class="dot" aria-hidden="true">.</span>br</h1>
      <div class="masthead-sub">
        <span class="kicker">Seu filtro no caos</span>
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
      <div class="specials-grid">
        <div class="special-card">
          <span class="kicker kicker--teal">● Lista aberta</span>
          <h3>Livros<br>sobre IA.</h3>
          <p>Iniciantes, profissionais e quem quer ir a fundo — curadoria contínua por nível, autor e ano de publicação.</p>
          <a class="btn btn-ink" href="https://livros.diar.ia.br/">Acessar a estante completa →</a>
        </div>
        <div class="special-card special-card--dark">
          <span class="kicker" style="color: var(--teal)">● Para assinantes</span>
          <h3>Cursos<br><span class="accent">gratuitos.</span></h3>
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
        <h2>Perguntas<br>frequentes.</h2>
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
        <div class="footer-headline">5 minutos.<br><span class="accent">Toda manhã.</span></div>
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
  // <form>, ver wireSignupForm abaixo) — este bloco agora só toca o CTA do
  // nav, que continua um link simples pra /assinar.
  (function () {
    if (!window.location.search) return;
    var ctas = document.querySelectorAll('a[href="/assinar"]');
    for (var i = 0; i < ctas.length; i++) {
      ctas[i].setAttribute("href", "/assinar" + window.location.search);
    }
  })();

  // #6976: resolve a inscrição no próprio hero (masthead + footer) — mesmo
  // mecanismo de workers/site/public/assinar/index.html (POST JSON pra
  // https://eia.diar.ia.br/jogar/subscribe, progressive enhancement, status
  // inline), mas fatorado numa função que recebe o FORM como argumento e é
  // chamada 1x por instância — nunca getElementById fixo — pra os 2 forms
  // da mesma página (ids distintos: masthead-form / footer-form) não
  // colidirem entre si.
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
        window
          .fetch(form.getAttribute("action"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
          .then(function (res) {
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
              if (btn) btn.disabled = true;
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
            setStatus("Erro de conexão. Tente de novo.", false);
            if (btn) btn.disabled = false;
          });
      });
    }

    var forms = document.querySelectorAll("form.signup");
    for (var i = 0; i < forms.length; i++) wireSignupForm(forms[i]);
  })();
  </script>
</body>
</html>
`;
}
