# onboarding-form (#10605)

No ar em https://formulario.diar.ia.br (22/10/2026: KV, secrets, rota, `form_sig` no Kit,
`ONBOARDING_FORM_TOKEN`/`ONBOARDING_FORM_LINK_SECRET` no Doppler). O envio segue
travado só pela aprovação dos textos e das perguntas pelo editor.

Formulário de perfil/interesses do onboarding (decisão do editor, 20/10/2026:
form próprio num Worker nosso). O executor `scripts/onboarding-followup-run.ts`
lê as respostas daqui (`GET /api/respostas`) e marca "preencheu" no store
(`data/onboarding/store.json` → `followup.people[id].form_filled_at`), o que
para os lembretes. `scripts/audience-run.ts` lê o mesmo endpoint e gera o
perfil de audiência (`context/audience-profile.md`) SÓ com estas respostas
(decisão 10 do editor, 08/11/2026: a survey da Beehiiv foi descartada).

Contrato e perguntas (v2, decisões do editor de 08/11/2026):
`scripts/lib/onboarding-form-contract.ts` (`FORM_QUESTIONS`). Tema e preço
(`hiddenWhen`) somem quando a pessoa marca "Nada disso" no que faria além da
newsletter: o HTML esconde e desabilita os campos (`HIDE_SCRIPT` em
`src/render.ts`) e o servidor descarta o que vier deles. HTML: `src/render.ts`
(mobile primeiro, sem dependência de runtime de Worker).

## Quem recebe o link

Três e-mails, textos em `context/templates/onboarding-followup/` (copiados
para `data/snippets/` por `onboarding-followup-run.ts --init-snippets`, todos
travados pelo marcador `ONBOARDING-CORPO-PENDENTE` até o editor aprovar):

1. `onboarding-formulario.md`: D+6 da escada (executor diário).
2. `pesquisa-base.md`: e-mail ÚNICO para a base já cadastrada. Rascunho no
   Kit montado por `scripts/onboarding-form-base-prep.ts --step draft
   --apply`, depois de `--step sigs --apply` gravar o `form_sig` do público.
   Nunca agendado pelo script: o editor agenda no Kit. Público: ativos, menos
   quem recebeu o D+6 ou vai recebê-lo em até 7 dias, e quem já respondeu.
3. `formulario-lembrete.md`: para quem recebeu o 1 OU o 2 e não respondeu, 30
   dias depois do último e-mail do formulário, até 3 vezes por pessoa. O
   store guarda qual convite a pessoa recebeu (`followup.people[id].form_invite`).

## Publicação (feito em 22/10/2026)

KV `ONBOARDING_FORM`, secrets `RESPONSES_TOKEN` e `ONBOARDING_FORM_LINK_SECRET`,
rota pública, `onboarding.followup.form_url`/`form_responses_url` no config,
`ONBOARDING_FORM_TOKEN`/`ONBOARDING_FORM_LINK_SECRET` no `.env` do executor e
o custom field `form_sig` no Kit. Falta só a aprovação dos textos e das
perguntas pelo editor.

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
