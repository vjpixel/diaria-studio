# Smoke-test de drift entre HUB_META e o Worker `arquivo` publicado

Issue: [#4750](https://github.com/vjpixel/diaria-studio/issues/4750) (follow-up do fleet review da PR #4749).

`test/hub-registry-completeness.test.ts` cruza os 3 registries de hub temático (`HUB_LOADERS`, `HUB_REGISTRY`, `HUB_META`) entre si — 6 asserções, CI obrigatória. Isso é sólido **enquanto o CI roda**, mas é inteiramente **test-time**: nada checava o que está de fato servido pelo Worker `arquivo` publicado (`arquivo.diar.ia.br`). Se os registries divergirem por um caminho que não passe pelo CI de PR, o drift chega em produção como um hub servindo 404 ou um link de navegação apontando pra lugar nenhum, silenciosamente. Mesma classe de problema da [#4723](https://github.com/vjpixel/diaria-studio/issues/4723) (Worker publicado divergindo de master) — aqui aplicada ao caso específico "hub servindo 404" em vez de "código velho no ar".

## O que ele checa

Para cada entrada de `HUB_META` (`workers/arquivo/src/hubs/meta.ts`, sem lista hardcoded — um hub novo entra na checagem sozinho na próxima execução):

1. **Descoberta automática** — lê `HUB_META` direto do módulo do repo (nenhuma lista de slugs mantida à mão neste script).
2. **GET runtime** (`checkHub`, `scripts/hub-drift-check.ts`) — bate `GET {DIARIA_ARQUIVO_URL}/temas/{slug}` (`DIARIA_ARQUIVO_URL` = `https://arquivo.diar.ia.br`, `scripts/lib/canonical-urls.ts`) com timeout de 15s.
3. **Decisão de drift** (`evaluateHubDrift`, `scripts/lib/hub-drift-check.ts`, lógica pura/testável):
   - HTTP 200 → `ok`.
   - HTTP != 200 (404, 5xx) → `broken`.
   - a chamada de rede em si falhou (timeout, DNS, conexão recusada) → `error` — tratado como pendência igual a `broken` (é sinal de que o link não está servindo o que devia, não uma falha de infraestrutura de checagem que precisa de tratamento separado — diferente do `worker-drift-check.ts`, onde uma falha de API é da CONTA INTEIRA).

Se houver pelo menos 1 hub `broken`/`error`, chega **1 e-mail** ao editor nomeando o(s) hub(s), o slug, a URL exata e o detalhe (status HTTP ou mensagem de erro).

## O que NÃO faz

Não substitui `test/hub-registry-completeness.test.ts`. As duas camadas respondem perguntas diferentes: o teste pergunta "os registries concordam entre si no código?"; este smoke-test pergunta "o que está no ar concorda com o que o código diz?". A #4723 mostrou que a segunda pergunta não é respondida pela primeira.

## Idempotência

Fingerprint do conjunto de hubs pendentes (`data/hub-drift-check/state.json`, mesmo padrão de `apoios-diff-alarm.ts`/`worker-drift-check.ts`) — inclui status + detalhe (HTTP status ou mensagem de erro) de cada hub problemático:

- o **mesmo** drift persistindo entre execuções (a cada 6h) não gera um novo e-mail a cada rodada — só na primeira vez que aquele estado aparece.
- um **hub adicional** quebrando muda o fingerprint — alarma de novo.
- o drift sendo **resolvido** (deploy corrige o Worker, ou o registry é corrigido) tira esse hub do conjunto pendente — o cursor "re-arma" (grava fingerprint `null`).
- o **mesmo hub voltando a quebrar** depois (ex: novo commit sem deploy) gera um fingerprint novo — alarma de novo mesmo partindo de um cursor já re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando algum hub está fora do ar. Sem e-mail = sem drift pendente na janela.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/hub-drift-check.ts --dry-run
  ```
- **Log da task agendada**: `data/hub-drift-check/.drift-check.log` (append-only, uma seção por execução).

## O que fazer quando o alarme dispara

1. Confirme se o slug existe de fato em `workers/arquivo/src/hubs/registry.ts` (drift de registry) e se o Worker `arquivo` está deployado com o commit mais recente (`cd workers/arquivo && npx wrangler deploy` — drift de deploy, caso coberto pelo `worker-drift-check.ts`).
2. Depois do fix, a próxima execução da task (até 6h depois) já reconhece o hub como `ok` — não é preciso limpar nenhum estado manualmente. Pra confirmar antes da próxima janela, rode `npx tsx scripts/hub-drift-check.ts --dry-run` de novo.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo, `npx tsx scripts/oauth-setup.ts` se ainda não tiver esse scope) — só necessário pra **enviar** o alarme quando há drift; a checagem HTTP em si é um `GET` público, sem credencial nenhuma. **Não** requer o junction `data/` para ler `HUB_META` (módulo do repo, local ao checkout) — só precisa dele para persistir `data/hub-drift-check/state.json` (idempotência). O antigo `.ps1` de setup do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Hub-Drift-Check
systemctl --user daemon-reload
systemctl --user enable --now diaria-hub-drift-check.timer
```

Isso registra a task `Diaria-Hub-Drift-Check` (a cada 6h). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-hub-drift-check.timer`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem acesso ao Task Scheduler real nem a `data/.credentials.json` reais, e a URL de produção não foi batida repetidamente em teste por decisão explícita do dispatch) — validado só via testes da lógica pura + fetch mockado (`test/hub-drift-check.test.ts`, `test/hub-drift-check-script.test.ts`), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4740.
