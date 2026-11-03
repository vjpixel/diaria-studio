/**
 * scripts/lib/shared/retrospectiva-index.ts (#12032)
 *
 * Fonte ÚNICA das retrospectivas publicadas em `retrospectiva.diar.ia.br` e
 * dos links internos que apontam pra elas.
 *
 * ## Por que existe
 *
 * Medição de 02/11/2026 (`data/seo/index-status-retrospectiva-2026-11-02.md`):
 * 1/4 URLs do host indexadas, e as 3 de fora (`/2605`, `/2606`, `/2607`)
 * órfãs: nenhuma página linkava pra elas, só o sitemap. É o mesmo padrão dos
 * hubs de `/temas/` em agosto (`docs/seo-notes.md`, Fatos 4 e 5): página que
 * só existe no sitemap não é rastreada.
 *
 * Antes daqui a lista vivia só em `PATHS_COM_TRECHO`
 * (`workers/retrospectiva/src/index.ts`) e alimentava só o sitemap. Agora a
 * MESMA lista alimenta o sitemap, o índice `retrospectiva.diar.ia.br/`, a nav
 * "Outras retrospectivas" de cada trecho público e o bloco de retrospectivas
 * na raiz de `arquivo.diar.ia.br`. Acrescentar uma retrospectiva aqui a
 * publica nos quatro lugares de uma vez; não há segunda lista pra esquecer
 * (`test/retrospectiva-index-12032.test.ts` trava isso).
 *
 * Por que uma lista e não `ARTICLES.list()` no KV: mesmo racional que o
 * Worker já documentava pro sitemap. `list()` custaria uma chamada por
 * request e traria também paths sem trecho público, e o Worker `arquivo` nem
 * tem o binding. Estar aqui é o que torna a retrospectiva descobrível;
 * publicar o `:teaser` no KV é o que a torna legível. Os dois são
 * deliberados.
 *
 * Módulo PURO e worker-safe (sem I/O, sem import de Node): é importado pelos
 * Workers `retrospectiva` e `arquivo`.
 */
import { classifyRetrospectivaPath } from "./retrospectiva-path.ts";

/** Host canônico das retrospectivas. Mesmo valor de `RETROSPECTIVA_HOST` do
 *  Worker (que passa a reexportar este). */
export const RETROSPECTIVA_BASE_URL = "https://retrospectiva.diar.ia.br";

/**
 * Paths com trecho público, do mais recente para o mais antigo. Cada um
 * precisa classificar em `classifyRetrospectivaPath` (o teste confere).
 *
 * A anual entra quando tiver trecho publicado; hoje nenhuma tem.
 */
export const RETROSPECTIVAS_PUBLICADAS: readonly string[] = ["2608", "2607", "2606", "2605"];

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rótulo legível do path: `2607` → "Retrospectiva de julho de 2026",
 * `2026` → "Retrospectiva de 2026", `aniversario2026` → "Retrospectiva de
 * aniversário de 2026". `null` para path que não classifica.
 *
 * @pure
 */
export function retrospectivaLabel(path: string): string | null {
  const c = classifyRetrospectivaPath(path);
  if (!c) return null;
  if (c.kind === "mensal") return `Retrospectiva de ${MESES[c.mes - 1]} de ${c.ano}`;
  if (c.kind === "aniversario") return `Retrospectiva de aniversário de ${c.ano}`;
  return `Retrospectiva de ${c.ano}`;
}

/**
 * Rótulo curto pra nav em linha, sem "de" entre mês e ano: `2607` →
 * "julho/2026", `2026` → "2026", `aniversario2026` → "aniversário 2026".
 * Existe porque a raiz do `arquivo` usa "{mês} de {ano}" como título das
 * seções de edição, e repetir esse formato num bloco de retrospectivas faria
 * "agosto de 2026" aparecer numa página sem nenhuma edição de agosto.
 *
 * @pure
 */
export function retrospectivaShortLabel(path: string): string | null {
  const c = classifyRetrospectivaPath(path);
  if (!c) return null;
  if (c.kind === "mensal") return `${MESES[c.mes - 1]}/${c.ano}`;
  if (c.kind === "aniversario") return `aniversário ${c.ano}`;
  return String(c.ano);
}

/** URL absoluta e LIMPA (sem UTM) de uma retrospectiva. Sem UTM de propósito:
 *  o link existe pra descoberta pelo crawler, e a URL precisa ser a mesma do
 *  sitemap e do `canonical` da página. */
export function retrospectivaUrl(path: string): string {
  return `${RETROSPECTIVA_BASE_URL}/${path}`;
}

export interface RetrospectivaLink {
  path: string;
  label: string;
  shortLabel: string;
  url: string;
}

/** Os links de todas as publicadas, na ordem da lista. Path que não
 *  classifica é descartado (nunca um link com rótulo inventado). */
