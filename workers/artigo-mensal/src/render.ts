/**
 * workers/artigo-mensal/src/render.ts (#3940)
 *
 * Páginas do GATE (form de e-mail + paywall + "não encontrado"). O artigo
 * completo NÃO é renderizado aqui — ele já chega pronto (HTML completo) do
 * KV `ARTICLES`, gravado por `scripts/build-article-page.ts` (Node-side,
 * reusando o mesmo pipeline testado do e-mail Brevo mensal — ver
 * `scripts/lib/mensal/build-article-page.ts`). Este Worker nunca faz parsing
 * de markdown.
 *
 * Cores inline espelham `scripts/lib/shared/design-tokens.ts` (INK/TEAL/
 * PAPER/BEGE) — mesma convenção de `workers/artigos` ("Design system
 * aplicado inline... sem dependências externas"). Sem import cruzado pro
 * lado Node do repo (Workers não compartilham módulo com `scripts/lib/`,
 * ver `test/lib-boundary.test.ts` — a fronteira lá é interna a
 * `scripts/lib/`, mas a convenção observada em TODOS os workers existentes
 * é zero import de `scripts/`).
 */

const INK = "#171411";
const TEAL = "#00A0A0";
const PAPER = "#FBFAF6";
const BEGE = "#EBE5D0";

