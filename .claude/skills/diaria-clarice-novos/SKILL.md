---
name: diaria-clarice-novos
description: Fecha o laço cadastro novo no Stripe → verificação MillionVerifier → campanha disparada na hora com a edição mensal mais recente da Clarice. Roda ~4×/semana, invocação manual, SEM gate humano (os guards determinísticos são a única trava — issue #4347).
---

# /diaria-clarice-novos [--since YYYY-MM-DD] [--dry-run] [--force] [--subject "…"] [--confirm]

Fecha o laço operacional que a issue #4347 identificou: cadastro novo no Stripe não virava envio sozinho. Esta skill busca o delta do Stripe, verifica os e-mails que precisam de verificação no MillionVerifier, monta o grupo `novos` (cadastro recente) e dispara a campanha IMEDIATAMENTE com a edição mensal mais recente da Clarice — sem intervenção do editor a cada rodada.

**Regime de execução — sem gate humano (D6).** Decisão travada do editor (#4347): os 8 guards determinísticos abaixo são a ÚNICA trava. Cada um deles **ABORTA**, nunca só avisa, fora de `--dry-run`. `--dry-run` é o modo recomendado pra 1ª invocação numa máquina nova.

| Guard | Onde | Condição de abort |
|---|---|---|
| Teto de tamanho (D13) | `clarice-build-segment.ts --group novos` | grupo selecionado > 500 contatos → aborta. `--force` destrava. |
| Semáforo (D4) | `clarice-check-semaphore.ts` | circuit breakers em vermelho → aborta. |
| Queued/sent | `clarice-build-segment.ts` (todos os grupos) | falha ao consultar campanhas comprometidas na Brevo → aborta fora de `--dry-run`. |
| HTML | `clarice-novos-resolve-cycle.ts` | nenhum ciclo com preview pronto → aborta. |
| É IA? | `clarice-novos-resolve-cycle.ts` / `checkEiaGuard` no `--send-now` | gabarito não gravado pro ciclo resolvido → aborta. |
| Crédito Brevo | Passo 4 (import) | import incompleto → aborta antes do `--create`. |
| Import incompleto | Passo 4 | polling não bate o total esperado → aborta antes do `--create`. |
| Custo MV (D8) | `verify-emails-mv.ts --since` | recorte > 500 e-mails a verificar sem `--confirm` → aborta sem gastar crédito. |

Falha de MCP/ferramenta em qualquer passo → halt banner (`scripts/render-halt-banner.ts`), nunca stall silencioso (regra global do projeto, #738).

**Zero elegíveis** em qualquer ponto (delta vazio, grupo `novos` vazio) → sai limpo, grava relatório "0 contatos", **exit 0** (não é erro).

---

## Passo 0 — Preflight

1. `npx tsx scripts/lib/exec-mode.ts` → se `cloud`, halte com uma mensagem clara: esta skill precisa do junction `data/` (label `local` da issue #4347 — Stripe/Brevo/MV reais + `data/`).
2. Confirme as 3 env vars: `STRIPE_API_KEY`, `BREVO_CLARICE_API_KEY`, `MILLION_VERIFIER_API_KEY`. Falta de qualquer uma → halt banner com a variável faltante.
3. `npx tsx scripts/clarice-check-derived-stale.ts` → se imprimir `stale`, rode `npx tsx scripts/clarice-build-db.ts` (ou `clarice-sync-brevo.ts` até o fim) antes de continuar — um store defasado (sync do Brevo interrompido) faz `send_eligible`/derivados mentirem.

## Passo 1 — Delta Stripe → store

```bash
npx tsx scripts/clarice-stripe-delta.ts --execute
```

Sem `--since`, o script calcula sozinho (`MAX(created)` do store − 2 dias de folga). Se a Stripe API falhar (perda de escopo da key, ver #2971), caia pro fallback manual: peça ao editor um export do Dashboard e rode `npx tsx scripts/clarice-stripe-delta.ts --from-csv <path> --execute` no lugar — nunca invente dados.

Depois, ingira no store:

```bash
npx tsx scripts/clarice-build-db.ts
```

Anote `--since` efetivamente usado (aparece no resumo JSON do passo 1) — os passos 2 e 3 usam o MESMO valor.

## Passo 2 — MV roteado por cohort (guard de custo D8)

```bash
npx tsx scripts/verify-emails-mv.ts --since {SINCE} --cycle {CICLO_ENVIO}
```

Onde `{CICLO_ENVIO}` é o ciclo Clarice (`{YYMM}-{MM}`) — normalmente o mesmo mês-envio corrente (ex: se hoje é julho/2026, `2606-07` ou `2607-08` dependendo do calendário do editor; se não tiver certeza, pergunte ou infira do ciclo mais recente com atividade em `data/clarice-subscribers/`).

O script imprime `N e-mails ≈ US$ X` e, se `N > 500`, ABORTA pedindo `--confirm` (nenhum crédito gasto). Se o editor não estiver presente pra confirmar (sessão desassistida), **não invente `--confirm`** — deixe abortar e registre no relatório final que a rodada parou aqui esperando revisão manual do volume. Se `N ≤ 500`, prossegue sozinho. Cohorts MV-isentos (`assinantes-ativos`) são pulados com log, custo zero.

## Passo 3 — Grupo `novos` (D13 + D4)

Primeiro o semáforo:

```bash
npx tsx scripts/clarice-check-semaphore.ts
```

Se `exit 1` (semáforo vermelho) → **ABORTE a rodada inteira aqui**, registre no relatório, não prossiga.

Depois o grupo:

```bash
npx tsx scripts/clarice-build-segment.ts --group novos --since {SINCE} --cycle {CICLO_ENVIO}
```

Se abortar por D13 (>500 contatos), NÃO passe `--force` automaticamente numa sessão desassistida — isso é o substituto do gate humano. Registre no relatório e pare. Numa sessão supervisionada (`/diaria-develop`), pergunte ao editor antes de repetir com `--force`.

Se `0 contato(s) no grupo 'novos'` → rodada vazia, pule pro fecho (relatório "0 contatos", exit 0).

## Passo 4 — Import Brevo

```bash
FOLDER_JSON=$(npx tsx scripts/clarice-resolve-folder.ts --name "Clarice novos")
# extraia .folderId do JSON acima
npx tsx scripts/clarice-import-waves.ts --cycle {CICLO_ENVIO} --group novos \
  --label "Novos {DD/MM}" --folder-id {FOLDER_ID} --execute
```

`clarice-resolve-folder.ts` nunca aborta — se não conseguir resolver/criar a folder "Clarice novos", cai na folder `1` com aviso (organização visual, não afeta elegibilidade).

O import da Brevo é assíncrono (`processId` no retorno) — aguarde alguns segundos e confirme o total de contatos importados antes de prosseguir (ex: reconsultar a lista via MCP Clarice ou uma nova invocação de `clarice-import-waves.ts` — que recusa recriar a lista, #idempotência). Se o total não bater, ABORTE antes do `--create` (guard "import incompleto").

## Passo 5 — Resolver a edição + criar a campanha (sem data)

```bash
npx tsx scripts/clarice-novos-resolve-cycle.ts [--subject "Assunto explícito"]
```

Sem `--subject`, o script tenta resolver o assunto vencedor A/B/C já usado nos envios canônicos do ciclo (`campaigns-summary.json`). Se nenhum ciclo estiver pronto (preview + gabarito É IA? + assunto conhecido), ABORTA com o motivo por ciclo candidato — pare a rodada aqui. Se o ciclo mais recente não estava pronto mas um anterior está (D3), o script já resolve automaticamente e sinaliza `fallback: true` — registre isso no relatório.

Resolva a key idempotente do dia (namespace por `{CICLO_ENVIO}` — é onde `group-campaigns.json` deste grupo mora):

```bash
npx tsx scripts/clarice-novos-resolve-key.ts --cycle {CICLO_ENVIO} --date {AAMMDD_HOJE}
```

Crie a campanha, SEM `--schedule-at` (rascunho pra envio imediato). **`--cycle` é sempre `{CICLO_ENVIO}`** (governa `segments/`/`group-campaigns.json` — mesmo namespace dos Passos 2–4); **`--content-cycle` é `{CICLO_MENSAL_RESOLVIDO}`** só quando ele DIVERGE de `{CICLO_ENVIO}` (caso comum no fallback D3) — controla de onde vêm o HTML e o gabarito É IA?:

```bash
npx tsx scripts/clarice-schedule-group.ts --cycle {CICLO_ENVIO} --content-cycle {CICLO_MENSAL_RESOLVIDO} \
  --group novos --key {KEY} --subject "{ASSUNTO}" --create
```

**Nunca passe `{CICLO_MENSAL_RESOLVIDO}` como `--cycle`** — isso faria o script procurar `group-campaigns.json`/o registro de listas do grupo `novos` no namespace ERRADO (o do conteúdo, não o de contatos), quebrando a resolução da lista criada no Passo 4. `--cycle` e `--content-cycle` são propositalmente independentes — sempre os dois flags juntos quando os ciclos divergirem.

## Passo 6 — Test email condicional (D12) + envio imediato

```bash
npx tsx scripts/clarice-novos-html-state.ts --cycle {CICLO_MENSAL_RESOLVIDO}
```

Se `shouldSendTest: true` no JSON de saída (**sempre `--cycle {CICLO_ENVIO}` + `--content-cycle {CICLO_MENSAL_RESOLVIDO}`, mesma dupla do Passo 5**):

```bash
npx tsx scripts/clarice-schedule-group.ts --cycle {CICLO_ENVIO} --content-cycle {CICLO_MENSAL_RESOLVIDO} \
  --group novos --key {KEY} --send-test
```

Se `false`, pule — o HTML é idêntico ao da última rodada (D12).

Dispare AGORA (guard É IA? embutido; GET-verify pós-disparo confirma status terminal antes de declarar sucesso):

```bash
npx tsx scripts/clarice-schedule-group.ts --cycle {CICLO_ENVIO} --content-cycle {CICLO_MENSAL_RESOLVIDO} \
  --group novos --key {KEY} --send-now
```

**Checar o exit code, não só o JSON.** Exit `0` = disparo confirmado (`status: "sent"` no JSON). Exit `2` = o POST `sendNow` foi aceito mas o GET-verify pós-disparo NÃO confirmou status terminal — NÃO declare sucesso ao editor/relatório nesse caso; registre como "disparo incerto, reconsulte a Brevo manualmente" e re-tente `--send-now` (idempotente: campanha já `"sent"` é pulada, então re-tentar é seguro). Qualquer outro exit (`1`) é erro duro (guard É IA?, campanha não criada, etc.) — trate como halt.

Finalize o state (grava SHA do HTML + acumula `sentCount`):

```bash
npx tsx scripts/clarice-novos-html-state.ts --cycle {CICLO_MENSAL_RESOLVIDO} --finalize \
  --list-id {LIST_ID_DO_PASSO_4} --campaign-id {CAMPAIGN_ID_DO_PASSO_5} --sent-count {N_CONTATOS_DO_GRUPO}
```

## Passo 7 — Relatório

Escreva um resumo em markdown (destaques: quantos contatos no delta Stripe, quantos verificados no MV, quantos no grupo `novos`, se algum guard abortou e qual, ciclo mensal usado + fallback ou não, resultado do disparo) em `data/clarice-subscribers/novos-reports/{KEY}.md`, depois registre:

```bash
npx tsx scripts/register-report.ts --kind clarice-novos --id {KEY} \
  --title "Diar.ia Clarice novos {AAMMDD} — N contato(s)" \
  --html-path data/clarice-subscribers/novos-reports/{KEY}.md
```

`register-report.ts` é fail-soft (nunca trava o fecho da rodada) — se falhar, prossiga mesmo assim.

---

## Notas operacionais

- **Sem e-mail por rodada** (D14) — só terminal + registro no Studio (`/relatorios`).
- **`Diaria-Clarice-Guardrail-Alarm`** manda e-mail nomeando *o próximo envio agendado* pra suspender — com `sendNow` não existe "próximo envio agendado". Se um alarme disparar depois de uma rodada `novos`, a remediação é simplesmente **não rodar a skill de novo** até investigar (kill switch trivial, invocação é manual).
- **Cadência ~4×/semana** — o sync do Brevo roda 1×/dia (08:30). Duas rodadas em dias consecutivos veem `sends_count=0` pra quem já recebeu ontem; quem fecha isso é o guard queued/sent (`fetchSentCampaignListIds`, wired em `clarice-build-segment.ts` pros 4 grupos), não `sends_count`. **Nunca pule esse guard** mesmo que pareça redundante numa rodada específica.
- **Idempotência de campanha**: `--key novos-{AAMMDD}` com sufixo `-2`/`-3`… se a skill rodar mais de uma vez no mesmo dia (`clarice-novos-resolve-key.ts`). `--create` é idempotente por key (pula se já criada) — nunca duplica campanha pra mesma key.
