# Smoke-test dos eixos de drift da home/edição pública Beehiiv

Issue: [#4557](https://github.com/vjpixel/diaria-studio/issues/4557) (guard), [#5005](https://github.com/vjpixel/diaria-studio/issues/5005) (registro como task agendada), [#5099](https://github.com/vjpixel/diaria-studio/issues/5099) (4º eixo, host legado), [#5106](https://github.com/vjpixel/diaria-studio/issues/5106) (5º eixo, porta na URL), [#5112](https://github.com/vjpixel/diaria-studio/issues/5112) (issue automática por achado), [#5113](https://github.com/vjpixel/diaria-studio/issues/5113) (cadência diária), [#5137](https://github.com/vjpixel/diaria-studio/issues/5137) (falso positivo do eixo english-labels), [#5257](https://github.com/vjpixel/diaria-studio/issues/5257) (6º eixo, hub sem link na home).

`scripts/beehiiv-home-meta-check.ts` + `scripts/lib/beehiiv-home-meta-check.ts` implementam a máquina completa de um alarme de drift no molde de `robots-txt-drift-check.ts`/`hub-drift-check.ts` — fetch da home pública, decisão pura/testável, fingerprint, idempotência, e-mail de alarme — mas até o #5005 não tinha nenhum agendamento: guard construído, sem estar armado, invisível em produção até alguém invocar a CLI manualmente.

## O que ele checa

Um `GET https://diar.ia.br/` (home pública — sem autenticação, sem API do Beehiiv, sem MCP; qualquer visitante vê o mesmo HTML) contra 5 eixos, mais um 6º checado contra a página da edição mais recente (`/p/{slug}`, descoberta a partir da própria home):

1. **`og:title`** — sem a marca oficial, ou com a grafia legada "Diar.ia" (deveria ser "diar.ia.br").
2. **Self-links http** — `href="http://diar.ia.br..."` na própria home (deveria ser `https://`).
3. **Rótulos residuais em inglês** — resíduo do tema padrão do Beehiiv ("Sign Up", "Login", "N min read") que deveria estar traduzido pro PT-BR. Casado contra o texto RENDERIZADO (`extractVisibleText`, #5137) — dado de configuração do builder Beehiiv embutido no HTML (ex: `"label":"Sign Up"` no JSON da navbar) não conta, só texto que o leitor de fato vê.
4. **Links pra host legado** (#5099) — `*.diaria.workers.dev` ou `diaria.beehiiv.com` em vez do host de marca `*.diar.ia.br`.
5. **Hub sem link na home** (`hub-link-missing`, #5257) — qualquer hub de `HUB_META` (`workers/arquivo/src/hubs/meta.ts`) sem um `href="…/temas/{slug}"` na home. A auditoria "Raio-X de /temas/" (14/08/2026) achou que 4 dos 5 hubs então publicados nunca foram rastreados pelo Google por faltar exatamente esse link — o bloco "Temas" na home é ação de painel do editor (fora de escopo aqui); este eixo é o guard que sobrevive pra hub futuro.
6. **Porta explícita na URL** (#5106) — qualquer `href` com `:PORTA` numa superfície pública (achado real: botão "View more" apontando pra `diar.ia.br:3002`, sobra de dev). Único eixo checado contra a página de edição mais recente, não a home.

Se pelo menos 1 eixo der drift, chega **1 e-mail** ao editor nomeando o(s) eixo(s), o detalhe exato, e (#5112) a issue GitHub associada a cada achado.

## Por que é só a home + 1 página de post

A issue #4557 original pede 3 mudanças de PAINEL Beehiiv (ação manual do editor) e autoriza em código só "um teste/guard que detecte regressão de og:title" — generalizado aqui pros eixos igualmente checáveis a partir do HTML público. O #5106 estendeu pra 1 página de post (a mais recente) porque o achado dele só existe lá. Não varre o site inteiro nem todas as páginas do Beehiiv.

## Issue automática por achado (#5112)

Cada achado pendente (dos 6 eixos acima) tem uma issue GitHub garantida — criada na 1ª vez que aparece, reusada nas execuções seguintes (dedup por cache local + marcador `<!-- alarm-finding: {eixo}:{fingerprint} -->` no corpo da issue, que sobrevive à perda do cache). Quando um achado deixa de reproduzir, a issue recebe um comentário ("não reproduz mais desde..."); depois de **2 execuções diárias consecutivas** sem o achado (48h, já que a task é diária desde #5113), a issue é fechada automaticamente. Ver `scripts/lib/alarm-issues.ts` — helper genérico, implementado só pra este check nesta unidade (os outros 8 alarmes do repo ficam de fora, follow-up futuro).

Se a criação/comentário/fechamento de issue falhar (ex: `gh` não autenticado no servidor), o **e-mail sai assim mesmo** — a linha do achado cita `→ issue não criada: {motivo}` em vez do número da issue, e o cursor de reconciliação NÃO avança (retry na próxima execução).

**#5338 (14-15/08/2026) — mecanismo estava morto em runtime, agora tem self-heal.** A label `alarm` que `ensureAlarmIssue` aplica incondicionalmente nunca tinha sido criada no repo — toda execução entre o #5112 e o #5338 falhava com `could not add label: 'alarm' not found` e **zero** achado virava issue (e-mails saíam sem citar issue nenhuma, `data/beehiiv-home-meta-check/alarm-issues.json` ficou em `{}` o tempo todo). A label foi criada manualmente nesta unidade e `ensureAlarmIssue` ganhou retry fail-soft (`createAlarmIssueWithLabelRetry`, `scripts/lib/alarm-issues.ts`): se `gh issue create` falhar só por label ausente, tenta self-heal (`gh label create alarm --force`, best-effort) e retenta — mantendo `alarm` se o self-heal funcionou, ou sem ela (e sem qualquer outra label reportada ausente, sem tentativa de auto-criação pra essas) caso contrário. Perder um rótulo é aceitável; perder o rastreio do achado inteiro não é.

## Idempotência

Fingerprint do conjunto de achados pendentes (`data/beehiiv-home-meta-check/state.json`, mesmo padrão de `hub-drift-check.ts`/`robots-txt-drift-check.ts`/`worker-drift-check.ts`):

- o **mesmo** drift persistindo entre execuções (diária, 09:35 — #5113) não gera um novo e-mail a cada rodada.
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

1. Abra `https://diar.ia.br/` (ou, pro eixo `port-in-url`, a página da edição mais recente) e confira qual eixo mudou — o corpo do e-mail nomeia o(s) achado(s) com o detalhe exato (trecho de HTML/rótulo encontrado) e a issue GitHub associada.
2. Corrija no painel do Beehiiv (tema/configurações de publicação — não é código deste repo; a issue #4557 original documenta onde cada eixo mora no painel).
3. Depois de corrigido, a próxima execução da task (até 24h depois) já reconhece o eixo como limpo — não é preciso limpar estado manualmente. Pra confirmar antes, rode `npx tsx scripts/beehiiv-home-meta-check.ts --dry-run`.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há drift; a checagem HTTP em si é um `GET` público, sem credencial nenhuma. `gh` CLI autenticado (#5112) — só necessário pra criar/comentar/fechar a issue de cada achado; sem ele a reconciliação falha fail-soft (o e-mail sai do mesmo jeito, com o motivo no lugar do número da issue). Não requer o junction `data/` pra rodar a checagem em si — só pra persistir `data/beehiiv-home-meta-check/state.json` (idempotência do e-mail) e `data/beehiiv-home-meta-check/alarm-issues.json` (tracking de issue por achado, #5112).

Linux/systemd (molde da épica #4798, cutover já concluído — desde o #5115 é a única via, nenhuma tarefa `Diaria-*` roda no Windows):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Beehiiv-Home-Meta-Check
systemctl --user daemon-reload
systemctl --user enable --now diaria-beehiiv-home-meta-check.timer
```

Isso registra a task `Diaria-Beehiiv-Home-Meta-Check` (diária, 09:35 BRT — #5113, mudou de "a cada 6h": o conserto é ação manual do editor de manhã, detectar de madrugada não adianta nada) — mesma faixa matinal dos outros drift-checks de superfície pública (`Diaria-Hub-Drift-Check` 10:00, `Diaria-Robots-Txt-Drift-Check` 10:15). Idempotente — re-rodar o `setup-systemd-timers.ts` regenera os units sem duplicar.

**Por que nunca teve `.ps1` de setup (#5005):** `Diaria-Beehiiv-Home-Meta-Check` foi a 1ª task registrada em `scripts/lib/scheduled-tasks.ts` depois do cutover pra systemd (épica #4798) — nasceu sem contraparte Windows/Task Scheduler, por decisão explícita de não criar mais `.ps1` como via de execução real. Os `.ps1` das demais tasks (que tinham nascido antes do cutover) foram removidos no #5115.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem `data/.credentials.json` real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de rede real nesta sessão, mesmo sendo GET público de leitura) — validado só via testes com a lógica pura + fetch mockado (`test/beehiiv-home-meta-check.test.ts` e afins) e via `test/scheduled-tasks.test.ts` (estrutura do registro), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750/#4910.
