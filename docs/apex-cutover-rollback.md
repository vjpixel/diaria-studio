# Plano de rollback do cutover do apex `diar.ia.br` (#467)

Preparado em **25/08/2026**, antes de qualquer ação. Existe porque a capacidade
central do cutover — `custom_domain = true` no apex depois que a Beehiiv soltar
o custom hostname — **não é testável antes**: o teste é a própria janela.

Medido ao vivo via API da Cloudflare (zona `0c1a216dee80404257ce225a18fae896`).

> **Este documento é o estado PRÉ-cutover.** Se ele divergir da realidade,
> confie na zona, não neste arquivo — e atualize-o.

---

## 1. Estado a restaurar (valores exatos)

```
A     diar.ia.br  →  104.16.243.55        proxied=true   ttl=1 (auto)
                     id 9246e7ffc5e6c8df11c979d31ca6cb1e

AAAA  diar.ia.br  →  2001:12ff:0:2::95    proxied=true   ttl=1 (auto)
                     id 1e19bf3285dff54456b607f6564617f7
```

Fatos vizinhos, verificados na mesma medição:

- **`www.diar.ia.br` não existe** na zona. Nada a restaurar ali.
- **0 rotas de Worker** na zona (a fantasma `diar.ia.br/2026/o-agente*` foi
  removida em 25/08 — ver #467). Se aparecer rota nova, não é resíduo: é algo
  que o cutover criou.
- O token de API do projeto **escreve DNS mas NÃO lê custom hostnames**
  (`Authentication error` em `/custom_hostnames`). O lado Cloudflare for SaaS
  da Beehiiv só é observável pelo painel — não automatizar checagem por ali.

## 2. Gatilhos de rollback

Reverter **sem discutir** se, após o cutover:

1. `https://diar.ia.br/` não responde 200 por mais de ~10 min
2. `https://diar.ia.br/p/{slug}` de uma edição conhecida não responde 200
3. O certificado não emite / erro de TLS no apex
4. `/subscribe` ou os formulários param de aceitar cadastro

O critério é **funcional, não estético**. Layout errado se conserta com o apex
já nosso; página fora do ar, não.

## 3. Procedimento

Restaurar é um PATCH em cada registro, de volta ao conteúdo da seção 1:

```bash
# A
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/9246e7ffc5e6c8df11c979d31ca6cb1e" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"A","name":"diar.ia.br","content":"104.16.243.55","proxied":true,"ttl":1}'

# AAAA
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/1e19bf3285dff54456b607f6564617f7" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"AAAA","name":"diar.ia.br","content":"2001:12ff:0:2::95","proxied":true,"ttl":1}'
```

`ZONE=0c1a216dee80404257ce225a18fae896`.

**Se o `custom_domain = true` do Worker tiver assumido o apex**, o PATCH acima
pode não bastar: o binding de custom domain precisa ser removido antes
(`wrangler` ou painel), senão a Cloudflare mantém o roteamento pro Worker. Essa
é a ordem de reversão: **primeiro soltar o custom domain, depois restaurar
A/AAAA.**

## 4. O que o rollback NÃO devolve

Registrado para a decisão de reverter ser informada, não otimista:

- **O custom hostname da Beehiiv precisa ser re-adicionado do lado deles.**
  Soltar é ação no painel da Beehiiv; voltar também é. O DNS apontar de volta
  pros IPs antigos não recria o binding SaaS na ponta deles.
- **Tempo de propagação**: os registros são `proxied=true` com TTL auto, o que
  torna a volta rápida no edge da Cloudflare — mas resolvers intermediários e
  o lado da Beehiiv têm cache próprio.
- **Certificado**: se o cutover emitir cert novo pro apex, reverter pode deixar
  uma janela de incompatibilidade até a Beehiiv reemitir o dela.

**Consequência prática:** rollback é recuperação de indisponibilidade, não um
"desfazer" barato. Vale ter a janela curta e a decisão de reverter tomada cedo.

## 5. Verificação pós-cutover (e pós-rollback)

```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"
for u in "https://diar.ia.br/" "https://diar.ia.br/robots.txt" \
         "https://arquivo.diar.ia.br/" "https://especial.diar.ia.br/2026/o-agente/"; do
  printf "%-50s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" --max-time 20 "$u")"
done
```

**Usar user-agent de navegador.** `curl` cru leva challenge 403 da Cloudflare no
apex — achado ao vivo em 25/08, e é medição inútil: 403 de challenge não
distingue "no ar" de "fora do ar".

Sinais de que o cutover **funcionou** (não só "respondeu"):

- `GET /robots.txt` **não** contém `# beehiiv default robots.txt` no topo
- `GET /p/{slug}` de uma edição traz `<html lang="pt-BR">`, não `lang="en"`
- a meta description da página descreve **aquela** edição, não outras (#5101)

Os três são exatamente o que o cutover existe para consertar; se qualquer um
continuar como antes, o apex ainda não é nosso, independentemente do 200.

## 6. Antes de abrir a janela

- [ ] Reconfirmar a seção 1 contra a zona (este arquivo pode ter envelhecido)
- [ ] Worker do apex **deployado e testado em host alternativo** — a janela não
      é hora de descobrir bug de render
- [ ] Editor com acesso ao painel da Beehiiv aberto (soltar o custom hostname)
      **e** ao da Cloudflare (rollback)
- [ ] Janela fora do horário de envio da edição (06:00 BRT) e do cluster de
      tasks matinais (09:00-09:50) — ver `docs/scheduled-tasks-registry.md`
