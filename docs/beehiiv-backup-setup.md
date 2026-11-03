# Snapshot semanal da publicação Beehiiv

Issue: [#5229](https://github.com/vjpixel/diaria-studio/issues/5229) (registro da task + `expand[]=stats`), agendamento em [#5230](https://github.com/vjpixel/diaria-studio/pull/5230).

`scripts/backup-beehiiv.ts` (#1742) existia desde 2026-06-03 como backup **manual sob demanda** — nunca rodou agendado. Os dois únicos snapshots em `data/beehiiv-backup/` antes desta task eram 2026-06-05 e 2026-06-17, ambos disparados à mão. Enquanto isso, `promoteBeehiivSubscription` (`scripts/evaluate-brevo-diaria.ts`) faz `DELETE`+`CREATE` todo dia às 05:30 e sobrescreve o `utm_source` original de quem é promovido por score — o snapshot é o único mecanismo que preserva a versão anterior, e sem agendamento ele não preservava nada.

## O que o snapshot captura

`backupBeehiiv()` grava em `data/beehiiv-backup/{YYYY-MM-DD}/`:

- `publication.json` — metadata + stats da publicação (`expand[]=stats`).
- `custom-fields.json` — schema de custom fields.
- `segments.json` — segments definidos.
- `automations.json` / `email-blasts.json` / `tiers.json` / `referral-program.json` — opcionais, puláveis se o plano não expõe o recurso (404/403 tolerado).
- `posts/{post_id}.json` — 1 arquivo por post: conteúdo (web+email) + stats.
- `subscribers.jsonl` — 1 linha por assinante, com `expand[]=custom_fields&expand[]=tags&expand[]=referrals&expand[]=stats`.
- `manifest.json` — sumário: timestamp, contagens, status por endpoint, gaps conhecidos (`mcp_only_gaps`).

**`expand[]=stats` no `subscribers.jsonl` (#5229):** traz `open_rate`/`total_received`/`total_unique_clicked` POR ASSINANTE, no mesmo ponto no tempo que a origem (`utm_source`). Sem isso o snapshot registrava a origem mas não o engajamento, e análise de coorte por canal de aquisição (`cohort-engagement.ts`) precisa dos dois juntos — sem o snapshot, essa análise refaz a chamada à API ao vivo, o que mede o engajamento de HOJE contra uma coorte de ONTEM. O `expand[]=stats` também é o que torna o snapshot capaz de reconstruir a origem destruída pela promoção Brevo→Beehiiv (`DELETE`+`CREATE` sobrescreve `utm_source`).

**Cobertura:** só o que a REST pública do Beehiiv expõe. Per-link clicks e per-subscriber engagement detalhado são MCP-only (`list_post_clicks`, `list_post_subscriber_engagement` — chamáveis só do top-level Claude) e não entram neste backup; o `manifest.json` sinaliza esse gap em `mcp_only_gaps`. Votos do É IA? vivem no Worker KV, fora do Beehiiv: o snapshot local não os cobre, mas a cópia off-site (abaixo, #11413) inclui um dump deles.

## Cadência: semanal, domingo 03:00 BRT (06:00 UTC)

Task `Diaria-Beehiiv-Backup` — o timer mais cedo da semana, antes de `Diaria-Seo-Weekly` (domingo 04:10) e de qualquer daily (a mais cedo é 05:00). Um snapshot pesado (drena a base de assinantes inteira, ~13 páginas na paginação da API) merece a janela mais vazia.

**Por que semanal e não diário:** existem DUAS vias de promoção em paralelo que sobrescrevem `utm_source` (`scripts/evaluate-brevo-diaria.ts` §"Duas vias de promoção em paralelo — clique OU score", #4476 item 2):

- **Score** (`promoteBeehiivSubscription`, roda diário às 05:30): exige acumular score por semanas antes de promover — o contato quase sempre aparece num snapshot anterior com a origem intacta. O semanal cobre bem esse caso.
- **Clique** (`workers/reativar/`, tempo real): dispara no instante em que a pessoa clica no link de reativação da edição diária do `brevo_diaria`, com o MESMO `DELETE`+`CREATE` destrutivo. Sem gate de score, sem espera — quem entra no pool e clica na mesma semana **nunca é snapshotado** antes de perder a origem, porque converter por clique rápido é exatamente o propósito do canal (achado do review da PR #5230).

Subir a cadência pra diário não fecharia a via de clique (dá pra entrar no pool e clicar no mesmo dia) — pagaria 7× o disco por uma cobertura ainda parcial. O conserto real da via de clique é preservação IN-BAND: os dois call sites já fazem `GET by_email` antes do `DELETE`, então `utm_source`/`created` originais estão na mão e bastaria ecoá-los num custom field do `CREATE`. Isso está registrado como follow-up na própria #5229 — **não é escopo desta task**, que é só a rede de proteção enquanto o fix in-band não existe. Ver também [#5231](https://github.com/vjpixel/diaria-studio/issues/5231) (issue relacionada à via de clique, fora do escopo deste documento).

## Como rodar manualmente (debug/auditoria)

```bash
npx tsx scripts/backup-beehiiv.ts --dry-run       # só imprime o plano, sem gravar nada
npx tsx scripts/backup-beehiiv.ts                 # backup completo de hoje
npx tsx scripts/backup-beehiiv.ts --posts-limit 5 # smoke test rápido (poucos posts)
npx tsx scripts/backup-beehiiv.ts --no-subscribers # pula a base inteira (mais rápido)
```

Requer `BEEHIIV_API_KEY` no `.env` (mesma credencial do resto do pipeline Beehiiv).

## Arme (Linux/systemd)

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Beehiiv-Backup
systemctl --user daemon-reload
systemctl --user enable --now diaria-beehiiv-backup.timer
```

Isso registra a task `Diaria-Beehiiv-Backup` (domingos 03:00 BRT / 06:00 UTC). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-beehiiv-backup.timer`.

**1ª task registrada depois do cutover systemd (épica #4798) — sem `.ps1`/Task Scheduler de propósito**, só o par `.service`/`.timer` gerado pelo registry declarativo (`scripts/lib/scheduled-tasks.ts`). Nenhuma tarefa `Diaria-*` roda no Windows (#5074).

**Armado e confirmado ativo em `300` (260814):** `systemctl --user is-active diaria-beehiiv-backup.timer` devolve `active`, próximo disparo domingo 2026-08-16 06:00:00 UTC.

## Log

`data/beehiiv-backup/.backup.log` (append-only, uma seção por execução da task agendada).

## Retenção e alarmes (#10710)

Nenhum script do repo apaga `data/beehiiv-backup/` — o `gc-data-dir.ts` o exclui até no `--apply`, e o relatório do dry-run nunca lista como dispensável o snapshot mais antigo de cada mês. Em 14/10/2026 todos os snapshots anteriores a 04/10 sumiram por uma remoção vinda do OneDrive remoto (o journal do cliente `onedrive` na `300` registra `Deleting local file`, ou seja, a remoção chegou de fora). A Lixeira online do OneDrive guarda o apagado por ~30 dias.

O alarme semanal (`beehiiv-backup-staleness-alarm.ts`) checa também:

- **Cobertura mensal:** todo mês fechado desde 2026-08 precisa ter ao menos 1 snapshot. Se a perda de um mês for definitiva, listar o mês em `BEEHIIV_BACKUP_ACKNOWLEDGED_LOST_MONTHS` (`scripts/lib/beehiiv-backup-staleness-alarm.ts`).
- **Exit-history:** `exit-history/manifest.json` precisa existir com `complete: true`. O drain é feito pelo agent `beehiiv-exit-history-drain` (#7248), que só roda numa sessão com o conector Beehiiv; o Stage 0 da diária devolve o dispatch (`pendingAgentDispatch` `0h.4`) enquanto o manifest não estiver completo.
- **Cópia off-site (#11413):** o objeto mais recente de `beehiiv/` e de `eia-votes/` no bucket R2 `diaria-backup` precisa ter até 7 dias. Credencial do bucket ausente no ambiente é achado (`remote:no-credentials`), nunca "ok".

## Cópia off-site criptografada (#11413)

O snapshot local vive só no OneDrive (`data/`), que já lotou uma vez (#10957) e já apagou snapshots por remoção remota (14/10/2026). Desde a #11413 o 2º passo da mesma task (`scripts/backup-offsite.ts`, sem timer novo) envia uma cópia compactada e criptografada para o bucket R2 **privado** `diaria-backup`:

| Objeto | Conteúdo |
|---|---|
| `beehiiv/{AAAA-MM-DD}.tar.gz.enc` | tar + gzip do diretório do snapshot do dia |
| `eia-votes/{AAAA-MM-DD}.jsonl.gz.enc` | JSONL `{key, value}` das chaves `vote:`, `score:` e `correct:` do KV `POLL` (nunca as imagens) |

- **Bucket:** sem r2.dev, sem domínio; lifecycle `retencao-8-semanas` (apaga após 56 dias), configurado no painel. Credencial S3 própria, restrita ao bucket (`R2_BACKUP_ACCESS_KEY_ID`/`R2_BACKUP_SECRET_ACCESS_KEY`); endpoint sai de `R2_ACCOUNT_ID`. Nunca as credenciais dos shorts, nunca URL pública: toda leitura, inclusive a conferência pós-upload, usa a API S3 assinada.
- **Cifra:** AES-256-GCM (`scripts/lib/backup-offsite-crypto.ts`), cabeçalho versionado `DIARIABK` + versão + keyId + IV + tag. A chave (`BACKUP_ENCRYPTION_KEY`, 32 bytes em base64) fica no Doppler `diaria-studio/dev` e numa 2ª cópia com o editor (Bitwarden), nunca no bucket. **Rotação:** guardar a chave antiga nos dois cofres enquanto houver backup cifrado com ela (56 dias); a restauração lê outra var com `--key-env`.
- **Quando sobe:** só se o snapshot do dia for bem-sucedido (diretório + `manifest.json` + `isSubscribersSnapshotUsable`). Senão o Beehiiv é pulado com log (o alarme acima já cobre o snapshot ruim) e os votos sobem do mesmo jeito.
- **Conferência:** depois do PUT, HEAD assinado com o mesmo tamanho e ETag igual ao MD5 do corpo.
- **Falha:** issue de alarme via `notifyEditor` (`check: backup-offsite`, fingerprint `backup-offsite-failed:{tipo}`) e exit 1 do passo. O snapshot local continua valendo.
- **Faixa grátis:** 10 GB divididos com os verticais; cada upload loga o tamanho no `.backup.log`.
- **Votos:** leitura do KV pela API REST (`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`, bulk get de 100 chaves por chamada, com queda para GET por chave). Zero chaves `vote:` é falha (token ou namespace errado), não um backup vazio.

```bash
doppler run -- npx tsx scripts/backup-offsite.ts --dry-run          # empacota, cifra e mede; não envia
doppler run -- npx tsx scripts/backup-offsite.ts                    # snapshot de hoje (UTC) + votos
doppler run -- npx tsx scripts/backup-offsite.ts --date 2026-11-08 --only beehiiv
```

### Restauração

```bash
doppler run -- npx tsx scripts/restore-backup-offsite.ts --list
doppler run -- npx tsx scripts/restore-backup-offsite.ts --latest beehiiv --out /tmp/restore-beehiiv
doppler run -- npx tsx scripts/restore-backup-offsite.ts --key eia-votes/2026-11-08.jsonl.gz.enc --out /tmp/restore-votos
doppler run -- npx tsx scripts/restore-backup-offsite.ts --file ./copia.tar.gz.enc --out /tmp/r   # arquivo já baixado
```

Baixa pela API assinada, autentica e decifra (chave errada ou byte alterado falham alto, sem escrever nada) e extrai em `--out`, que precisa estar vazia. Voltar o conteúdo para `data/beehiiv-backup/` é passo manual, depois de conferir.
