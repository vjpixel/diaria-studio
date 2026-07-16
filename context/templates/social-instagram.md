# Template — Caption Instagram (diar.ia.br)

## Regras

- Abrir com **hook direto**: dado concreto ou fato surpreendente — sem pergunta retórica.
- Tom mais coloquial que o Facebook: frases curtas, ritmo de feed, zero jargão corporativo.
- 2–3 parágrafos curtos (Instagram trunca a caption após ~3 linhas antes do "mais" — o hook precisa segurar sozinho).
- **Call-to-action final SEM menção a e-mail/newsletter por e-mail** (#2486 — `no-email-cta-instagram`). O Instagram não linka URL clicável no corpo do post; o CTA nativo é "link na bio" + follow:
  `"Edição completa no link da bio. Segue @diar.ia pra não perder a próxima."`
- Até 5 hashtags (Instagram tolera mais que Facebook, mas evitar spam — nada de bloco de 20 hashtags).
- 600–900 caracteres no corpo editorial (sem contar hashtags) — mais curto que o Facebook, pensado pra leitura rápida no feed.

## Estrutura

```
[Hook — 1 frase com dado ou fato concreto]

[Parágrafo 1 — desenvolve o fato em linguagem coloquial]

[Parágrafo 2 — "por que isso muda alguma coisa" para o leitor comum]

Edição completa no link da bio. Segue @diar.ia pra não perder a próxima.

#Hashtag1 #Hashtag2 #Hashtag3
```

## Diferença em relação ao Facebook

- **Nunca mencionar e-mail, assinatura por e-mail ou "receba por e-mail"** — proibido por `no-email-cta-instagram` (#2486). O CTA é sempre "link na bio" (tráfego) + "segue @diar.ia" (retenção no canal).
- Corpo mais curto e mais coloquial — Instagram é feed rápido, não newsletter.
- Sem URL crua no corpo (Instagram não renderiza links clicáveis fora da bio).

## Não fazer

- Não usar `"assine grátis"`, `"receba por e-mail"`, `"cadastre-se"` ou qualquer variante de CTA de assinatura por e-mail — vaza pro Facebook fallback quando ausente, mas aqui a seção é própria e a lint valida direto.
- Não usar linguagem corporativa.
- Não usar mais de 5 hashtags.
- Não repetir o hook no parágrafo seguinte.
