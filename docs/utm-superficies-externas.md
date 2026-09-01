# UTM das superfícies externas (#4525)

Links pra `diar.ia.br` que **não nascem de código**: campo de bio, site de
perfil, homepage de repositório. O inventário vive em
`scripts/lib/shared/utm-registry.ts` (`EXTERNAL_UTM_SURFACES`), aparece no
`/utms` do Studio, e este documento é o runbook — onde fica cada campo, o que
cada plataforma faz com a URL, e como reconferir.

**Por que existe:** o #4295 fechou o que a pipeline emite e deixou estas
explicitamente fora de escopo. A varredura de 260803 achou pior do que "sem
UTM" — três convenções incompatíveis coexistindo, duas apontando pra uma
campanha encerrada em ago/2026 (`lancamento-2607`), uma superfície sem link
nenhum, e nenhuma das seis no inventário.

## Convenção

```
utm_source={plataforma nua}   utm_medium=bio   utm_campaign=perfil-{source}[-{variante}]
```

- **`utm_source` nu** (`instagram`, não `instagram-diaria`): o sufixo fatiava o
  mesmo canal em duas linhas do `/utms` que nunca somam.
- **`utm_medium=bio`** separa o link PARADO no perfil do CTA do post do dia, que
  usa `organic_social` com o mesmo `utm_source`. Sem isso, as duas conversões
  colapsam na mesma linha.
- **`utm_campaign` único por superfície.** Um campaign compartilhado quebra o
  detector de drift: o Beehiiv só devolve agregações planas (`counts` por
  source, `campaignCounts` por campaign, sem cruzamento), então bastaria UMA
  superfície converter pra mascarar todas as outras. A **variante** existe pra
  quando a mesma plataforma hospeda mais de uma superfície (os 2 repos do
  GitHub).
- Nunca digite a URL: use `buildExternalSurfaceUrl()`.

## Estado (260803)

| Superfície | Onde se edita | Valor | Aplicado |
|---|---|---|---|
| Instagram | **app mobile** → Editar perfil → Site | `perfil-instagram` | 260803 (editor) |
| Facebook | Trocar identidade → Página → Sobre → Links | `perfil-facebook` | 260803 |
| Threads | Edit profile → Links → Add link | `perfil-threads` | 260803 |
| X | Edit profile → Website | `perfil-twitter` | 260803 |
| Apoia.se | Editar campanha → Identificação → Redes sociais → 1º campo | só `utm_source=apoiase` | 260803 (editor) |
| YouTube | Studio → Personalização → Perfil → Links | `perfil-youtube` | 260803 |
| GitHub `diaria-studio` | `gh repo edit --homepage` | `perfil-github-studio` | 260803 |
| GitHub `diaria-design` | `gh repo edit --homepage` | `perfil-github-design` | 260803 |
| LinkedIn | Editar página → Botão + Site | `company_page_cta` (exceção) | 260731 |

## Armadilhas por plataforma — leia antes de mexer

**Instagram — só pelo app.** O campo Website de `instagram.com/accounts/edit/`
vem desabilitado na web: *"Editing your links is only available on mobile."*
Não há contorno por browser.

**Apoia.se — trunca no `&`.** Aceita o save, retorna sucesso, e **descarta em
silêncio** qualquer URL com mais de um parâmetro: o link some da página pública
em vez de dar erro. Um parâmetro só persiste. Por isso a entrada carrega apenas
`utm_source=apoiase` e o drift dela é medido por `source`, não por `campaign`
(`driftKey: "source"`) — legítimo porque esse source é exclusivo dela.

**Facebook — exige trocar a identidade.** Pelo perfil pessoal a seção Links é
read-only. É preciso "Trocar agora" pra identidade da Página antes de
Sobre → Links.

**YouTube — o campo precisa de blur.** O botão Publicar só sai do estado inerte
depois que o campo perde o foco. Sem Tab antes de publicar, a edição se perde em
silêncio.

**Threads — acrescenta parâmetros.** O redirect final leva
`utm_content=link_in_bio` + um `utm_id` próprio, colados por cima dos nossos. Os
3 parâmetros sobrevivem intactos; o extra não atrapalha, mas vai aparecer no
relatório.

