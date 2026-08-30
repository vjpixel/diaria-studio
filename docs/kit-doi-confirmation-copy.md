# Copy do e-mail de confirmação (double opt-in) do Kit — pronta pra colar

> **Status: aguardando aprovação do editor.** Refs #6812. Nada disto foi
> colado no Kit — é só o texto proposto.
>
> Calibrado pelo mesmo tom de `docs/kit-welcome-sequence-draft.md` (E-mail 1,
> D0), contra 14 edições reais e `context/editorial-rules.md` §5. Evita o
> padrão identificado em `docs/experiments/cta-ab-mensal-2606-07.md`
> (CTA-01): CTA imperativo + "grátis" + seta no mesmo bloco, above the fold,
> é sinal textual de classificador promocional — aqui o botão é o único
> elemento de ação, sem link concorrente e sem essa densidade.

## Onde colar

Dashboard do Kit → form "Newsletter site" (`KIT_DOI_FORM_ID` = 9839463) →
Settings → Incentive. **Não desligar o toggle "Send confirmation email" ao
sair** — é o mesmo painel, e o double opt-in do cadastro novo depende dele
ligado (contexto #6810).

## Assunto (3 opções)

1. Pixel aqui — falta 1 clique pra você começar a receber a diária
2. Confirme e a diar.ia.br chega no seu próximo dia útil
3. Você quase assinou. Falta confirmar.

**Preview text:** Um clique confirma que foi você — a diária de segunda a sexta começa depois disso.

## Corpo

```
Oi! Aqui é o Pixel, editor da diar.ia.br.

Você pediu pra assinar — todos os dias úteis, de segunda a sexta, um resumo
de ~5 minutos com as notícias mais relevantes sobre inteligência artificial,
com curadoria minha, não de robô.

Falta só confirmar que foi você mesmo quem pediu. É por isso que existe este
passo: sem ele, qualquer pessoa poderia inscrever seu e-mail sem você saber.

[Confirmar assinatura]

Depois de confirmar, a próxima edição já chega no seu próximo dia útil.

Até já,
Pixel
```

**Texto do botão:** Confirmar assinatura

## Por que este texto

- Nomeia o remetente (Pixel) e o formato (diária, seg-sex, ~5min) antes de
  pedir o clique — mesmo padrão do E-mail 1 da sequence de boas-vindas.
- 1 CTA só, texto de botão sem "grátis"/seta/imperativo em bold — evita o
  sinal de densidade promocional do CTA-01.
- Explica o motivo da confirmação em 1 linha ("sem ele, qualquer pessoa
  poderia inscrever seu e-mail sem você saber") — reduz "não pedi isto" e
  report de spam, que é o que machuca `news.diar.ia.br` em aquecimento
  (#6504).
- Assunto nomeia o remetente ou o próximo passo concreto, evita o padrão
  genérico "Confirme sua inscrição" que a issue pediu pra evitar.
