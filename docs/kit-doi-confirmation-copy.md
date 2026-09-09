# Copy do e-mail de confirmação (double opt-in) — CANÔNICA

> **Fonte: o e-mail real que a Beehiiv enviava.** Recuperado em 09/09/2026 do
> Gmail do editor (remetente `diaria` em `mail.beehiiv.com`, thread `1a03e8a2c2bf1bb9`,
> enviado 26/08/2026), porque o texto não existia em lugar nenhum do repo e a
> conta Beehiiv está com 0 assinantes ativos desde o #7386 — se ela fosse
> encerrada antes, a copy se perderia.
>
> Decisão do editor (09/09/2026, #7723): **portar esta copy para o Kit**, em
> vez de usar a proposta anterior. Ela já passou pelo design system (#5518) e
> é o que os assinantes reais receberam até 04/09.
>
> A proposta anterior desta issue (#6812) está preservada em
> `kit-doi-confirmation-copy-proposta-6812.md` — vale como referência de tom,
> não como fonte.

## Estado: JÁ COLADA (09/09/2026)

A copy abaixo está **no ar** no designer form **`9897918` — "Cadastro DOI
(confirmacao)"**, criado no painel do Kit em 09/09/2026 a partir do template
"Clare". `platform.config.json` (`kit.doiFormId`) e
`workers/poll/wrangler.toml` (`KIT_DOI_FORM_ID`) já apontam para ele.

Verificado ao vivo, não por inspeção do painel: um subscriber criado
`inactive` + vinculado ao form recebeu o e-mail em 09/09/2026 04:31:45Z, e o
HTML entregue traz o assunto e os três parágrafos abaixo, o botão único com
`background-color:#00A0A0` (nas duas variantes, MSO e não-MSO) e o link
`app.kit.com/forms/confirm?key=…`. Remetente: `oi` em `news.diar.ia.br`.

A seção seguinte descreve onde a configuração vive, para quem precisar
reeditar ou recriar o form.

## Onde colar

⚠️ **Não é o form `9839463` ("Newsletter site")**, apesar do que a #6812 e a
nota de `kit.doiFormId` dizem. Aquele é form de **sistema** (`format: null`
em `GET /v4/forms`): não aparece em `Landing pages & forms`, as URLs de
edição dão 404, e ele **não tem o toggle**.

O toggle vive em **designer form** (`format` preenchido):

```
Kit → Landing pages & forms → {designer form} → Settings → Confirmation email
  ☑ Send confirmation email
  [ Edit Email Contents ]        ← a copy abaixo vai aqui
  After confirming redirect to:  ← ver "Redirect" abaixo
```

**Não desligar o toggle ao sair** — o double opt-in do cadastro novo depende
dele ligado.

## Assunto

```
🚀 Falta 1 clique para sua dose diária de IA
```

**Preview text:**

```
Sem essa confirmação, nenhuma edição chega até você.
```

## Corpo

```
Falta um passo pra sua assinatura da diar.ia.br começar: confirmar que este
e-mail é seu.

[Confirmar meu e-mail]

Depois de confirmar, sua primeira edição chega numa manhã de segunda a sexta,
com 5 minutos das notícias essenciais sobre IA e os tutoriais que importam.
```

> **Decisão do editor (09/09/2026):** o parágrafo final da versão Beehiiv —
> *"Se não foi você que se cadastrou, é só ignorar este e-mail. Sem o clique
> acima, nada é enviado."* — foi **removido**. Não recolocar ao reeditar o
> form.

O botão é o **único** elemento de ação — sem link concorrente. Densidade
promocional above the fold é o gatilho de classificador identificado no
CTA-01 (`docs/experiments/cta-ab-mensal-2606-07.md`), e importa mais aqui:
`news.diar.ia.br` saiu há pouco da rampa de aquecimento da recusa de 72% do
Gmail (#6504).

## O que muda ao portar para o Kit

| | Beehiiv | Kit |
|---|---|---|
| Remetente | `diaria` em `mail.beehiiv.com` | `oi` em `news.diar.ia.br` (o sender já verificado da conta) |
| Link do botão | `diaria.beehiiv.com/opt_in?opt_in_token=…` | token do Kit, inserido pelo editor de conteúdo do form |
| Redirect pós-confirmação | `https://eia.diar.ia.br/confirmado` (`opt_in_redirect_url`, medido nas settings da Beehiiv em 09/09/2026) | default é `https://app.kit.com/confirm-subscription` — **reapontar para `https://diar.ia.br/confirmado`** |

A página `/confirmado` foi criada no #5167 e continua no ar — desde o #7737
(decisão do editor) ela é servida no APEX (`diar.ia.br/confirmado`, Worker
`site`), não mais em `eia.diar.ia.br` (que agora só faz 301 pra lá — link
antigo continua funcionando). **Pendente:** o campo "After confirming
redirect to" do form 9897918 no painel do Kit ainda aponta pra
`eia.diar.ia.br/confirmado` — atualizar manualmente para
`https://diar.ia.br/confirmado` (ação de painel, fora do escopo de código
do #7737).

## Marca no corpo

O plaintext da Beehiiv trazia `**diar**.**ia****.br**` — artefato da
conversão HTML→texto do negrito parcial, não texto literal. Ao colar no Kit,
escrever `diar.ia.br` normalmente. A grafia da marca é sempre minúscula e
nunca "Diar.ia".
