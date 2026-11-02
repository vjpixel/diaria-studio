# Pesquisa ad-hoc de candidatos: datas e claims só da fonte primária (#11797)

Vale para toda pesquisa de candidatos a item pedida fora do Stage 1, como
"pesquisa profunda das newsletters recebidas desde DD/MM", "procura mais
lançamentos da semana" ou "vê se saiu algo depois da pesquisa". Quem despacha o
subagente cita este arquivo no prompt, e o subagente o lê antes de começar.

## Caso que motivou (edição 261103)

O subagente disse que o Gemini 4 Carbon era de 30/10 e trouxe comparações com
Opus e GPT que a página do Google não sustentava. Na fonte primária: 28/10, 59
pontos no índice da Artificial Analysis, 88,2% no SEC-bench Pro. O item
Cathedral x Anthropic era de 26 a 28/10, fora da janela que começava em 30/10.
Só a releitura manual das fontes primárias pegou os dois erros.

## Regras para o subagente

1. **A data vem da página da fonte primária**, nunca do resumo da newsletter
   nem da data em que a newsletter chegou. Quando der, rode
   `npx tsx scripts/verify-dates.ts <entrada.json>`, que lê a data dos
   metadados da página (JSON-LD, `og:article:published_time` e afins). Se não
   conseguir ler a data na primária, declare `date_source: "newsletter"` ou
   `"unknown"`. Não invente nem arredonde.
2. **Cada claim de número, comparação, ranking ou superlativo** ("supera o
   Opus", "59 pontos", "o primeiro a") traz a fonte de onde foi lido. Claim que
   só aparece na newsletter ou no seu resumo leva `source: "newsletter"` e é
   apresentado como "não verificado". Não reformule um claim para que ele pareça
   mais forte do que a primária diz.
3. **Candidato com data anterior ao início da janela não é sugerido.** Ele vai
   para a lista de fora da janela, com a data primária ao lado.
4. **Entregue os candidatos em JSON** neste formato, além do texto que o
   coordenador pediu:

```json
[
  {
    "url": "https://blog.google/...",
    "title": "Gemini 4 Carbon",
    "date": "2026-10-28",
    "date_source": "primary",
    "claims": [
      { "text": "59 pts no índice da Artificial Analysis", "source": "primary", "source_url": "https://..." },
      { "text": "supera o Opus em código", "source": "newsletter" }
    ]
  }
]
```

## Regra para o coordenador

Antes de sugerir qualquer candidato ao editor, rode:

```
npx tsx scripts/check-adhoc-research-candidates.ts --candidates <json> --window-start YYYY-MM-DD
```

- `ok`: o candidato pode ser sugerido.
- `nao_verificado`: só entra na sugestão com a marca "não verificado" e o
  motivo que o relatório traz, ou depois que você mesmo relê a primária e
  corrige a data ou o claim.
- `fora_da_janela`: não é sugerido. No máximo, aparece numa linha à parte com a
  data real.
- Exit 0 quer dizer que todos os candidatos saíram `ok`. Exit 3 quer dizer que
  há itens marcados, o que é informação a repassar ao editor e não falha. Exit 1
  é erro de uso ou de leitura.

O gate não acredita no rótulo `primary` que o subagente põe. Ele só garante
que nenhum item sem data ou claim declarado como lido da primária passe como
verificado (mesma disciplina do #573). O fact-checker do Stage 4 continua sendo
a segunda rede depois que o item entra na edição.
