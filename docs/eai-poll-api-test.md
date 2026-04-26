# Teste — Beehiiv Trivia Poll API exposure (#107)

## Hipótese

Beehiiv tem 2 tipos de poll: **Voting** (que usamos) e **Trivia** (que não usamos). Trivia é desenhado pra "guess the right answer" — leitor escolhe, dashboard mostra "X% acertou". Hipótese: a API `aggregate-stats` expõe stats Trivia (correct_count / total) mesmo sem expor responses individuais. Se sim, **#107 fecha sem trocar de plataforma e sem nova infra**.

## Como testar (1 edição)

### Antes da publicação

Edição 260427 (ou primeira pós-PR) usa Trivia em vez de Voting na seção É IA?. Roteiro em `context/publishers/beehiiv.md` § "É IA?" passo 4.

### Após a publicação (~24h depois pra ter respostas)

1. **Capturar `post_id`** do Beehiiv da edição publicada (visível em `data/editions/{AAMMDD}/05-published.json` campo `post_id` ou na URL `/posts/{id}/edit`).

2. **Hit aggregate stats**:
   ```bash
   curl -H "Authorization: Bearer $BEEHIIV_API_KEY" \
     "https://api.beehiiv.com/v2/publications/{publication_id}/posts/{post_id}/aggregate-stats" \
     | jq .
   ```

3. **Inspecionar response shape**. Procurar por:
   - Campo `polls` ou `trivia` no JSON
   - Per-poll: `total_responses`, `correct_responses`, `breakdown` (votos por opção)

### Critérios de sucesso

| Achado | Conclusão | Ação |
|---|---|---|
| Response inclui Trivia stats com correct/total | ✅ Hipótese confirmada | Implementar `fetch-eai-poll-stats.ts` que consome esse endpoint. Wire no Stage 1 do orchestrator. Fechar #107. |
| Response não inclui Trivia stats | ❌ Hipótese rejeitada | Voltar à decisão entre alternativas (#5 dropar linha, #2 click tracking, custom landing page) |
| Trivia stats parciais (sem `correct_responses` derivável) | 🟡 Calcular manualmente: `correct = breakdown[ai_side]`, total = soma. Usable se `breakdown` por opção existir. |

### Onde guardar o resultado

Append em `docs/eai-poll-api-test.md` seção "Resultados do teste" com:
- Data do teste
- Edição testada
- Output do `curl` (sanitizado)
- Conclusão

## Resultados do teste

_(preencher após a primeira edição com Trivia poll — pendente)_
