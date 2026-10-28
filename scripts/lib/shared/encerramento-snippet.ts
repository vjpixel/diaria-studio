/**
 * encerramento-snippet.ts (#3219, reescopo #4413/#4411)
 *
 * Loader/render do parágrafo de apoio (Apoia.se) + créditos de ferramentas em
 * `data/snippets/encerramento-social-apoio.md` (#5227, migrado de
 * `context/snippets/`) — a ÚNICA parte da seção
 * `PARA ENCERRAR` que ainda é editável por edição (via painel Caixas do
 * Studio, `platform.config.json` → `para_encerrar.slot_a`).
 *
 * #4413 (decisão do editor, 260801): o convite social ("siga a diar.ia.br
 * no...") deixou de morar neste arquivo — virou BLOCO FIXO, a constante
 * `SOCIAL_INVITE` abaixo, montada a partir das URLs canônicas
 * (`canonical-urls.ts`). Motivo: o texto tinha 5 variantes divergentes entre
 * diário/mensal/config/docs (catalogadas no #4413); um bloco fixo elimina o
 * drift pela raiz — não é mais possível editar o convite social por edição.
 * #4411: mesma lógica pra `CURADORIA_PILLS` (pílulas "Cursos/Livros/
 * Equipamentos"), que tinha 3 grafias diferentes entre diário e mensal.
 *
 * Reusado pelo diário (`scripts/stitch-newsletter.ts`, injetado
 * deterministicamente na seção `PARA ENCERRAR`) e documentado como fonte pro
 * mensal (`.claude/agents/writer-monthly.md`, seção `PARA ENCERRAR` — o
 * writer-monthly é um prompt de LLM, então ele CITA `SOCIAL_INVITE`/
 * `CURADORIA_PILLS` literalmente no prompt, drift-guardado por
 * `test/encerramento-social-apoio-3219.test.ts` contra estas constantes, em
 * vez de importar este módulo). `shared/` (não `diaria/` nem `mensal/`)
 * porque o conteúdo é consumido pelos dois formatos — ver
 * test/lib-boundary.test.ts (#2747).
 */
import { readSnippetFile } from "./snippet-loader.ts";
import {
  DIARIA_LINKEDIN_PAGE_URL,
  DIARIA_INSTAGRAM_URL,
  DIARIA_THREADS_URL,
  DIARIA_FACEBOOK_PAGE_URL,
  DIARIA_X_URL,
  DIARIA_YOUTUBE_URL,
  DIARIA_CURSOS_URL,
  DIARIA_LIVROS_URL,
  DIARIA_AMAZON_LOJA_URL,
  DIARIA_ARQUIVO_URL,
  DIARIA_EIA_URL,
} from "../canonical-urls.ts";
import {
  CURSOS_RODAPE_UTM,
  LIVROS_RODAPE_UTM,
  EQUIPAMENTOS_RODAPE_UTM,
  ARQUIVO_RODAPE_UTM,
  JOGAR_RODAPE_UTM,
} from "./utm-registry.ts"; // #4536/#4553 — UTM da direção newsletter → curadoria; JOGAR_RODAPE_UTM #4550; EQUIPAMENTOS_RODAPE_UTM #4968

/**
 * #4413: convite social FIXO — texto único, idêntico em diário e mensal,
 * nunca editável por edição (decisão do editor, 260801, comentário do
 * #4413/#4421 — já publicado no ciclo 2607-08, 9 campanhas #102–#110,
 * ~30 mil pessoas). Ordem das redes: LinkedIn → Instagram → Threads →
 * Facebook → X → YouTube (o Facebook caiu do 2º pro 4º lugar em relação à redação
 * anterior). Sempre o ÚLTIMO parágrafo da seção `PARA ENCERRAR`
 * (invariante do #3219/#3368, preservada). O TEXTO mudou no #11483 (ver
 * abaixo); bloco fixo e ordem das redes seguem iguais.
 */
/**
 * #11483 (pedido do editor, 28/10/2026, revisa o texto do #4413): o convite
 * virou "Siga a diar.ia.br:" seguido dos ÍCONES das redes, cada um linkando a
 * rede. No markdown continua um parágrafo só, com um link por rede (mesma
 * ordem); o renderer troca cada link pelo ícone (`renderSocialInviteIconsHtml`).
 * Vale a partir das edições costuradas depois deste PR: o `02-reviewed.md` de
 * uma edição já costurada (261029 e anteriores) guarda o texto antigo e
 * re-renderiza igual, pelo prefixo legado abaixo.
 */
