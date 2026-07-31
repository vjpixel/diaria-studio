# Worker `cursos`: alarme de erro + sync do KV de assinantes

Issue: [#4320](https://github.com/vjpixel/diaria-studio/issues/4320) (extraída da [#4305](https://github.com/vjpixel/diaria-studio/issues/4305), PR [#4306](https://github.com/vjpixel/diaria-studio/pull/4306)).

O worker `cursos` (hosting da página "Cursos sobre IA", `cursos.diar.ia.br`) loga todo caminho de degradação e tem `[observability] enabled = true` no `wrangler.toml` — o Cloudflare coleta os logs, mas **coletar não é avisar**. Este documento cobre as duas peças que fecham esse gap:

1. **Alarme de erro** (`scripts/cursos-error-alarm.ts`) — consulta os logs do worker e manda e-mail quando algo quebra.
2. **Sync do KV de assinantes** (`scripts/sync-cursos-subscribers-kv.ts`) — mantém `CURSOS_SUBSCRIBERS` atualizado (fonte primária de verificação do gate).

---

## 1. Alarme de erro do worker

### O que ele checa

A cada execução, consulta a Cloudflare GraphQL Analytics API pelos logs do worker `cursos` desde o último cursor salvo (`data/cursos-error-alarm-state.json`) e avalia duas condições:

| Condição | Gatilho | O que significa |
|---|---|---|
| **Fatal** | Qualquer ocorrência de `"COOKIE_HMAC_SECRET ausente"` ou `"cadastro na Beehiiv falhou"` | Secret rotacionado/ausente (ninguém desbloqueia) ou o cadastro inline na Beehiiv está quebrado (ninguém vira assinante pelo formulário do worker). |
| **Taxa** | `?email= não confirmado como assinante ativo` cruza o limiar (default: 90%, `DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT` em `scripts/lib/cursos-error-alarm.ts`) | Taxa baixa é normal (parte de quem clica não é assinante ativo — link velho, ex-assinante). Taxa perto de 100% é sinal de merge tag quebrada na newsletter ou o gate `?email=` morto de novo. Só avalia quando a amostra na janela é ≥ 5 tentativas (`DEFAULT_NOT_CONFIRMED_MIN_SAMPLE`) — abaixo disso não mede nada (mesma lição do poll "É IA?", ver memória `eia-poll-volume-insuficiente-para-medir`). |

Se qualquer uma disparar, chega **1 e-mail** ao editor (nunca 2 e-mails separados na mesma janela) com o resumo, a amostra dos matches fatais e a ação sugerida.

### Idempotência

Diferente do alarme de guardrail Clarice (idempotiza por ID de campanha), este idempotiza por **cursor de tempo**: cada execução só consulta `[lastCheckedUntil, now)`. Janelas nunca se sobrepõem, então nunca reavalia (nem realarma) o mesmo intervalo 2×. O cursor só avança se a run terminar com sucesso — uma falha de fetch OU de envio de e-mail deixa o cursor parado, e a mesma janela (agora maior) é reprocessada na próxima execução.

### Como o editor confere o alarme

- **Passivo**: o alarme chega por e-mail (Gmail, mesma conta configurada em `platform.config.json` → `inbox.editor_personal_email`) só quando algo dispara. Sem e-mail = sem alarme na janela — não é preciso checar nada proativamente.
- **Ativo** (debug/auditoria): rodar manualmente com `--dry-run` pra ver o que a próxima execução avaliaria, sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/cursos-error-alarm.ts --dry-run
  ```
- **Log da task agendada**: `data/cursos-subscribers/.error-alarm.log` (append-only, uma seção por execução).
- **Logs ao vivo do worker** (quando o e-mail chegar e for investigar): `cd workers/cursos && npx wrangler tail`, ou o dashboard Cloudflare → Workers & Pages → `cursos` → Logs.

### O que fazer quando o alarme dispara

| Alarme | Ação |
|---|---|
| `"COOKIE_HMAC_SECRET ausente"` | `cd workers/cursos && npx wrangler secret put COOKIE_HMAC_SECRET` (gerar novo: `openssl rand -hex 32`) e reimplantar (`npx wrangler deploy`). Todo mundo que clicou no link da newsletter enquanto o secret estava ausente viu o teaser mesmo sendo assinante ativo — não há como recuperar esses cliques, só evitar que se repita. |
| `"cadastro na Beehiiv falhou"` | Checar `BEEHIIV_API_KEY`/`BEEHIIV_PUBLICATION_ID` do worker (`npx wrangler secret list` não mostra o valor, só a presença — rotacionar se suspeitar de key inválida) e o status da Beehiiv API (`https://status.beehiiv.com`, se existir, ou tentar uma chamada manual). Formulário de cadastro inline do worker ficou fora do ar durante a janela — nenhum assinante novo entrou por ali; considerar avisar quem tentou, se identificável. |
| Taxa de `não confirmado` acima do limiar | 1) Checar se o KV `CURSOS_SUBSCRIBERS` está atualizado — rodar `npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run` e comparar a contagem com a base ativa esperada (Beehiiv). 2) Checar se a merge tag `{{email}}` no template da newsletter está resolvendo (não virou `{{ email }}` cru ou vazio) — abrir um teste de envio recente e conferir o link `cursos.diar.ia.br/?email=...`. 3) Se ambos ok, checar `verificação Beehiiv falhou` no `wrangler tail` — a Beehiiv pode estar fora do ar (esse log fica DE FORA da taxa de propósito, ver comentário `#4321` em `workers/cursos/src/index.ts` — não confundir os dois sinais). |

