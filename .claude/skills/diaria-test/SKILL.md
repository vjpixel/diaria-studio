---
name: diaria-test
description: Roda a pipeline completa da Diar.ia sem gates humanos para benchmark de performance — auto-aprova tudo, pula Drive sync. Por default pula Etapa 4 (publicação); `--with-publish` ativa também Etapa 4 com social agendado 10 dias à frente. Uso — `/diaria-test [AAMMDD] [--with-publish]`.
---

# /diaria-test

Roda a pipeline completa da Diar.ia **sem gates humanos** para benchmark de performance.
Todo conteúdo social é agendado 10 dias à frente para que o editor possa deletar antes da publicação real.

## Argumentos

- `<date>` (opcional) = data da edição no formato `AAMMDD` (ex: `260423`). Default: hoje.
- `--with-publish` (opcional) = **opt-in pra rodar Etapa 4** (publicação) também no teste. Default: **off** (Etapa 4 pulada). Quando ativo:
  - Newsletter cria rascunho no Beehiiv + envia email de teste (igual produção).
  - Facebook agenda 10 dias à frente via Graph API.
  - LinkedIn cria rascunho ou agenda 10 dias à frente via Chrome.
  - **Pré-requisito: Chrome com extensão Claude in Chrome ativa e logado em LinkedIn/Beehiiv.** Se o probe do Chrome MCP falhar, a Etapa 4 ainda pula com warn loud (em vez do silent skip do default).
  - Editor é responsável por **deletar manualmente** os rascunhos/scheduled gerados antes da data de publicação.
