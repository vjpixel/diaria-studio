# Setup do cliente OneDrive (`onedrive.service`, systemd --user)

Issue: [#5548](https://github.com/vjpixel/diaria-studio/issues/5548) — "Sync do OneDrive parado há 17h no `300`: `data/` divergiu nas duas pontas em silêncio (causou o skip da #5526)".

**Item 1 da issue (religar o serviço) já foi resolvido antes desta unidade** — verificado ao vivo pelo coordenador em 17/08 14:47 UTC: `systemctl --user status onedrive` mostrava `active (running)` desde `2026-08-17T14:33:34Z`, com uploads/downloads acontecendo. Este doc cobre só os itens 2-4: exclusão do escopo de sync (item 2), o alarme de sync parado (item 3, código real — ver `scripts/onedrive-sync-alarm.ts`) e o override `Restart=` (item 4).

Como em todo setup de máquina local deste repo (`data/` junction, watchdog — ver `docs/overnight-watchdog-setup.md`), **nada aqui foi aplicado ao vivo nesta unidade** — mexer no daemon de sync ou no unit file compartilhado com outras sessões ativas na mesma máquina é ação manual do editor, documentada como passo-a-passo.

## Item 2 — Excluir do sync o que não deve sincronizar

O achado ao vivo mostrou dois padrões de arquivo causando ruído no log do cliente antes dele morrer:

```
WARNING: Online file integrity failure for: Documentos/diaria-studio-data/run-log.jsonl
To disable the integrity checking of uploaded files use --disable-upload-validation
WARNING: The file uploaded to Microsoft OneDrive does not match your local version. Data loss may occur.
```

repetido em loop com `run-log.jsonl` (append-only, escrito com alta frequência pela pipeline — o arquivo muda DURANTE o upload, o hash calculado no início nunca bate com o conteúdo no fim, o cliente reintenta indefinidamente). Também apareceram notificações de deleção de `clarice-users.db-shm`/`clarice-users.db-wal` — arquivos WAL/SHM transitórios do SQLite (`node:sqlite`, ver CLAUDE.md item 1a) que não deveriam estar no escopo de sync — eles existem só enquanto uma conexão está aberta, e a sync do OneDrive corre atrás de um alvo que muda de forma incompatível com o modelo de arquivo estável que ela assume.

### `skip_file` recomendado

O cliente Linux (`abraunegg/onedrive`) usa a chave `skip_file` em `~/.config/onedrive/config`, uma lista separada por `|` de padrões glob (não regex). O default hoje é:

```
skip_file = "~*|.~*|*.tmp|*.swp|*.partial"
```

Adicionar os padrões de arquivo transitório/append-only que causaram o loop de integrity failure:

```
skip_file = "~*|.~*|*.tmp|*.swp|*.partial|*.db-shm|*.db-wal|*.sqlite3-shm|*.sqlite3-wal|run-log.jsonl|*.mp4"
```

`*.mp4` entrou com o #10957 (item 6). A linha não precisa ser escrita à mão: `npx tsx scripts/onedrive-skip-file-config.ts --apply` faz isso sem duplicar o que já existe.

Padrão a padrão:

- `*.db-shm` / `*.db-wal` — WAL/SHM do SQLite usado por `clarice-users.db` (`scripts/lib/clarice-db.ts`) — arquivos transitórios, recriados pelo `node:sqlite` a cada conexão; nunca precisam sincronizar entre máquinas (o `.db` principal em si continua sincronizando normalmente).
- `*.sqlite3-shm` / `*.sqlite3-wal` — mesma classe de arquivo, cobrindo a extensão alternativa `.sqlite3` caso algum store futuro a use (nenhum store atual do repo usa essa extensão — entrada preventiva, sem custo).
- `run-log.jsonl` — **decisão explícita de excluir do sync, não só de mitigar o loop.** É o único arquivo do repo que é (a) escrito com alta frequência (toda etapa de toda edição loga nele) e (b) append-only sem nunca ser truncado/rotacionado — a combinação exata que quebra o modelo de integrity-check do cliente (hash calculado no início do upload não bate com o conteúdo no fim, porque o arquivo cresceu no meio do upload). Excluir do sync significa que `data/run-log.jsonl` passa a ser **local por máquina** — `/diaria-log` (`.claude/skills/diaria-log/SKILL.md`) só vê os eventos logados NAQUELA máquina a partir daí. Trade-off aceito: o log já é primariamente uma ferramenta de debug ao vivo (rodada em curso, mesma máquina), não um histórico consultado entre máquinas — perder sync não quebra nenhum fluxo automático (nenhuma skill/script lê `run-log.jsonl` de uma máquina diferente da que o escreveu). Se o editor quiser consolidar o log entre máquinas no futuro, a solução correta é rotação/truncamento (arquivo estável entre uploads), não voltar a sincronizar o append-only bruto.

### Como aplicar (ação manual do editor, fora de escopo desta unidade)

```bash
# 1. Editar ~/.config/onedrive/config, adicionar/ajustar a linha skip_file acima.
# 2. Aplicar a config nova. Mudar skip_file exige --resync (só reiniciar não basta, ver abaixo):
systemctl --user stop onedrive
onedrive --sync --resync --resync-auth --dry-run   # conferir que o plano não tem deleção
onedrive --sync --resync --resync-auth
systemctl --user start onedrive
# 3. Confirmar (leitura, sem mutar nada):
systemctl --user status onedrive
```

**Só `restart` derruba o daemon (#11256).** No cliente v2.5.x (medido no `300` com o v2.5.10, 27/10/2026), mudar `skip_file` e reiniciar faz o serviço sair com status 126 e a mensagem "An application configuration change has been detected where a --resync is required". O sync fica parado até alguém rodar o resync, e o `onedrive-sync-alarm` só percebe depois da janela de tolerância. Por isso a sequência acima para o serviço, roda o resync primeiro em `--dry-run` (se o plano listar deleção de arquivo, parar e investigar antes de seguir), depois o mesmo comando sem `--dry-run`, e só então religa. O resync relista a conta inteira: fazer com tempo.

`skip_file` só afeta o que o cliente escolhe subir/baixar DAQUI PRA FRENTE — não remove um arquivo já sincronizado incorretamente antes. Se `run-log.jsonl`/`*.db-shm`/`*.db-wal` já subiram pro OneDrive em versões antigas, ficam órfãos lá (histórico, sem ação automática — mesmo tratamento dado a artefatos legados noutros lugares deste repo, ex: docs do Drive do #3713).

## Item 3 — Alarme de sync parado

`scripts/onedrive-sync-alarm.ts` (I/O) + `scripts/lib/onedrive-sync-alarm.ts` (lógica pura, coberta por `test/onedrive-sync-alarm.test.ts`) fecham o buraco de observabilidade do #5548: o serviço morreu com exit 0 (systemd não reinicia unit que sai "com sucesso") e ficou 17h parado sem que ninguém percebesse.

### Dois sinais independentes, mesma execução

1. **Estado do serviço** — `systemctl --user is-active onedrive` (só leitura — este alarme NUNCA muta o serviço, mesmo guard que protege qualquer outro script deste repo de mexer em daemon de máquina compartilhada). `inactive`/`failed` → achado direto (o cenário real da issue). `unknown` (systemctl ausente, sessão cloud sem OneDrive instalado, erro de consulta) nunca é tratado como "parado" — fail-soft honesto, mesmo padrão de `scripts/lib/scheduled-task-status.ts`.

2. **Canário de frescor** — `data/.onedrive-sync-canary.json`. A cada execução, o script lê o `mtime` do arquivo EXISTENTE (escrito por uma execução anterior) antes de sobrescrevê-lo com o timestamp desta máquina (side A). Se o mtime anterior está mais velho que a tolerância (`--tolerance-hours`, default 6h), isso é staleness — sinaliza mesmo quando o serviço reporta `active` (rede degradada sem o daemon detectar, por exemplo). Ausência total do arquivo (1ª execução, ou `data/` nunca sincronizado nesta máquina) vira `canary-missing-baseline`, tratado como achado **informativo, nunca alarma sozinho** — distinto de staleness detectada de fato.

**Limitação honesta, documentada de propósito (não é bug):** com uma única máquina (`300`, único host 24/7 rodando alarmes deste repo hoje — ver label `server` em `CLAUDE.md`) escrevendo o canário, o sinal 2 prova primariamente "este timer está rodando + `data/` é gravável nesta máquina" — não prova, sozinho, que uma máquina PEER recebeu a escrita via OneDrive de fato. Combinado com o sinal 1 (estado do serviço), a dupla cobre o cenário real do #5548 (serviço morto, ninguém percebendo) mesmo sem um canário do lado peer (Windows do editor). Um canário bilateral de verdade (cada máquina escreve seu próprio lado, cada uma lê o lado da outra) é follow-up natural se um incidente futuro mostrar que o sinal 1 sozinho não bastou — não implementado aqui por falta de acesso à segunda máquina nesta sessão.

### Veredito e cadência

| verdict | Serviço | Canário | Alarma? |
|---|---|---|---|
| `ok` | active/unknown | fresh | não |
| `canary-missing-baseline` | qualquer | missing | não (informativo) |
| `alarm-service-down` | inactive/failed | qualquer | **sim** |
| `alarm-canary-stale` | active/unknown | stale | **sim** |

Idempotência: `data/.onedrive-sync-alarm-state.json` guarda `lastAlarmedVerdict` — 1 e-mail por verdict distinto (reenvia se o verdict mudar, ex: `alarm-service-down` → `alarm-canary-stale`; não reenvia enquanto o MESMO verdict persistir). Issue via `scripts/lib/alarm-issues.ts` (mesmo mecanismo dedup/auto-close dos outros ~14 alarmes do repo, `CLOSE_ALARM_ISSUE_AFTER_RUNS = 2`) — 1 issue por verdict, prioridade `P1` (sync parado bloqueia trabalho entre máquinas em silêncio, como o #5526 mostrou).

### Uso manual / debug

```bash
npx tsx scripts/onedrive-sync-alarm.ts                     # avalia + alarma se necessário
npx tsx scripts/onedrive-sync-alarm.ts --dry-run            # avalia + imprime, NÃO envia nem persiste (canário também não é gravado)
npx tsx scripts/onedrive-sync-alarm.ts --to email@x         # override do destinatário
npx tsx scripts/onedrive-sync-alarm.ts --tolerance-hours 6  # override da tolerância do canário (default 6h)
```

Requer `data/.credentials.json` com o scope `gmail.send` — só necessário pra ENVIAR o alarme (mesmo requisito dos outros alarmes locais). A checagem do serviço/canário em si não precisa de credencial.

### Setup (ação local one-time do editor — NÃO feito nesta unidade)

Registrada no registro declarativo (`scripts/lib/scheduled-tasks.ts` → `Diaria-OneDrive-Sync-Alarm`, cadência `interval` a cada 4h). Sem `.ps1`/Task Scheduler de propósito — nenhuma tarefa `Diaria-*` roda no Windows (decisão do editor 260811, #5074). Linux/systemd:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-OneDrive-Sync-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-onedrive-sync-alarm.timer
```

Confirmar (leitura):

```bash
systemctl --user list-timers diaria-onedrive-sync-alarm.timer
```

## Item 4 — `Restart=always` na unit

O incidente #5548 aconteceu porque o serviço saiu com `status=0/SUCCESS` — systemd só reinicia automaticamente uma unit com `Restart=on-failure` (o default provável do pacote) quando o exit code é diferente de 0. Um exit limpo, mesmo inesperado, não dispara restart nenhum.

**Nunca editar o unit file do pacote diretamente** (`/usr/lib/systemd/user/onedrive.service`) — é sobrescrito em toda atualização do pacote. O jeito correto é um **drop-in override**, que o systemd mescla por cima do unit original sem tocá-lo:

```bash
systemctl --user edit onedrive.service
```

Isso abre um editor apontando para `~/.config/systemd/user/onedrive.service.d/override.conf` (criado se não existir). Colar:

```ini
[Service]
Restart=always
RestartSec=30
```

- `Restart=always` — reinicia em QUALQUER saída (falha ou exit limpo), fechando exatamente o buraco do #5548 (o daemon saiu com exit 0 e ninguém reiniciou).
- `RestartSec=30` — espera 30s antes de tentar de novo, evitando um loop de restart imediato se a causa raiz for persistente (ex: config quebrada, rede genuinamente fora) — mesma ordem de grandeza usada por outros serviços de longa duração deste tipo de setup.

Depois de salvar:

```bash
systemctl --user daemon-reload
systemctl --user restart onedrive
systemctl --user status onedrive     # confirma Restart=always no bloco [Service] efetivo
```

`systemctl --user cat onedrive.service` mostra o unit original + o override mesclados, útil para confirmar que o drop-in foi aplicado sem editar o arquivo do pacote.

## Item 5 — Há DOIS detectores de sync degradado, e eles podem discordar (#7300)

Quem investiga "o sync estava fora naquela hora?" precisa olhar duas fontes. Elas nasceram independentes, cobrem a mesma classe de falha por caminhos diferentes, e têm limiares próprios — então **discordar é o comportamento esperado, não sinal de bug em nenhuma das duas**.

| | Alarme deste doc (`onedrive-sync-alarm.ts`) | `assessCrossMachineSyncFreshness` (`session-registry.ts`, #7169) |
|---|---|---|
| Quando roda | Agendado, independente de haver sessão | Síncrono, dentro do `merge-lock-acquire` |
| O que observa | `systemctl is-active` + mtime do canário | `lastHeartbeat` de sessão ativa de OUTRA máquina |
| Limiar | 6h (`--tolerance-hours`, default) | 10min (`CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS`) |
| Efeito | E-mail / issue | Aviso no terminal de quem vai mergear |

**As duas formas de discordância, e o que cada uma significa:**

- **Aviso de merge aceso, alarme mudo** — o caso comum. Vem do fator ~36 entre os limiares: uma janela de 20min de sync morto cruza os 10min e não chega perto das 6h. Não é falso positivo do aviso nem falha do alarme.
- **Alarme aceso, aviso de merge mudo** — acontece quando não há sessão de outra máquina registrada. `assessCrossMachineSyncFreshness` só enxerga sync através de heartbeat alheio; sem peer, ela não tem o que medir e fica em silêncio mesmo com o sync completamente fora.

**Nenhum dos dois é "o certo", e silêncio de qualquer um deles nunca é evidência de que o sync está saudável.** Ao reconstruir uma janela de incidente, cheque as duas — e, se elas divergirem, a divergência em si já localiza o intervalo.

Por que não fundir: um é sensível e local à decisão de merge, o outro é lento e vale mesmo sem ninguém trabalhando. Unificar limiar ou mecanismo pioraria os dois.

## Item 6 — Cota: vídeo fora do sync, retenção e alarme (#10957)

Em 23/10/2026 a conta do OneDrive ficou sem espaço e o sync de `data/` parou. A causa era vídeo: `data/` tinha 4,8 GB, `data/editions/2610` sozinho 2,0 GB, quase todo `.mp4` (edição com vídeo 0,4 a 0,7 GB contra ~0,1 GB sem). O vídeo já tem cópia fora do disco (YouTube e a fonte no Drive, que `fetch-drive-video.ts` baixa de novo). O R2 dos verticais (bucket `diaria-shorts`, habilitado em 27/10/2026, #10772) também guarda o vertical publicado, mas só por 7 dias (lifecycle de `shorts/`), menos que a retenção local de 14: não serve de cópia de longo prazo. Decisão do editor (briefing do overnight 261026b): tirar `*.mp4` do sync, retenção por data, e alarme de cota que diga a causa.

### Peças

- `scripts/onedrive-skip-file-config.ts` — põe `*.mp4` (e os padrões do item 2) no `skip_file` de `~/.config/onedrive/config`. Idempotente, dry-run por padrão, `--apply` grava com backup `.bak-{timestamp}` ao lado e imprime a sequência de resync abaixo. Não reinicia o daemon nem chama o binário `onedrive`. `--print` mostra a linha recomendada inteira. Lógica em `scripts/lib/onedrive-skip-file.ts`.
- `scripts/prune-edition-videos.ts` — retenção dos `.mp4` de `data/editions/` pela data da EDIÇÃO (diretório `AAMMDD`, não o mtime). Dry-run por padrão, mantém 14 dias (`--keep-days`), `--apply` apaga. `.mp4` sem diretório de edição no caminho nunca é tocado. Não está agendado: armar a retenção automática fica pra depois de o editor ver o dry-run. Lógica em `scripts/lib/edition-video-retention.ts`.
- Sinal de cota no `scripts/onedrive-sync-alarm.ts` — lê (só leitura) o log do daemon (`journalctl --user -u onedrive`, janela de `--tolerance-hours`) atrás de recusa de upload por falta de espaço, e mede o que `data/` sincroniza descontando o `skip_file` efetivo, contra o orçamento `--quota-gb` (default 5, aviso a partir de `--quota-warn-pct` 80). Achado próprio, `check: "onedrive-quota"`: `quota-full` (P1, recusa no log ou uso ≥ cota) e `quota-near` (P2). O texto da issue e do e-mail traz a causa: total, quanto é `.mp4` e quanto dele ainda sincroniza, os maiores diretórios (`editions/{AAMM}` separado) e arquivos, e o passo que resolve. Sem `data/` e sem recusa no log, o veredito é `unmeasured` e as issues de cota ficam congeladas (não fecham por falta de medida). Lógica em `scripts/lib/onedrive-quota.ts`.

**Premissa do orçamento:** 5 GB é inferido, não medido — `data/` com 4,8 GB encheu a conta, o que fecha com o plano gratuito. `onedrive --display-quota` recusa rodar com o daemon ativo, e o alarme não usa o token do cliente pra consultar a Graph por fora (poderia rotacionar o refresh token dele). Se a cota real for outra, passar `--quota-gb` no registro da task.

**O uso local subestima a cota.** `skip_file` não apaga a cópia que já subiu, e apagar no OneDrive manda pra lixeira, que também conta. Por isso a recusa no log vence a medida local.

**A recusa arma uma trava (`data/.onedrive-quota-latch.json`).** O journal só é lido na janela de `--tolerance-hours`, e o daemon só registra recusa quando tenta subir algo, então uma janela sem recusa não prova que a cota liberou. Depois de uma recusa, `quota-full` se mantém até a janela mostrar pelo menos um upload concluído (`Uploading ... done`) e nenhuma recusa. Journal ilegível ou janela sem upload mantêm a trava. Só com a trava solta o veredito volta a vir da medida local, e só então a issue `quota-full` pode fechar por streak.

### Como aplicar no `300` (manual, nesta ordem)

```bash
# 1. Ver o plano e gravar o skip_file (backup automático ao lado):
npx tsx scripts/onedrive-skip-file-config.ts
npx tsx scripts/onedrive-skip-file-config.ts --apply
# 2. Aplicar a config nova (mudar skip_file exige --resync, ver item 2):
systemctl --user stop onedrive
onedrive --sync --resync --resync-auth --dry-run   # conferir que o plano não tem deleção
onedrive --sync --resync --resync-auth
systemctl --user start onedrive
journalctl --user -u onedrive -n 50 --no-pager
```

Não usar só `systemctl --user restart onedrive` aqui: no cliente v2.5.x o daemon sai com status 126 pedindo `--resync` e o sync fica parado (#11256). O resync relista a conta inteira: fazer com tempo.

```bash
# 3. Liberar a cota: os .mp4 que já subiram seguem ocupando espaço online.
#    Apagar pelo OneDrive web (pasta Documentos/diaria-studio-data/editions,
#    filtrar por .mp4) e esvaziar a lixeira (Lixeira → Esvaziar e, depois,
#    "Lixeira de segundo estágio" no painel). Com *.mp4 no skip_file, apagar
#    online não apaga a cópia local.
# 4. Retenção local (opcional, depois de olhar o dry-run):
npx tsx scripts/prune-edition-videos.ts
npx tsx scripts/prune-edition-videos.ts --apply
# 5. Conferir o alarme (dry-run não grava canário nem cria issue):
npx tsx scripts/onedrive-sync-alarm.ts --dry-run
```

### Efeitos colaterais a conferir

- **Vídeo deixa de atravessar máquinas.** Com `*.mp4` fora do sync no `300`, um vídeo baixado ou gerado lá não aparece no Windows do editor, e vice-versa. O caso conhecido é o passo guiado do Instagram no Chrome (`/diaria-shorts`, Passo 3b, roda só no Windows) usando `_internal/diaria-comentada-{AAMMDD}-short-instagram-chrome.mp4`: se o `--publish` que gera esse arquivo rodou no `300`, ele precisa ser gerado de novo no Windows (ou o vertical baixado do Drive lá).
- **O Windows não lê `skip_file`.** O cliente oficial do Windows não tem essa chave; o equivalente é a política "Excluir tipos específicos de arquivo do upload" (`EnableODIgnoreListFromGPO`, registro `HKLM\SOFTWARE\Policies\Microsoft\OneDrive\EnableODIgnoreListFromGPO` com um valor `*.mp4`). Sem isso, um `.mp4` salvo em `data/` no Windows continua subindo.

## Relacionadas

#5526 (rodada que sofreu o skip silencioso), #5227 (migração de `data/snippets/` — mesmo junction OneDrive), #5112/#5339 (mecanismo de alarme→issue reusado aqui), #7169 (o segundo detector), #7300 (cross-referência entre os dois).
