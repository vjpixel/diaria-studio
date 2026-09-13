/**
 * workers/site — fallback pra Kit quando a página estática do acervo não existe (#6429).
 *
 * Até aqui este Worker era de STATIC ASSETS PURO (sem `main`) — `[assets]`
 * servia `public/p/{slug}/index.html`/`public/index.html` direto, sem
 * script nenhum na frente. O acervo é gerado por `scripts/gen-archive-pages.ts`
 * a partir de `data/beehiiv-cache/posts/*.json` (gated por
 * `publishing.newsletter.read_backend`, hoje ainda `"beehiiv"`) — uma edição
 * publicada só pelo Kit (desde o switchover de ENVIO do #6114, 26/08/2026)
 * nunca entra nesse cache, então a página estática nunca é gerada e
 * `/p/{slug}` responde 404 no nosso domínio pra toda edição nova.
 *
 * Achado ao vivo (#6429): o botão de compartilhar do WhatsApp embutido no
 * e-mail aponta pro nosso permalink (`https://diar.ia.br/p/{slug}`), então
 * todo leitor que compartilhou a edição do dia mandou um link morto — sem
 * ver erro nenhum (quem recebe o clique é o CONTATO dele, não ele).
 *
 * Fix de curto prazo, este `main`: quando `env.ASSETS.fetch` devolve 404
 * pra um path `/p/{slug}`, redireciona (302) pro permalink hospedado no Kit
 * (`https://{EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/{slug}`) — confirmado
 * ao vivo na issue que o Kit já serve a página pública (`public: true`) pra
 * broadcast publicado só lá. Mantém o e-mail já enviado (com o link antigo)
 * funcional retroativamente e cobre toda edição nova até o fix definitivo
 * (gen-archive-pages.ts ler do Kit — escopo do #463/#6184) — o fallback
 * some sozinho quando a página própria passar a existir, porque o `if`
 * abaixo só dispara em 404.
 *
 * `run_worker_first = true` no `wrangler.toml` (mudança irmã desta) garante
 * que este script rode ANTES do asset ganhar a request — mesmo invariante
 * já documentado em `workers/livros/wrangler.toml`/`workers/cursos/wrangler.toml`.
 *
 * Qualquer outro path (`/`, `/subscribe`, acervo que EXISTE) segue
 * exatamente como antes — `env.ASSETS.fetch(request)` é sempre a 1ª coisa
 * chamada, e só um 404 especificamente em `/p/{slug}` muda de rumo.
 *
 * #7657 — 2ª responsabilidade deste script: `/img/{key}` serve as capas das
 * edições a partir do KV `POLL`, os MESMOS bytes que `workers/poll` já servia
 * em `eia.diar.ia.br/img/{key}`. Motivo: as capas da home vinham de um host
 * DIFERENTE do documento, e um bloqueador de conteúdo no navegador do leitor
 * que corte o subdomínio derruba as 7 imagens da home de uma vez — sem gerar
 * log nosso, então sem como medir quantos leitores veem a página quebrada
 * (reproduzido ao vivo em 08/09/2026, ver a issue). Servindo na mesma origem
 * do documento não há hostname de terceiro pra um filtro cortar.
 *
 * `eia.diar.ia.br/img/{key}` continua no ar, permanentemente: toda edição já
 * ENVIADA por e-mail e todas as páginas `/p/{slug}` do acervo carregam aquela
 * URL. Este path é adição, nunca substituição.
 */
import { EXPECTED_SUBSCRIBE_REDIRECT_HOST } from "../../../scripts/lib/apex-cutover.ts";
// #7657: mesmo miolo que workers/poll usa em eia.diar.ia.br/img/{key}.
import { imageKeyFromPath, serveKvImage, type KvImageStore } from "../../../scripts/lib/shared/kv-image.ts";
// #7737: página de confirmação do double opt-in, movida de
// eia.diar.ia.br/confirmado (Worker `poll`, que agora só faz 301 pra cá) —
// render puro em scripts/lib/shared/, sem import cross-worker (ver
// docstring do módulo).
import { handleConfirmadoPage } from "../../../scripts/lib/shared/confirmado-page.ts";
// #8062: mesma instrumentação de bot de IA / Referer de assistente que
// workers/arquivo/src/index.ts já tem — este Worker (apex diar.ia.br) era o
// único dos 4 sem NENHUM contador, apesar de ser a superfície com mais URLs
// indexadas (263 no GSC) e mais provável de ser citada por um assistente.
import { matchAiReferrerHost, logAiReferrerHit } from "../../../scripts/lib/shared/ai-referrer-log.ts";
import {
  matchAiFetchBot,
  aiFetchBotCounterKey,
  aiFetchReferrerCounterKey,
  incrementAiFetchCounter,
} from "../../../scripts/lib/shared/ai-fetch-counters.ts";

