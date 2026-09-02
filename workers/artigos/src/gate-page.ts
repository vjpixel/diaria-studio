/**
 * workers/artigos/src/gate-page.ts (#7030)
 *
 * HTML da tela `GET /gate` — campo de e-mail que confirma apoio via
 * `POST /gate/verify`. Mesmo padrão visual/estrutural de
 * `workers/cursos/src/gate-page.ts` (#4052), SEM o caminho de cadastro
 * inline (esta issue não pede "vira apoiador aqui" — quem não apoia vai
 * pro apoia.se, ver `artigo-especial-gate-cta.ts`).
 */
/** `redirectPath` já resolvido pelo caller (`index.ts`, via
 * `gated-articles.ts`) — este módulo não assume nenhum ano fixo, pra não
 * quebrar silenciosamente quando um artigo de ano diferente de 2026 for
 * adicionado. `"/"` (home) é o fallback seguro pra slug desconhecido. */
export function renderGatePage(redirectPath: string): string {
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirmar apoio · diar.ia.br</title>
<meta name="robots" content="noindex">
<style>
  :root { --teal: #00A0A0; --ink: #171411; --paper: #FBFAF6; --rule: #EBE5D0; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 64px 24px; }
  h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 12px; }
  p { font-size: 14px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; }
  input[type="email"] { width: 100%; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
  button { width: 100%; padding: 12px; background: var(--teal); color: #FFFFFF; border: 0; border-radius: 6px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { font-size: 13px; margin-top: 14px; min-height: 18px; }
  .msg.error { color: #b00020; }
  .msg.ok { color: var(--teal); }
  a { color: var(--teal); }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Já apoia a diar.ia.br?</h1>
    <p>Confirme o e-mail que você usa pra apoiar (apoia.se) pra desbloquear o Artigo Especial completo.</p>
    <form id="gate-form">
      <label for="email">E-mail</label>
      <input type="email" id="email" name="email" required autocomplete="email">
      <button type="submit">Desbloquear</button>
    </form>
    <div id="msg" class="msg"></div>
    <p style="margin-top:24px;">Ainda não apoia? <a href="https://apoia.se/diaria">apoia.se/diaria</a> — a partir de R$10/mês.</p>
  </div>
  <script>
    const form = document.getElementById('gate-form');
    const msg = document.getElementById('msg');
    const btn = form.querySelector('button');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Verificando…';
      try {
        const res = await fetch('/gate/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('email').value }),
        });
        const data = await res.json();
        if (data.ok) {
          msg.className = 'msg ok';
          msg.textContent = 'Confirmado! Redirecionando…';
          window.location.href = ${JSON.stringify(redirectPath)};
        } else {
          msg.className = 'msg error';
          msg.textContent = data.error === 'rate_limited'
            ? 'Muitas tentativas — tente de novo mais tarde.'
            : 'Não encontramos apoio com esse nível pra este e-mail.';
          btn.disabled = false;
        }
      } catch {
        msg.className = 'msg error';
        msg.textContent = 'Erro de rede — tente de novo.';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
