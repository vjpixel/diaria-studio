/**
 * scripts/lib/raw-cached-post.ts (#14001)
 *
 * Tipo do post cru de `data/beehiiv-cache/posts/*.json`, movido sem mudança de
 * `scripts/generate-arquivo-titles.ts` (que o reexporta) para que os módulos de
 * lib que o leem (`hub-sources.ts`, `hub-staleness-check.ts`,
 * `entity-staleness-check.ts`) não importem o CLI de topo. "Este arquivo" e
 * "este script" abaixo seguem querendo dizer `generate-arquivo-titles.ts`.
 */

/** Shape mínimo lido de cada `data/beehiiv-cache/posts/{id}.json` — passthrough
 * (a API/cache carrega bem mais campos; só os usados aqui). `subtitle` não é
 * usado por este arquivo (só por `generate-hub-sources.ts`, #4558 Parte A —
 * D2/D3 da edição, separados por " | "), mas vive na mesma interface
 * compartilhada em vez de duplicada, já que os dois scripts leem o mesmo
 * `data/beehiiv-cache/posts/*.json`. */
export interface RawCachedPost {
  slug?: string;
  title?: string;
  subtitle?: string;
  /** Teaser D2|D3, fallback do `dek` quando `subtitle` está ausente — mesmo
   * campo que `deriveDek` (`lib/site-archive-pages.ts`) já usa como 2º
   * candidato pro `<meta name="dek">` das páginas `/p/*` (#7921). Reusado
   * aqui (#8345) pra alimentar o MESMO `dek` na listagem do arquivo. */
  preview_text?: string;
  subject?: string;
  web_url?: string;
  publish_date?: number | null;
  status?: string;
  /** URL da cover/thumbnail do post, se a Beehiiv tiver uma associada —
   * mesmo campo `get_post.thumbnail_url` que a antiga `beehiiv-cover-upload.ts` (removida no #14048) lia
   * como verificação READ-only pós-upload (#2341). Alimenta `coverImageUrl`
   * abaixo (#5131) — reusa o MESMO dataset já lido por este script em vez de
   * abrir um 2º pipeline contra `data/editions/{ed}/_internal/06-public-images.json`
   * (que exigiria cruzar publishDate↔pasta de edição, e nem toda edição
   * antiga tem esse arquivo — 77/101 no momento do #5131). Como
   * `06-public-images.json.images.cover.url` é o que se sobe como thumbnail
   * (#2341, antiga `beehiiv-cover-upload.ts`), `thumbnail_url` É essa mesma imagem,
   * só espelhada pelo CDN da Beehiiv em vez de `eia.diar.ia.br` — decisão
   * de engenharia registrada aqui, não um desvio silencioso do que a issue
   * pedia ("host nosso"). */
  thumbnail_url?: string;
  /** HTML da edição publicada — só o corpo `free.web` interessa aqui (o
   * cache também traz `free.email`, não declarado por não ter consumidor
   * ainda). Usado por `generate-hub-sources.ts` (#4919 Parte A) pra achar,
   * por casamento EXATO de texto de âncora, o link de fonte primária de
   * cada manchete casada — nunca por posição (ver `HubSourceEntry.primarySourceUrls`). */
  content?: {
    free?: {
      web?: string;
    };
  };
}
