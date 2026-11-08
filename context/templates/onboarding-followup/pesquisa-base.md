<!--
e-mail único da pesquisa para a base já cadastrada (#10605)
assunto: "Fiz uma pesquisa nova e queria sua resposta"
preview_text: "Mesmo que você tenha respondido a anterior. Sete perguntas, uns dois minutos."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.

RASCUNHO (/diaria-develop 261108, decisão 11 do editor de 08/11/2026: a
sessão rascunha, o editor aprova o texto e a hora). Fonte versionada:
`onboarding-followup-run.ts --init-snippets` copia este arquivo para
data/snippets/pesquisa-base.md (nunca sobrescreve um texto já editado).
`onboarding-form-base-prep.ts --step draft` recusa montar o rascunho no Kit
enquanto a linha do marcador acima existir no arquivo de data/snippets/.
O e-mail sai UMA vez, como rascunho no Kit, e quem agenda é o editor.
Público (regra B): assinantes ativos, menos quem já recebeu o D+6 ou vai
recebê-lo em até 7 dias, e quem já respondeu o formulário novo. Quem
respondeu a pesquisa ANTIGA recebe: as respostas dela foram descartadas
(decisão 10). O corpo precisa conter {{FORM_URL}}; "sete" acompanha
FORM_QUESTIONS (teste trava).
-->
<p>Pixel aqui. Um tempo atrás mandei uma pesquisa para conhecer melhor quem lê a diar.ia.br. Agora fiz outra, e é ela que vai orientar a escolha das notícias daqui para a frente.</p>
<p>Se você respondeu a anterior, peço que responda de novo: as respostas daquela não entram mais na conta. Se não respondeu, esta é a hora. Com a sua resposta, as edições ficam mais perto do que você quer ler.</p>
<p>São sete perguntas sobre o seu trabalho e sobre as seções da newsletter, quase todas de marcar. Leva uns dois minutos. No fim pergunto também se algum curso ou aula faria sentido para você.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder a pesquisa</a></p>
<p>Seu e-mail já vem preenchido.</p>
<p>Obrigado,<br>Pixel</p>
