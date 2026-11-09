<!--
convite anual do formulário, para quem respondeu há 12 meses ou mais (#12490)
assunto: "Muita coisa mudou desde a sua resposta?"
preview_text: "Faz um ano que você respondeu o formulário. Topa responder de novo?"
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.

RASCUNHO (overnight, #12490, decisão do editor de 09/11/2026: a cada 12
meses, quem já respondeu recebe o formulário de novo, com um e-mail dizendo
que a pessoa já respondeu, mas muita coisa pode ter mudado). Fonte
versionada: `onboarding-followup-run.ts --init-snippets` copia este arquivo
para data/snippets/formulario-anual.md (nunca sobrescreve um texto já
editado). O envio segue travado enquanto a linha do marcador acima existir.
O corpo precisa conter {{FORM_URL}} (o mesmo link assinado do formulário).
{{RESPONDEU_EM}} vira "{mês} de {ano}" da última resposta de quem está no
lote (o lote sai um mês de resposta por vez). O preview_text NÃO troca
placeholders: se o editor quiser o mês no preview, reescrever sem ele.
O formulário abre vazio (decisão do escopo da issue: não pré-preencher).
-->
<p>Pixel aqui. Em {{RESPONDEU_EM}} você respondeu o formulário sobre o seu trabalho e sobre como usa a diar.ia.br. Obrigado de novo.</p>
<p>De lá para cá muita coisa pode ter mudado: as ferramentas, o jeito como você usa IA, o que você gostaria de aprender. Por isso estou mandando o formulário de novo.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder de novo</a></p>
<p>O formulário abre em branco e leva uns dois minutos. Com as respostas deste ano eu consigo ver o que mudou e ajustar as edições.</p>
<p>Pixel</p>