- `--full-research` (opcional) = **opt-in** pra dispatchar `source-researcher` (WebSearch nas fontes sem RSS) e `discovery-searcher` (queries temáticas abertas). Default: **off** (RSS-only — só fontes RSS rodam, researchers/discovery pulados). Razão (#1055): yield de researchers em runs de teste foi 12× pior por fonte e ~80% do token budget de Stage 1f. Pra benchmark de pipeline (RSS + dedup + render), default RSS-only é mais útil. `--full-research` cobre o caminho LLM completo quando explicitamente desejado.

## O que muda em relação a `/diaria-edicao`

| Aspecto | `/diaria-edicao` | `/diaria-test` (default) | `/diaria-test --with-publish` |
|---------|------------------|--------------------------|-------------------------------|
| Gates humanos | Pausa em cada stage | **Auto-approve** | **Auto-approve** |
| Source researchers (WebSearch) | Rodam ~11 fontes | **Pulados** (RSS-only, `--full-research` re-ativa) | **Pulados** (RSS-only, `--full-research` re-ativa) |
| Discovery searchers (queries abertas) | ~10 queries paralelas | **Puladas** (RSS-only) | **Puladas** (RSS-only) |
| Social schedule | `day_offset` do config (0) | n/a (Stage 4 pula) | **`day_offset = 10`** |
| Newsletter | Rascunho + email de teste | n/a (Stage 4 pula) | Rascunho + email de teste |
| Lint intentional-error | Bloqueia se ausente | n/a | **Downgrade pra warn** (#1057) |
| LinkedIn (Chrome) | Rascunho + agenda | **Pulado** (`pending_manual`) | Rascunho + agenda 10 dias à frente |
| Facebook (Graph API) | Agenda | **Pulado** | Agenda 10 dias à frente |
| Drive sync | Push + pull normal | **Desabilitado** | **Desabilitado** |
| Janela de publicação | Pergunta ao usuário | **Default automático** | **Default automático** |
| Timing | Inferido de file mtimes | **`stage-timing.ts` roda no final** | **`stage-timing.ts` roda no final** |

## Processo

### 1. Setup

1. **Parsear argumentos.** Aceitos: `<date>` (positional, AAMMDD), `--with-publish` (flag), `--full-research` (flag). Todos opcionais, em qualquer ordem. Setar `with_publish = true` se `--with-publish` aparece; setar `rss_only = false` se `--full-research` aparece (default `rss_only = true`).
2. Se `<date>` não foi passado, usar hoje (como AAMMDD):
   ```bash
   node -e "process.stdout.write(new Date().toISOString().slice(2,10).replace(/-/g,''))"
   ```
3. Converter `<date>` (AAMMDD) para ISO e calcular `window_days` default (sem perguntar ao usuário):
   ```bash
   node -e "const s='<date>';const d=new Date('20'+s.slice(0,2)+'-'+s.slice(2,4)+'-'+s.slice(4,6));const day=d.getUTCDay();process.stdout.write(String(day===1||day===2?4:3))"
   ```
4. Verificar pré-requisitos silenciosamente:
   - `context/sources.md` existe e >200 bytes
   - `context/editorial-rules.md` existe e >200 bytes
   - Se algum faltar, abortar com erro (não perguntar — é um teste).

### 2. Executar o playbook diretamente no top-level (#207)

**Você (top-level Claude Code) lê `.claude/agents/orchestrator.md` e executa o playbook stage-a-stage diretamente.** **Não delegue a um subagente `orchestrator` via `Agent`** — o runtime bloqueia recursão de Agent dentro de subagentes (issue #207). O top-level tem `Agent` disponível e pode dispatchar todos os subagentes que cada stage prescreve (`source-researcher`, `writer`, `social-*`, `publish-*`, etc).

Variáveis pra alimentar o playbook:
- `edition_date = <date>` (AAMMDD)
- `edition_iso = 20${date.slice(0,2)}-${date.slice(2,4)}-${date.slice(4,6)}`
- `window_days = {valor calculado}`
- `test_mode = true` → auto-aprovar todos os gates, **desabilitar Drive sync** (pular blocos de push/pull), copiar `_internal/01-categorized.json` → `_internal/01-approved.json` direto sem edição humana
- `with_publish = true` se a flag `--with-publish` foi passada; senão `false` → controla se a Etapa 4 (publicação) roda. Quando `false` (default), o orchestrator força `CHROME_MCP = false` em Stage 0c, fazendo Etapa 4 pular com `status: "skipped"`. Quando `true`, o probe do Chrome roda normalmente — Etapa 4 dispatcha publish-newsletter/publish-facebook/publish-linkedin com `schedule_day_offset = 10`.
- `schedule_day_offset = 10` → social posts agendados 10 dias à frente (só relevante quando `with_publish = true`).
- `rss_only = true` por default; `false` se `--full-research` foi passado (#1055). Quando `true`, Stage 1f pula source-researchers (WebSearch nas fontes sem RSS) e discovery-searchers (queries temáticas). RSS batch + eia-composer rodam normalmente. Token savings: ~200K em edição típica (medido em #1055).
- `skip_intentional_error_lint = true` em test_mode (#1057). publish-newsletter agent vai downgrade exit 1 do lint pre-flight `intentional-error-flagged` pra warn em vez de abort. Justificativa: erro intencional só humano declara em produção; em test_mode bloqueio impede testar Stage 4 newsletter end-to-end. Editor sempre vai deletar rascunho de teste antes de publicar.

**Não relayar gates ao usuário.** Em `test_mode`, auto-aprovar tudo conforme Princípio 2 do playbook.

### 3. Ao completar

1. Rodar `stage-timing.ts` no diretório da edição:
   ```bash
   npx tsx scripts/stage-timing.ts --edition {AAMMDD}
   ```
2. Mostrar ao usuário:
   - Tabela de timing por stage
   - Total wall clock
   - **Se `with_publish = true`:** lembrete reforçado (URLs derivadas de `platform.config.json` → `publishing.social.linkedin.scheduled_posts_url` etc; substitua na renderização):
     ```
     ⚠️  Conteúdo de teste foi publicado nas plataformas. Delete antes da data agendada:
       • Beehiiv: rascunho criado — deletar em https://app.beehiiv.com/posts (URL específica em 05-published.json → draft_url)
       • Facebook: 3 posts agendados para {date+10} — Meta Business Suite > Planejado
       • LinkedIn: 3 rascunhos/agendados — {publishing.social.linkedin.scheduled_posts_url do config}
     ```
   - **Se `with_publish = false`:** "Etapa 4 pulada (default). Use `--with-publish` pra cobrir publicação."
   - Link para o rascunho no Beehiiv (de `05-published.json`) — só se `with_publish = true` e Beehiiv rodou.

### 4. Stage final — Coleta de erros e auto-reporter (#519)

**Roda independente de sucesso/falha dos stages anteriores** — captura tudo o que merece virar issue. O `/diaria-test` existe pra surfar regressões; este stage fecha o loop.

1. Coletar sinais com a flag `--include-test-warnings` (capta também error/warn genéricos do run-log da edição):

   ```bash
   npx tsx scripts/collect-edition-signals.ts \
     --edition-dir data/editions/{AAMMDD}/ \
     --include-test-warnings
   ```

2. Ler `data/editions/{AAMMDD}/_internal/issues-draft.json`:
   - **Se `signals_count === 0`:** logar info ("nada a reportar — edição de teste limpa") e finalizar.
   - **Se `signals_count > 0`:** dispatchar `auto-reporter` com `test_mode: true`:

     ```
     Agent({
       subagent_type: "auto-reporter",
       description: "Auto-criar issues do test run {AAMMDD}",
       prompt: "Coletar issues-draft.json em data/editions/{AAMMDD}/_internal/. test_mode=true (auto-aprovar criação sem gate humano). repo=vjpixel/diaria-studio. edition_dir=data/editions/{AAMMDD}/."
     })
     ```

3. Em `test_mode`, o `auto-reporter` pula o gate humano, dedup contra issues abertas, cria/comenta issues e tagga as criadas com `from-diaria-test` (ver `.claude/agents/auto-reporter.md`).

4. No resumo final ao usuário, incluir bloco:

   ```
   📋 Auto-reporter (test_mode):
      {issues_created} issues novas: #NN, #NN
      {issues_commented} issues comentadas: #NN
   ```

   (omitir se zero.)

## Output

Mesmo de `/diaria-edicao`: todos os arquivos em `data/editions/{AAMMDD}/`. Adicional: issues GitHub abertas com label `from-diaria-test` quando o run captou regressões.
