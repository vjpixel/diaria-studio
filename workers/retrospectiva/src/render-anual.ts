/**
 * workers/anual/src/render.ts (#7581)
 *
 * Páginas do GATE de cadastro (trecho + convite de cadastro, form de
 * "já cadastrado? entre com seu e-mail", "não encontrado"). A edição
 * COMPLETA não é renderizada aqui — chega pronta do KV `ARTICLES`, gravada
 * por `scripts/build-annual-page.ts` (Node-side). Este Worker nunca faz
 * parsing de markdown. Mesma estrutura de `workers/artigo-mensal/src/render.ts`
 * (#3940/#7580), adaptada ao gate de CADASTRO (não apoio) — o CTA único é
 * "cadastre-se", não "apoie" + "cadastre-se" hierarquizados.
 *
 * Cores inline espelham `scripts/lib/shared/design-tokens.ts` — mesma
 * convenção observada em todos os Workers com host público. Import cruzado
 * pro Node do repo só via `scripts/lib/shared/` (worker-safe, sem I/O — ver
 * `test/worker-bundle-node-only-imports.test.ts`): o registry de UTM abaixo
 * entra pelo mesmo caminho que `src/index.ts` já usa para `retrospectiva-
 * path.ts`/`robots-txt.ts`/`rate-limit.ts` (#7715).
 */
import {
  RETROSPECTIVA_ANUAL_UTM_SOURCE,
  RETROSPECTIVA_ANUAL_UTM_MEDIUM,
  buildRetrospectivaAnualCampaign,
} from "../../../scripts/lib/shared/utm-registry.ts"; // #7715

const INK = "#171411";
const TEAL = "#00A0A0";
const PAPER = "#FBFAF6";
const BEGE = "#EBE5D0";

/**
 * Endpoint público de cadastro (worker `poll`, domínio de marca) — o MESMO
 * usado pela home (`renderSignupForm`, `scripts/lib/site-home-page.ts`) e por
 * `arquivo`/`hub`/`livros`/`cursos`. `anual.diar.ia.br` precisa constar em
 * `ALLOWED_ORIGINS` de `workers/poll/wrangler.toml` pro fetch cross-origin
 * funcionar (adicionado nesta mesma unidade, #7581).
 */
const SUBSCRIBE_ENDPOINT = "https://eia.diar.ia.br/jogar/subscribe";

/**
 * `SUBSCRIBE_ENDPOINT` com UTM próprio anexado como query string (#7715) —
 * `path` é o path público da página (`AAAA`/`aniversarioAAAA`, ex: `2026`/
 * `aniversario2026`), o mesmo que `classifyRetrospectivaPath` resolve no
 * roteador. `workers/poll/src/subscribe.ts` lê o corpo do POST, não a query
 * string, então isto não muda o cadastro em si — é a MEDIÇÃO do CTA (o link
 * de saída da página) que ganha atribuição, escopo desta issue; ligar o
 * subscribe em si a um `utm_source` dinâmico por edição é decisão à parte
 * (mexeria na allowlist de spoofing de `client-utm-allowlist.ts`, fora do
 * escopo dos 4 itens da #7715).
 */
function subscribeEndpointComUtm(path: string): string {
  const params = new URLSearchParams({
    utm_source: RETROSPECTIVA_ANUAL_UTM_SOURCE,
    utm_medium: RETROSPECTIVA_ANUAL_UTM_MEDIUM,
    utm_campaign: buildRetrospectivaAnualCampaign(path),
  });
  return `${SUBSCRIBE_ENDPOINT}?${params.toString()}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, description: string, canonical: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}" />
<link rel="canonical" href="${escHtml(canonical)}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escHtml(title)}" />
<meta property="og:description" content="${escHtml(description)}" />
<meta property="og:url" content="${escHtml(canonical)}" />
<style>
  body { margin:0; padding:0; background:${BEGE}; font-family: Georgia, 'Times New Roman', serif; color:${INK}; }
  .wrap { max-width:560px; margin:0 auto; padding:64px 24px; box-sizing:border-box; }
  .card { background:${PAPER}; border:1px solid ${BEGE}; border-radius:12px; padding:36px 32px; }
  h1 { font-size:24px; line-height:1.3; margin:0 0 16px; }
  h2 { font-family:Georgia,'Times New Roman',serif; font-size:22px; line-height:1.3; margin:0 0 12px; color:${INK}; }
  p { font-size:16px; line-height:1.6; margin:0 0 16px; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  a { color:${INK}; text-decoration-color:${TEAL}; }
  a.button, button.button {
    display:inline-block; background:${TEAL}; color:#fff; text-decoration:none;
    font-family: -apple-system, Helvetica, Arial, sans-serif; font-weight:bold;
    padding:14px 28px; border-radius:8px; border:none; cursor:pointer; font-size:16px;
  }
  input[type=email], input[type=text] {
    width:100%; box-sizing:border-box; padding:12px 14px; font-size:16px;
    border:1px solid ${BEGE}; border-radius:8px; margin:0 0 12px; font-family:inherit;
  }
  .hp { position:absolute; left:-9999px; }
  label.optin { font-size:13px; display:flex; gap:6px; align-items:flex-start; font-family: -apple-system, Helvetica, Arial, sans-serif; margin:0 0 16px; }
  .muted { font-size:13px; color:${INK}; opacity:0.7; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  .status { margin-top:10px; min-height:1.2em; font-size:14px; font-family: -apple-system, Helvetica, Arial, sans-serif; }
</style>
</head>
<body>
  <div class="wrap"><div class="card">${bodyHtml}</div></div>
</body>
</html>`;
}