**LinkedIn — exceção deliberada.** Já estava taggeado antes de a convenção
existir (foi dele que o #4295 tirou o padrão), o campaign já é único, e o canal
tem conversão real. Renomear custaria a série histórica sem ganhar medição.
O `utm_medium=organic_social` fora do padrão é o marcador visível de que é
exceção. Um mesmo valor cobre dois pontos: o botão de CTA e o campo Site.

## Pré-registradas, ainda não publicadas (#5917)

**Nexo Jornal** (`perfil-nexo`) e **Outras Palavras** (`perfil-outraspalavras`) —
artigos assinados em veículo externo, link na bio do autor ao pé do artigo.
Registradas em `EXTERNAL_UTM_SURFACES` **antes** de o artigo sair (reunião com
o Nexo em 24/08/2026; artigo pro Outras Palavras ainda a enviar) — as duas
ainda **sem `appliedAt`**, porque nenhum dos dois artigos foi publicado.

**Por que registrar antes, diferente de toda outra entrada desta tabela:** os
8 slots acima são campos de painel — editáveis pra sempre, dá pra corrigir o
UTM a qualquer momento. A bio de um artigo publicado **congela** junto com o
artigo. Errar o UTM (ou esquecer de incluir) no artigo é irreversível para
aquele artigo especificamente — não há segunda chance de instrumentar depois
que sai. Por isso a instrumentação precisa estar pronta e revisada *antes* do
envio ao veículo, não depois de publicar.

`appliedAt` ausente é o mecanismo que já existe pra esse estado: o detector
de drift (`computeDrift`) trata superfície sem `appliedAt` como "ainda não
aplicada, não converter é o esperado" — nunca acusa `sem_conversao` até o
editor setar a data real de publicação. `panelUrl` das duas aponta pra home
do veículo (não pra URL do artigo específico, que ainda não existe) — trocar
pela URL do artigo real, junto com `appliedAt`, assim que sair.

**Decisão de `driftKey` (#5917, precedente Apoia.se acima):** as duas nascem
com os **3 parâmetros completos** (`driftKey` ausente = default `campaign`),
**não** com o fallback de 1 parâmetro que o Apoia.se usa. O fallback do
Apoia.se foi REATIVO — confirmado ao vivo que a plataforma trunca a URL no
`&`. Não há evidência equivalente pra Nexo/Outras Palavras; presumir
truncamento preventivamente trocaria uma exceção observada por um default
sem base. Se o veículo truncar a query string na publicação (ou o editor do
veículo simplesmente limpar a URL), migrar pra `driftKey: "source"` então —
mesmo caminho que o Apoia.se percorreu, não antes.

**1 campaign por VEÍCULO, nunca por artigo.** Se virar coluna recorrente
(~1×/mês em vez de artigo avulso), `perfil-nexo`/`perfil-outraspalavras`
continuam cobrindo todos os artigos daquele veículo — nunca criar
`perfil-nexo-artigo-2` ou variante por artigo. O motivo é o mesmo do resto
desta convenção: o Beehiiv só devolve agregações PLANAS (`counts` por
source, `campaignCounts` por campaign, sem cruzamento), então um campaign por
artigo fatiaria a série em linhas que nunca somam — o mesmo bug que o #4525
corrigiu ao unificar `instagram-diaria` em `instagram`.

**Fora de escopo desta instrumentação** (#5917): escrever o artigo e conduzir
a conversa com os veículos — trabalho do editor, não desta fatia de código.

## Sem onde pôr link

Não entraram no inventário porque não emitem nada — catalogar superfície que não
existe seria mentira de inventário.

- **Uma Penca** (`umapenca.com/diariabr`): o painel só tem campos de
  Instagram/YouTube/TikTok/X, **sem campo de site**, e a loja pública não tem
  nenhum caminho de volta pra `diar.ia.br`. Só entraria via página customizada.
- **Spotify** (show): o único campo de URL é "New Host URL", que é migração de
  hospedagem. Um link só caberia no texto da descrição.

## Como reconferir

Estas superfícies somem em redesign de plataforma sem avisar ninguém.

1. `/utms` do Studio, bloco **Superfícies externas**: a coluna de assinantes por
   campanha é o sinal por superfície. Zero numa superfície com `appliedAt`
   antigo aparece como drift `sem_conversao`.
2. Ao vivo: abrir o `panelUrl` da entrada e conferir que a query string
   sobreviveu ao save (Facebook e Apoia.se normalizam URL).
3. `npx tsx scripts/count-subscriptions-by-utm.ts` — as origens novas devem
   aparecer com volume baixo mas não-zero.

**Zero absoluto em todas ao mesmo tempo** não é "os perfis não convertem": é
sinal de que algo quebrou no caminho. Investigar antes de concluir.

## Fora de alcance por design

Story cards e thumbnail default (`gen-story-card.ts`, `gen-default-thumbnail.ts`)
rasterizam `diar.ia.br` **dentro** da imagem — quem vê digita o domínio. É
`direct` legítimo, sem instrumento possível.

## Exceção conhecida do #4424

O YouTube **recusa** `diar.ia.br` como nome de canal: *"Esse nome não pode ser
usado no seu canal do YouTube. Tente outro nome."* Bloqueio de nome com forma de
domínio. O canal segue `diariabr` (o `@handle` é slug técnico e não muda de todo
jeito). Não é pendência — é limite de plataforma.
