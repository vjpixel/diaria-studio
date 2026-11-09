<!--
lembrete 3 de 3 do formulário (#10605)
assunto: "Último lembrete sobre o formulário"
preview_text: "Depois desse, prometo que paro."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.
(O marcador fica aqui DE PROPÓSITO: o texto já está aprovado, mas o envio só
destrava quando a linha sai da cópia em data/snippets, depois do merge.)

TEXTO v3, aprovado pelo editor em 09/11/2026 (e-mail 5, lembrete 3).
O executor escolhe o texto pelo número do lembrete da pessoa (1º, 2º ou 3º,
FORM_REMINDER_STEPS em scripts/lib/onboarding-followup.ts). Quem recebeu o
convite do onboarding recebe nos dias de `form_reminder_days_onboarding`
contados da confirmação do cadastro (hoje D+19/49/79); quem recebeu o e-mail
da base, `form_reminder_days` depois do envio anterior (hoje 30).
Por isso o texto não cita qual convite a pessoa recebeu. O destravamento é em
data/snippets, depois do merge (`--init-snippets` copia este arquivo para
data/snippets/formulario-lembrete-3.md, sem sobrescrever texto editado).
-->
<p>Olá! Tudo bem?</p>
<p>Esse é o último lembrete sobre o formulário. Se ainda quiser responder, o link está aqui embaixo.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder o formulário</a></p>
<p>Depois desse, não te mando mais lembrete. Obrigado por ler a diar.ia.br.</p>
<p>Pixel</p>
