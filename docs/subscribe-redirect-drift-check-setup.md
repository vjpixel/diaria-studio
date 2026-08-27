# Smoke-test do destino do redirect `/subscribe` (perfil hospedado Kit)

Issue: [#6365](https://github.com/vjpixel/diaria-studio/issues/6365) (achado do fleet review da PR #6363, pré-requisito de segurança do cutover #467, irmão do #6359).

O Worker `diaria-site` faz `/subscribe` retornar 302 pra `https://diar-ia-br.kit.com/` (o perfil hospedado padrão da conta Kit — não há landing page própria publicada, ver comentário de `workers/site/public/_redirects`). Esse destino foi verificado ao vivo **uma vez**, em 26/08/2026. Nada re-verificava depois. Depois do cutover do apex (#467), `/subscribe` é a **única** porta de cadastro pelo site, e o destino está inteiramente fora do nosso controle — se o Kit renomear o slug, despublicar o perfil, mudar o esquema de URL, ou a conta lapsar, `/subscribe` vira um redirect pra uma página morta e **todas as camadas reportam sucesso** (a Cloudflare serve o redirect, o Worker faz o que mandaram, e a página de erro do Kit tipicamente responde 200 com corpo de erro). O sinal seria o crescimento estagnar, dias ou semanas depois.

## O que ele checa

Para cada alvo de `buildDefaultTargets` (`scripts/lib/subscribe-redirect-drift-check.ts`):

1. **`kit-subscribe`** — `GET https://diar-ia-br.kit.com/` (destino do redirect, com User-Agent de navegador — sem UA a Cloudflare devolve challenge, ver memória "curl sem UA recebe challenge"). `ok` exige status 200 **e** o corpo conter `type="email"` **e** `>Subscribe<` (confirmados ao vivo em 26/08/2026 — campo de e-mail e botão de submit da página real).
2. **`worker-root`** — `GET https://{WORKER_DEV_HOST}/` (host `workers.dev` do Worker `diaria-site`, pré-cutover — mesma constante do guard de pré-condição do `--cutover`, `scripts/lib/apex-cutover.ts`). `ok` exige status 200 **e** o corpo conter `EXPECTED_ROOT_MARKER` (`<title>diar.ia.br</title>`).
3. **`worker-sample-page`** — `GET https://{WORKER_DEV_HOST}/p/{SAMPLE_ARCHIVE_SLUG}` (amostra do acervo). `ok` exige status 200 **e** o corpo conter o `<link rel="canonical">` apontando pro apex.

Os alvos 2 e 3 são a extensão pedida pelo item 4 do checklist da issue — fecham o laço entre "config committada parece certa" e "a Cloudflare serve o que a gente quis" (mesma classe do Finding 3 do fleet review da PR #6363: `deploy-site.yml` roda `wrangler deploy` sem smoke-test pós-deploy).

Status 200 sozinho **nunca** basta — é por isso que todo alvo declara `expectedMarkers`: uma página de erro genérica pode responder 200 (ver docstring de `scripts/lib/subscribe-redirect-drift-check.ts`).

Se houver pelo menos 1 alvo `broken`/`error`, chega **1 e-mail** ao editor nomeando o(s) alvo(s), a URL exata e o detalhe (status HTTP, ou qual marcador está faltando, ou o erro de rede).

## O que NÃO faz

Não substitui `test/site-worker-routes-6359.test.ts`. As duas camadas respondem perguntas diferentes: o teste pergunta "a regra de redirect existe no código e aponta pra `kit.com`?"; este smoke-test pergunta "o destino publicado hoje ainda serve o formulário de cadastro de verdade?" — inclusive o caso em que o teste continuaria passando (ex: um typo de slug que ainda casa `/kit\.com/`, ou o destino real virando uma página de erro 200) sem que ninguém percebesse.

## Idempotência

Fingerprint do conjunto de alvos pendentes (`data/subscribe-redirect-drift-check/state.json`, mesmo padrão de `hub-drift-check.ts`/`worker-drift-check.ts`) — inclui key + status + detalhe (HTTP status ou mensagem de erro) de cada alvo problemático:

- o **mesmo** drift persistindo entre execuções (diária, 10:30) não gera um novo e-mail a cada rodada — só na primeira vez que aquele estado aparece.
- um **alvo adicional** quebrando muda o fingerprint — alarma de novo.
- o drift sendo **resolvido** (Kit republica o perfil, `_redirects` é corrigido, ou o Worker é redeployado) tira esse alvo do conjunto pendente — o cursor "re-arma".
- o **mesmo alvo voltando a quebrar** depois gera um fingerprint novo — alarma de novo mesmo partindo de um cursor já re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando algum alvo está fora do ar. Sem e-mail = sem drift pendente na janela.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/subscribe-redirect-drift-check.ts --dry-run
  ```
- **Log da task agendada**: `data/subscribe-redirect-drift-check/.drift-check.log` (append-only, uma seção por execução).

## O que fazer quando o alarme dispara

1. Se o alvo for `kit-subscribe`: confira `https://app.kit.com` — o slug/perfil hospedado pode ter mudado, sido despublicado, ou a conta lapsou. Se o destino mudou, atualize a URL em `workers/site/public/_redirects` (única fonte — as 2 regras de `/subscribe`/`/subscribe/` apontam pro mesmo destino, ver comentário do próprio arquivo).
2. Se o alvo for `worker-root`/`worker-sample-page`: confira se o deploy do Worker `diaria-site` (`cd workers/site && npx wrangler deploy`) está com o commit mais recente.
3. Depois do fix, a próxima execução da task (até 24h depois) já reconhece o alvo como `ok` — não é preciso limpar nenhum estado manualmente. Pra confirmar antes da próxima janela, rode `npx tsx scripts/subscribe-redirect-drift-check.ts --dry-run` de novo.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo, `npx tsx scripts/oauth-setup.ts` se ainda não tiver esse scope) — só necessário pra **enviar** o alarme quando há drift; as checagens HTTP em si são `GET`s públicos, sem credencial nenhuma. **Não** requer o junction `data/` pra rodar a checagem — só pra persistir `data/subscribe-redirect-drift-check/state.json` (idempotência).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Subscribe-Redirect-Drift-Check
systemctl --user daemon-reload
systemctl --user enable --now diaria-subscribe-redirect-drift-check.timer
```

Isso registra a task `Diaria-Subscribe-Redirect-Drift-Check` (diária, 10:30). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-subscribe-redirect-drift-check.timer`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade como task agendada** (worktree isolado, sem acesso ao systemd real nem a `data/.credentials.json` reais) — validado via testes da lógica pura + fetch mockado (`test/subscribe-redirect-drift-check.test.ts`, `test/subscribe-redirect-drift-check-script.test.ts`), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4740/#4750. O único contato com a URL de produção real foi **1** `GET` manual de leitura contra `https://diar-ia-br.kit.com/` ao escrever este script (confirmado 200 + `type="email"` + `>Subscribe<` presentes em 26/08/2026) — não repetido em automação nem em teste.
