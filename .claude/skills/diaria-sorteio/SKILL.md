---
name: diaria-sorteio
description: Processa respostas de leitores ao sorteio mensal "ache o erro, ganhe um número". Drena threads do Gmail desde o último processamento, apresenta cada uma pro editor decidir, e ao aprovar atribui número sequencial + cria rascunho automático de resposta. Sub-comandos — list (default, drena pendentes) e draw (sorteia no início do mês seguinte). Aceita argumento opcional YYYY-MM (default é o mês seguinte ao corrente, mês quando o sorteio acontece).
---

# /diaria-sorteio (processamento manual do sorteio)

Drena respostas pendentes do Gmail e processa novos participantes do sorteio mensal. Storage em `data/contest-entries.jsonl` (já tem entries em 260504-260505 do bootstrap manual).

**Modo automático integrado (#929):** o passo `0p` do orchestrator Stage 0 já dreina e processa pendentes em **modo batch** antes de Stage 1 quando `/diaria-edicao` ou `/diaria-1-pesquisa` rodam. Esta skill standalone permanece útil pra:
- Processar fora do horário de edição (interactive, thread-por-thread).
- Fazer o sorteio do mês (`draw`).
- Re-processar uma thread skipada anteriormente sem rodar pipeline.

Se Stage 0 já processou todas as pendentes, esta skill exit 0 silenciosa (sumário com 0 aprovações).

**Quando NÃO usar:**
- Não chame durante uma edição em curso (`/diaria-edicao`) — Stage 0 já cuida disso; rodar simultaneamente confunde contexto.
- Não chame se o `mcp__claude_ai_Gmail` estiver offline (verificar com `/mcp`).

## Argumentos

- **Sem argumentos** ou apenas `--month YYYY-MM`: modo `list` — drena pendentes e apresenta gate por gate.
- **`draw [--month YYYY-MM]`**: sorteia o ganhador do mês (random uniforme entre confirmados).
- **`--month YYYY-MM`** (default): mês do sorteio (mês quando o sorteio acontece). Default = mês seguinte ao corrente — sorteios sempre rodam no início do mês posterior às edições.

## Modo list (default) — processar pendentes

### Passo 1: descobrir thread mais recente já processada

Ler `data/contest-entries.jsonl` e pegar o `confirmed_at` mais recente. Se vazio, usar 30 dias atrás como cutoff.

```bash
npx tsx scripts/sorteio-process.ts list 2>/dev/null | head -50
```

### Passo 2: drenar Gmail

Buscar threads em `diariaeditor@gmail.com` que:
- Tenham label da newsletter Diar.ia (verificar — pode ser `Diar.ia` ou similar).
- Foram recebidas APÓS o cutoff do passo 1.
- Ainda NÃO foram processadas (verificar via `--thread-id` na lib `contest-entries`).

Use `mcp__claude_ai_Gmail__search_threads` com query como `label:Diar.ia after:YYYY/MM/DD`. Mantenha-se conservador — limit 20 threads por chamada.

### Passo 3: para cada thread nova, apresentar ao editor

Para cada thread retornada:
1. `mcp__claude_ai_Gmail__get_thread` pra pegar conteúdo.
2. Verificar se `thread_id` já está em `contest-entries.jsonl` (chamando `sorteio-process.ts list` e grep, ou loadEntries via tsx -e).
3. Se já processada, pular silenciosamente.
4. Se nova, formatar pro editor:

```
🎯 Nova resposta de sorteio (thread {N}/{total}):

  De:       {sender_name} <{sender_email}>
  Subject:  {subject}
  Recebida: {date_brt}
  Edição:   {detected_edition_AAMMDD}

  Erro reportado:
  > {first_paragraph_of_body}

  Tipo provável: {error_type_guess}
  
  [a]provar  [r]ejeitar  [s]kip (decidir depois)  [q]uit
```

Inferir `error_type` examinando o conteúdo:
- "v4" / "v5" / "v6" / "versão" / "version" → `version_inconsistency`
- erros de fato (datas, nomes, lugares) → `factual`
- erros matemáticos → `math`
- typos → `typo`
- informação datada → `outdated`
- caso ambíguo → perguntar ao editor.

### Passo 4: ao aprovar (a)

```bash
npx tsx scripts/sorteio-process.ts add \
  --month {YYYY-MM} \
  --email {sender_email} \
  --name {sender_name} \
  --edition {AAMMDD} \
  --error-type {factual|version_inconsistency|...} \
  --detail "{descrição curta}" \
  --thread-id {gmail_thread_id}
```

O CLI:
- Atribui o próximo número sequencial pro `--month`.
- Append em `data/contest-entries.jsonl`.
- Imprime no stdout `{ entry, reply_text }` com texto pronto pra resposta.

Capture `reply_text` do output e crie um draft no Gmail:

```
mcp__claude_ai_Gmail__create_draft({
  thread_id: "{gmail_thread_id}",
  body: reply_text,
  subject: "Re: {subject_original}",
})
```

Reportar ao editor:
```
✅ Entry #{number} adicionada para {name}. Draft criado no Gmail thread {thread_id} — revisar e enviar manualmente.
```

### Passo 5: ao rejeitar (r)

Sem ação. Próxima thread. (Idealmente, marcar com label "rejected-sorteio" via Gmail MCP pra pular em runs futuros — mas é opcional.)

### Passo 6: ao skipar (s)

Sem ação. A thread permanece pendente — próxima invocação da skill apresenta de novo.

### Passo 7: ao terminar (q ou todas processadas)

Sumário:
```
Sorteio {YYYY-MM} processado:
  Total threads consideradas: N
  Aprovadas: X (números atribuídos: a, b, c)
  Rejeitadas: Y
  Skipadas: Z (vão aparecer de novo na próxima rodada)
  Drafts criados: X
```

## Modo draw — sortear ganhador

```bash
npx tsx scripts/sorteio-process.ts draw --month YYYY-MM
```

(Adicionar `--seed N` se quiser reprodutibilidade — opcional.)

Output JSON em stdout:
```json
{ "winner": { entry completo }, "candidates_count": N, "draw_month": "YYYY-MM" }
```

Reportar ao editor:
```
🎉 Sorteio de {mês} de {ano}!

Vencedor sorteado entre {N} participantes:
  #{number}  {name}  <{email}>
  Edição:    {AAMMDD}
  Erro:      {detail}

Sugestão de próximo passo: criar draft de email pro vencedor com:
  Subject: "Você ganhou o sorteio Diar.ia de {mês}!"
  Body:    "Olá, {primeiro_nome}! Seu número {N} foi sorteado..."
```

Não criar o draft automaticamente — vencedor é alto valor, editor decide o tom.

## Falhas comuns

- **Gmail MCP offline**: render halt banner via `npx tsx scripts/render-halt-banner.ts --stage "sorteio" --reason "mcp__gmail desconectado" --action "reconecte e responda 'retry'"`.
- **Thread já processada**: CLI retorna exit 3 — pular silenciosamente, não é erro real.
- **Editor rejeita por engano**: lembrar que entries são append-only — se aprovar uma rejeitada antes, basta re-rodar a skill (a thread aparece de novo).

## Notas

- Idempotente: rodar a skill 2× seguidas sem novas threads = sumário com 0 aprovações.
- Schema de `data/contest-entries.jsonl` é fixo (ver `scripts/lib/contest-entries.ts`).
- Default `--month` é o mês seguinte ao corrente (mês quando o sorteio acontece). Editor pode passar mês passado pra processar respostas atrasadas.