export const SOCIAL_INVITE_PREFIX = "Siga a **diar.ia.br**:";

export const SOCIAL_INVITE =
  `${SOCIAL_INVITE_PREFIX} [LinkedIn](${DIARIA_LINKEDIN_PAGE_URL}) [Instagram](${DIARIA_INSTAGRAM_URL}) [Threads](${DIARIA_THREADS_URL}) [Facebook](${DIARIA_FACEBOOK_PAGE_URL}) [X](${DIARIA_X_URL}) [YouTube](${DIARIA_YOUTUBE_URL})`;

/** Prefixo da redação anterior ao #11483 (#4413), em texto corrido. Edições
 * costuradas até a 261029 têm este texto em `02-reviewed.md`. */
export const SOCIAL_INVITE_LEGACY_PREFIX =
  "Para acompanhar as 3 principais notícias de IA todos os dias, siga a";

/** `SOCIAL_INVITE` como era antes do #11483 (última versão, com o YouTube,
 * #10761). O invariante de drift aceita este texto sem avisar: é o que as
 * edições já costuradas carregam, e re-renderizá-las não deve mudar nada. */
export const SOCIAL_INVITE_LEGACY =
  `${SOCIAL_INVITE_LEGACY_PREFIX} **diar.ia.br** no [LinkedIn](${DIARIA_LINKEDIN_PAGE_URL}), [Instagram](${DIARIA_INSTAGRAM_URL}), [Threads](${DIARIA_THREADS_URL}), [Facebook](${DIARIA_FACEBOOK_PAGE_URL}), [X](${DIARIA_X_URL}) ou [YouTube](${DIARIA_YOUTUBE_URL}).`;

/**
 * #10781: o parágrafo é o convite social? Casa pelo PREFIXO estável
 * (`SOCIAL_INVITE_PREFIX`), não pela igualdade com a constante atual — toda
 * edição costurada com uma versão anterior de `SOCIAL_INVITE` (ex.: antes do
 * YouTube entrar na lista, #10761) tem o texto antigo em `02-reviewed.md` e
 * perdia a caixa "painel" ao re-renderizar. Também aceita a redação de texto
 * corrido anterior ao #11483 (`SOCIAL_INVITE_LEGACY_PREFIX`) e a redação
 * legada "Agora que chegou…" (#1148).
 */
export function isSocialInviteParagraph(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith(SOCIAL_INVITE_PREFIX) ||
    t.startsWith(SOCIAL_INVITE_LEGACY_PREFIX) ||
    /^agora que chegou/i.test(t)
  );
}

/** #11483: chave do ícone (nome do arquivo em `assets/social-icons/` e em
 * `workers/site/public/icons/social/`), na ordem do convite. */
export const SOCIAL_INVITE_ICON_KEYS = ["linkedin", "instagram", "threads", "facebook", "x", "youtube"] as const;
export type SocialInviteIconKey = (typeof SOCIAL_INVITE_ICON_KEYS)[number];

/** Rótulo do link no markdown → chave do ícone. */
const SOCIAL_INVITE_ICON_BY_LABEL: Record<string, SocialInviteIconKey> = {
  LinkedIn: "linkedin",
  Instagram: "instagram",
  Threads: "threads",
  Facebook: "facebook",
  X: "x",
  YouTube: "youtube",
};

/** Tamanho exibido do ícone no e-mail (px). O PNG tem 3x isso. */
export const SOCIAL_INVITE_ICON_PX = 28;

/** Os PNGs vivem no Worker do apex (`workers/site/public/icons/social/`,
 * gerados por `scripts/gen-social-invite-icons.ts`). Mesmo host do
 * `og-default.png` da home. */
export const SOCIAL_INVITE_ICON_BASE_URL = "https://diar.ia.br/icons/social";

export function socialInviteIconUrl(key: SocialInviteIconKey): string {
  return `${SOCIAL_INVITE_ICON_BASE_URL}/${key}.png`;
}

/**
 * #11483: separa o convite no formato de ícones em `lead` (o texto antes do
 * 1º link, ex. "Siga a **diar.ia.br**:") e os links de rede. `null` quando o
 * parágrafo não é o convite novo (texto corrido legado, "Agora que chegou…",
 * ou algo entre os links além de espaço) — o renderer cai no texto corrido de
 * sempre, sem perder conteúdo.
 */