/** Form de cadastro — progressivamente aprimorado por `signupScript()` abaixo
 * (fetch JSON pro worker `poll`, mesma origem cross-domain de sempre); sem
 * JS, faz um POST de página inteira pro mesmo endpoint (funciona, resposta
 * crua do worker `poll` — degradação aceitável). */
function renderSignupForm(idSuffix: string, path: string): string {
  return `<form class="signup" id="anual-signup-${idSuffix}" method="POST" action="${escHtml(subscribeEndpointComUtm(path))}">
    <input type="hidden" name="source" value="apex">
    <div class="hp" style="position:absolute;left:-9999px;" aria-hidden="true"><label>Deixe em branco<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    <input type="email" name="email" placeholder="seu@email.com" required autocomplete="email">
    <label class="optin"><input type="checkbox" name="optin" value="on" required> Quero receber a diar.ia.br — newsletter diária e gratuita que resume as principais notícias e tutoriais de IA em 5 minutos de leitura, seg-sex.</label>
    <button class="button" type="submit">Cadastrar e ler completo</button>
    <p class="status" role="status" aria-live="polite"></p>
  </form>`;
}

/** Script (IIFE) que aprimora `renderSignupForm` acima: fetch JSON pro
 * endpoint, sem navegar pra fora da página — "conversão acontece na própria
 * página" (decisão do editor, comentário-marcador da #7581). Falha de rede
 * degrada pro submit nativo (o `<form>` continua com `action`/`method`
 * corretos, então um `preventDefault` que nunca roda ainda funciona). */
function signupScript(idSuffix: string, path: string): string {
  return `<script>
(function () {
  var form = document.getElementById("anual-signup-${idSuffix}");
  if (!form) return;
  var status = form.querySelector(".status");
  function setStatus(msg) { if (status) status.textContent = msg; }
  form.addEventListener("submit", function (ev) {
    if (typeof window.fetch !== "function") return; // sem fetch: cai no submit nativo
    ev.preventDefault();
    var email = form.email.value.trim();
    var optin = form.optin.checked;
    var website = form.website.value;
    var btn = form.querySelector("button");
    if (!email || !optin) { setStatus("Preencha o e-mail e marque a caixinha."); return; }
    if (btn) btn.disabled = true;
    setStatus("Cadastrando…");
    window.fetch(${JSON.stringify(subscribeEndpointComUtm(path))}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, optin: optin, website: website, source: "apex" })
    }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (data) {
      if (data && data.ok) {
        setStatus("Pronto! Confira seu e-mail para confirmar — depois é só voltar aqui e recarregar a página com o mesmo e-mail (?email=...) para ler completo.");
      } else {
        setStatus("Não deu, tente de novo em instantes.");
        if (btn) btn.disabled = false;
      }
    }).catch(function () {
      setStatus("Erro de conexão. Tente de novo.");
      if (btn) btn.disabled = false;
    });
  });
})();
</script>`;
}

/** Página exibida quando o leitor JÁ é cadastrado mas nenhum `?email=` foi
 * informado ainda (link "Já é cadastrado? Entre com seu e-mail"). */
export function renderEmailForm(slug: string, canonical: string): string {
  const action = `/${encodeURIComponent(slug)}`;
  const body = `
    <h1>Já é assinante da diar.ia.br?</h1>
    <p>Digite o e-mail que você usa para assinar — se ele estiver ativo, você lê a retrospectiva completa.</p>
    <form method="GET" action="${escHtml(action)}">
      <input type="email" name="email" placeholder="seu@email.com" required />
      <button class="button" type="submit">Acessar edição completa</button>
    </form>
    <p class="muted">Ainda não assina? <a href="${escHtml(action)}">Volte e cadastre-se</a> — é grátis.</p>
  `;
  return shell(
    "diar.ia.br — Retrospectiva anual: entre com seu e-mail",
    "Digite o e-mail com que você assina a diar.ia.br para ler a retrospectiva anual completa.",
    canonical,
    body,
  );
}

