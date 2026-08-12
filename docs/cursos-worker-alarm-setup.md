# Worker `cursos`: alarme de erro + sync do KV de assinantes

Issue: [#4320](https://github.com/vjpixel/diaria-studio/issues/4320) (extraída da [#4305](https://github.com/vjpixel/diaria-studio/issues/4305), PR [#4306](https://github.com/vjpixel/diaria-studio/pull/4306)).

O worker `cursos` (hosting da página "Cursos sobre IA", `cursos.diar.ia.br`) loga todo caminho de degradação e tem `[observability] enabled = true` no `wrangler.toml` — o Cloudflare coleta os logs, mas **coletar não é avisar**. Este documento cobre as duas peças que fecham esse gap:

1. **Alarme de erro** (`scripts/cursos-error-alarm.ts`) — consulta os logs do worker e manda e-mail quando algo quebra.
2. **Sync do KV de assinantes** (`scripts/sync-cursos-subscribers-kv.ts`) — mantém `CURSOS_SUBSCRIBERS` atualizado (fonte primária de verificação do gate).

---

## 1. Alarme de erro do worker

### O que ele checa

**#4382 (redesign):** a versão original consultava a Cloudflare GraphQL Analytics API (dataset `workersInvocationsAdaptiveGroups`) fazendo grep de texto nos logs — CONFIRMADO AO VIVO (credenciais Cloudflare reais) que esse dataset não existe no schema exposto (`unknown field`, não um erro de permissão). A API pública GraphQL Analytics parece expor só métricas agregadas, não conteúdo de log individual. O worker `cursos` agora incrementa 4 contadores cumulativos DIRETO no KV `CURSOS_SUBSCRIBERS` (mesmo namespace do sync de assinantes) nos mesmos pontos onde já loga via `console.error`/`console.warn`/`console.log` — ver `scripts/lib/shared/cursos-alarm-counters.ts` pras chaves. Este script só LÊ os 4 contadores (via `getTextFromWorkerKV`, fetch-based) e calcula o DELTA desde a última checagem (snapshot salvo em `data/cursos-error-alarm-state.json`), avaliando duas condições:

| Condição | Gatilho | O que significa |
|---|---|---|
| **Fatal** | Qualquer ocorrência de `"COOKIE_HMAC_SECRET ausente"` ou `"cadastro na Beehiiv falhou"` | Secret rotacionado/ausente (ninguém desbloqueia) ou o cadastro inline na Beehiiv está quebrado (ninguém vira assinante pelo formulário do worker). |
| **Taxa** | `?email= não confirmado como assinante ativo` cruza o limiar (default: 90%, `DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT` em `scripts/lib/cursos-error-alarm.ts`) | Taxa baixa é normal (parte de quem clica não é assinante ativo — link velho, ex-assinante). Taxa perto de 100% é sinal de merge tag quebrada na newsletter ou o gate `?email=` morto de novo. Só avalia quando a amostra na janela é ≥ 5 tentativas (`DEFAULT_NOT_CONFIRMED_MIN_SAMPLE`) — abaixo disso não mede nada (mesma lição do poll "É IA?", ver memória `eia-poll-volume-insuficiente-para-medir`). |

Se qualquer uma disparar, chega **1 e-mail** ao editor (nunca 2 e-mails separados na mesma janela) com o resumo, a amostra dos matches fatais e a ação sugerida.

### Idempotência

Diferente do alarme de guardrail Clarice (idempotiza por ID de campanha), este idempotiza por **snapshot de contadores** (#4382 — antes era cursor de tempo): cada execução guarda o valor cumulativo dos 4 contadores da última checagem bem-sucedida (`lastCounters` em `data/cursos-error-alarm-state.json`) e calcula o delta contra a leitura atual. Nunca reavalia (nem realarma) o mesmo incremento 2×. O snapshot só avança se a run terminar com sucesso — uma falha de leitura do KV OU de envio de e-mail deixa o cursor parado, e o próximo delta (agora maior) cobre o intervalo perdido. Na 1ª execução (sem baseline), o delta é sempre zero — nunca alarma retroativamente sobre um histórico cumulativo de idade desconhecida, só estabelece o baseline.

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

Requer Linux/systemd + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` (escopo de leitura/escrita de Workers KV — o MESMO token já usado por outros scripts que leem/escrevem KV Cloudflare via `scripts/lib/cloudflare-kv-upload.ts`, ex: `clarice-engagement-cohorts.ts`; **não** mais `CLOUDFLARE_API_TOKEN`/"Account Analytics Read" — #4382 removeu a dependência da Analytics API) + `CURSOS_KV_NAMESPACE_ID` (id do namespace `CURSOS_SUBSCRIBERS`, o MESMO já usado por `scripts/sync-cursos-subscribers-kv.ts` — ver `workers/cursos/wrangler.toml` `[[kv_namespaces]] id`) + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito do alarme de guardrail Clarice, `npx tsx scripts/oauth-setup.ts` se ainda não tiver esse scope) + o junction `data/` (OneDrive). O antigo `.ps1` do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Cursos-Error-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-cursos-error-alarm.timer
```

Isso registra a task `Diaria-Cursos-Error-Alarm` (a cada 2h). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-cursos-error-alarm.timer`.

**Antes de confiar neste alarme em produção**, rodar uma vez com credenciais reais:

```bash
npx tsx scripts/cursos-error-alarm.ts --dry-run
```

e conferir se a linha de log bate com os contadores esperados (não precisa ser 0 sempre — se o worker nunca rodou desde o deploy deste PR, os 4 contadores ainda não existem no KV e a leitura retorna 0 pros 4, o que é esperado até a 1ª ocorrência de cada evento).

---

## 2. Sync do KV de assinantes

`scripts/sync-cursos-subscribers-kv.ts` (#4052) pagina `GET /subscriptions?status=active` na Beehiiv e escreve `subscriber:{sha256(email)}` → `"1"` no KV `CURSOS_SUBSCRIBERS` — fonte **primária** de verificação do gate `?email=`. Rodou manualmente 1× (PR #4052) e nunca foi agendado; o `by_email` da Beehiiv funciona como fallback ao vivo (confirmado na #4305), então isto não é urgente, mas o caminho primário ficava permanentemente desatualizado sem o agendamento.

### Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer `BEEHIIV_API_KEY` (+ opcional `BEEHIIV_PUBLICATION_ID`, fallback `platform.config.json`) + `CLOUDFLARE_ACCOUNT_ID` + `CURSOS_KV_NAMESPACE_ID` (id do namespace `CURSOS_SUBSCRIBERS`, do `wrangler.toml`) no `.env` local + o junction `data/`. O antigo `.ps1` do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Cursos-Kv-Sync
systemctl --user daemon-reload
systemctl --user enable --now diaria-cursos-kv-sync.timer
```

Isso registra a task `Diaria-Cursos-Kv-Sync` (diária, 09:15 — 45min depois da `Diaria-Clarice-Sync`, pra não concorrer no mesmo horário). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-cursos-kv-sync.timer`.

### Verificar que a 1ª execução deixou a contagem coerente

```bash
npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run
```

Imprime `{ subscribers: N, kv_entries: M, dry_run: true }` — `N` deve bater (ordem de grandeza) com a contagem de assinantes ativos no dashboard Beehiiv, bem acima dos 535 que motivaram a issue original. Rodar sem `--dry-run` pra escrever de fato no KV.

### Log

`data/cursos-subscribers/.kv-sync.log` (append-only, uma seção por execução).

---

## Follow-up explícito deste PR

Nem o registro das duas tasks no systemd nem a 1ª execução ao vivo do KV sync foram feitos na sessão original (#4320) — o dispatch rodou num worktree isolado, sem acesso ao agendador real da máquina do editor nem a credenciais Cloudflare/Beehiiv ao vivo (escopo intencional, ver corpo do PR). **Ação pendente do editor pós-merge:** rodar os comandos `setup-systemd-timers.ts`/`systemctl` acima (registro das tasks) e, antes de confiar no alarme, o `--dry-run` descrito na seção 1.

**#4382 (este PR):** o redesign de GraphQL→contadores KV também não foi validado ao vivo (mesmo motivo — worktree isolado sem credenciais reais). A lógica de delta/idempotência é coberta por teste (`test/cursos-error-alarm.test.ts`), e o incremento dos contadores no worker é coberto fim-a-fim (`test/cursos-gate.test.ts`), mas o round-trip real "worker incrementa no KV de produção → script lê o mesmo KV via API HTTP" nunca rodou contra credenciais/deploy reais. **Ação pendente do editor pós-merge (além do registro das tasks acima):** fazer deploy do worker atualizado (`cd workers/cursos && npx wrangler deploy`), gerar pelo menos 1 ocorrência de cada evento (ex: bater em `/gate/verify` com um e-mail não-assinante pra incrementar `emailGateNotConfirmed`) e rodar `npx tsx scripts/cursos-error-alarm.ts --dry-run` conferindo que os contadores lidos batem com o que foi gerado.
