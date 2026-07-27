/**
 * workers/cursos/src/gate-page.ts (#4052)
 *
 * HTML da tela de gate (`GET /gate`) — campo de e-mail que primeiro tenta
 * `POST /gate/verify` (assinante já ativo → desbloqueia sem novo cadastro);
 * se não achar, o MESMO form vira cadastro inline (`POST /gate/subscribe`,
 * honeypot + opt-in), reusando o padrão do #3580 (ver subscribe.ts). Estilo
 * inline mínimo — espelha a paleta do DS canônico (teal/ink/paper/rule) já
 * usada em `scripts/lib/shared/curadoria-page.ts`, sem puxar o módulo inteiro
 * (esta é uma única página curta, não vale o import cruzado scripts/→worker
 * só por CSS).
 */
export function renderGatePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Desbloquear cursos completos · Diar.ia</title>
<meta name="robots" content="noindex">
<style>
  :root { --teal: #00A0A0; --ink: #171411; --paper: #FBFAF6; --rule: #EBE5D0; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; background: var(--paper); color: var(--ink); line-height: 1.55; }
  .wrap { max-width: 480px; margin: 0 auto; padding: 64px 24px; }
  h1 { font-family: Georgia, serif; font-size: 26px; margin: 0 0 12px; }
  p { font-size: 14px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; }
  input[type="email"], input[type="text"] { width: 100%; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
  .optin { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; font-weight: 400; margin-bottom: 16px; }
  .optin input { width: auto; margin: 3px 0 0; }
  button { width: 100%; padding: 12px; background: var(--teal); color: #FFFFFF; border: 0; border-radius: 6px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { font-size: 13px; margin-top: 14px; min-height: 18px; }
  .msg.error { color: #b00020; }
  .msg.ok { color: var(--teal); }
  .website { position: absolute; left: -9999px; }
  a { color: var(--teal); }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Já é assinante da Diar.ia?</h1>
    <p>Confirme seu e-mail pra desbloquear os cursos completos. Ainda não assina? O mesmo formulário te cadastra na newsletter.</p>
    <form id="gate-form">
      <label for="email">E-mail</label>
      <input type="email" id="email" name="email" required autocomplete="email">
      <label for="name" id="name-label" style="display:none">Nome (opcional)</label>
      <input type="text" id="name" name="name" style="display:none" autocomplete="name">
      <input type="text" name="website" class="website" tabindex="-1" autocomplete="off">
      <div class="optin" id="optin-row" style="display:none">
        <input type="checkbox" id="optin" name="optin">
        <label for="optin" style="font-weight:400">Quero receber a Diar.ia (5 minutos diários sobre IA) por e-mail.</label>
      </div>
      <button type="submit" id="submit-btn">Desbloquear</button>
      <p class="msg" id="msg" role="status"></p>
    </form>
  </div>
<script>
(function () {
  var form = document.getElementById('gate-form');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submit-btn');
  var nameField = document.getElementById('name');
  var nameLabel = document.getElementById('name-label');
  var optinRow = document.getElementById('optin-row');
  var optinInput = document.getElementById('optin');
  var mode = 'verify';

  function setMsg(text, cls) {
    msg.textContent = text;
    msg.className = 'msg' + (cls ? ' ' + cls : '');
  }

  function showSubscribeFields() {
    mode = 'subscribe';
    nameField.style.display = '';
    nameLabel.style.display = '';
    optinRow.style.display = 'flex';
    btn.textContent = 'Assinar e desbloquear';
    setMsg('Não encontramos assinatura ativa com esse e-mail. Confirme abaixo pra assinar a Diar.ia e desbloquear.', '');
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    btn.disabled = true;
    var email = document.getElementById('email').value.trim();
    var name = nameField.value.trim();
    var website = form.website.value;

    if (mode === 'verify') {
      fetch('/gate/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, website: website }),
      }).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
        .then(function (r) {
          btn.disabled = false;
          if (r.data && r.data.ok) {
            setMsg('Verificado! Redirecionando…', 'ok');
            window.location.href = '/';
            return;
          }
          if (r.status === 429) { setMsg('Muitas tentativas. Tente novamente em alguns minutos.', 'error'); return; }
          showSubscribeFields();
        })
        .catch(function () { btn.disabled = false; setMsg('Erro de rede. Tente novamente.', 'error'); });
      return;
    }

    if (!optinInput.checked) { btn.disabled = false; setMsg('Marque a caixinha de opt-in para continuar.', 'error'); return; }
    fetch('/gate/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, name: name, optin: optinInput.checked, website: website }),
    }).then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (r.data && r.data.ok) { setMsg('Assinatura confirmada! Redirecionando…', 'ok'); window.location.href = '/'; return; }
        if (r.status === 429) { setMsg('Muitas tentativas. Tente novamente em alguns minutos.', 'error'); return; }
        if (r.data && r.data.error === 'subscribe_unavailable') { setMsg('Cadastro indisponível no momento — assine em diar.ia.br.', 'error'); return; }
        setMsg('Não foi possível concluir. Tente novamente.', 'error');
      })
      .catch(function () { btn.disabled = false; setMsg('Erro de rede. Tente novamente.', 'error'); });
  });
})();
</script>
</body>
</html>
`;
}