export interface Env {
  ASSETS: Fetcher;
  /** #7657: KV `POLL` — o MESMO namespace que `workers/poll` lê. Só leitura
   *  aqui; quem escreve continua sendo a pipeline (upload-images-public.ts). */
  POLL: KvImageStore;
  /** #8062: KV `CURSOS_SUBSCRIBERS` — o MESMO namespace que
   *  `workers/arquivo`/`workers/cursos` usam, prefixo próprio
   *  (`counter:ai-fetch:site:`). `incrementAiFetchCounter` trata KV ausente
   *  como no-op — binding opcional em runtime mesmo sendo declarado real. */
  CURSOS_SUBSCRIBERS?: KVNamespace;
}

/** Casa `/p/{slug}` (com ou sem barra final — `html_handling` já resolve a
 * canonicalização pro asset, mas o fallback precisa aceitar as duas formas
 * ANTES de o asset lookup decidir isso). Pura, exportada pra teste. */
export function matchArchiveSlug(pathname: string): string | null {
  const match = pathname.match(/^\/p\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // #8062: mesmo par de blocos fail-soft de workers/arquivo/src/index.ts —
    // log de Referer de assistente + contador de fetch por bot nomeado.
    // ANTES de qualquer outra lógica (asset lookup, /img, /confirmado): a
    // request casa ou não casa independente do que o resto do handler faz
    // com ela, e um try/catch isolado nunca deve atrasar a resposta real.
    try {
      const aiHost = matchAiReferrerHost(request.headers.get("Referer"));
      if (aiHost) {
        logAiReferrerHit("site", aiHost, new URL(request.url).pathname);
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchReferrerCounterKey(aiHost, day, "site"));
      }
    } catch {
      // logging nunca derruba a página — mesma disciplina do catch em
      // workers/arquivo/src/index.ts.
    }
    try {
      const bot = matchAiFetchBot(request.headers.get("User-Agent"));
      if (bot) {
        const day = new Date().toISOString().slice(0, 10);
        await incrementAiFetchCounter(env.CURSOS_SUBSCRIBERS, aiFetchBotCounterKey(bot, day, "site"));
      }
    } catch {
      // mesma disciplina fail-soft do bloco de Referer acima.
    }
    // #7657: `/img/{key}` é resolvido ANTES do asset lookup — não existe
    // arquivo nenhum em `public/img/`, então deixar cair no `env.ASSETS`
    // primeiro só gastaria um 404 pra chegar aqui de qualquer jeito. Só GET
    // e HEAD: o KV é leitura pura, qualquer outro método cai no fluxo de
    // sempre e termina no 404 do asset (mesmo critério do dispatch de
    // `/img/*` em workers/poll/src/index.ts).
    // reqUrl: parse único reusado pelos dispatches abaixo que precisam do
    // pathname ANTES do asset lookup (/img/{key} e /confirmado) — nome não
    // é mais "imageUrl" desde que o 2º dispatch (#7737) passou a usá-lo.
    const reqUrl = new URL(request.url);
    if (request.method === "GET" || request.method === "HEAD") {
      const key = imageKeyFromPath(reqUrl.pathname);
      if (key !== null) {
        return serveKvImage(key, env.POLL, request.headers.get("If-None-Match"));
      }
    }

    // #7737: /confirmado — sem arquivo em public/, mesmo racional do
    // /img/{key} acima: resolvido ANTES do asset lookup pra não gastar um
    // 404 desnecessário. Só GET, mesmo critério do dispatch em
    // workers/poll/src/index.ts (que agora só redireciona pra cá).
    if (request.method === "GET" && reqUrl.pathname === "/confirmado") {
      return handleConfirmadoPage();
    }

    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const url = new URL(request.url);
    const slug = matchArchiveSlug(url.pathname);
    if (!slug) return response;

    // #6429 achado do fleet review: preservar a query string (UTM do link de
    // compartilhamento) e re-encodar o slug antes de montar a URL de destino
    // — `matchArchiveSlug` só valida "sem barra", nunca sanitiza pra uso em
    // path de URL.
    const target = new URL(`https://${EXPECTED_SUBSCRIBE_REDIRECT_HOST}/posts/${encodeURIComponent(slug)}`);
    target.search = url.search;
    return Response.redirect(target.toString(), 302);
  },
};