export function parseSocialInviteIcons(
  text: string,
): { lead: string; links: Array<{ label: string; url: string; icon: SocialInviteIconKey | null }> } | null {
  const t = text.trim();
  if (!t.startsWith(SOCIAL_INVITE_PREFIX)) return null;
  const rest = t.slice(SOCIAL_INVITE_PREFIX.length);
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const links: Array<{ label: string; url: string; icon: SocialInviteIconKey | null }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(rest)) !== null) {
    if (rest.slice(last, m.index).trim() !== "") return null;
    links.push({ label: m[1], url: m[2], icon: SOCIAL_INVITE_ICON_BY_LABEL[m[1]] ?? null });
    last = m.index + m[0].length;
  }
  if (rest.slice(last).trim() !== "" || links.length === 0) return null;
  return { lead: SOCIAL_INVITE_PREFIX, links };
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * #11483: HTML da fileira de ícones do convite (só a fileira; o `lead` é
 * renderizado por quem chama, com o pipeline inline do próprio formato).
 * PNG hospedado, nunca SVG inline (Gmail/Outlook não renderizam SVG); `alt` =
 * nome da rede, então com imagens bloqueadas o leitor ainda vê "LinkedIn",
 * "Instagram"... clicáveis. Link sem ícone conhecido sai como texto.
 * `hrefFor` deixa o formato aplicar a própria normalização de URL (o mensal
 * põe UTM nos links). `textColor`/`fontFamily` estilizam o alt e o fallback.
 */
export function renderSocialInviteIconsHtml(
  links: Array<{ label: string; url: string; icon: SocialInviteIconKey | null }>,
  opts: { textColor: string; fontFamily: string; hrefFor?: (label: string, url: string) => string },
): string {
  const px = SOCIAL_INVITE_ICON_PX;
  // Estilo do texto (alt e fallback) vai uma vez no <p> e é herdado: repetir
  // por link custava ~500 bytes por rede num e-mail que já encosta no limite
  // de clipping do Gmail.
  const anchors = links.map(({ label, url, icon }) => {
    const href = escAttr(opts.hrefFor ? opts.hrefFor(label, url) : url);
    const inner = icon
      ? `<img src="${socialInviteIconUrl(icon)}" width="${px}" height="${px}" alt="${escAttr(label)}" style="display:block;border:0;">`
      : escAttr(label);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow" style="display:inline-block;margin:0 14px 0 0;vertical-align:middle;color:${opts.textColor};text-decoration:none;">${inner}</a>`;
  });
  return `<p style="margin:12px 0 0;line-height:${px}px;font-family:${opts.fontFamily};font-size:14px;color:${opts.textColor};">${anchors.join("")}</p>`;
}

/** Rótulos dos links de rede no convite social — usados pra reconhecer um
 * parágrafo que TENTA ser o convite (#10835). */
const SOCIAL_INVITE_NETWORK_LABELS = ["LinkedIn", "Instagram", "Threads", "Facebook", "X", "YouTube"] as const;

export type SocialInviteDrift =
  /** Parece o convite (cita a diar.ia.br + ≥2 redes) mas o renderer não o
   * reconhece: sai SEM a caixa "painel", em silêncio. */
  | { kind: "unrecognized"; paragraph: string }
  /** Reconhecido (ganha a caixa), mas o texto difere do `SOCIAL_INVITE`
   * atual — ex.: costurado antes do YouTube entrar (#10761). */
  | { kind: "outdated"; paragraph: string };

/**
 * #10835: acha o parágrafo de convite social do markdown e diz se ele diverge
 * do `SOCIAL_INVITE` atual. O renderer só põe a caixa quando
 * `isSocialInviteParagraph` casa; um parágrafo editado à mão ou costurado com
 * outra redação perdia a borda sem nada avisar. Puro — consumido pelo
 * invariante `social-invite-drift` do Stage 4. `null` = nada a avisar
 * (convite idêntico, ou nenhum parágrafo com cara de convite).
 */