### Ajustar o limiar da taxa

`--rate-threshold-pct N` no CLI, ou editar `DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT` em `scripts/lib/cursos-error-alarm.ts` (decisão operacional, não medida — ajustar se o alarme ficar barulhento ou surdo demais).

### Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer Windows + Task Scheduler + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (escopo "Account Analytics Read"/leitura de Workers Logs — pode ser um token diferente de `CLOUDFLARE_WORKERS_TOKEN`, que só precisa de escrita KV) + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito do alarme de guardrail Clarice, `npx tsx scripts/oauth-setup.ts` se ainda não tiver esse scope) + o junction `data/` (OneDrive).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-cursos-error-alarm-schedule.ps1
```

Isso registra a task `Diaria-Cursos-Error-Alarm` (a cada 2h). Idempotente — re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.

**Importante — schema da query não verificado ao vivo (ver docstring de `scripts/cursos-error-alarm.ts`):** esta sessão (dispatch `/diaria-overnight`, worktree isolado) não tem acesso a credenciais Cloudflare reais nem pode fazer chamada de rede ao vivo. A query GraphQL (`CURSOS_LOGS_QUERY`) foi desenhada com base na documentação pública da Analytics API, mas o shape exato de `logs{}` por grupo de invocação não foi confirmado contra uma resposta real. **Antes de confiar neste alarme em produção**, rodar uma vez com credenciais reais:

```powershell
npx tsx scripts/cursos-error-alarm.ts --dry-run
```

e conferir se a linha `eventCount` no output bate com o volume esperado (não fica em 0 sempre, mesmo com tráfego real no worker). Se a query não casar o schema real da API, só `CURSOS_LOGS_QUERY`/`parseGraphqlLogsResponse` (em `scripts/cursos-error-alarm.ts`) precisam de ajuste — a lógica de alarme (`scripts/lib/cursos-error-alarm.ts`, testada em `test/cursos-error-alarm.test.ts`) não muda.

---

## 2. Sync do KV de assinantes

`scripts/sync-cursos-subscribers-kv.ts` (#4052) pagina `GET /subscriptions?status=active` na Beehiiv e escreve `subscriber:{sha256(email)}` → `"1"` no KV `CURSOS_SUBSCRIBERS` — fonte **primária** de verificação do gate `?email=`. Rodou manualmente 1× (PR #4052) e nunca foi agendado; o `by_email` da Beehiiv funciona como fallback ao vivo (confirmado na #4305), então isto não é urgente, mas o caminho primário ficava permanentemente desatualizado sem o agendamento.

### Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer `BEEHIIV_API_KEY` (+ opcional `BEEHIIV_PUBLICATION_ID`, fallback `platform.config.json`) + `CLOUDFLARE_ACCOUNT_ID` + `CURSOS_KV_NAMESPACE_ID` (id do namespace `CURSOS_SUBSCRIBERS`, do `wrangler.toml`) no `.env` local + o junction `data/`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-cursos-kv-sync-schedule.ps1
```

Isso registra a task `Diaria-Cursos-Kv-Sync` (diária, 09:15 — 45min depois da `Diaria-Clarice-Sync`, pra não concorrer no mesmo horário). Idempotente. Remover: mesmo comando com `-Unregister`.

### Verificar que a 1ª execução deixou a contagem coerente

```powershell
npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run
```

Imprime `{ subscribers: N, kv_entries: M, dry_run: true }` — `N` deve bater (ordem de grandeza) com a contagem de assinantes ativos no dashboard Beehiiv, bem acima dos 535 que motivaram a issue original. Rodar sem `--dry-run` pra escrever de fato no KV.

### Log

`data/cursos-subscribers/.kv-sync.log` (append-only, uma seção por execução).

---

## Follow-up explícito deste PR

Nem o registro das duas tasks no Task Scheduler nem a 1ª execução ao vivo do KV sync foram feitos nesta sessão — o dispatch rodou num worktree isolado, sem acesso ao Task Scheduler real da máquina do editor nem a credenciais Cloudflare/Beehiiv ao vivo (escopo intencional, ver corpo do PR). **Ação pendente do editor pós-merge:** rodar os dois comandos `setup-*-schedule.ps1` acima (registro das tasks) e, antes de confiar no alarme, o `--dry-run` de validação do schema da query descrito na seção 1.
