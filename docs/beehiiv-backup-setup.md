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

**Cobertura:** só o que a REST pública do Beehiiv expõe. Per-link clicks e per-subscriber engagement detalhado são MCP-only (`list_post_clicks`, `list_post_subscriber_engagement` — chamáveis só do top-level Claude) e não entram neste backup; o `manifest.json` sinaliza esse gap em `mcp_only_gaps`. Votos do É IA? vivem no Worker KV, fora do Beehiiv — fora de escopo.

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

**Armado e confirmado ativo em `helios` (260814):** `systemctl --user is-active diaria-beehiiv-backup.timer` devolve `active`, próximo disparo domingo 2026-08-16 06:00:00 UTC.

## Log

`data/beehiiv-backup/.backup.log` (append-only, uma seção por execução da task agendada).