export function detectSocialInviteDrift(markdown: string): SocialInviteDrift | null {
  const paragraphs = markdown.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    if (p === SOCIAL_INVITE) return null;
    // #11483: edição costurada antes da troca pelos ícones carrega o texto
    // corrido; é o esperado, não drift.
    if (p === SOCIAL_INVITE_LEGACY) return null;
    if (isSocialInviteParagraph(p)) {
      // Redação legada "Agora que chegou…" é aceita pelo renderer de propósito
      // (#1148) — não reclamar de edição antiga só por isso.
      if (/^agora que chegou/i.test(p)) return null;
      return { kind: "outdated", paragraph: p };
    }
    const networks = SOCIAL_INVITE_NETWORK_LABELS.filter((l) => p.includes(`[${l}](`)).length;
    if (/diar\.ia\.br/i.test(p) && /\bsiga\b/i.test(p) && networks >= 2) {
      return { kind: "unrecognized", paragraph: p };
    }
  }
  return null;
}

/**
 * Monta `{url}?utm_source=...&utm_medium=...&utm_campaign=...` a partir de um
 * triplo do registry — mesmo padrão TEXTUAL já usado pelos emissores de
 * footer-nav (`renderCuradoriaFooter` em `curadoria-page.ts`, consumido por
 * `build-cursos-page.ts`/`build-livros-page.ts`/`render-archive.ts`):
 * concatenação simples, preservando a URL base EXATAMENTE como a constante
 * declara (`DIARIA_CURSOS_URL`/`DIARIA_LIVROS_URL`/`DIARIA_ARQUIVO_URL`, sem
 * `/` final). Deliberadamente NÃO usa `new URL()` aqui — diferente de
 * `buildFacebookCtaUrl`/`buildInstagramWeeklyArchiveUrl` (que partem de uma
 * URL genérica embutida em prosa e não têm essa restrição), `new URL(...)
 * .toString()` normaliza o path vazio pra `/`, o que mudaria a forma da URL
 * base em TODO outro lugar que a compara/hardcoda por igualdade de string
 * (ex: `FOOTER_DOMAINS`/testes que citam `DIARIA_CURSOS_URL` cru). Os valores
 * aqui são 100% ASCII estático (sem risco de encoding), então a concatenação
 * é segura. Centralizado porque as 3 pills abaixo repetem a mesma forma 3x
 * (#4536/#4553).
 */
function withRodapeUtm(
  url: string,
  utm: { source: string; medium: string; campaign: string },
): string {
  return `${url}?utm_source=${utm.source}&utm_medium=${utm.medium}&utm_campaign=${utm.campaign}`;
}

/**
 * #4411: lista de pílulas de navegação estrutural FIXA do PARA ENCERRAR,
 * idêntica em diário e mensal.
 *
 * #4968 (260811, decisão do editor): reorganizada em DOIS GRUPOS ROTULADOS —
 * o label único "Acesse nossas curadorias:" (gerado hardcoded pelo render)
 * mentia sobre parte da lista: descrevia Cursos/Livros mas não o Arquivo
 * (conteúdo próprio) nem o É IA? (jogo). Cada grupo agora carrega o próprio
 * rótulo EMBUTIDO NO TEXTO — um parágrafo curto terminado em `:`
 * imediatamente antes do respectivo `- [...]`. O render de cada formato
 * (`renderEncerrar` em `newsletter-render-html.ts`, `renderEncerramento` em
 * `monthly-render.ts`) reconhece esse parágrafo como o label DAQUELA lista
 * (consumido, não renderizado como corpo) — não é mais hardcoded, e suporta
 * N listas rotuladas na mesma seção. Uma `- [...]` SEM parágrafo-label
 * imediatamente anterior cai no fallback "Acesse nossas curadorias:" (mesmo
 * texto de antes — compatibilidade com edições já stitchadas/overrides de
 * teste que ainda não têm o parágrafo-label).
 *
 * Também #4968: as 3 pills também tiveram nome revisto — "Equipamentos"
 * mantido (decisão do editor: o grupo "Curadorias:" já dá o contexto que
 * faltava no rótulo solto), "Arquivo" → "Edições anteriores" (diz
 * literalmente o que tem lá) e "É IA?" → "Jogar É IA?" (o verbo separa da
 * seção homônima da própria edição e sinaliza que é jogo).
 *
 * #4536 (pill original "Arquivo" — antes dessa issue `arquivo.diar.ia.br`
 * não tinha NENHUM link de entrada a partir da newsletter) + #4553 (UTM nas
 * pills que apontam pra domínio próprio — Cursos/Livros/Arquivo — na direção
 * newsletter → curadoria; convenção `source: newsletter, medium: email,
 * campaign` único por pill, ver `utm-registry.ts`). #4968 estende esse UTM
 * pra "Equipamentos" também (`EQUIPAMENTOS_RODAPE_UTM`) — antes ficava de
 * fora por estar fora do escopo original do #4553, não por impossibilidade
 * técnica; ver docstring de `EQUIPAMENTOS_RODAPE_UTM`/`CURSOS_RODAPE_UTM`
 * em `utm-registry.ts` pro que isso compra de verdade (desambiguação entre
 * colocações do mesmo storefront, não analytics do lado da Amazon).
 *
 * #4550 (pill original "É IA?", 260804): distribuição própria do jogo —
 * decisão do editor de dar tratamento de produto ao "É IA?" (motor de
 * divulgação inteiro construído, ~8 votos/edição, "ninguém chega na porta").
 * Esta é 1 das 3 superfícies acordadas no briefing overnight do #4550
 * (rodapé + post/story dedicado + link em bio — ver `jogar-promo-urls.ts`
 * pras outras 2). Desde #4968, mora no grupo "Da diar.ia.br:" (conteúdo/
 * produto da própria newsletter, não curadoria de terceiro) — separado das
 * pills de curadoria (Cursos/Livros/Equipamentos), que ficam no grupo
 * "Curadorias:".
 */
