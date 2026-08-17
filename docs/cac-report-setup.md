# Custo por leitor por canal (`scripts/cac-report.ts`) + `/ads` no Studio

Issue: [#5236](https://github.com/vjpixel/diaria-studio/issues/5236). Depende de `leitor-v1` + mapa de origem recuperada (#5235, ver `docs/definicao-leitor.md`).

## O que isto responde

Onde botar o orçamento de aquisição (R$ 4.000+/mês, decisão do editor 260814 — teto de CAC revogado, o custo **ranqueia**, não reprova). A tela `/ads` do Studio responde em 5 segundos:

1. Qual canal traz leitor mais barato, e com que `n`?
2. A coorte de cada canal lê mais ou menos que a base?
3. Quanto do orçamento do mês já foi consumido?
4. Algum canal degradou desde o último período?

## Parte 1 — `data/aquisicao/spend.csv`

Import manual, cinco colunas: `canal,mes,moeda,valor,fonte`. `valor` é sempre um número com **ponto** decimal (`956.21`), nunca vírgula — a coluna `moeda` já carrega o código separadamente. Ver `scripts/lib/aquisicao-spend.ts` (`parseSpendCsv`) pro parser (tolerante mas barulhento: header faltando lança, célula vazia/valor inválido vira `errors[]` visível, nunca `null` silencioso).

Seed inicial (as 3 linhas do histórico conhecido em 260814 — Google Ads R$ 956,21, Beehiiv Boosts R$ 397,08, LinkedIn R$ 0):

```bash
npx tsx scripts/seed-spend-csv.ts        # recusa sobrescrever se já existir
npx tsx scripts/seed-spend-csv.ts --force
```

`data/` é a junction OneDrive (`.gitignore` blanket) — o CSV em si nunca vai pro repo; `SPEND_SEED_ROWS` (`scripts/lib/aquisicao-spend.ts`) é a fonte versionada do conteúdo do seed, com o rationale completo de `mes`/`fonte` documentado ali.

## Parte 2 — `scripts/cac-report.ts`

```bash
npx tsx scripts/cac-report.ts                       # snapshot mais recente, registra em /relatorios
npx tsx scripts/cac-report.ts --json
npx tsx scripts/cac-report.ts --snapshot 2026-08-14 --no-register
npx tsx scripts/cac-report.ts --desde 2026-08-01 --ate 2026-08-16   # recorta a base por created (#5495)
```

Insumos: `data/aquisicao/spend.csv`, snapshot mais recente de `data/beehiiv-backup/`, e (opcional) `data/aquisicao/origem-original.json` — sem ele, roda com aviso explícito usando `utm_source` cru.

Núcleo puro em `scripts/lib/cac.ts` (reusa `resolveGroupKey`/`computeGroupEngagement`/`filterWindow`/`countMissingCreated` de `scripts/cohort-engagement.ts`, nunca reimplementa):

- **Filtra contas internas/teste antes de agrupar** (`filterInternalAndTestSubscribers` — endereça o achado do self-review de #5235: `build-origem-map.ts` não fazia esse filtro nem normalizava email).
- **`CHANNEL_KEY_SPECS`** (#5496) é a fonte única de verdade — uma lista de specs `{ canal, subcanal?, keys, janela?, ambigua? }`, não mais um mapa achatado canal→chaves. `CHANNEL_GROUP_KEYS` (mapa legado canal→chaves, usado quando `spend.csv` não usa a coluna `subcanal`) é DERIVADO dali, união das chaves NÃO-ambíguas de cada canal. Google Ads confirmado em #4466/#5254: sub-canal "PMax" (`android.googlequicksearchbox`, `googlesyndication`, `googleadservices`); sub-canal "Search" (`google.com`) é AMBÍGUO — colide com busca orgânica — e só conta como pago dentro da janela da campanha (dez/2025-fev/2026, `spec.janela`), nunca fora dela e nunca no caminho legado sem sub-canal (`CHANNEL_GROUP_KEYS["Google Ads"]` exclui `google.com` de propósito). LinkedIn ainda sem campanha real rodada (spend R$0), chaves são convenção especulativa a confirmar quando uma campanha real rodar.
- **Meta / Microsoft Advertising (#5493)**: nomes canônicos fixados em `RESERVED_CHANNEL_NAMES` (`"Meta"`, `"Microsoft Advertising"`), mas SEM spec em `CHANNEL_KEY_SPECS` ainda — bloqueado por observação real (navegador embutido da Meta corta a query string; `instagram.com`/`instagram-diaria`/`instagram-pessoal` já são orgânicos hoje). Rodar `npx tsx scripts/observe-channel-keys.ts --since AAAA-MM-DD` contra ≥1 dia de campanha real e colar a saída literal no PR que adicionar a spec — nunca adivinhar. Até lá, uma linha `Meta`/`Microsoft Advertising` em `spend.csv` aparece como "canal desconhecido" avisado (nunca como número silenciosamente errado).
- **Beehiiv Boosts** é ESTIMADO, nunca medido por grupo (sem chave de atribuição estável no snapshot) — faixa mín-máx pela proporção 157 leads faturados / 233 leads totais (`BOOST_ESTIMATE_ANCHOR`), nunca soma no total "medido" do relatório.
- **leitor-v1** (`scripts/lib/leitor.ts`) é contado separadamente — nunca o campo `.leitores` de `GroupEngagement` (que depende de `open_rate` por assinante, ausente nos snapshots locais).
- **Janela de atribuição opcional** (`--desde`/`--ate`, #5495): filtra TODA a base (`subs`) por `created` antes de qualquer agregação — base metrics e por canal. Assinante sem `created` é excluído quando a janela está ativa (nunca assumido dentro/fora), contado em `CacReport.excludedMissingCreated` e impresso no corpo do relatório. Combina por INTERSECÇÃO com a janela própria de um sub-canal ambíguo (`spec.janela`), quando a linha usa `subcanal` — `CacMeasuredRow.window`/`.excludedMissingCreated` carregam a janela EFETIVA por linha. Sem `--desde`/`--ate`, comportamento idêntico a antes do #5495 (acumulado desde sempre).
- **Procedência no corpo do markdown** (#5495): data de apuração (`now()`), snapshot usado, e a janela aplicada aparecem como linhas no topo do relatório — não só no nome do arquivo. O id do relatório ganha um sufixo `--w{desde}_{ate}` quando `--desde`/`--ate` é passado, pra duas apurações com janelas diferentes no mesmo snapshot não se sobrescreverem (sem flags, o id continua só `{snapshotDate}`, comportamento inalterado).
- **Sub-canal** (`SpendRow.subcanal`, coluna OPCIONAL em `spend.csv` — não faz parte de `SPEND_CSV_HEADERS`, arquivo sem ela parseia idêntico a sempre): uma linha com `subcanal` mede só aquela spec (`{canal, subcanal}`); uma linha sem `subcanal` continua medindo "o canal inteiro" via `CHANNEL_GROUP_KEYS`. `buildCacReport` recusa (`assertNoMixedSubcanalRows`, lança) `spend.csv` que misture, no mesmo `(canal, mes)`, uma linha de canal inteiro com linha(s) de sub-canal — dupla-contagem em `totalGastoMedido`.
- Sinal de **degradação**: compara a abertura agregada do canal no snapshot mais recente contra o snapshot ANTERIOR disponível (queda ≥5pp → `degradado: true`); sem 2º snapshot, fica `null` (nunca `false` por omissão).

## Parte 2b — `scripts/observe-channel-keys.ts` (#5493)

Instrumento de OBSERVAÇÃO (nunca adivinhação) das chaves de grupo (`utm_source`/`referring_site` normalizados) usadas por assinantes cadastrados numa janela — existe pra transformar "chute de chave de canal novo" em "medição" antes de adicionar uma spec a `CHANNEL_KEY_SPECS`.

```bash
npx tsx scripts/observe-channel-keys.ts --since 2026-08-17
npx tsx scripts/observe-channel-keys.ts --since 2026-08-17 --until 2026-08-20 --filter "facebook|instagram"
```

Só leitura local (snapshot já baixado) — nunca toca a API Meta/Microsoft/Beehiiv ao vivo. Filtra contas internas/teste antes de contar, mesmo padrão de `cac-report.ts`.

## Parte 3 — `/ads` no Studio

`scripts/studio-ui/studio-ads.ts` (`buildAdsData`) — mesmo padrão de `studio-tasks.ts`: cache 10min + `forceRefresh`, fail-soft por camada (spend/snapshot/origem cada um com seu próprio `error`, nunca derruba a página). Sessão cloud (`data/` ausente) mostra "sem dados" — nunca lança.

`GET /api/ads` → `scripts/studio-ui/public/ads.html`/`ads.js`/`ads.css`. Read-only nesta versão — sem edição de `spend.csv` pela UI (import manual continua fora do Studio). Tabela mostra a coluna Sub-canal (#5496) e o rodapé indica snapshot + data de apuração; janela `--desde`/`--ate` não é exposta como controle da UI ainda (o painel sempre chama `buildCacReport` sem `opts.window` — só o CLI aceita as flags por enquanto).

## Achados de self-review (não corrigidos nesta unidade — ver comentários inline do PR)

- `CHANNEL_GROUP_KEYS["LinkedIn"]` é especulativo (nenhuma campanha real rodou ainda) — confirmar/ajustar quando houver dado real.
- A fórmula de `computeBoostRange` (escalar `ativosAnchor`/`leitoresAnchor` pela razão `233/157`) é uma interpretação razoável de "estimados pela proporção 157/233", mas não está pinada a uma derivação explícita na issue — vale confirmação do editor.
- `DEGRADATION_THRESHOLD_PCT = 5` (pontos percentuais) é um default arbitrário, não especificado pela issue.
- (#5236, corrigido no #5276) Canal desconhecido em `spend.csv` avisa em 3 superfícies (console + markdown + `/ads`) — ver `CacReport.unmappedChannels`.
- (#5496) A janela da spec "Search" (dez/2025 a fev/2026) foi fixada a partir da descrição textual da campanha nas issues #4466/#5254/#5496 ("pausada ~06/fev/2026"), não de uma data exata de fatura — se o painel Google Ads tiver a data exata de pausa, vale apertar a borda.
- (#5495) O painel `/ads` do Studio não expõe controle de `--desde`/`--ate` na UI — só o CLI `cac-report.ts` aceita as flags por ora.
