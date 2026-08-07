# Check de drift entre o código publicado e o master de cada Worker

Issue: [#4723](https://github.com/vjpixel/diaria-studio/issues/4723).

O Worker `reativar` ficou **4 dias em produção com código defasado** — um commit mergeou em `master` mas ninguém rodou `wrangler deploy`. Não havia nenhum sinal automático; só foi percebido porque o editor estranhou um cadastro anômalo. Este documento cobre a task que fecha esse gap para **todos** os workers do repo (`reativar`, `poll`, `cursos`, `diaria-dashboard`, `brevo-dashboard`, e qualquer worker novo que entrar em `workers/`).

## O que ele checa

Para cada diretório sob `workers/*` com um `wrangler.toml`/`.jsonc`:

1. **Descoberta automática** (`discoverWorkers`, `scripts/worker-drift-check.ts`) — lê `workers/*/wrangler.toml` e extrai o campo `name`. Nenhuma lista de workers é mantida à mão; um worker novo entra na checagem sozinho na próxima execução. O nome do diretório pode diferir do `name` publicado (ex: `workers/artigos/` publica como `diaria-artigos`) — a checagem usa o `name` correto pra consultar a Cloudflare e o diretório correto para o `git log`/comando de deploy.
2. **Último deploy publicado** (`fetchAllWorkerScriptsMetadata`) — `GET /accounts/{account}/workers/scripts` na Cloudflare REST API ("List Workers", UMA chamada pra conta inteira), campo `modified_on` de cada item. Usa REST em vez de `wrangler deployments list` pelo mesmo motivo já documentado em `check-cloudflare-token.ts`: sem depender do CLI `wrangler` no PATH, sem side-effects de login interativo, testável com mock de `fetch`. Usa o endpoint de LISTA (não `.../scripts/{name}`, que devolve o conteúdo do script, não metadata) — `modified_on` é semanticamente "quando este script foi atualizado pela última vez", o mesmo que "último deploy" (só `wrangler deploy` atualiza um Worker Script).
3. **Último commit local** (`getLastCommitAt`) — `git log -1 --format=%aI -- workers/{dir}`.
4. **Decisão de drift** (`evaluateWorkerDrift`, `scripts/lib/worker-drift-check.ts`, lógica pura/testável) — compara os dois timestamps:
   - commit mais recente que o deploy → `drift`.
   - worker nunca deployado mas já tem commit(s) em `workers/{dir}/` → `never_deployed` (mesmo tratamento de "drift", email inclui os dois casos).
   - deploy em dia → `ok`.
   - consulta à Cloudflare falhou pra esse worker (credencial, rede, 5xx) → `error` — reportado no e-mail/log, **não** bloqueia a checagem dos demais workers.

Se houver pelo menos 1 worker em `drift`/`never_deployed`, chega **1 e-mail** ao editor nomeando o(s) worker(s), há quanto tempo, e o comando exato de deploy (`cd workers/{dir} && npx wrangler deploy`).

## Idempotência

Fingerprint do conjunto de workers pendentes (`data/worker-drift-check/state.json`, mesmo padrão de `apoios-diff-alarm.ts`) — inclui o timestamp de commit E de deploy de cada worker problemático:

- o **mesmo** drift persistindo entre execuções (a cada 6h) não gera um novo e-mail a cada rodada — só na primeira vez que aquele estado aparece.
- um **novo commit** chegando em cima de um drift já alarmado (código divergiu ainda mais sem deploy) muda o fingerprint — alarma de novo, porque é informação nova.
- o drift sendo **resolvido** (editor roda `wrangler deploy`) tira esse worker do conjunto pendente — o cursor "re-arma" (grava fingerprint `null`).
- o **mesmo worker voltando a driftar** depois (novo ciclo commit → deploy pendente) gera um fingerprint novo — alarma de novo mesmo partindo de um cursor já re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando algum worker está defasado. Sem e-mail = sem drift pendente na janela.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/worker-drift-check.ts --dry-run
  ```
- **Log da task agendada**: `data/worker-drift-check/.drift-check.log` (append-only, uma seção por execução).

## O que fazer quando o alarme dispara

1. O corpo do e-mail já traz o comando exato: `cd workers/{dir} && npx wrangler deploy`.
2. Depois do deploy, a próxima execução da task (até 6h depois) já reconhece o worker como `ok` — não é preciso limpar nenhum estado manualmente. Pra confirmar antes da próxima janela, rode `npx tsx scripts/worker-drift-check.ts --dry-run` de novo.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Windows + Task Scheduler + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` (token com permissão de **leitura** em Workers Scripts — o mesmo par de env vars já usado por `cursos-error-alarm.ts`/`postmaster-spam-sync.ts`) + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo, `npx tsx scripts/oauth-setup.ts` se ainda não tiver esse scope). **Não** requer o junction `data/` para ler o estado do repo em si (`workers/*/wrangler.toml` e commits git são locais ao checkout) — só precisa dele para persistir `data/worker-drift-check/state.json` (idempotência).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-worker-drift-check-schedule.ps1
```

Isso registra a task `Diaria-Worker-Drift-Check` (a cada 6h). Idempotente — re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` nem `data/.credentials.json` reais) — validado só via testes da lógica pura + parsing determinístico (`test/worker-drift-check.test.ts`), mesma disciplina do #4320/#4382/#4490/#4534.
