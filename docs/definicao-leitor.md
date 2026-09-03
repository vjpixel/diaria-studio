# Definição canônica de `leitor-v1`

Issue: [#5235](https://github.com/vjpixel/diaria-studio/issues/5235) (corrigida em 260814 — a versão original usava `stats.click_rate`, que é a armadilha documentada abaixo).

Primeira metade da camada de dados de aquisição que destrava decisão de gasto em ads (#4466). A segunda é o mapa de origem recuperada (`scripts/build-origem-map.ts`, ver seção própria abaixo) e o relatório consolidado (#5236).

## Contexto da decisão (260814)

- **Teto de CAC revogado.** Não há linha de corte fixa de custo por leitor — o objetivo é minimizar custo por leitor dentro do orçamento de R$ 4.000+/mês, não bater um teto.
- **A unidade é LEITOR**, não cadastro nem assinante ativo — ela embute qualidade na própria métrica. Um cadastro pode nunca abrir; um ativo pode nunca clicar. Um leitor clicou de verdade.

## A armadilha do `click_rate` — nunca usar

`stats.click_rate` da API Beehiiv é `total_unique_clicked ÷ total_unique_opened`, **não** `÷ total_received`. Tem abertura no denominador — exatamente a contaminação de MPP (Mail Privacy Protection: o pixel de abertura do Apple Mail dispara sem o leitor ter aberto de fato) que a definição por clique existe pra escapar.

Confirmado no dado bruto (Apêndice A do mídia kit, o mesmo registro replicado como fixture em `test/leitor.test.ts`):

```
total_received 238 · total_unique_opened 217 · total_unique_clicked 171
click_rate 78.8  →  171/217 = 78,8%   (e não 171/238 = 71,8%)
```

Usar `click_rate` como CTR infla o resultado em ~7× nesse caso e reintroduz o viés de abertura. **A CTR real é sempre calculada à mão**: `total_unique_clicked ÷ total_received`.

`scripts/lib/leitor.ts` reforça isso em dois níveis:

1. `computeCtrPct(totalUniqueClicked, totalReceived)` — a única função que produz uma taxa, e é sempre `clicados ÷ recebidas`.
2. `BeehiivSubscriberStatsShape` (o tipo aceito por `leitorInputFromBeehiivSubscriber`) nem declara o campo `click_rate` — quem chama a função com o objeto bruto da API pode ter o campo no runtime, mas a função nunca o lê. `test/leitor.test.ts` trava isso com um `Proxy` que lança se `click_rate` for acessado, além de 2 casos adversariais onde um `click_rate` propositalmente mentiroso não muda o veredito de `isLeitorV1`.

## Por que abertura sozinha não serve como unidade

Medido no snapshot de 260814: **242 assinantes ativos clicam mas têm abertura abaixo de 40%** — provavelmente bloqueiam carregamento de imagem (onde vive o pixel de abertura), então o pixel nunca dispara mas o clique acontece normalmente (é um link real, não depende de imagem). Definição por abertura erra nos dois sentidos:

- **Falso positivo**: MPP conta abertura sem leitura real.
- **Falso negativo**: bloqueio de imagem esconde engajamento comprovado por clique.

## Distribuição do CTR real

443 assinantes ativos com ≥20 edições recebidas (mediana da base inteira: 110 recebidas):

| CTR real (clicados ÷ recebidas) | N | % |
|---|---|---|
| ≥1% | 272 | 61,4% |
| **≥2%** | **182** | **41,1%** |
| ≥3% | 139 | 31,4% |
| ≥5% | 97 | 21,9% |

Mediana individual: **1,35%**. CTR agregado da base (soma de cliques ÷ soma de recebidas, não média de médias): **5,21%**.

## Decisão: os cortes de `leitor-v1`

```
leitor-v1 = status === "active"
        AND total_received >= 20
        AND (total_unique_clicked / total_received) * 100 >= 2
```

Implementado em `scripts/lib/leitor.ts`:

- `LEITOR_V1_THRESHOLDS = { ctrMinPct: 2, receivedMin: 20 }` — constantes, não hardcoded dentro do predicado.
- `isLeitorV1(input, thresholds = LEITOR_V1_THRESHOLDS)` — predicado puro, testável sem I/O.
- `leitorInputFromBeehiivSubscriber(sub)` — extração estreita do dado bruto do backup/API (ver seção acima).

### Por que o piso é 20 recebidas, não 5

A mediana da base é 110 edições recebidas. Com um piso baixo (5, por exemplo), quem recebeu 5 edições e clicou em 1 já marca 20% de CTR — acima até do corte mais rigoroso da tabela — e entraria como leitor pela pura sorte de ter chegado há pouco, sem nenhum histórico de engajamento sustentado. O piso de 20 exige uma amostra mínima antes de qualquer CTR contar.

### Por que o corte é 2%, não outro valor da tabela

2% é ~1,5× a mediana individual medida (1,35%) e recorta N=182 de 443 elegíveis (41,1%) — nem tão frouxo que inclua a cauda de quase-zero engajamento, nem tão rígido que corte a maioria da base. Testado contra coortes reais de aquisição paga: no mesmo número de ativos, Google Ads produziu 56 leitores e o boost pago produziu 17 — o corte discrimina qualidade de canal, que é exatamente pra isso que ele existe.

## Regra de versionamento: `leitor-v2` nunca sobrescreve `v1` retroativamente

Se os cortes forem revisados no futuro (`leitor-v2`), o histórico de decisões de gasto já tomadas com `leitor-v1` **não é recalculado**. `leitor-v2` é uma definição NOVA, com seu próprio nome de campo/coluna onde for persistida — nunca uma migração in-place do valor `leitor-v1` já registrado. Duas razões:

1. **Auditoria**: uma decisão de ads tomada em determinada data precisa ser explicável com os critérios vigentes NAQUELA data, não retroativamente reinterpretada por um corte que só existe depois.
2. **Comparabilidade**: mudar o corte e sobrescrever o rótulo antigo destrói a possibilidade de medir se `v2` de fato discrimina melhor que `v1` sobre o MESMO histórico.

Na prática: quando `leitor-v2` existir, ele ganha suas próprias constantes (`LEITOR_V2_THRESHOLDS` ou equivalente) e sua própria função/predicado em `scripts/lib/leitor.ts` (ou um módulo irmão) — `isLeitorV1`/`LEITOR_V1_THRESHOLDS` permanecem intocados e `leitor-v1` continua computável exatamente como antes, indefinidamente.

## Migração Beehiiv → Kit (#461/#6050, 260824)

`leitor.ts` ganhou `leitorInputFromKitSubscriber` — extração simétrica à da Beehiiv, mesma disciplina de nunca ler `click_rate`. Mapa de campos:

| `LeitorInput` | Beehiiv | Kit |
|---|---|---|
| `status` | `status` (`unsubscribe: true` é o único caminho pra inativo) | `state` (enum `active\|cancelled\|bounced\|complained\|inactive` — mais rico, motivo de saída é gravável) |
| `totalReceived` | `stats.total_received` | `stats.sent` (via `range` customizado, ver abaixo) |
| `totalUniqueClicked` | `stats.total_unique_clicked` | `stats.clicked` (idem) |

**Achado ao vivo (260824): `range` de `stats` não é limitado a 90 dias.** O default do MCP (`mcp__kit__filter_subscribers`, `include: [{type: "stats"}]`) é uma janela móvel de 90 dias quando `range` é omitido — mas passar `range: {start, end}` explícito aceita qualquer intervalo (testado com `2020-01-01` a `2026-08-24`). Isso destrava o risco técnico original da issue (#6050 temia estar preso a uma janela fixa incompatível com o piso de 20 recebidas do `leitor-v1`, que é acumulado, não móvel).

**Decisão sobre a descontinuidade da série histórica (editor, 260824): aceitar, não fazer bridge.** Os contadores `sent`/`clicked` do Kit começam do zero pra TODO mundo no cutover — inerente a trocar de ESP, o Kit só enxerga envios feitos por ele mesmo (mesmo que o `range` cubra anos, não há dado antes da conta existir). Consequência prática: por ~20 edições (≈3 semanas) pós-cutover, ninguém bate `total_received >= 20`, e a contagem de `leitor-v1` reportada cai artificialmente nesse período — **é vale esperado, não queda real de qualidade**. Rejeitada a alternativa de somar os totais históricos de `data/beehiiv-backup/` (por e-mail) aos contadores novos do Kit: resolveria o vale, mas cria dívida de reconciliação permanente entre duas fontes de dado pra resolver um problema que se resolve sozinho.

**Quando o cutover acontecer** (fora do escopo desta sessão — depende de #463/#464 primeiro), marcar a data aqui como o marco de descontinuidade da série, e o consumidor de `leitor.ts` que rodar contra Kit precisa passar `range.start` = essa data (nunca "desde sempre" — sempre existirá zero antes dela).

## CLI

```bash
# snapshot mais recente de data/beehiiv-backup/, cortes default (2% / 20 recebidas)
npx tsx scripts/lib/leitor.ts

# snapshot específico + cortes customizados
npx tsx scripts/lib/leitor.ts --snapshot 2026-08-14 --ctr-min 3 --received-min 10

# root alternativo (ex: rodar contra um snapshot de teste fora de data/)
npx tsx scripts/lib/leitor.ts --root /caminho/alternativo
```

Saída (`summarizeLeitores`):

```json
{
  "snapshot_date": "2026-08-14",
  "thresholds": { "ctrMinPct": 2, "receivedMin": 20 },
  "total_subscribers": 1462,
  "total_active": 628,
  "leitores_v1": 182
}
```

**Só leitura local** — nunca chama a API Beehiiv ao vivo. Depende de `data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl` já existir (task `Diaria-Beehiiv-Backup`, ver `docs/beehiiv-backup-setup.md`); sem snapshot disponível, o comando sai com erro explícito em vez de degradar silenciosamente pra zero.

## Mapa de origem recuperada (`scripts/build-origem-map.ts`)

Complementar a `leitor-v1`: `promoteBeehiivSubscription`/`activateSubscription` (via score ou clique, #4530) fazem `DELETE`+`CREATE` na subscription Beehiiv pra reativar contatos Pending, e o `CREATE` novo sobrescreve `utm_source`/`utm_medium`/`utm_campaign`/`referring_site` com os valores do próprio evento de reativação (`utm_source: "brevo-diaria"` nas duas vias — ver `scripts/lib/shared/utm-registry.ts`), perdendo a origem de aquisição ORIGINAL do contato (#5231 é o conserto in-band da causa raiz; este script é reconstrução OFFLINE, só para análise — **nenhuma escrita na Beehiiv**).

### Precedência

Cruzando os snapshots semanais em `data/beehiiv-backup/` (mais antigo pro mais novo), pra cada email:

1. Se a aparição **mais recente** já tem origem não-promocional → nunca foi sobrescrito → `original: true`, usa essa aparição.
2. Senão (mais recente é promocional) → usa a aparição **não-promocional mais ANTIGA** disponível → `recuperado: true`. É a melhor aproximação da origem real: quanto mais cedo a fotografia, mais perto do cadastro original.
3. Se nenhuma aparição em nenhum snapshot disponível é não-promocional → sem recuperação — o contato só foi capturado por um backup depois de já ter sido promovido. Fica fora do mapa `origem`, mas entra em `unrecovered_emails` no relatório de cobertura.

`original` e `recuperado` nunca coexistem no mesmo registro, e todo registro do mapa tem exatamente um dos dois — nunca misturado sem sinalizar qual é qual.

### CLI

```bash
npx tsx scripts/build-origem-map.ts
# --root data/beehiiv-backup (default) / --out data/aquisicao/origem-original.json (default)
```

Escreve `data/aquisicao/origem-original.json`:

```json
{
  "generated_at": "...",
  "snapshot_root": "data/beehiiv-backup",
  "snapshots_used": ["2026-06-05", "2026-06-17", "2026-08-14"],
  "promotional_utm_sources": ["brevo-diaria"],
  "emails_seen_total": 1463,
  "original_count": 1419,
  "recovered_count": 40,
  "unrecovered_count": 4,
  "unrecovered_emails": ["..."],
  "origem": {
    "email@exemplo.com": {
      "utm_source": "android.googlequicksearchbox",
      "utm_medium": "...",
      "utm_campaign": "...",
      "referring_site": "...",
      "created": 1733000000,
      "snapshot_date": "2026-06-05",
      "recuperado": true
    }
  }
}
```

Rodando localmente contra os 3 snapshots disponíveis (2026-06-05 / 2026-06-17 / 2026-08-14, junction OneDrive): dos 44 contatos com `utm_source: "brevo-diaria"` no snapshot mais recente, 40 recuperam origem de um snapshot anterior e 4 não têm nenhuma aparição pré-promoção capturada. **Este número é menor que o "191 já sobrescritos" citado no corpo da issue #5235** — a medição da issue é de um ponto do dia 260814 mais tardio que o snapshot mais recente disponível localmente (gerado às 04:06 UTC do mesmo dia pela task `Diaria-Beehiiv-Backup`); a cobertura de recuperação cresce a cada snapshot semanal novo que capturar contatos antes da próxima promoção.

**Só leitura local** — nunca chama a API Beehiiv ao vivo, mesma disciplina de `leitor.ts`.

## `leitor-v1` cross-plataforma (#6464 fatia 7 — #6591)

`scripts/lib/leitor-store.ts` — módulo IRMÃO de `leitor.ts` (ver "Regra de versionamento" acima): mesma definição v1 (`isLeitorV1`, `LEITOR_V1_THRESHOLDS`, `computeCtrPct`), fonte de dado nova — o store unificado do épico #6464 (`scripts/lib/diaria-subscribers-db.ts`, fatias 2-5: #6585/#6586/#6587/#6589), que soma recebidas e cliques ao longo da vida do assinante **atravessando** Beehiiv/Brevo/Kit, em vez de enxergar 1 plataforma por vez.

**Decisão de substituir vs. coexistir com a definição por snapshot: adiada de propósito.** A issue #6591 pediu explicitamente decidir "com o número na mão, não agora" — as duas definições coexistem (`leitor.ts` intocado; `leitor-store.ts` só adiciona um caminho novo de cálculo) até essa decisão ser tomada contra dado real. **Atualização (#7163/#7198, 02-03/09/2026): a 1ª ingestão real já rodou** — `data/diaria-subscribers/` existe, com 77.945 eventos (Beehiiv), 1.198 `identity_alias` e 1.131 `subscriber`. A decisão de substituir vs. coexistir segue pendente mesmo assim: a base de eventos ainda tem buracos conhecidos (cobertura da Beehiiv incompleta, `subscription` pouco populada — ver "Guard de cobertura" abaixo) que precisam fechar antes do número servir de critério pra essa escolha.

### Por que `brevo_clarice` fica de fora

`PLATFORMS` do store **nunca inclui** `brevo_clarice` desde #7196 (fatia 1 do épico #7163) — a base de reativação da Clarice News (~435k contatos, produto/audiência diferente, `scripts/lib/clarice-db.ts`) tem pipeline próprio e nunca ingere no store da diária; a exclusão é estrutural (o tipo `Platform` não tem esse valor), não mais um `.filter()` em cima de um `PLATFORMS` que a incluísse. `leitor-v1` é a unidade de qualidade da **diária**; somar engajamento da Clarice inflaria as duas pontas da fração com um produto diferente — alguém pode ler a Clarice todo dia e nunca ter recebido uma edição da diária. `LEITOR_DIARIA_PLATFORMS` é hoje um alias de `PLATFORMS` (as 3 plataformas da diária: Beehiiv, Brevo diária, Kit) — mantido como nome próprio pra documentar a intenção no ponto de uso.

### Guard de cobertura de `subscription` (#7198)

`summarizeStoreLeitores` pode devolver `leitores_v1: 0`/`total_active: 0` por dois motivos indistinguíveis olhando só o número: a base não tem leitor real, OU a dimensão `subscription` está pouco populada (ingestão de assinatura ainda não rodou pra boa parte da base — era exatamente o estado medido em 02/09/2026: `subscription` com 0 linhas). O campo `subscription_data_coverage_low` no summary (e `missingSubscriptionData` por subscriber em `StoreLeitorResult`, usado pela ficha do painel) sinaliza esse segundo caso explicitamente, abaixo de `LEITOR_SUBSCRIPTION_COVERAGE_WARN_FRACTION` (50%) — mesmo padrão de `MISSING_STATS_WARN_FRACTION` acima. **Corrige a promessa da seção "CLI" abaixo**: com o `.db` PRESENTE mas `subscription` vazia, o comando não sai com erro — devolve o summary normalmente, com `subscription_data_coverage_low: true` sinalizando que o número não é fato. "Nunca degrada silenciosamente pra zero" continua valendo só pro caso do arquivo `.db` AUSENTE (`openDiariaSubscribersDbSafe` → `null` → exit 1).

### Recebidas: `delivered` explícito, ou `sent − bounce` quando a plataforma não expõe `delivered`

Mesma disciplina de `EVENT_TYPES` em `diaria-subscribers-db.ts`: o Kit ingere `delivered` como eixo de 1ª classe (#6586, achado #6504 — Gmail recusou 72% de um envio em massa) — usado direto quando presente. A API da Brevo nunca expõe `delivered` por contato (só `messagesSent`, mapeado pra `"sent"`), mas expõe bounce explícito — por simetria (Kit deriva bounce = sent−delivered; Brevo deriva delivered = sent−bounce), "recebidas" da Brevo é `max(0, sent − bounce)`. Qual caminho usar é **detectado do dado** (`detectPlatformCapabilities` — alguma plataforma já gravou algum evento `delivered`?), nunca hardcoded por nome de plataforma.

### "Únicas clicadas": por edição, não por evento de clique

`total_unique_clicked` conta EDIÇÕES em que o assinante clicou ao menos 1 link — nunca o total de eventos de clique. O Kit já grava 1 evento `click` por (assinante × broadcast); a Brevo grava 1 evento POR LINK (`links[]` de `contact.statistics.clicked`), então 2 links clicados na mesma campanha contariam como 2 "cliques únicos" sem deduplicar — o mesmo viés de inflação que `leitor-v1` inteiro existe pra evitar. Por isso `kit-subscribers-ingest.ts`/`brevo-subscribers-ingest.ts` passaram a gravar `event.edicao` (broadcastId/campaignId, coluna já existia no schema, só não populada) e `leitor-store.ts` conta `COUNT(DISTINCT COALESCE(edicao, external_event_id))` por tipo de evento — o fallback pra `external_event_id` só protege dado legado sem `edicao` (não existe hoje).

### PISO, nunca exato

Herdado de `diaria-subscribers-identity-resolve.ts` (#6589): identidade não-casada aparece como um `subscriber` separado por plataforma (churn + cadastro novo, nunca continuidade) — `summarizeStoreLeitores` sempre devolve `note` (`CROSS_PLATFORM_FLOOR_NOTE`) ao lado do número. "Temos ao menos N leitores" é defensável; "temos N leitores" não é.

### CLI

```bash
npx tsx scripts/lib/leitor-store.ts
# --db <path> (default: data/diaria-subscribers/diaria-subscribers.db)
# --ctr-min 2 --received-min 20 (mesmos defaults de leitor.ts)
```

Só leitura local, nunca chama API nenhuma ao vivo. Sem o store (clone fresco, sessão cloud, ou nenhuma ingestão rodada ainda), sai com erro explícito — nunca degrada silenciosamente pra zero. Com o store presente mas `subscription` pouco populada, o comando não lança — devolve o summary com `subscription_data_coverage_low: true` (ver "Guard de cobertura de `subscription`" acima); o consumidor precisa checar esse campo antes de tratar `leitores_v1`/`total_active` como fato.
