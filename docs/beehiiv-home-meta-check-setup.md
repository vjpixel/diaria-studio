# Smoke-test dos 3 eixos de drift da home pública Beehiiv

Issue: [#4557](https://github.com/vjpixel/diaria-studio/issues/4557) (guard), [#5005](https://github.com/vjpixel/diaria-studio/issues/5005) (registro como task agendada).

`scripts/beehiiv-home-meta-check.ts` + `scripts/lib/beehiiv-home-meta-check.ts` implementam a máquina completa de um alarme de drift no molde de `robots-txt-drift-check.ts`/`hub-drift-check.ts` — fetch da home pública, decisão pura/testável, fingerprint, idempotência, e-mail de alarme — mas até o #5005 não tinha nenhum agendamento: guard construído, sem estar armado, invisível em produção até alguém invocar a CLI manualmente.

## O que ele checa

Um único `GET https://diar.ia.br/` (home pública — sem autenticação, sem API do Beehiiv, sem MCP; qualquer visitante vê o mesmo HTML) contra os 3 eixos de drift que a issue #4557 documentou:

1. **`og:title`** — sem a marca oficial, ou com a grafia legada "Diar.ia" (deveria ser "diar.ia.br").
2. **Self-links http** — `href="http://diar.ia.br..."` na própria home (deveria ser `https://`).
3. **Rótulos residuais em inglês** — resíduo do tema padrão do Beehiiv ("Sign Up", "Login", "N min read") que deveria estar traduzido pro PT-BR.

Se pelo menos 1 eixo der drift, chega **1 e-mail** ao editor nomeando o(s) eixo(s) e o detalhe exato.

## Por que é só a home, e só 3 eixos

A issue #4557 original pede 3 mudanças de PAINEL Beehiiv (ação manual do editor) e autoriza em código só "um teste/guard que detecte regressão de og:title" — generalizado aqui pros 3 eixos igualmente checáveis a partir do HTML público da home. Não varre o site inteiro nem outras páginas do Beehiiv.

## Idempotência

Fingerprint do conjunto de achados pendentes (`data/beehiiv-home-meta-check/state.json`, mesmo padrão de `hub-drift-check.ts`/`robots-txt-drift-check.ts`/`worker-drift-check.ts`):

- o **mesmo** drift persistindo entre execuções (a cada 6h) não gera um novo e-mail a cada rodada.
- um **eixo adicional** com drift, ou uma mudança no detalhe de um eixo já problemático, muda o fingerprint — alarma de novo.
- o drift sendo **resolvido** (o editor corrige no painel Beehiiv) tira o conjunto pendente — o cursor "re-arma".
- o **mesmo drift reaparecendo** depois (ex: update do tema Beehiiv reseta a config) gera um fingerprint novo — alarma de novo mesmo partindo de um cursor já re-armado.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando há drift.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o cursor:
  ```powershell
  npx tsx scripts/beehiiv-home-meta-check.ts --dry-run
  ```
  `--to email@x` sobrepõe o destinatário do alarme (debug).
- **Log da task agendada**: `data/beehiiv-home-meta-check/.meta-check.log` (append-only, uma seção por execução).

## O que fazer quando o alarme dispara

1. Abra `https://diar.ia.br/` e confira qual dos 3 eixos mudou — o corpo do e-mail nomeia o(s) achado(s) com o detalhe exato (trecho de HTML/rótulo encontrado).
2. Corrija no painel do Beehiiv (tema/configurações de publicação — não é código deste repo; a issue #4557 original documenta onde cada eixo mora no painel).
3. Depois de corrigido, a próxima execução da task (até 6h depois) já reconhece o eixo como limpo — não é preciso limpar estado manualmente. Pra confirmar antes, rode `npx tsx scripts/beehiiv-home-meta-check.ts --dry-run`.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há drift; a checagem HTTP em si é um `GET` público, sem credencial nenhuma. Não requer o junction `data/` pra rodar a checagem em si — só pra persistir `data/beehiiv-home-meta-check/state.json` (idempotência).

Linux/systemd (molde da épica #4798, cutover já concluído — desde o #5115 é a única via, nenhuma tarefa `Diaria-*` roda no Windows):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Beehiiv-Home-Meta-Check
systemctl --user daemon-reload
systemctl --user enable --now diaria-beehiiv-home-meta-check.timer
```

Isso registra a task `Diaria-Beehiiv-Home-Meta-Check` (a cada 6h) — mesma cadência dos outros drift-checks de superfície pública (`Diaria-Hub-Drift-Check`, `Diaria-Robots-Txt-Drift-Check`). Idempotente — re-rodar o `setup-systemd-timers.ts` regenera os units sem duplicar.

**Por que nunca teve `.ps1` de setup (#5005):** `Diaria-Beehiiv-Home-Meta-Check` foi a 1ª task registrada em `scripts/lib/scheduled-tasks.ts` depois do cutover pra systemd (épica #4798) — nasceu sem contraparte Windows/Task Scheduler, por decisão explícita de não criar mais `.ps1` como via de execução real. Os `.ps1` das demais tasks (que tinham nascido antes do cutover) foram removidos no #5115.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem `data/.credentials.json` real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de rede real nesta sessão, mesmo sendo GET público de leitura) — validado só via testes com a lógica pura + fetch mockado (`test/beehiiv-home-meta-check.test.ts` e afins) e via `test/scheduled-tasks.test.ts` (estrutura do registro), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750/#4910.
