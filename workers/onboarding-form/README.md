# onboarding-form (#10605)

No ar em https://formulario.diar.ia.br (22/10/2026: KV, secrets, rota, `form_sig` no Kit,
`ONBOARDING_FORM_TOKEN`/`ONBOARDING_FORM_LINK_SECRET` no Doppler). Perguntas e
textos v3 aprovados pelo editor em 09/11/2026; o envio segue travado só até os
textos serem destravados em `data/snippets` (tirar o marcador
`ONBOARDING-CORPO-PENDENTE`), depois do merge.

Formulário de perfil/interesses do onboarding (decisão do editor, 20/10/2026:
form próprio num Worker nosso). O executor `scripts/onboarding-followup-run.ts`
lê as respostas daqui (`GET /api/respostas`) e marca "preencheu" no store
(`data/onboarding/store.json` → `followup.people[id].form_filled_at`), o que
para os lembretes. `scripts/audience-run.ts` lê o mesmo endpoint e gera o
perfil de audiência (`context/audience-profile.md`) SÓ com estas respostas
(decisão 10 do editor, 08/11/2026: a survey da Beehiiv foi descartada).

Contrato e perguntas (v3, aprovada pelo editor em 09/11/2026):
`scripts/lib/onboarding-form-contract.ts` (`FORM_QUESTIONS`): 12 perguntas
numeradas e 3 subperguntas sem número, todas de rádio ou caixa (nunca menu
suspenso). Condicionais (`hiddenWhen`/`shownWhen`), opção exclusiva e o limite
de "até 3" rodam no cliente (`FORM_SCRIPT` em `src/render.ts`) e são
validados de novo no servidor, que descarta o que vier de pergunta que não
aparece. HTML: `src/render.ts` (mobile primeiro, sem dependência de runtime
de Worker).

