# Superharness Push Relay (Cloudflare Worker)

Stateless APNs relay for the Superharness iOS companion app (`com.lxe.superharness`), reusing your Cloudflare account and Apple Developer Team APNs AuthKey (`.p8`).

## One-time Deploy

```bash
cd push-relay
npx wrangler login
npx wrangler kv namespace create DEVICES
# Paste the returned KV namespace id into wrangler.toml
npx wrangler secret put APNS_KEY < /path/to/AuthKey_7CV9JYHX47.p8
npx wrangler deploy
```

Once deployed at `https://super-harness-push.lxe.workers.dev`, both the iOS app and Linux host automatically derive the shared HMAC relay key from your existing Mobile API Bearer token — no extra pairing required.
