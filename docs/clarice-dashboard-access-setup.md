# clarice-dashboard — access setup

Cookie-token auth gates the entire dashboard.
A single shared token is configured as a Worker secret and validated via a `cf-dash-auth` cookie (HttpOnly, Secure, SameSite=Strict, 30-day expiry).
No Cloudflare Access zone required.

---

## Initial setup

### 1. Generate a strong token

```bash
openssl rand -hex 32
```

Copy the output — this is your AUTH_TOKEN. Store it in 1Password or equivalent.

### 2. Set the secret

```bash
cd workers/brevo-dashboard
wrangler secret put AUTH_TOKEN
# paste the token when prompted
```

### 3. Deploy

```bash
wrangler deploy
```

### 4. Verify login

Open `https://clarice-dashboard.diaria.workers.dev` in a private window.
The login page should appear.
Enter the token → you should be redirected to the dashboard.

Both `vjpixel@gmail.com` and `felipe@clarice.ai` use the same shared token — share it via 1Password or secure channel.

---

## Mandatory deploy ordering — coupon tab (PII guard)

The coupon tab shows customer emails. Never enable it before auth is confirmed working.

1. **Set AUTH_TOKEN + deploy** (steps 1–3 above) → dashboard now requires login
2. **Verify login works** (step 4) — do not proceed until confirmed
3. **Set Stripe key**
   ```bash
   wrangler secret put STRIPE_API_KEY
   ```
4. **Deploy**
   ```bash
   wrangler deploy
   ```
5. **Enable coupon tab** — in `wrangler.toml` under `[vars]`:
   ```toml
   COUPONS_TAB_ENABLED = "true"
   ```
   Then deploy again:
   ```bash
   wrangler deploy
   ```
6. **Verify** — open dashboard, log in, confirm coupon tab is visible and loads data

---

## Rollback

```bash
# Clear cached state
wrangler kv key delete --binding=STATS_CACHE "dash:lastgood:html"
wrangler kv key delete --binding=STATS_CACHE "dash:lastgood:hash"
wrangler kv key delete --binding=STATS_CACHE "coupons:usage"

# Disable coupon tab (set COUPONS_TAB_ENABLED=false in wrangler.toml or Cloudflare dashboard)
wrangler deploy
```

---

## Revoking access

Generate a new token and overwrite the secret:

```bash
openssl rand -hex 32
wrangler secret put AUTH_TOKEN   # paste new token
```

The old cookie becomes instantly invalid — all sessions are logged out automatically.
Distribute the new token to `vjpixel@gmail.com` and `felipe@clarice.ai`.

---

## Dev mode

If `AUTH_TOKEN` is not set, auth is bypassed — the dashboard is fully open.
This is the default for local `wrangler dev` without secrets.
Never leave `AUTH_TOKEN` unset in production.