Histórico e versão (#12490): cada envio é uma chave própria no KV
(`resp:{e-mail}:{submitted_at}:{nonce}`), com `form_version: "v3"`, e nunca
sobrescreve o anterior. `GET /api/respostas` devolve todos os envios
(inclusive os antigos `resp:{e-mail}`); o perfil e os lembretes usam o mais
recente por e-mail (`latestFormResponses`). Tempo de preenchimento: a página
leva a hora em que foi gerada, assinada (campo oculto `t`,
`signFormRenderedAt`), e o envio grava `duration_s`; mediana e p75 saem em
`onboarding-followup-run.ts --status`.

## Quem recebe o link

Três e-mails, textos em `context/templates/onboarding-followup/` (copiados
para `data/snippets/` por `onboarding-followup-run.ts --init-snippets`, todos
travados pelo marcador `ONBOARDING-CORPO-PENDENTE` até o editor aprovar):

1. `onboarding-formulario.md`: D+6 da escada (executor diário).
2. `pesquisa-base.md`: e-mail ÚNICO para a base já cadastrada. Runbook:
   `scripts/onboarding-form-base-prep.ts --step sigs --apply` repetido até
   `restantes: 0` (exit 1 se alguma gravação falhar); `--step draft --apply`
   (confere pelo GET singular quem a listagem mostra sem assinatura e recusa
   se faltar alguém); o editor agenda no Kit (o script nunca agenda); depois
   do envio, `--step confirm --apply` (ou o executor diário) grava o
   `form_base` por pessoa. Broadcast perdido (apagado/abortado):
   `--step reset --apply`. Saiu com audiência não confirmada (alarme toda
   rodada): `--step reset --apply --force --mark-sent-unverified`, que fecha
   o convite sem gravar `form_base` por pessoa (sem lembrete para ele). Público: ativos, menos quem recebeu o D+6 ou vai
   recebê-lo em até 7 dias (padrão de `base_invite_window_days`), e quem já
   respondeu; enquanto o e-mail não sai, eles não recebem o D+6. Rodar
   `audience-run.ts` só depois de haver respostas.
3. `formulario-lembrete-{1,2,3}.md`: para quem recebeu o 1 OU o 2 e não
   respondeu, até 3 vezes por pessoa, um texto por lembrete. Quem recebeu o
   D+6 recebe em D+19, D+49 e D+79 da confirmação do cadastro; quem recebeu o
   e-mail da base, 30 dias depois do envio anterior. Depois do primeiro mês,
   nenhum pedido sai a 10 dias ou menos de outro (`ask_min_gap_days: 11`). O
   store guarda qual convite a pessoa recebeu (`followup.people[id].form_invite`;
   registro antigo sem o campo: ler por `formInviteOf`, que deriva de `sends`).

## Reenvio anual, histórico e versão (#12490)

Decisão do editor (09/11/2026): a cada 12 meses, quem já respondeu recebe o
formulário de novo. O Worker grava cada resposta duas vezes: `resp:{e-mail}`
(a mais recente, que o executor e o perfil de audiência leem, como antes) e
`hist:{e-mail}:{submitted_at}` (uma por envio, nunca sobrescrita). A resposta
de quem respondeu antes do histórico existir é copiada para `hist:` na 1ª
resposta nova. `GET /api/respostas?historico=1` lista o histórico. Cada
resposta leva `form_version` (`FORM_VERSION` do contrato, presa às perguntas
por teste: mudou pergunta, sobe a versão); ausente = v2.

No executor, `form_filled_at` passa a ser a resposta mais recente (a 1ª fica
em `form_first_filled_at`). Etapas `form_anual` (365 dias depois da última
resposta, `form_annual_days`) e `form_anual_lembrete` (até
`form_annual_reminder_max`, padrão 1, 30 dias depois). Textos
`formulario-anual.md` e `formulario-anual-lembrete.md`, com
`{{RESPONDEU_EM}}` ("{mês} de {ano}"): o lote sai um mês de resposta por
vez. O formulário abre vazio.

## Resultados para quem responde depois (#12495)

Os resultados saem como edição especial para quem respondeu, com uma versão
web restrita (decisão do editor, 09/11/2026). Depois do envio dela, o editor
preenche `RESULTS_URL` e `RESULTS_PUBLISHED_AT` no `[vars]` do
`wrangler.toml` e os mesmos valores em `onboarding.followup.results_url` e
`results_published_at` (teste trava os dois iguais). A partir daí a página
de obrigado mostra o link, e o executor manda `formulario-resultados.md`
(`{{RESULTADOS_URL}}`) uma vez a quem respondeu pela 1ª vez depois do envio.
Com os campos vazios nada muda.

## Publicação (feito em 22/10/2026)

KV `ONBOARDING_FORM`, secrets `RESPONSES_TOKEN` e `ONBOARDING_FORM_LINK_SECRET`,
rota pública, `onboarding.followup.form_url`/`form_responses_url` no config,
`ONBOARDING_FORM_TOKEN`/`ONBOARDING_FORM_LINK_SECRET` no `.env` do executor e
o custom field `form_sig` no Kit. Textos e perguntas aprovados (09/11/2026);
falta só destravar os textos em `data/snippets`.

O envio dos e-mails do formulário fica travado enquanto isso
(`formContentGate` → `form_nao_configurado` / `texto_pendente` /
`assinatura_nao_configurada`; `campo_assinatura_ausente` se o Kit não guardar
o `form_sig`; `link_rejeitado_pelo_worker` se a sonda de ponta a ponta do
executor não receber 200). O e-mail da base tem o gate próprio
(`baseInviteContentGate`), com as mesmas condições.

## Link assinado (#10657)

O link do e-mail é `{form_url}?email={{ subscriber.email_address }}&sig={{ subscriber.form_sig }}`,
com `sig = base64url(HMAC-SHA256(ONBOARDING_FORM_LINK_SECRET, "onboarding-form:v1:" + e-mail normalizado))`
(`scripts/lib/onboarding-form-link-sig.ts`). O Worker:

- `GET /` sem assinatura válida: página "Link inválido" (403), sem formulário;
- `POST /enviar`: e-mail e assinatura vêm de campos ocultos; assinatura que
  não bate com o e-mail enviado responde 403 e não grava nada no KV.

Assim ninguém marca outra pessoa como "preencheu" nem sobrescreve as
respostas dela.

O e-mail vai cru na query (sem filtro Liquid: `{{ subscriber.email_address }}`
é a única merge tag confirmada ao vivo no Kit). O `+` que a query decodifica
como espaço é restaurado (`prefillEmailFromQuery`). Resíduo aceito: um `&` ou
`#` no local part corta o e-mail e a pessoa vê "Link inválido".

Toda recusa vai pro log do Worker como
`{"event":"link_invalido","route":"/"|"/enviar","reason":"email_vazio"|"sig_vazia"|"sig_divergente"}`
(nunca e-mail nem assinatura); secret ou KV faltando sai como `console.error`
`not_configured`.

Antes de cada `--send` com lote do formulário, o executor faz uma sonda:
assina `sonda+link@diar.ia.br` e dá `GET` no link. Qualquer coisa diferente
de 200 trava o formulário (`link_rejeitado_pelo_worker`, com alarme).
