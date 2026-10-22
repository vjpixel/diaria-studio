# Análise das reescritas de lead (#10791)

Decisão do editor no briefing do overnight 261022b: comparar o texto gerado com o final e ajustar `writer-destaque`/`writer`/`context/templates/newsletter.md` se houver padrão. Conclusão: **não há padrão novo que justifique mudar os prompts.** O alarme recorrente sai do classificador (#10883). Desde o #8694 (15/10), o writer só leva cortes de uma frase.

## Método

- **Edições:** 35 (260901 a 261022, todas as que têm `_internal/02-draft.md`).
- **Comparação:** corpo de cada destaque (sem a linha `DESTAQUE N` nem as linhas de título) entre `_internal/02-draft.md` (saída do writer) e `02-reviewed.md` final, com o snapshot `editor-request-snapshots/stage2-post-gate/02-reviewed.md` como ponto intermediário.
- **Casamento:** pela URL do título, então reordenação não conta como reescrita.
- **Métrica:** similaridade de palavras, `2·LCS / (|a|+|b|)` sobre tokens minúsculos sem pontuação.
- **Intro, erro intencional e "É IA?":** comparadas separadamente, nas 4 edições citadas na issue.

`data/` é gitignored, então os trechos abaixo são curtos e só servem para conferência.

## Números

| Grupo | Destaques |
|---|---|
| Destaques finais nas 35 edições | 105 |
| URL ausente no rascunho do writer (troca de destaque ou de link no gate) | 49 |
| Casados por URL | 56 |
| similaridade ≥ 0,95 (ajuste de palavra) | 43 |
| 0,90 a 0,95 | 2 |
| < 0,90 (reescrita substantiva) | 11 |

Depois do #8694 (edições 261019 a 261022) foram 9 destaques casados, com similaridade mínima de 0,96. Em cada caso a única mudança foi cortar uma frase de detalhe secundário, como em 261020 D2 ("Placas de vídeo sofrem o mesmo aperto...") e 261021 D3 ("...e 44% deles estão em instituições públicas").

## As 4 edições da issue

| Edição / seção | O que mudou de fato |
|---|---|
| 261014 destaque-1 | Os 3 destaques ficaram idênticos ao writer (similaridade 1,00). Mudou a caixa de evento abaixo do D1, que o parser conta como parte da seção. |
| 261015 erro-intencional | O editor preencheu `{PREENCHER_NARRATIVA_DO_ERRO}`, que é o fluxo esperado. A regra de tamanho (>1,3×) disparou. |
| 261016 e-ia | O bloco "É IA?" é idêntico no pós-gate 2 e no final. A diferença está no limite da seção. |
| 261021 intro | O TÍTULO/SUBTÍTULO derivam do D1/D2, que foram reordenados, e entrou a caixa "Agora também em vídeo". O corpo da intro é o template, com a contagem de itens. |

A única reescrita real de lead nessas 4 edições é a do **261016 D3** ("ChatGPT fez mal a crianças...", similaridade 0,33). O classificador registrou como `section-order`, não como `lead-rewrite`.

## As 11 reescritas substantivas, por tipo

| Tipo | Casos | Já coberto no prompt? |
|---|---|---|
| Lead com moldura ou enchimento ("entrou na corrida... aposta estreita"; frase de "o volume chama atenção pela escala") | 261005 D1, 260909 D1 | Sim, #8694 (cita 261005 nominalmente) |
| "Por que isso importa" genérico, como "vale acompanhar" ou conselho corporativo, trocado por fato concreto (preço e data; requisitos de acesso) | 260922 D2, 260929 D3, 261006 D2 | Sim, #9382 |
| Corpo acima da janela (5 parágrafos e 185 palavras, virou 2 parágrafos e 102 palavras) | 261008 D3 | Sim, janela 900-1000 chars (#3993/#6061/#9539) |
| Fato acrescentado pelo editor que não estava no `summary` (nome do pesquisador, system prompt, bloqueio da Amazon; comparação com o Jev; detalhes do WSJ) | 261007 D1, 261005 D1, 260921 D3 | Não é falha de prompt: o writer não tem WebFetch (#4000) |
| Bloco "Aprofunde:"/"Saiba mais" removido, com o texto do editor intacto | 260903 D1, 260925 D2 | Não é reescrita do editor |
| Reenquadramento para o leitor brasileiro ou pais ("O ChatGPT que crianças usam no Brasil é o mesmo que..."; "Para quem deixa os filhos usar...") | 261016 D3 | Caso único, e contradiz regras vigentes (#1755 e "Não começar com 'Para [audiência],'"). Virar regra pede decisão do editor, não um único diff. |

## Decisão

- **Prompts e template sem alteração.** Os padrões recorrentes já estão em `writer-destaque.md` (#8694, #9382, #9423). A janela posterior ao #8694 mostra o efeito: nenhuma reescrita substantiva em 9 destaques.
- O `writer.md` não precisa acompanhar, porque nada mudou no `writer-destaque.md`.
- O que alimenta o alarme é o classificador `scripts/derive-editor-requests.ts`, que conta caixas, placeholder, intro derivada e reordenação e perde a reescrita real. Esse trabalho foi separado na **#10883**.
- **Reavaliar** se, depois do #10883, o `lead-rewrite` voltar a disparar com eventos que resistam à conferência acima.