export function retrospectivaLinks(paths: readonly string[] = RETROSPECTIVAS_PUBLICADAS): RetrospectivaLink[] {
  const out: RetrospectivaLink[] = [];
  for (const path of paths) {
    const label = retrospectivaLabel(path);
    const shortLabel = retrospectivaShortLabel(path);
    if (label && shortLabel) out.push({ path, label, shortLabel, url: retrospectivaUrl(path) });
  }
  return out;
}

/** Marcador da nav injetada nos trechos (idempotência da injeção). */
export const RETROSPECTIVA_NAV_MARKER = 'data-retrospectiva-nav="outras"';

/**
 * Nav "Outras retrospectivas" pro rodapé do trecho público de cada edição
 * (#12032). A página atual fica de fora; sobrando nenhuma, devolve string
 * vazia (nunca um `<nav>` sem link). Estilo inline: o trecho vem do KV com
 * CSS próprio e esta nav não pode depender dele.
 *
 * @pure
 */
export function renderOutrasRetrospectivasNav(
  currentPath: string,
  paths: readonly string[] = RETROSPECTIVAS_PUBLICADAS,
): string {
  const outras = retrospectivaLinks(paths).filter((l) => l.path !== currentPath);
  if (outras.length === 0) return "";
  const items = outras
    .map(
      (l) =>
        `<li style="margin:0 0 8px;"><a href="${esc(l.url)}" style="color:#171411;text-decoration-color:#00A0A0;">${esc(l.label)}</a></li>`,
    )
    .join("\n      ");
  return `<nav ${RETROSPECTIVA_NAV_MARKER} aria-label="Outras retrospectivas" style="max-width:520px;margin:0 auto;padding:32px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#171411;">
    <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:18px;margin:0 0 12px;">Outras retrospectivas</h2>
    <ul style="list-style:none;padding:0;margin:0 0 12px;">
      ${items}
    </ul>
    <p style="margin:0;"><a href="${esc(RETROSPECTIVA_BASE_URL)}/" style="color:#171411;text-decoration-color:#00A0A0;">Todas as retrospectivas</a></p>
  </nav>`;
}

/**
 * Injeta a nav antes do ÚLTIMO `</body>` (mesmo cuidado de
 * `renderTeaserWithPaywall`: o primeiro pode ser de um exemplo citado como
 * texto). Fail-soft: HTML sem `</body>`, nav vazia ou nav já presente voltam
 * sem mudança, porque a nav é descoberta, nunca condição pra servir a página.
 *
 * @pure
 */
export function injectOutrasRetrospectivasNav(
  html: string,
  currentPath: string,
  paths: readonly string[] = RETROSPECTIVAS_PUBLICADAS,
): string {
  if (html.includes(RETROSPECTIVA_NAV_MARKER)) return html;
  const nav = renderOutrasRetrospectivasNav(currentPath, paths);
  if (!nav) return html;
  const ultima = [...html.matchAll(/<\/body\s*>/gi)].at(-1);
  if (ultima?.index === undefined) return html;
  return `${html.slice(0, ultima.index)}${nav}\n${html.slice(ultima.index)}`;
}

/**
 * Página-índice de `retrospectiva.diar.ia.br/` (#12032). Antes o `/` devolvia
 * 400 (path obrigatório), então o host não tinha nenhuma página que linkasse
 * as edições. Documento completo, indexável, com `canonical` próprio.
 *
 * @pure
 */
export function renderRetrospectivaIndexPage(paths: readonly string[] = RETROSPECTIVAS_PUBLICADAS): string {
  const links = retrospectivaLinks(paths);
  const items =
    links.length > 0
      ? links
          .map(
            (l) =>
              `      <li style="margin:0 0 12px;"><a href="${esc(l.url)}" style="color:#171411;text-decoration-color:#00A0A0;font-size:18px;">${esc(l.label)}</a></li>`,
          )
          .join("\n")
      : `      <li>Nenhuma retrospectiva publicada ainda.</li>`;
  const description =
    "Todas as retrospectivas publicadas da diar.ia.br: o resumo de cada mês e de cada ano das notícias e tutoriais de IA que saíram na newsletter.";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrospectivas da diar.ia.br</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(RETROSPECTIVA_BASE_URL)}/">
<meta name="robots" content="index, follow">
</head>
<body style="margin:0;background:#FBFAF6;color:#171411;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <main style="max-width:640px;margin:0 auto;padding:48px 16px;">
    <p style="margin:0 0 8px;font-size:14px;letter-spacing:.04em;text-transform:uppercase;"><a href="https://diar.ia.br" style="color:#171411;text-decoration:none;">diar.ia.br</a> · Retrospectivas</p>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.2;margin:0 0 16px;">Retrospectivas</h1>
    <p style="font-size:16px;line-height:1.6;margin:0 0 32px;">${esc(description)}</p>
    <ul style="list-style:none;padding:0;margin:0;">
${items}
    </ul>
  </main>
</body>
</html>
`;
}