/** URL canônica de apoio (espelha `DIARIA_APOIASE_URL`, `scripts/lib/canonical-urls.ts`). */
const APOIASE_URL = "https://apoia.se/diaria";

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)}</title>
<style>
  body { margin:0; padding:0; background:${BEGE}; font-family: Georgia, 'Times New Roman', serif; color:${INK}; }
  .wrap { max-width:520px; margin:0 auto; padding:64px 24px; box-sizing:border-box; }
  .card { background:${PAPER}; border:1px solid ${BEGE}; border-radius:12px; padding:36px 32px; }
  h1 { font-size:24px; line-height:1.3; margin:0 0 16px; }
  p { font-size:16px; line-height:1.6; margin:0 0 16px; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  a { color:${INK}; text-decoration-color:${TEAL}; }
  a.button {
    display:inline-block; background:${TEAL}; color:#fff !important; text-decoration:none;
    font-family: -apple-system, Helvetica, Arial, sans-serif; font-weight:bold;
    padding:14px 28px; border-radius:8px; font-size:16px;
  }
  button.button {
    display:inline-block; background:${TEAL}; color:#fff; text-decoration:none;
    font-family: -apple-system, Helvetica, Arial, sans-serif; font-weight:bold;
    padding:14px 28px; border-radius:8px; border:none; cursor:pointer; font-size:16px;
    width:100%;
  }
  input[type=email] {
    width:100%; box-sizing:border-box; padding:12px 14px; font-size:16px;
    border:1px solid ${BEGE}; border-radius:8px; margin:0 0 16px; font-family:inherit;
  }
  .muted { font-size:13px; color:${INK}; opacity:0.7; font-family: -apple-system, Helvetica, Arial, sans-serif; }
</style>
</head>
<body>
  <div class="wrap"><div class="card">${bodyHtml}</div></div>
</body>
</html>`;
}

/** Página exibida quando NENHUM e-mail foi informado ainda (`?email=` ausente/vazio). */
export function renderEmailForm(cycle: string): string {
  const action = `/${encodeURIComponent(cycle)}`;
  const body = `
    <h1>Artigo exclusivo para apoiadores</h1>
    <p>O Panorama do Mês faz parte dos benefícios de quem apoia a diar.ia.br como Mantenedor, a partir de R$25/mês. Digite o e-mail que você usa para apoiar:</p>
    <form method="GET" action="${escHtml(action)}">
      <input type="email" name="email" placeholder="seu@email.com" required />
      <button class="button" type="submit">Acessar artigo</button>
    </form>
    <p class="muted">Ainda não apoia? <a href="${APOIASE_URL}">Conheça o Apoia.se da diar.ia.br</a>.</p>
  `;
  return shell("diar.ia.br — Artigo exclusivo para apoiadores", body);
}

/**
 * Página exibida quando o e-mail informado NÃO está na allowlist
 * (não-apoiador ou apoio abaixo de Mantenedor).
 *
 * #7658: a copy dizia "R$10/mês ou mais" — e, com o limiar corrigido pra
 * R$25+, isso deixaria de ser doc desatualizada pra virar informação ERRADA
 * mostrada ao leitor: quem apoia com R$10 leria que deveria ter acesso, na
 * página que acabou de negá-lo. O valor citado aqui tem que ser o mesmo de
 * `PANORAMA_DO_MES_NIVEIS` (`scripts/build-apoiador-allowlist.ts`), que é
 * quem de fato monta a allowlist.
 */
export function renderPaywall(): string {
  const body = `
    <h1>Este artigo é exclusivo para apoiadores da diar.ia.br</h1>
    <p>O Panorama do Mês faz parte da recompensa de Mantenedor, a partir de R$25/mês — não encontramos um apoio ativo nesse nível para esse e-mail neste mês.</p>
    <p><a class="button" href="${APOIASE_URL}">Apoiar a diar.ia.br</a></p>
    <p class="muted">Já apoia e acha que isso é um erro? <a href="?entrar=1">Entre com seu e-mail</a>.</p>
  `;
  return shell("diar.ia.br — Conteúdo exclusivo para apoiadores", body);
}

/** Página 404 dedicada — o leitor JÁ provou ser apoiador, mas o ciclo não tem artigo publicado. */
export function renderCycleNotFound(cycle: string): string {
  const body = `
    <h1>Artigo não encontrado</h1>
    <p>Não há um artigo publicado para o ciclo <strong>${escHtml(cycle)}</strong>.</p>
  `;
  return shell("diar.ia.br — artigo não encontrado", body);
}

/** Página 400 — nenhum ciclo informado no path (`GET /`). */
export function renderMissingCycle(): string {
  const body = `
    <h1>Ciclo não informado</h1>
    <p>Use o link completo do artigo mensal (ex: <code>/2607-08</code>).</p>
  `;
  return shell("diar.ia.br — ciclo obrigatório", body);
}

/**
 * URL de cadastro na diária, com UTM próprio (#7580).
 *
 * O CTA secundário do trecho aponta para `/assinar` em vez de embutir um
 * formulário: o endpoint de cadastro (`workers/poll/src/subscribe.ts`) valida
 * `source` contra um enum por superfície, e acrescentar `artigo.diar.ia.br` ali
 * seria mais um deploy e mais uma origem para manter — desproporcional a um
 * CTA que a decisão do editor colocou como linha SECUNDÁRIA. `/assinar` já tem
 * o formulário funcionando.
 */
const ASSINAR_URL =
  "https://diar.ia.br/assinar?utm_source=artigo-mensal&utm_medium=artigo-web&utm_campaign=trecho-paywall";

/**
 * Trecho público + paywall por cima (#7580).
 *
 * O `teaserHtml` é um documento HTML COMPLETO vindo do KV (`article:{ciclo}:teaser`),
 * cortado no fim do 1º destaque por `cutDraftAfterFirstDestaque` no lado Node.
 * Aqui só se injeta o bloco de conversão antes de `</body>`, preservando a
 * tipografia e o layout do artigo — que é justamente o que se quer mostrar.
 *
 * ## O corte é do servidor, o degradê é decoração
 *
 * O texto pago NÃO está nesta resposta: ele nunca sai do KV para quem não
 * passou no gate. Desabilitar CSS ou ver o código-fonte não revela nada, porque
 * não há nada para revelar. O degradê existe para comunicar "continua", não
 * para esconder.
 *
 * ## Dois CTAs, hierarquizados
 *
 * Decisão do editor (07/09/2026): apoio em destaque, cadastro como linha
 * secundária. Quem chega aqui sem apoiar é o perfil que assinaria a diária de
 * graça, mas dois CTAs com o mesmo peso diluem os dois — a página vende apoio,
 * e o cadastro é a saída de quem não vai apoiar hoje.
 *
 * Falha alto se não houver `</body>`: publicar o trecho SEM o bloco de
 * conversão seria entregar conteúdo de graça sem pedir nada em troca — o pior
 * dos dois mundos. Quem chama trata como "sem trecho" e cai no paywall seco.
 */
export function renderTeaserWithPaywall(teaserHtml: string): string {
  // ÚLTIMO `</body>`, não o primeiro. `String.replace` com regex não-global
  // casa o PRIMEIRO, e o #7592 já mostrou o estrago disso nas páginas de
  // edição: numa newsletter que cita HTML como texto, o primeiro `</body>`
  // é o do exemplo — o bloco de conversão entraria no meio do artigo e o
  // resto renderizaria depois de um fechamento precoce. O navegador reabre o
  // body por recuperação de erro, então some em silêncio.
  //
  // A lógica é a mesma de `injectBeforeBodyEnd` (`site-archive-pages.ts`),
  // reescrita aqui em vez de importada: os Workers não importam de
  // `scripts/lib/` (convenção observada em todos eles, ver o topo deste
  // arquivo). Duplicar 4 linhas é o preço dessa fronteira.
  const ocorrencias = [...teaserHtml.matchAll(/<\/body\s*>/gi)];
  const ultima = ocorrencias.at(-1);
  if (ultima?.index === undefined) {
    throw new Error("teaser sem </body> — não há onde injetar o bloco de conversão (#7580)");
  }
  const bloco = `
<div style="position:relative;margin-top:-120px;height:120px;background:linear-gradient(to bottom, rgba(255,255,255,0), ${PAPER});pointer-events:none;"></div>
<div style="background:${BEGE};padding:40px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:${PAPER};border-radius:12px;padding:32px 28px;box-sizing:border-box;">
    <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;margin:0 0 12px;color:${INK};">
      O resto deste artigo é para quem apoia a diar.ia.br
    </h2>
    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;color:${INK};opacity:.85;">
      Apoiadores de R$&nbsp;10/mês ou mais leem o artigo mensal completo — os outros dois destaques,
      as recomendações e o fechamento.
    </p>
    <p style="margin:0 0 20px;">
      <a href="${APOIASE_URL}" style="display:inline-block;background:${TEAL};color:#fff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:8px;font-size:16px;">Apoiar a diar.ia.br</a>
    </p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 8px;color:${INK};opacity:.75;">
      Já apoia? <a href="?entrar=1" style="color:${INK};text-decoration-color:${TEAL};">Entre com seu e-mail</a>.
    </p>
    <p style="font-size:14px;line-height:1.6;margin:0;color:${INK};opacity:.75;">
      Não quer apoiar agora? A <a href="${ASSINAR_URL}" style="color:${INK};text-decoration-color:${TEAL};">diária é de graça</a> — notícias e tutoriais de IA todo dia útil.
    </p>
  </div>
</div>`;
  return `${teaserHtml.slice(0, ultima.index)}${bloco}\n${teaserHtml.slice(ultima.index)}`;
}