export const CURADORIA_PILLS = `Curadorias:
- [Cursos](${withRodapeUtm(DIARIA_CURSOS_URL, CURSOS_RODAPE_UTM)})
- [Livros](${withRodapeUtm(DIARIA_LIVROS_URL, LIVROS_RODAPE_UTM)})
- [Equipamentos](${withRodapeUtm(DIARIA_AMAZON_LOJA_URL, EQUIPAMENTOS_RODAPE_UTM)})

Da diar.ia.br:
- [Edições anteriores](${withRodapeUtm(DIARIA_ARQUIVO_URL, ARQUIVO_RODAPE_UTM)})
- [Jogar É IA?](${withRodapeUtm(`${DIARIA_EIA_URL}/jogar`, JOGAR_RODAPE_UTM)})`;

/**
 * Cláusula de abertura do parágrafo de apoio pro DIÁRIO — vazia, porque o
 * parágrafo já abre direto em "Apoie a curadoria...": dizer "essa edição
 * nasce da diar.ia.br" não faz sentido dentro do próprio diário.
 */
export const ENCERRAMENTO_OPENING_DAILY = "";

/**
 * Cláusula de abertura do parágrafo de apoio pro MENSAL — contextualiza a
 * relação mensal/diária antes do CTA de apoio (inclui o espaço final antes
 * de "Apoie").
 */
export const ENCERRAMENTO_OPENING_MONTHLY =
  "Essa edição mensal nasce da **diar.ia.br**, newsletter diária gratuita sobre IA. ";

/**
 * Lê o template cru de `data/snippets/encerramento-social-apoio.md` (sem
 * o comentário HTML de header), com o marcador `{{OPENING}}` intacto.
 * Retorna `null` se o arquivo não existir ou ficar vazio após o strip do
 * comentário — graceful, igual ao `loadDivulgacaoSnippet` do stitch (caller
 * decide o fallback). Leitura crua delegada a `readSnippetFile` (#3219 —
 * extraído pra parar de duplicar essa lógica em paralelo com
 * `loadDivulgacaoSnippet`). `rootDir` (opcional) — override de teste
 * repassado pra `readSnippetFile`; produção nunca passa (sempre resolve a
 * raiz real do repo).
 */
export function loadEncerramentoSocialApoioTemplate(rootDir?: string): string | null {
  return readSnippetFile("encerramento-social-apoio.md", rootDir);
}

/**
 * Renderiza o bloco (hoje: parágrafo de apoio + créditos de ferramentas,
 * #4413 — o convite social saiu daqui, ver `SOCIAL_INVITE` acima)
 * substituindo `{{OPENING}}` pela cláusula de abertura do formato
 * (`ENCERRAMENTO_OPENING_DAILY`, `ENCERRAMENTO_OPENING_MONTHLY`, ou uma
 * string customizada). Retorna `null` se o template não existir/ficar vazio
 * (graceful). `rootDir` (opcional) — mesmo override de teste de
 * `loadEncerramentoSocialApoioTemplate`.
 */
export function renderEncerramentoSocialApoio(opening: string, rootDir?: string): string | null {
  const template = loadEncerramentoSocialApoioTemplate(rootDir);
  if (!template) return null;
  return template.replace("{{OPENING}}", opening);
}
