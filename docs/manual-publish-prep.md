# Publicação manual requer `prep-manual-publish.ts` antes

Movido do `CLAUDE.md` (#6935 PR 2 — curadoria do teto de bytes, ver
"Otimização de tokens" no `CLAUDE.md`). Enforcement real do que segue vive
em código (`scripts/prep-manual-publish.ts`, `scripts/close-poll.ts`,
`scripts/sync-intentional-error.ts`), não em alguém lembrar de ler este
texto — por isso mover daqui não muda nenhum comportamento do pipeline.

## O procedimento (#1044, #1047, refatorado #1185, simplificado #1186)

Sempre que for publicar manualmente no Beehiiv, **antes** do paste no
template, rodar:

```
npx tsx scripts/prep-manual-publish.ts --edition AAMMDD
```

O script valida pré-condições (`newsletter-final.html` tem a merge tag de
identidade do voto, Worker disponível) e imprime instruções step-by-step
(URL do template, file path do HTML, comando `close-poll` após publicar).

## Modo merge-tag (#1186)

A URL de voto usa essa merge tag sem sig HMAC — `inject-poll-sig.ts` foi
removido.

## `{{email}}` cru, não `{{poll_token}}` (#4581, 260804)

A merge tag do voto é `{{email}}` cru. **NÃO rodar `inject-poll-token.ts`.**

O #4487 (260802) tinha trocado `{{email}}` pelo token opaco
`{{poll_token}}@vote.eia.diaria.local` pra parar de vazar o e-mail do
assinante quando a edição é encaminhada (#4487/#4456 — "vota no lugar
dele"). Revertido no ramo Beehiiv em 260804, decisão do editor: **o É IA?
não distribui prêmio**, então votar no lugar de outra pessoa não causa
dano — e o token cobrava um custo real, porque dependia de um custom field
populado por assinante que nunca chegou a rodar ao vivo; com o campo
inexistente a Beehiiv acusa "Invalid merge tag" e a base inteira vota com a
mesma identidade degenerada.

`scripts/inject-poll-token.ts` continua no repo mas **ficou órfão do
diário**: rodá-lo hoje gasta ~565 PATCHes na Beehiiv + escritas no KV,
termina com exit 0 e não muda nada que o e-mail leia — trabalho
desperdiçado reportando sucesso (por isso ele agora aborta sem
`--force-orphan`).

O token segue **vivo e em produção no canal Brevo** (`brevo_diaria`,
#4517), onde `publish-daily-brevo.ts` popula o atributo inline antes de
cada campanha. Destino do script e unificação dos dois canais: #4581.

## Depois de publicar

Rodar:

```
npx tsx scripts/close-poll.ts --edition AAMMDD
```

**`close-poll.ts` sincroniza `intentional-errors.jsonl` automaticamente
(#3210)** — chama `sync-intentional-error.ts` internamente (idempotente,
fail-soft) então o gabarito do "ache o erro" fica registrado mesmo sem
passar pelo playbook automático (`beehiiv-playbook.md` §0.1, que só roda no
fluxo `/diaria-5-publicacao`). Antes do #3210, publicação manual nunca
sincronizava a entry — o jsonl ficava com buraco e §0-replies (Stage 0) não
conseguia creditar leitor que acertasse o erro dessa edição.