/** Trecho ausente/sem teaser publicado — paywall seco com CTA de cadastro. */
export function renderNoTeaser(canonical: string, path: string): string {
  const body = `
    <h1>Esta retrospectiva é exclusiva para quem assina a diar.ia.br</h1>
    <p>Cadastro grátis. Assinantes ativos leem a edição completa.</p>
    ${renderSignupForm("noteaser", path)}
    <p class="muted">Já assina? <a href="?entrar=1">Entre com seu e-mail</a>.</p>
  `;
  return shell(
    "diar.ia.br — Retrospectiva anual (cadastro)",
    "A retrospectiva anual da diar.ia.br é exclusiva para assinantes. Cadastro gratuito.",
    canonical,
    body + signupScript("noteaser", path),
  );
}

/**
 * Trecho público + bloco de conversão por cima (#7581) — mesmo mecanismo de
 * `renderTeaserWithPaywall` (`workers/artigo-mensal/src/render.ts`, #7580),
 * com UM CTA só (cadastro), não dois hierarquizados: aqui não existe opção
 * de "apoiar" — a única saída é assinar, que é grátis.
 *
 * Falha alto se não houver `</body>` — publicar o trecho SEM o bloco de
 * conversão entregaria conteúdo de graça sem pedir cadastro em troca. Quem
 * chama trata como "sem trecho" e cai em `renderNoTeaser`.
 */
export function renderTeaserWithSignup(teaserHtml: string, canonical: string, path: string): string {
  const ocorrencias = [...teaserHtml.matchAll(/<\/body\s*>/gi)];
  const ultima = ocorrencias.at(-1);
  if (ultima?.index === undefined) {
    throw new Error("teaser sem </body> — não há onde injetar o bloco de conversão (#7581)");
  }
  const bloco = `
<div style="position:relative;margin-top:-120px;height:120px;background:linear-gradient(to bottom, rgba(255,255,255,0), ${PAPER});pointer-events:none;"></div>
<div style="background:${BEGE};padding:40px 20px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:${PAPER};border-radius:12px;padding:32px 28px;box-sizing:border-box;">
    <h2 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;margin:0 0 12px;color:${INK};">
      O resto desta retrospectiva é para assinantes da diar.ia.br
    </h2>
    <p style="font-size:16px;line-height:1.6;margin:0 0 20px;color:${INK};opacity:.85;">
      Cadastro grátis — o mesmo que já recebe a diária todo dia útil.
    </p>
    ${renderSignupForm("teaser", path)}
    <p style="font-size:14px;line-height:1.6;margin:12px 0 0;color:${INK};opacity:.75;">
      Já assina? <a href="?entrar=1" style="color:${INK};text-decoration-color:${TEAL};">Entre com seu e-mail</a>.
    </p>
  </div>
</div>
${signupScript("teaser", path)}`;
  return `${teaserHtml.slice(0, ultima.index)}${bloco}\n${teaserHtml.slice(ultima.index)}`;
}

/** 404 dedicado — o leitor JÁ provou ser assinante, mas o slug não tem edição publicada. */
export function renderSlugNotFound(slug: string, canonical: string): string {
  const body = `
    <h1>Edição não encontrada</h1>
    <p>Não há uma retrospectiva anual publicada para <strong>${escHtml(slug)}</strong>.</p>
  `;
  return shell("diar.ia.br — edição não encontrada", "Retrospectiva anual não encontrada.", canonical, body);
}

/** 400 — nenhum slug informado no path (`GET /`). */
export function renderMissingSlug(canonical: string): string {
  const body = `
    <h1>Edição não informada</h1>
    <p>Use o link completo da retrospectiva (ex: <code>/2026-aniversario</code>).</p>
  `;
  return shell("diar.ia.br — slug obrigatório", "Retrospectiva anual — slug da edição obrigatório na URL.", canonical, body);
}

/** 429 — rate limit do gate por IP excedido. */
export function renderRateLimited(canonical: string): string {
  const body = `
    <h1>Muitas tentativas</h1>
    <p>Espere um pouco e tente de novo.</p>
  `;
  return shell("diar.ia.br — muitas tentativas", "Rate limit do gate de cadastro excedido.", canonical, body);
}
