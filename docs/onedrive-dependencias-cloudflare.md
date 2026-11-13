# Dependências do `data/` sincronizado e o que pode ir para a Cloudflare (#12736)

Mapa pedido na #12736: tudo que lê ou grava em `data/` por meio do sync de
arquivo (OneDrive hoje, Google Drive depois do cutover da #12359), separado
entre **arquivo de trabalho**, que fica no Drive, e **estado trocado entre
máquinas** (registro, sinal, lock, contador), que sofre com sync de arquivo e
pode ir para KV, R2, D1 ou um Worker.

Este documento só mapeia e recomenda. A decisão de migrar cada grupo é do
editor; as issues filhas propostas estão na seção 6.

## 1. Método e data da medição

Medido no `300` em 10/11/2026, com o `data/` ainda no OneDrive
(`/home/vjpixel/diaria-studio/data -> ~/OneDrive/Documentos/diaria-studio-data`).

- Tasks: `npx tsx scripts/lib/scheduled-tasks.ts --json` (128 tasks systemd do
  `300`) e `--desktop` (1 task do app Claude no Neo). Tabela completa no
  apêndice A.
- Caminhos: busca por `data/` e pelos helpers de caminho (`sessionsDir`,
  `editionDir`, `DEFAULT_STORE_PATH`, `DEFAULT_DB_PATH`) em `scripts/`,
  `scripts/lib/` e `.claude/hooks/`.
- Evidência de conflito: contagem das cópias de conflito que os clientes de
  sync deixam em `data/`. `*-300-safeBackup-NNNN.*` é o cliente do `300`
  (`abraunegg/onedrive`) perdendo uma corrida, quase sempre contra o próprio
  script (o caso da #12474). `*-Neo[-N].*` é o cliente do Windows registrando
  escrita concorrente de duas máquinas. Os números estão na seção 3.
- Varredura de imports para a coluna de credencial Google (seção 4, G11): um
  script de varredura estática seguiu os imports locais de cada task e marcou
  quem alcança `scripts/google-auth.ts`. Varredura de import superestima (o
  import não prova que a chamada acontece em toda execução), e por isso só
  esse sinal entrou no mapa; as outras marcações do apêndice são por nome de
  task e pelo arquivo exigido do registro.

## 2. Premissas que mudam a recomendação

1. **Três máquinas escrevem em `data/`.** `data/sessions/` tem hoje registros
   de `300`, `Neo` e `Zenbook` (96, 28+9 e 5 arquivos). As 128 tasks rodam só no
   `300`; a única task fora dele é `diaria-short-video-relacionado`, no Neo
   (`scripts/lib/scheduled-tasks.ts:3815`). Edições, `/diaria-develop`,
   `/diaria-video-montagem` e `/diaria-publica` rodam no Neo ou no `300`.
2. **Depois do cutover o `300` sincroniza em rodadas, não em tempo real.** O
   bisync dedicado de `data/` roda 1 min depois do fim da rodada anterior
   (`scripts/systemd/gdrive-data-bisync.sh:5`), com `--conflict-resolve newer
   --conflict-loser num` (`scripts/systemd/gdrive-bisync.sh:188`). Um sinal
   gravado no Neo chega ao `300` em minutos, e escrita concorrente nas duas
   pontas passa a ser decidida por mtime, com o perdedor renomeado. Para
   arquivo de trabalho isso basta; para lock, contador e "isto aconteceu ou
   não" piora em relação ao `onedrive --monitor`.
3. **Lock em arquivo não exclui entre máquinas.** `O_CREAT|O_EXCL`
   (`flag: "wx"`) e `rename` atômico valem dentro de um sistema de arquivos.
   Cada máquina tem a própria cópia de `data/`; as duas veem o arquivo
   ausente e as duas "ganham" (#6182). Vale para o merge lock, o lock de
   edição e os locks O_EXCL das tasks.
4. **Já existe uma lista de arquivos que nunca atravessam máquinas.**
   `DATA_LOCAL_ONLY_PATTERNS` (`scripts/lib/data-sync-exclusions.ts:56-67`):
   `*.db-wal`/`*.db-shm`, `run-log*.jsonl`, `*.mp4`, `inbox*.md`,
   `drive-cache*.json`, `*safeBackup*`. O mesmo bloco vai para o `skip_file`
   do OneDrive e para os filtros do rclone. Parte das recomendações abaixo é
   só acrescentar padrões a essa lista.
5. **O que a Cloudflare oferece, e para quê serve cada peça.** A conta é
   Workers Paid (fatura conferida pelo editor em 09/11/2026, #12533;
   reconferir com `npx tsx scripts/cloudflare-plan.ts`).
   - **KV**: chave-valor com consistência eventual e sem compare-and-swap. A
     Cloudflare documenta "up to 60 seconds or more" para uma escrita
     aparecer em outros pontos (conferido em 10/11/2026 em
     https://developers.cloudflare.com/kv/concepts/how-kv-works/); o número
     é piso, não teto.
     Serve para registro "último valor vence" e sinal de um escritor só. Não
     serve para lock. Cliente REST pronto: `scripts/lib/cloudflare-kv-rest.ts`
     (`createKvRestOps`, linha 109).
   - **D1**: SQLite gerenciado com um primário, consistente, consultável por
     REST (`POST /accounts/{account_id}/d1/database/{database_id}/query`)
     sem Worker. Serve para
     lock com TTL e registro com escrita condicional (`INSERT ... ON CONFLICT
     DO UPDATE ... WHERE`). O projeto ainda não tem banco D1. O endpoint foi
     conferido em 10/11/2026 em
     https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/;
     o modelo de consistência foi conferido em 11/11/2026 pela #12842 em
     https://developers.cloudflare.com/d1/best-practices/read-replication/:
     um primário; escritas sempre vão a ele; sem a Sessions API (que só
     existe no binding de Worker, não na REST) toda query roda no primário,
     mesmo com a replicação de leitura ligada. Por REST, então, leitura e
     escrita são consistentes e o upsert condicional decide a corrida.
     Implementado em `scripts/lib/d1-locks.ts` (G2a, abaixo).
   - **Durable Object**: consistência forte por objeto, mas exige Worker
     próprio. Só compensa se o D1 não der conta, o que nada aqui indica.
   - **R2**: objetos grandes. O bucket `diaria-shorts` já é usado
     (`workers/poll/wrangler.toml`, `workers/site/wrangler.toml`), com cliente
     em `scripts/lib/r2-object-upload.ts`.

## 3. Evidência de conflito medida (10/11/2026)

Cópias de conflito em `data/`, agrupadas pelo arquivo de origem (fora
`editions/`):

| Arquivo | `-300-safeBackup` | `-Neo` | Escritores |
|---|---:|---:|---|
| `brevo-rate-state.json` | 19 | 3 | todas as máquinas, a cada resposta Brevo da família de campanhas |
| `brevo-diaria/kit-sem-abertura-log.jsonl` | 11 | 0 | `300` (lote) |
| `kit-frio/reativacao-pelo-form-261102.jsonl` | 9 | 0 | `300` (lote) |
| `sessions/.merge-lock.json` | 7 | 0 | coordenadores de todas as máquinas |
| `apoia-se/diaria/2026-10.json` | 7 | 0 | `300` |
| `clarice-subscribers/.brevo-sync-checkpoint-inc.json` | 6 | 0 | `300` (`scripts/clarice-sync-brevo.ts:112`) |
| `sessions/` fora o merge lock (soma) | 31 | 0 | o hook `session-beacon.mjs` de cada sessão |
| `overnight/{rodada}/plan.json` (soma) | 30 | 3 | coordenador do overnight; develop no Neo |
| `brave-credits.jsonl` | 4 | 0 | Etapa 1 de qualquer máquina |
| `.credentials.json` | 0 | 3 | refresh do token Google em qualquer máquina |
| `reports/index.jsonl` | 2 | 1 | registro de relatório de qualquer máquina |
| `session-lifecycle.jsonl` | 1 | 1 | `session-registry.ts` de qualquer máquina |
| `continuo/last-tick-report.md` | 2 | 0 | `300` |
| `past-editions.md` | 1 | 0 | Etapa 0 de qualquer máquina |

Em `editions/` há 95 `safeBackup` (os mais frequentes:
`261105/_internal/06-shorts-sending.json` com 4, `261111/06-public-images.json`
com 3, rascunhos e prompts de D3) e um bloco de cópias `-Neo` em `261030`
(`stage-status.json`, HTML renderizados, `fact-check.json`): duas sessões na
mesma edição, o caso que o `edition-lock` (#10309) passou a barrar.

Leitura: a maior parte dos `safeBackup` é o cliente do `300` brigando com o
próprio script (#12474) e some com o desligamento do OneDrive (#12360). As
cópias `-Neo` e os arquivos com escritores em máquinas diferentes
(`brevo-rate-state.json`, `.merge-lock.json`, `.credentials.json`, logs
compartilhados) são o problema que continua depois do cutover.

## 4. Mapa por grupo

Cada grupo junta dados com a mesma natureza e o mesmo destino. "Entre
máquinas" quer dizer que quem grava e quem lê podem estar em máquinas
diferentes. Esforço e risco são estimativas para orientar a ordem, não
orçamento.

### G1. Arquivos de trabalho da edição e dos produtos editoriais

- **Caminhos:** `data/editions/{AAMM}/{AAMMDD}/**` (resolvido por
  `editionDir()`), `data/weekly/`, `data/monthly/`, `data/annual/`,
  `data/cortes/{slug}/`, `data/artigo-especial/`, `data/snippets/` (#5227),
  `data/brand/`, `data/livros/`.
- **Quem grava / lê:** sessões de edição no Neo ou no `300`; o Studio
  (`300`) lê e grava `02-reviewed.md`/`03-social.md`; tasks do `300` leem
  (apêndice A, grupo G1).
- **Natureza:** arquivo de trabalho, texto e imagem; escrita em rajada
  durante uma etapa, depois quase só leitura.
- **Destino:** Google Drive, como hoje. É o caso para o qual sync de arquivo
  serve, e o editor abre essas pastas.
- **Esforço:** nenhum além do cutover.
- **Risco:** o de hoje. Concorrência entre sessões na mesma edição é barrada
  pelo `edition-lock` (G2), não pelo sync. Vídeo já não atravessa por aqui:
  `*.mp4` está em `DATA_LOCAL_ONLY_PATTERNS` e o vertical vai por R2 desde a
  #12473.

### G2. Registro de sessões, merge lock e locks entre máquinas

- **Caminhos:**
  - `data/sessions/{kind}-{host}-{id}.json`, `sessionsDir()` em
    `scripts/lib/session-registry.ts:918`; gravado a cada chamada de
    ferramenta pelo hook `.claude/hooks/session-beacon.mjs` (throttle de 5 s,
    `MIN_WRITE_INTERVAL_MS`, linha 136).
  - `data/sessions/.merge-lock.json` e `.merge-lock--{owner}--{repo}.json`,
    `mergeLockPath()` em `scripts/lib/session-registry.ts:935`, TTL de 2 min
    (`MERGE_LOCK_TTL_MS`, linha 781).
  - `.merge-grant-consumed-*.json`, `.worktree-claims/<hash>.json`,
    `.registry.jsonl` no mesmo diretório.
  - `{EDITION_DIR}/_internal/edition-lock.json`
    (`scripts/lib/edition-lock.ts:9`, TTL de 45 min na linha 41).
- **Quem grava / lê:** toda sessão de Claude Code de toda máquina. Leem os
  hooks `block-gh-pr-merge-subagent.mjs` (linhas 283, 359, 418),
  `inject-session-id.mjs`, `block-worktree-alien-commit.mjs` (linha 109),
  `consume-merge-grant-on-merge.mjs`, o coordenador do overnight/develop/
  continuo, a task `Diaria-Session-Registry-Gc` e a Triagem do Studio.
- **Natureza:** registro pequeno (1 JSON por sessão) e locks com TTL.
  Escrita frequente (beacon a cada 5 s por sessão ativa).
- **Problema:** o merge lock não exclui entre máquinas (#6182, premissa 3);
  com o bisync em rodadas, a latência pode passar dos 2 min do TTL. A #12547
  é o mesmo dado visto pelo outro lado: com o cliente de sync parado no Neo,
  o guard de merge lê um `data/sessions` velho e falha com erro genérico.
- **Destino recomendado:** **D1**, em duas partes.
  1. Locks (merge lock por repo, consumo de grant, `edition-lock`) numa
     tabela `locks(name PRIMARY KEY, holder, expires_at)`, tomados com
     `INSERT ... ON CONFLICT(name) DO UPDATE ... WHERE expires_at < :agora`
     e conferidos pelo número de linhas alteradas. É o que dá exclusão real
     entre máquinas. KV não serve aqui (sem CAS, consistência eventual).
     **Feito na #12842:** `scripts/lib/d1-locks.ts` (tabela `locks` com
     `acquired_at`/`expires_at` no relógio do D1, conferência pelo
     `RETURNING`), integrado em `session-registry.ts merge-lock-*`,
     `consume-merge-grant`/`check-merge-grant`, `scripts/edition-lock.ts` e
     nos hooks `block-gh-pr-merge-subagent.mjs`/`consume-merge-grant-on-merge.mjs`
     (`.claude/hooks/lib/d1-locks.mjs`). Quando o D1 responde, ele decide
     (o arquivo é espelho e não veta); quando não responde, o arquivo é o
     fallback, com aviso. Erro permanente (HTTP 4xx, tabela ausente,
     réplica) vira ERRO no stderr e `d1_locks_permanent_error` no run-log,
     em vez do aviso de queda passageira. Liga quando
     `platform.config.json` → `d1_locks.database_id` é preenchido
     (`scripts/d1-locks-setup.ts`). A autorização de uso único do vídeo
     (`video-publish-authorization.ts`) ficou fora: já recusa consumo de
     outro host.
  2. Registro de sessões: o beacon continua gravando o arquivo local (é hook
     síncrono de toda chamada de ferramenta; uma ida à rede ali põe latência
     em cada `Bash`), e um espelho empurra o estado para o D1 de tempos em
     tempos. Os leitores entre máquinas (guard de merge, liveness do
     coordenador, GC) passam a ler do D1.
- **Esforço:** alto. `session-registry.ts` tem ~8 mil linhas e vários
  consumidores, inclusive o kind `continuo`, usado pelo Hermes
  (CLAUDE.md). A tabela de locks sozinha é médio.
- **Risco:** hook sem rede (Neo offline, Cloudflare fora) precisa de
  comportamento definido, hoje o fail-open/fail-closed de cada hook está
  escrito para arquivo ausente; sessão cloud sem `data/` ganha acesso ao
  registro, o que muda o que `exec-mode.ts` responde; testes rodam sobre
  `MergeLockIo` injetado e precisam de um backend D1 falso. Fazer os locks
  primeiro e deixar o registro para depois reduz o risco.

### G3. Vínculo do vídeo relacionado do Short (Neo grava, `300` confere)

- **Caminho:** `{EDITION_DIR}/_internal/06-short-related.json`
  (`SHORT_RELATED_FILE`, `scripts/lib/diaria/youtube-short-related.ts:41`).
- **Quem grava / lê:** grava a task do Neo `diaria-short-video-relacionado`
  (`.claude/skills/diaria-publica-video/short-related-task.md:62`); lê o
  `Diaria-Short-Related-Missed-Alarm` no `300`
  (`scripts/short-related-missed-alarm.ts`, `evaluateShortRelatedMissed`, o
  caso `missing-record`).
- **Natureza:** sinal pequeno, um escritor, uma chave por edição, 1 escrita
  por dia útil.
- **Problema:** a ausência do arquivo no `300` não diz se a task não rodou ou
  se o arquivo não replicou (#12541, #12315).
- **Destino recomendado:** **KV**, já decidido pelo editor na #12541 (item 2).
  Chave `short-related:{AAMMDD}`, valor com `linked|failed|alerted`, IDs e
  timestamp. O arquivo da edição continua sendo gravado, para quem lê a pasta.
  **Implementado** (11/11/2026): namespace `diaria-ops-state`
  (`platform.config.json` → `ops_state_kv.namespace_id`), gravação por
  `scripts/short-related-kv-publish.ts` (Passo 6 do roteiro da task), leitura
  no alarme antes do arquivo (`scripts/lib/diaria/short-related-kv.ts`).
- **Esforço:** baixo. Cliente REST pronto; a task do Neo ganha um `put`, o
  alarme ganha um `get`.
- **Risco:** baixo. Consistência eventual não atrapalha: o alarme roda às
  13:30, horas depois da escrita. A task do Neo precisa do token Cloudflare
  no `.env` do Neo.
- **Issue:** a #12541 já cobre; não abrir filha.

### G4. Registro e marcador de envio do vertical, estado do horizontal

- **Caminhos:** `_internal/06-shorts-published*.json`
  (`SHORTS_PUBLISHED_FILE`, `scripts/lib/diaria/short-video.ts:109`),
  `_internal/06-shorts-sending*.json`
  (`scripts/lib/diaria/shorts-sending-marker.ts:44`),
  `_internal/05-youtube-step.json`
  (`scripts/lib/diaria/edition-video-evidence.ts:40`),
  `_internal/no-video.json` (`scripts/lib/diaria/d1-no-video.ts:34`),
  `data/cortes/{slug}/_internal/.shorts-corte-timer.lock` e o heartbeat
  (`scripts/shorts-corte-timer.ts:41`, `:71`).
- **Quem grava / lê:** `/diaria-publica` no Neo ou no `300` e os timers do
  vertical no `300` (apêndice A, G4).
- **Natureza:** registro do que foi publicado em plataforma pública e marca
  "envio em curso" que evita post duplicado.
- **Situação:** o registro e a marca já são um arquivo por escritor (#11157,
  comentário em `shorts-sending-marker.ts:32-33`), então duas máquinas nunca
  gravam o mesmo arquivo. O que sobra é latência: a marca vale por 90 min
  para o timer do corte, folga larga contra o atraso do bisync. Os 4
  `safeBackup` de `261105/_internal/06-shorts-sending.json` são o cliente do
  `300` contra o próprio script.
- **Destino recomendado:** continua no Drive. Reavaliar junto da tabela de
  locks do G2 se aparecer post duplicado com as duas máquinas no mesmo
  destino; aí a marca vira uma linha em `locks`.
- **Esforço / risco:** nenhum agora.

### G5. Contador da cota horária da Brevo

- **Caminho:** `data/brevo-rate-state.json` (`DEFAULT_RATE_STATE_PATH`,
  `scripts/lib/brevo-rate-state.ts:38`; escrita na linha 91, sem atomic
  write).
- **Quem grava / lê:** `brevo-client.ts` grava a cada resposta da família
  `/v3/emailCampaigns*`, em qualquer máquina; leem os diagnósticos que
  chamam `assertCampaignQuotaHeadroom()`. Tasks do `300` envolvidas:
  apêndice A, G5.
- **Natureza:** um valor (o último `x-sib-ratelimit-remaining` observado) de
  uma cota que é da CONTA Brevo, não da máquina (`docs/brevo-rate-limits.md`).
  Até ~100 escritas por hora, que é o teto da própria cota.
- **Problema:** o arquivo mais conflitado de `data/` (19 `safeBackup`, 3
  cópias `-Neo`). Cópia local defasada faz uma máquina achar que tem folga
  que a outra já gastou, justamente o incidente que motivou o arquivo (#5697).
- **Destino recomendado:** **KV**, chave única `brevo-rate:{conta}` com o
  valor e o timestamp da observação; leitor descarta observação mais velha
  que a janela de 1 h. "Último valor vence" é a semântica certa: o valor vem
  do header da própria Brevo. Teto de escrita: ~72 mil por mês por conta, bem
  abaixo do 1 milhão do plano.
- **Esforço:** baixo. O módulo é fail-soft por desenho (falha de
  leitura/escrita nunca quebra a chamada real), então trocar o backend não
  muda o caminho crítico.
- **Risco:** baixo. Uma ida à rede por resposta da Brevo; manter o arquivo
  local como cache e mandar ao KV sem bloquear a chamada.
- **Feito (#12841):** chave `brevo-rate:email-campaigns` no namespace
  `diaria-ops-state` (`ops_state_kv`, o mesmo do #12541). A escrita grava o
  arquivo e manda o estado ao KV em segundo plano (PUTs do mesmo processo em
  ordem, intermediários coalescidos); os leitores chamam
  `refreshCampaignQuotaStateFromKv()` antes do assert, que traz a observação
  do KV para o arquivo quando é mais nova. KV fora do ar ou sem credencial
  (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN`) cai no arquivo, sem
  lançar; `BREVO_RATE_STATE_KV=0` desliga. A chave é uma só, como o arquivo:
  o header não diz de qual conta Brevo veio a resposta.

### G6. Interruptores e overrides do editor

- **Caminhos:** `data/clarice-envio-enabled.json`
  (`scripts/lib/clarice-envio-enabled.ts:154`, escrita na linha 234),
  `data/clarice-novos-enabled.json`, `data/clarice-envio-override.json`,
  `data/apoio-overrides.json`.
- **Quem grava / lê:** o editor (Studio no `300` ou sessão no Neo) grava;
  as tasks `Diaria-Clarice-Novos`, `-Novos-Tarde` e `-Envio` leem no `300`.
- **Natureza:** sinal, escrita rara (dias ou semanas), leitura diária.
- **Destino recomendado:** continua no Drive. Atraso de minutos entre o
  clique e a task é aceitável para uma task diária. Se o interruptor passar a
  ser usado como freio de emergência (desligar um envio que começa em
  minutos), vira KV.
- **Esforço / risco:** nenhum agora.

### G7. Stores JSON e logs de um escritor só (o `300`)

- **Caminhos:** `data/brevo-diaria/contacts.json`
  (`scripts/lib/brevo-diaria-store.ts:39`), `data/onboarding/store.json`
  (`scripts/lib/onboarding-store.ts:42`), `data/brevo-diaria/kit-sem-abertura-log.jsonl`,
  `data/kit-frio/*.jsonl`, `data/apoia-se/diaria/{AAAA-MM}.json`,
  `data/clarice-subscribers/.brevo-sync-checkpoint-inc.json`
  (`scripts/clarice-sync-brevo.ts:112`), `data/overnight/{rodada}/plan.json`,
  `data/continuo/`.
- **Quem grava / lê:** tasks e coordenadores do `300`; o Studio (`300`) lê.
  Escrita no Neo é exceção (develop grava o próprio `data/develop/`).
- **Natureza:** estado de domínio ou plano de rodada, gravado em lote.
- **Problema:** é o grupo da #12474. Os `safeBackup` vêm do cliente OneDrive
  do `300` brigando com o próprio script, não de outra máquina. O
  `restore-brevo-semanal-suppressed.ts` já passou a gravar em lote
  (`createBatchedStoreWriter`, linha 142).
- **Destino recomendado:** continua no Drive (serve de cópia de segurança e o
  editor consulta). O self-race acaba com o OneDrive (#12360); o rclone
  bisync lê o arquivo na rodada e, com escrita atômica (tmp + rename), não
  pega arquivo pela metade. Conferir depois do cutover que nenhum `*.conflict*`
  do rclone aparece nesses caminhos.
- **Esforço / risco:** nenhum para a Cloudflare.

### G8. Bancos SQLite

- **Caminhos:** `data/clarice-subscribers/clarice-users.db` (195 MB,
  `scripts/lib/clarice-db.ts:62-64`, WAL na linha 204) e
  `data/diaria-subscribers/diaria-subscribers.db` (76 MB,
  `scripts/lib/diaria-subscribers-db.ts:95-97`, WAL na linha 701).
- **Quem grava / lê:** só tasks do `300` (apêndice A, G8) e o Studio no
  `300`.
- **Natureza:** banco com escrita diária em volume (sync da Brevo, ingestão do
  Kit) e milhares de consultas por execução.
- **Problema:** o sync sobe o `.db` sem o `-wal` (os dois padrões estão em
  `DATA_LOCAL_ONLY_PATTERNS`). A cópia que chega a outra máquina pode não ter
  as transações ainda no WAL, e uma cópia feita durante um checkpoint pode
  sair inconsistente. Cada escrita também reenvia centenas de MB.
- **Destino recomendado:** **local no `300`**, fora da árvore sincronizada,
  com snapshot consistente (`VACUUM INTO` ou a API de backup do SQLite) uma
  vez por dia para o Drive ou para o R2. D1 não compensa: exigiria reescrever
  o acesso de dezenas de scripts para chamadas de rede, e ninguém fora do
  `300` precisa do banco ao vivo.
- **Esforço:** médio (mover o caminho padrão, task de snapshot, apontar o
  `requiredFile` das tasks para o novo lugar).
- **Risco:** sessão no Neo que rode skill da Clarice (`/diaria-clarice-envio`)
  perde o banco local; pela regra atual essas rodadas já são do `300`.
  Restauração passa a depender do snapshot, que precisa de alarme de
  frescor.
- **Fora da Cloudflare**, mas entra no mapa porque decide o que o cutover
  carrega.

### G9. Logs append-only escritos por mais de uma máquina

- **Caminhos:** `data/session-lifecycle.jsonl`
  (`scripts/lib/session-registry.ts:2105`), `data/reports/index.jsonl`
  (`scripts/register-report.ts`; lido pela superfície de Relatórios do Studio
  e por `scripts/calibration-allowlist-growth-report.ts:77`),
  `data/brave-credits.jsonl` (`scripts/lib/brave-credits.ts:71`),
  `data/social-schedule-rotation.jsonl`
  (`scripts/lib/social-schedule-rotation-record.ts:32`),
  `data/source-health.json` (reescrito inteiro em
  `scripts/record-source-run.ts:195`).
- **Quem grava / lê:** qualquer máquina que rode edição, sessão ou relatório;
  leem o Studio, as tasks de relatório e o auto-reporter.
- **Problema:** duas máquinas anexando ao mesmo arquivo geram cópia de
  conflito e linhas perdidas na reconciliação (tabela da seção 3).
- **Destino recomendado:** **arquivo por máquina** no Drive
  (`{nome}-{host}.jsonl`), com os leitores fazendo a união. Não precisa de
  Cloudflare. O `run-log.jsonl` já é local por máquina
  (`DATA_LOCAL_ONLY_PATTERNS`), com um efeito colateral: o auto-reporter
  (`scripts/collect-edition-signals.ts:2134`) só vê o log da máquina onde roda,
  e uma edição que fez a Etapa 1 no Neo e a 5 no `300` chega incompleta. O
  mesmo esquema por host, sincronizado, resolveria os dois casos.
- **Esforço:** baixo por arquivo (helper de caminho por host + leitor que
  junta).
- **Risco:** leitor esquecido que continue lendo o nome antigo; procurar todos
  os leitores antes de cada troca.

### G10. Logs e estado de alarme das tasks do `300`

- **Caminhos:** o `logPath` das 128 tasks (todos sob `data/`) e os
  `*-alarm-issues.json`/`*-state.json` dos alarmes.
- **Quem grava / lê:** a própria task e outros alarmes, todos no `300`.
- **Destino recomendado:** nenhuma mudança. Atravessar para o Drive só serve
  para leitura de depuração em outra máquina.
- **Esforço / risco:** nenhum.

### G11. Credenciais em `data/`

- **Caminhos:** `data/.credentials.json` (`scripts/google-auth.ts:31`,
  reescrito a cada refresh de access token na linha 85),
  `data/.fb-credentials.json` (`scripts/stage-0-run.ts:502`).
- **Quem grava / lê:** toda máquina que manda e-mail ou fala com Gmail, Drive,
  YouTube ou GA4. Pela varredura de imports, 80 das 128 tasks alcançam
  `scripts/google-auth.ts` (em boa parte para mandar o e-mail de alarme).
- **Problema:** o refresh token é o mesmo para todos, mas o access token
  expira em ~1 h e cada máquina reescreve o arquivo inteiro ao renová-lo. Daí
  as 3 cópias `-Neo`. O cliente que perde a reconciliação pode ficar com um
  refresh token velho se alguém rodar `oauth-setup.ts` numa máquina.
- **Destino recomendado:** **fora da Cloudflare.** Separar o cache do access
  token (local por máquina, novo padrão em `DATA_LOCAL_ONLY_PATTERNS`) do
  refresh token (compartilhado, raramente muda; candidato ao Doppler, onde já
  vivem os outros segredos).
- **Esforço:** baixo.
- **Risco:** a troca de `oauth-setup.ts` precisa chegar às três máquinas; até
  lá, manter a leitura do formato antigo.

### G12. Cursores, cotas e caches da pesquisa

- **Caminhos:** `data/inbox-cursor.json` (`scripts/inbox-drain.ts:69`),
  `data/inbox.md` (linha 73), `data/newsletter-capture-cursor*.json`,
  `data/exploration-quota.json` (`scripts/lib/exploration-quota.ts:230`),
  `data/link-verify-cache.json`, `data/past-editions.md`, `data/eia-used.json`.
- **Quem grava / lê:** Etapas 0 e 1 de qualquer máquina; uma edição por vez.
- **Destino recomendado:** continua no Drive.
- **Achado a conferir (não é Cloudflare):** `inbox-cursor.json` atravessa
  máquinas, mas `inbox*.md` está em `DATA_LOCAL_ONLY_PATTERNS`. Um dreno no Neo
  avança o cursor de todos e grava o conteúdo só no `inbox.md` do Neo; uma
  Etapa 1 seguinte no `300` não vê as submissões que sobraram. Não foi
  reproduzido aqui; vale uma issue própria para confirmar.

### G13. Alarmes do próprio sync

- **Tasks:** `Diaria-OneDrive-Sync-Alarm`, `Diaria-GDrive-Sync-Alarm`, e o
  `data/sessions/.safebackup-alarm.log` do GC de sessões.
- **Destino:** saem ou mudam com a #12360. Se os G2, G3 e G5 forem para a
  Cloudflare, o alarme do Drive deixa de proteger estado crítico e pode ter a
  urgência reduzida.

### G14. Banco de agendamentos (sessões gravam, `300` lê)

Acrescentado em 11/11/2026, depois da medição da seção 1: a task
`Diaria-Agendamentos-Tick` (#12774) entrou no registro depois do censo.

- **Caminho:** `data/agendamentos/banco.json` (`AGENDAMENTOS_DB_REL_PATH`,
  `scripts/lib/diaria/agendamentos.ts:40`).
- **Quem grava / lê:** gravam as sessões de vídeo e publicação
  (`/diaria-video-montagem`, `/diaria-publica`) pelo CLI
  `scripts/agendamentos.ts`, no Neo ou no `300`; lê a task
  `Diaria-Agendamentos-Tick` no `300`, de hora em hora
  (`scripts/agendamentos-tick.ts`), que nunca grava.
- **Natureza:** registro pequeno (um item por peça agendada, poucas escritas
  por dia), arquivo único com várias máquinas escrevendo.
- **Situação:** a escrita é atômica e tem revisão otimista
  (`saveAgendamentos`, linha 187), mas a revisão é conferida contra o disco
  local: duas máquinas que gravam antes de o sync replicar a escrita uma da
  outra passam as duas na conferência, e o cliente de sync fica com uma das
  versões (ou com uma cópia de conflito). Na prática é uma sessão por vez
  (comentário da linha 24), e nenhuma escrita perdida publica nada em
  dobro: um `marcar` perdido vira alarme de item vencido no `tick`, mas um
  `registrar` perdido some sem alarme (o item não existe para o `tick` nem
  para a listagem do `/diaria-publica` de D+7).
- **Destino recomendado:** continua no Drive. Se aparecer cópia de conflito
  de `banco.json` ou item sumido, o banco vai para o D1 junto da tabela de
  locks do G2a: a revisão otimista vira `UPDATE ... WHERE revisao = :lida`,
  que o D1 executa de forma atômica.
- **Esforço / risco:** nenhum agora.

## 5. Resumo e ordem sugerida

| Grupo | Dado | Entre máquinas | Destino | Esforço | Risco | Ordem |
|---|---|---|---|---|---|---|
| G3 | vínculo do vídeo relacionado | sim (Neo para `300`) | KV | baixo | baixo | 1 (#12541) |
| G5 | `brevo-rate-state.json` | sim (todas) | KV | baixo | baixo | 2 |
| G2a | merge lock, grant, `edition-lock` | sim (todas) | D1 | médio | médio | 3 |
| G2b | registro de sessões | sim (todas) | D1 (espelho do arquivo local) | alto | médio-alto | 4, depois do G2a |
| G9 | logs append-only compartilhados | sim | arquivo por host no Drive | baixo | baixo | quando der, sem Cloudflare |
| G11 | `.credentials.json` | sim | cache local + Doppler | baixo | baixo | quando der, sem Cloudflare |
| G8 | SQLite | não (só `300`) | local + snapshot no Drive/R2 | médio | médio | antes do cutover, se possível |
| G4 | registro/marca do vertical | sim, já por escritor | Drive; D1 se houver duplicado | nenhum | baixo | reavaliar |
| G6 | interruptores | sim, escrita rara | Drive; KV se virar freio de emergência | nenhum | baixo | reavaliar |
| G14 | banco de agendamentos | sim (sessões para `300`) | Drive; D1 se houver conflito | nenhum | baixo | reavaliar |
| G1, G7, G10, G12 | trabalho, stores do `300`, logs de task, cursores | trabalho sim, resto não | Drive | nenhum | o de hoje | cutover normal |
| G13 | alarmes do sync | não | sai com a #12360 | baixo | baixo | com a #12360 |

Por que essa ordem: G3 e G5 são escritores simples, sem necessidade de
exclusão, e servem de piloto para o caminho de script para KV no Neo e no `300`
(token, timeout, fallback). G2a é o único que precisa de consistência forte e
resolve uma falha conhecida (#6182, #12547); vem antes do registro inteiro
porque é menor e não toca o hook do beacon. G8 não é Cloudflare, mas tirar
271 MB de banco do sync antes do cutover encurta a cópia final e o `rclone
check` da #12359.

O cutover da #12359 não depende de nenhuma dessas migrações. O que muda é
que, sem elas, G2 e G5 passam a ter a latência do bisync em vez da do
`onedrive --monitor`.

## 6. Issues filhas propostas

Para os grupos que valem ir para a Cloudflare (critério de pronto da
#12736). Abrir depois que o editor escolher quais seguem:

1. **G3**: já coberto pela #12541 (item 2).
2. **G5**: "Mover `brevo-rate-state.json` para KV da Cloudflare" (P2:
   arquivo mais conflitado de `data/`, cota é da conta e não da máquina).
3. **G2a**: "Locks entre máquinas em D1: merge lock, consumo de grant e
   edition-lock" (P2: exclusão entre máquinas hoje não existe, #6182; guard
   falha com sync parado, #12547).
4. **G2b**: "Espelhar o registro de sessões em D1 para os leitores entre
   máquinas" (P3: depende do G2a; maior superfície, inclui consumidor externo
   do kind `continuo`).

Fora da Cloudflare, mas achados deste mapa que merecem issue própria:

5. **G8**: "SQLite da Clarice e de assinantes fora do sync, com snapshot
   diário" (P2: o `.db` atravessa sem o WAL).
6. **G9**: "Logs append-only por host (`session-lifecycle`, `reports/index`,
   `brave-credits`, `social-schedule-rotation`, `source-health`, `run-log`)"
   (P3).
7. **G11**: "Separar o access token Google (local) do refresh token
   (compartilhado)" (P3).
8. **G12**: "Conferir `inbox-cursor.json` sincronizado com `inbox*.md` local
   por máquina" (P3, a confirmar).

## Apêndice A. Tasks agendadas e grupos

Gerado de `npx tsx scripts/lib/scheduled-tasks.ts --json` em 10/11/2026.
"Arquivo exigido" é o `requiredFile` do registro (a task não roda se ele
faltar). A coluna de grupos é por nome da task e arquivo exigido; G10 vale
para todas, porque todo log está em `data/`.

**Limite desta coluna:** os grupos saem do nome da task e do `requiredFile`,
não da leitura de cada script. Task com dependência fora do padrão do nome
pode ter ficado só em G10, e uma marcação pode sobrar (caso corrigido:
`Diaria-Clarice-Dashboard-Precompute`, ver a linha). A tabela serve para
decidir os grupos; a issue filha de cada grupo refaz a lista de tasks lendo os
scripts antes de escopar a migração.

**Mantido em dia por teste:** `test/onedrive-dependencias-inventario-12736.test.ts`
falha quando uma task de `SCHEDULED_TASKS` (ou do `DESKTOP_SCHEDULED_TASKS`)
não tem linha aqui, quando sobra linha de task que saiu do registro, ou
quando a coluna de grupos fica vazia ou cita um grupo sem seção `### Gn.` na
seção 4. Task nova entra com uma linha nesta tabela e os grupos dela; se não
couber em nenhum grupo, ganha um grupo novo na seção 4.

Task fora do systemd: `diaria-short-video-relacionado` (Neo, `5 6 * * 1-5`,
`.claude/skills/diaria-publica-video/short-related-task.md`), grupos G3 e G4.

| Task | Agenda | Estado | Script principal | Log em `data/` | Arquivo exigido | Grupos |
|---|---|---|---|---|---|---|
| Diaria-Apoios-Diff-Alarm | daily 09:45 | armada | `scripts/apoios-diff-alarm.ts` | `apoia-se/.diff-alarm.log` |  | G7, G10 |
| Diaria-Artigos-Apoio-Kv-Sync | daily 10:17 | armada | `scripts/sync-artigos-apoio-kv.ts` | `apoia-se/.artigos-kv-sync.log` | `apoia-se/contacts.jsonl` | G7, G10 |
| Diaria-Kv-Image-Binding-Smoke | daily 06:45 | desarmada | `scripts/check-kv-image-binding.ts` | `kv-image-smoke/.check.log` |  | G10 |
| Diaria-Regen-Home-Watchdog | daily 06:20 | armada | `scripts/check-regen-home.ts` | `regen-home-watchdog/.check.log` |  | G1, G10 |
| Diaria-Video-D1-Link-Watch | daily 06:05 | armada | `scripts/video-d1-link-watch.ts` | `video-d1-link-watch/.watch.log` | `editions` | G4, G1, G10 |
| Diaria-YouTube-Analytics-Snapshot | daily 11:35 | armada | `scripts/youtube-analytics-snapshot.ts` | `youtube-analytics/.snapshot.log` | `editions` | G4, G1, G10 |
| Diaria-Short-Related-Missed-Alarm | daily 13:30 | armada | `scripts/short-related-missed-alarm.ts` | `short-related-missed-alarm/.alarm.log` | `editions` | G3, G4, G1, G10 |
| Diaria-Agendamentos-Tick | interval 1h | armada | `scripts/agendamentos-tick.ts` | `agendamentos/.tick.log` | `editions` | G14, G10 (incluída em 11/11/2026, depois da medição) |
| Diaria-Continuo-Ratelimit-Watchdog | interval 1h | armada | `scripts/run-continuo-ratelimit-watchdog.ts` | `continuo/.ratelimit-watchdog.log` |  | G2, G10 |
| Diaria-Home-Meta-Check | daily 09:35 | armada | `scripts/home-meta-check.ts` | `home-meta-check/.meta-check.log` |  | G10 |
| Diaria-Brevo-Diaria-Guardrail | interval 4h | armada | `scripts/check-brevo-diaria-guardrail.ts` | `brevo-diaria/.guardrail-check.log` |  | G5, G7, G10 |
| Diaria-Clarice-Cohorts-Crawl | daily 21:00 | armada | `scripts/clarice-engagement-cohorts-v2.ts` | `clarice-subscribers/.cohorts-v2-crawl.log` |  | G8, G5, G10 |
| Diaria-Clarice-Dashboard-Precompute | interval 1h | armada | `scripts/clarice-dashboard-precompute.ts` | `clarice-dashboard/.precompute.log` |  | G10 (conferido no script: só faz `GET /` no Worker `clarice-dashboard`; não abre SQLite nem usa `brevo-rate-state.json`, as chamadas à Brevo correm dentro do Worker) |
| Diaria-Clarice-Backfill-Campaigns | daily 11:20 | armada | `scripts/clarice-backfill-campaigns.ts` | `clarice-dashboard/.backfill-campaigns.log` |  | G8, G5, G10 |
| Diaria-Coupon-Clarice-Class | daily 11:25 | armada | `scripts/coupon-clarice-class.ts` | `clarice-dashboard/.coupon-clarice-class.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G10 |
| Diaria-Clarice-Guardrail-Alarm | interval 4h | armada | `scripts/clarice-guardrail-alarm.ts` | `clarice-subscribers/.guardrail-alarm.log` |  | G8, G5, G10 |
| Diaria-Subscriber-State-Snapshot | daily 23:55 | armada | `scripts/subscriber-state-snapshot.ts` | `subscriber-state-snapshots/.snapshot.log` |  | G8, G10 |
| Diaria-Subscriber-State-Snapshot-Recent | interval 1h | armada | `scripts/subscriber-state-snapshot.ts` | `subscriber-state-snapshots/.recent.log` |  | G8, G10 |
| Diaria-Nightly-Chain | daily 00:15 | armada | `scripts/overnight/run-nightly-chain.ts` | `overnight/.nightly-chain.log` |  | G2, G10 |
| Diaria-Audience-Profile-Staleness-Alarm | daily 09:30 | armada | `scripts/audience-profile-staleness-alarm.ts` | `audience-profile-staleness-alarm/.alarm-check.log` |  | G10 |
| Diaria-Clarice-Opens-Catchup-Alarm | daily 09:00 | armada | `scripts/clarice-opens-catchup-alarm.ts` | `clarice-subscribers/.opens-catchup-alarm.log` |  | G8, G5, G10 |
| Diaria-Clarice-Unblock-Suspended | daily 08:45 | armada | `scripts/clarice-unblock-orphaned-selections.ts` | `clarice-subscribers/.unblock-suspended.log` |  | G8, G5, G10 |
| Diaria-Clarice-Sync | daily 08:30 | armada | `scripts/clarice-sync-brevo.ts` | `clarice-subscribers/.brevo-sync-daily.log` |  | G8, G5, G10 |
| Diaria-Cursos-Kv-Sync | daily 09:15 | armada | `scripts/sync-cursos-subscribers-kv.ts` | `cursos-subscribers/.kv-sync.log` |  | G10 |
| Diaria-Hotmart-Vendas-Sync | weekly Saturday 04:30 | armada | `scripts/sync-hotmart-vendas.ts` | `hotmart/.vendas-sync.log` | `diaria-subscribers/diaria-subscribers.db` | G8, G10 |
| Diaria-Brevo-Diaria-Evaluate | daily 05:30 | armada | `scripts/evaluate-brevo-diaria.ts` | `brevo-diaria/.evaluate.log` | `brevo-diaria/contacts.json` | G5, G7, G10 |
| Diaria-Sunset-Weekly | weekly Sunday 09:20 | desarmada | `scripts/sunset-dead-subscribers.ts` | `brevo-diaria/.sunset-weekly.log` | `brevo-diaria/contacts.json` | G5, G7, G10 |
| Diaria-Geo-Citation-Monitor | weekly Sunday 07:00 | armada | `scripts/geo-citation-monitor.ts` | `geo-citations/.monitor.log` |  | G10 |
| Diaria-Geo-Citation-Staleness-Alarm | weekly Sunday 10:30 | armada | `scripts/geo-citation-staleness-alarm.ts` | `geo-citations/.staleness-alarm.log` |  | G10 |
| Diaria-Ai-Fetch-Report | daily 10:12 | armada | `scripts/ai-fetch-report.ts` | `ai-fetch/.report.log` |  | G10 |
| Diaria-Ai-Fetch-Staleness-Alarm | daily 10:47 | armada | `scripts/ai-fetch-staleness-alarm.ts` | `ai-fetch/.staleness-alarm.log` |  | G10 |
| Diaria-LinkedIn-Weekly-Staleness-Alarm | weekly Sunday 22:00 | armada | `scripts/linkedin-weekly-staleness-alarm.ts` | `weekly/.linkedin-staleness-alarm.log` |  | G10 |
| Diaria-Retro-Semanal-Staleness-Alarm | weekly Saturday 07:00 | armada | `scripts/retro-semanal-staleness-alarm.ts` | `weekly/.retro-semanal-staleness-alarm.log` |  | G10 |
| Diaria-Circle-Stack-Weekly-Preview | weekly Saturday 09:25 | armada | `scripts/publish-circle-stack.ts` | `weekly/.circle-stack-preview.log` | `editions` | G1, G10 |
| Diaria-Circle-Stack-Weekly-Publish | weekly Monday 06:00 | armada | `scripts/publish-circle-stack-scheduled.ts` | `weekly/.circle-stack-publish.log` | `weekly` | G1, G10 |
| Diaria-Hub-Drift-Check | daily 10:00 | armada | `scripts/hub-drift-check.ts` | `hub-drift-check/.drift-check.log` |  | G10 |
| Diaria-Acervo-Staleness | daily 11:05 | armada | `scripts/acervo-staleness-alarm.ts` | `acervo-staleness/.alarm.log` |  | G10 |
| Diaria-Robots-Txt-Drift-Check | daily 10:15 | armada | `scripts/robots-txt-drift-check.ts` | `robots-txt-drift-check/.drift-check.log` |  | G10 |
| Diaria-Plugin-Review-Drift-Check | daily 10:20 | armada | `scripts/plugin-review-drift-check.ts` | `plugin-review-drift-check/.drift-check.log` |  | G10 |
| Diaria-Subscribe-Redirect-Drift-Check | daily 10:30 | armada | `scripts/subscribe-redirect-drift-check.ts` | `subscribe-redirect-drift-check/.drift-check.log` |  | G10 |
| Diaria-Kit-Doi-Orphan-Guard | daily 10:35 | armada | `scripts/kit-doi-orphan-guard.ts` | `kit-doi-orphan-guard/.guard-check.log` |  | G10 |
| Diaria-Kit-Subscriber-Limit-Alarm | interval 4h | armada | `scripts/kit-subscriber-limit-alarm.ts` | `kit-subscriber-limit-alarm/.alarm-check.log` |  | G10 |
| Diaria-Kit-Subscriber-State-Transition-Alarm | daily 11:15 | armada | `scripts/kit-subscriber-state-transition-alarm.ts` | `kit-subscriber-state-transition-alarm/.alarm-check.log` |  | G8, G10 |
| Diaria-Codex-Credential-Alarm | daily 10:50 | armada | `scripts/codex-credential-alarm.ts` | `codex-credential-alarm/.alarm.log` |  | G10 |
| Diaria-Doppler-Token-Expiry-Alarm | daily 11:00 | armada | `scripts/doppler-token-expiry-alarm.ts` | `doppler-token-expiry-alarm/.alarm.log` |  | G10 |
| Diaria-LinkedIn-Personal | daily 07:46 | armada | `scripts/linkedin-personal-token-alarm.ts` | `linkedin-personal/.task.log` |  | G10 |
| Diaria-Neo-Readiness-Alarm | daily 11:42 | declarada | `scripts/neo-readiness-alarm.ts` | `failover/.neo-readiness-alarm.log` |  | G10 |
| Diaria-LinkedIn-Personal-Catchup | interval 1h | desarmada | `scripts/publish-linkedin-personal.ts` | `linkedin-personal/.catchup.log` |  | G10 |
| Diaria-Shorts-LinkedIn-Profile | daily 06:31 | armada | `scripts/shorts-linkedin-profile-timer.ts` | `shorts/.linkedin-profile-timer.log` |  | G4, G10 |
| Diaria-Shorts-LinkedIn-Profile-Catchup | interval 1h | armada | `scripts/shorts-linkedin-profile-timer.ts` | `shorts/.linkedin-profile-timer-catchup.log` |  | G4, G10 |
| Diaria-Shorts-Instagram | daily 06:32 | armada | `scripts/shorts-instagram-timer.ts` | `shorts/.instagram-timer.log` | `editions` | G4, G1, G10 |
| Diaria-Shorts-Instagram-Catchup | interval 1h | armada | `scripts/shorts-instagram-timer.ts` | `shorts/.instagram-timer-catchup.log` | `editions` | G4, G1, G10 |
| Diaria-Shorts-Threads-Profile | daily 06:33 | armada | `scripts/shorts-threads-profile-timer.ts` | `shorts/.threads-profile-timer.log` | `editions` | G4, G1, G10 |
| Diaria-Shorts-Threads-Profile-Catchup | interval 1h | armada | `scripts/shorts-threads-profile-timer.ts` | `shorts/.threads-profile-timer-catchup.log` | `editions` | G4, G1, G10 |
| Diaria-Shorts-Cortes | interval 1h | armada | `scripts/shorts-corte-timer.ts` | `shorts/.corte-timer.log` | `editions` | G4, G1, G10 |
| Diaria-Threads-Personal-Token | daily 04:20 | armada | `scripts/threads-personal-token-refresh.ts` | `threads-personal/.token-refresh.log` |  | G10 |
| Diaria-Hub-Staleness-Check | weekly Sunday 09:33 | armada | `scripts/hub-staleness-check.ts` | `hubs/.staleness-check.log` |  | G10 |
| Diaria-Entity-Pages-Regen | daily 09:40 | armada | `scripts/regenerate-entity-pages.ts` | `entities/.regen.log` |  | G1, G10 |
| Diaria-Entity-Pages-Staleness-Alarm | weekly Sunday 09:43 | armada | `scripts/regenerate-entity-pages.ts` | `entities/.staleness-alarm.log` |  | G1, G10 |
| Diaria-Clarice-Novos | daily 09:00 | armada | `scripts/clarice-novos-run.ts` | `clarice-subscribers/.novos-run.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G6, G10 |
| Diaria-Clarice-Novos-Tarde | daily 18:00 | armada | `scripts/clarice-novos-run.ts` | `clarice-subscribers/.novos-tarde-run.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G6, G10 |
| Diaria-Clarice-Envio | daily 19:10 | armada | `scripts/clarice-envio-run.ts` | `clarice-subscribers/.envio-run.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G6, G10 |
| Diaria-Clarice-Envio-Guard | daily 05:00 | armada | `scripts/clarice-envio-guard.ts` | `clarice-subscribers/.envio-guard.log` |  | G8, G5, G10 |
| Diaria-Clarice-Envio-Guard-Alarm | daily 06:15 | armada | `scripts/clarice-envio-guard-alarm.ts` | `clarice-subscribers/.envio-guard-alarm.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G10 |
| Diaria-Clarice-Envio-Alarm | daily 22:45 | armada | `scripts/clarice-envio-alarm.ts` | `clarice-subscribers/.envio-alarm.log` | `clarice-subscribers/clarice-users.db` | G8, G5, G10 |
| Diaria-Postmaster-Spam-Sync | daily 12:30 | armada | `scripts/postmaster-spam-sync.ts` | `clarice-subscribers/.postmaster-spam-sync.log` |  | G8, G10 |
| Diaria-Postmaster-Spam-Alarm | daily 12:45 | armada | `scripts/clarice-postmaster-alarm.ts` | `clarice-subscribers/.postmaster-alarm.log` |  | G8, G10 |
| Diaria-SEO-Weekly | weekly Sunday 04:10 | armada | `scripts/seo-index-check.ts` | `seo/.seo-weekly.log` |  | G10 |
| Diaria-Beehiiv-Backup | weekly Sunday 03:00 | armada | `scripts/backup-beehiiv.ts` | `beehiiv-backup/.backup.log` |  | G10 |
| Diaria-Acquisition-Health-Alarm | weekly Sunday 03:30 | armada | `scripts/check-acquisition-health.ts` | `acquisition-health/.check.log` |  | G10 |
| Diaria-Beehiiv-Backup-Staleness-Alarm | weekly Sunday 04:00 | armada | `scripts/beehiiv-backup-staleness-alarm.ts` | `beehiiv-backup/.staleness-alarm.log` |  | G10 |
| Diaria-Meta-Capi-Batch-Send | weekly Sunday 04:15 | armada | `scripts/meta-capi-batch-send.ts` | `beehiiv-backup/.meta-capi-batch.log` |  | G10 |
| Diaria-Kit-Roster-Ingest | daily 04:25 | armada | `scripts/diaria-subscribers-ingest-kit.ts` | `diaria-subscribers/.kit-roster-ingest.log` | `diaria-subscribers/diaria-subscribers.db` | G8, G10 |
| Diaria-Metrics-Health-Alarm | daily 04:40 | armada | `scripts/check-metrics-health.ts` | `metrics-health/.alarm.log` |  | G10 |
| Diaria-Reconcile-Send-Audiences | daily 04:45 | armada | `scripts/reconcile-send-audiences.ts` | `reconcile-send-audiences/.guard.log` |  | G10 |
| Diaria-Worker-Drift-Check | interval 6h | armada | `scripts/worker-drift-check.ts` | `worker-drift-check/.drift-check.log` |  | G10 |
| Diaria-Bing-Seo-Monthly-Pull | monthly day 1 09:00 | armada | `scripts/bing-pull.ts` | `seo/.bing-monthly-pull.log` |  | G10 |
| Diaria-Google-Keyword-Monthly-Pull | monthly day 1 09:30 | armada | `scripts/google-keyword-pull.ts` | `seo/.google-keyword-monthly-pull.log` |  | G10 |
| Diaria-Editorial-Concentration-Monthly-Measure | monthly day 2 09:00 | armada | `scripts/measure-editorial-concentration.ts` | `editorial-concentration/.measure.log` |  | G10 |
| Diaria-On-Hold-Vencimento-Alarm | weekly Sunday 11:00 | armada | `scripts/on-hold-vencimento-alarm.ts` | `on-hold-vencimento-alarm/.alarm.log` |  | G10 |
| Diaria-OneDrive-Sync-Alarm | interval 4h | armada | `scripts/onedrive-sync-alarm.ts` | `onedrive-sync-alarm/.alarm.log` |  | G13, G10 |
| Diaria-GDrive-Sync-Alarm | interval 1h | armada | `scripts/gdrive-sync-alarm.ts` | `gdrive-sync-alarm/.alarm.log` |  | G13, G10 |
| Diaria-Systemd-Failed-Units-Alarm | interval 2h | armada | `scripts/systemd-failed-units-alarm.ts` | `systemd-failed-units-alarm/.alarm.log` |  | G10 |
| Diaria-Studio-Liveness-Alarm | interval 1h | armada | `scripts/studio-liveness-alarm.ts` | `studio-liveness-alarm/.alarm.log` |  | G10 |
| Diaria-Edicao-Diaria-Staleness-Alarm | daily 18:20 | armada | `scripts/edicao-diaria-staleness-alarm.ts` | `edicao-diaria-staleness-alarm/.alarm.log` |  | G1, G10 |
| Diaria-Remediate-Never-Armed-Tasks | daily 18:15 | armada | `scripts/remediate-never-armed-tasks.ts` | `task-never-armed-alarm/.remediate-run.log` |  | G10 |
| Diaria-Task-Never-Armed-Alarm | daily 18:30 | armada | `scripts/task-never-armed-alarm.ts` | `task-never-armed-alarm/.alarm.log` |  | G10 |
| Diaria-Google-Ads-Spend-Ingest | daily 09:50 | armada | `scripts/google-ads-ingest-spend.ts` | `aquisicao/.google-ads-ingest.log` |  | G10 |
| Diaria-Meta-Ads-Spend-Ingest | daily 09:54 | armada | `scripts/meta-ads-ingest-spend.ts` | `aquisicao/.meta-ads-ingest.log` |  | G10 |
| Diaria-Google-Ads-Confirmations-Upload | daily 07:20 | armada | `scripts/upload-google-ads-confirmations.ts` | `google-ads/.confirmations-upload.log` |  | G10 |
| Diaria-Meta-Capi-Confirmations-Send | interval 1h | armada | `scripts/meta-capi-confirmations-send.ts` | `meta-capi/.confirmations-send.log` |  | G10 |
| Diaria-Hub-Pages-Build | weekly Sunday 08:05 | desarmada | `scripts/build-hub-page.ts` | `hubs/.build-all.log` |  | G10 |
| Diaria-Hub-Weekly-Regen | weekly Friday 02:30 | armada | `scripts/hubs-weekly-regen.ts` | `hubs/.weekly-regen.log` |  | G1, G10 |
| Diaria-Ads-Test-Watch | daily 06:30 | armada | `scripts/ads-test-watch.ts` | `aquisicao/.ads-test-watch.log` | `aquisicao/spend.csv` | G10 |
| Diaria-Onboarding-Watch-Returning | interval 1h | armada | `scripts/onboarding-watch-returning.ts` | `onboarding/.watch-returning.log` | `onboarding/store.json` | G7, G10 |
| Diaria-Onboarding-Welcome-Run | daily 09:05 | armada | `scripts/onboarding-welcome-run.ts` | `onboarding/.welcome-run.log` | `onboarding/store.json` | G7, G10 |
| Diaria-Onboarding-Continuity-Alarm | daily 09:58 | armada | `scripts/onboarding-continuity-alarm.ts` | `onboarding/.continuity-alarm.log` | `onboarding/store.json` | G7, G10 |
| Diaria-Top-YouTube-Video-Measure | weekly Monday 08:50 | armada | `scripts/measure-top-youtube-video.ts` | `youtube/.top-video-measure.log` |  | G4, G10 |
| Diaria-Session-Registry-Gc | daily 09:55 | armada | `scripts/session-registry-gc.ts` | `sessions/.gc.log` |  | G2, G10 |
| Diaria-Backlog-Reconcile | daily 10:10 | armada | `scripts/backlog-reconcile.ts` | `backlog-reconcile/.reconcile.log` |  | G2, G10 |
| Diaria-Dmarc-Drain | daily 10:25 | armada | `scripts/dmarc-drain.ts` | `dmarc-reports/.drain.log` |  | G10 |
| Diaria-Claude-Session-Version-Drift-Alarm | interval 6h | armada | `scripts/claude-session-version-drift-alarm.ts` | `claude-session-version-drift-alarm/.alarm.log` |  | G10 |
| Diaria-Npm-Version-Drift-Alarm | daily 10:40 | armada | `scripts/npm-version-drift-alarm.ts` | `npm-version-drift-alarm/.alarm.log` |  | G10 |
| Diaria-Stale-Red-Pr-Alarm | interval 2h | armada | `scripts/stale-red-pr-alarm.ts` | `stale-red-pr-alarm/.alarm.log` |  | G10 |
| Diaria-Stuck-Approved-Pr-Alarm | interval 2h | declarada | `scripts/stuck-approved-pr-alarm.ts` | `stuck-approved-pr-alarm/.alarm.log` |  | G10 |
| Diaria-Openrouter-Billing-Leak-Alarm | daily 21:45 | armada | `scripts/openrouter-billing-leak-check.ts` | `openrouter-billing-leak/.alarm.log` |  | G10 |
| Diaria-Branch-Cleanup | daily 10:45 | armada | `scripts/branch-cleanup.ts` | `branch-cleanup/.cleanup.log` |  | G2, G10 |
| Diaria-GA4-Sync | daily 10:50 | armada | `scripts/ga4-sync.ts` | `ga4-cache/.sync.log` |  | G10 |
| Diaria-Route-Marker-Staleness-Alarm | weekly Sunday 11:15 | armada | `scripts/route-marker-staleness-alarm.ts` | `route-marker-staleness/.alarm.log` |  | G10 |
| Diaria-Ads-Spend-Ingest-Alarm | daily 10:05 | armada | `scripts/ads-spend-ingest-alarm.ts` | `aquisicao/.ads-spend-ingest-alarm.log` |  | G10 |
| Diaria-Aquisicao-Conversions-Ingest | daily 09:56 | armada | `scripts/aquisicao-conversions-ingest.ts` | `aquisicao/.aquisicao-conversions-ingest.log` |  | G10 |
| Diaria-Aquisicao-Reconcile-Daily | daily 10:07 | armada | `scripts/aquisicao-reconcile-daily.ts` | `aquisicao/.aquisicao-reconcile-daily.log` |  | G10 |
| Diaria-Ads-Daily-Digest | daily 10:55 | armada | `scripts/ads-daily-digest.ts` | `aquisicao/.ads-daily-digest.log` | `aquisicao/spend.csv` | G10 |
| Diaria-Alarm-Retirement-Candidates | weekly Sunday 11:30 | armada | `scripts/check-alarm-retirement-candidates.ts` | `alarm-retirement-candidates/.check.log` |  | G10 |
| Diaria-Corrupted-Names-Weekly-Check | weekly Sunday 11:45 | armada | `scripts/check-corrupted-names.ts` | `clarice-subscribers/.corrupted-names-check.log` |  | G8, G10 |
| Diaria-Task-Registry-Prose-Drift-Alarm | daily 18:35 | armada | `scripts/task-registry-prose-drift-check.ts` | `task-registry-prose-drift/.check.log` |  | G10 |
| Diaria-Guard-Never-Invoked-Weekly-Check | weekly Sunday 12:00 | armada | `scripts/check-guard-never-invoked.ts` | `guard-never-invoked/.check.log` |  | G10 |
| Diaria-Issue-File-Collisions-Weekly-Check | weekly Sunday 12:15 | armada | `scripts/check-issue-file-collisions.ts` | `issue-file-collisions/.check.log` |  | G2, G10 |
| Diaria-Dmarc-Enforcement-Alarm | weekly Sunday 12:30 | armada | `scripts/dmarc-enforcement-alarm.ts` | `dmarc-enforcement/.alarm.log` |  | G10 |
| Diaria-Meta-Capi-Staleness-Alarm | daily 20:05 | armada | `scripts/meta-capi-staleness-alarm.ts` | `aquisicao/.meta-capi-staleness-alarm.log` |  | G10 |
| Diaria-Gtm-Drift-Check | daily 20:20 | armada | `scripts/gtm-drift-check.ts` | `gtm-drift-check/.drift-check.log` |  | G10 |
| Diaria-Revert-Calibration-Orphan-Check | interval 2h | armada | `scripts/check-revert-calibration-prs.ts` | `revert-calibration/.orphan-check.log` |  | G10 |
| Diaria-Social-Followers-Collect | daily 07:10 | armada | `scripts/social-followers-collect.ts` | `metrics/.social-followers-collect.log` |  | G10 |
| Diaria-Calibration-Allowlist-Audit-Quarterly | monthly day 3 09:40 | armada | `scripts/record-calibration-pr-decisions.ts` | `calibration-audit/.allowlist-audit.log` |  | G10 |
| Diaria-Calibration-Touch-Minutes-Monthly | monthly day 3 09:45 | armada | `scripts/derive-touch-minutes.ts` | `calibration-audit/.touch-minutes.log` |  | G10 |
| Diaria-Tmp-Cleanup | daily 03:20 | armada | `scripts/cleanup-tmp-300.ts` | `tmp-cleanup/.cleanup.log` |  | G10 |
| Diaria-Video-Montage-Cache-Prune | daily 03:50 | armada | `scripts/prune-video-montage-cache.ts` | `video-montage-cache-prune/.prune.log` |  | G1, G10 |
| Diaria-Video-Montage-Disk-Alarm | daily 13:40 | armada | `scripts/video-montage-disk-alarm.ts` | `video-montage-disk-alarm/.alarm-check.log` |  | G10 |
| Diaria-Video-Bruto-Archive | weekly Saturday 03:00 | armada | `scripts/archive-video-brutos.ts` | `video-bruto-archive/.archive.log` |  | G1, G10 |
| Diaria-Tmp-Disk-Alarm | interval 6h | armada | `scripts/tmp-disk-alarm.ts` | `tmp-disk-alarm/.alarm-check.log` |  | G10 |
| Diaria-Site-Page-Merge-Check | daily 05:15 | armada | `scripts/check-site-page-merge.ts` | `site-page-merge-check/.check.log` |  | G10 |
| Diaria-Gc-Data-Dir-Weekly | weekly Saturday 03:40 | armada | `scripts/gc-data-dir.ts` | `gc-data-dir/.gc.log` | `editions` | G1, G10 |
