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
