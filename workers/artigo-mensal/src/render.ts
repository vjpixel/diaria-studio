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
    <p>Este artigo faz parte dos benefícios de quem apoia a Diar.ia com R$10/mês ou mais. Digite o e-mail que você usa para apoiar:</p>
    <form method="GET" action="${escHtml(action)}">
      <input type="email" name="email" placeholder="seu@email.com" required />
      <button class="button" type="submit">Acessar artigo</button>
    </form>
    <p class="muted">Ainda não apoia? <a href="${APOIASE_URL}">Conheça o Apoia.se da Diar.ia</a>.</p>
  `;
  return shell("Diar.ia — Artigo exclusivo para apoiadores", body);
}

/** Página exibida quando o e-mail informado NÃO está na allowlist (não-apoiador ou apoio < R$10). */
export function renderPaywall(): string {
  const body = `
    <h1>Este artigo é exclusivo para apoiadores da Diar.ia</h1>
    <p>Não encontramos um apoio ativo de R$10/mês ou mais para esse e-mail neste mês. Apoiadores R$10+ têm acesso ao artigo mensal completo.</p>
    <p><a class="button" href="${APOIASE_URL}">Apoiar a Diar.ia</a></p>
    <p class="muted">Já apoia e acha que isso é um erro? <a href="?">Tente outro e-mail</a>.</p>
  `;
  return shell("Diar.ia — Conteúdo exclusivo para apoiadores", body);
}

/** Página 404 dedicada — o leitor JÁ provou ser apoiador, mas o ciclo não tem artigo publicado. */
export function renderCycleNotFound(cycle: string): string {
  const body = `
    <h1>Artigo não encontrado</h1>
    <p>Não há um artigo publicado para o ciclo <strong>${escHtml(cycle)}</strong>.</p>
  `;
  return shell("Diar.ia — artigo não encontrado", body);
}

/** Página 400 — nenhum ciclo informado no path (`GET /`). */
export function renderMissingCycle(): string {
  const body = `
    <h1>Ciclo não informado</h1>
    <p>Use o link completo do artigo mensal (ex: <code>/2607-08</code>).</p>
  `;
  return shell("Diar.ia — ciclo obrigatório", body);
}
