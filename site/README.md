# superharness.tech

The Superharness website: static HTML and CSS in `src/`, built into `dist/` by
`build.mjs`.

```
node build.mjs   # fills in the shared header, footer and App Store badge, writes dist/
./deploy.sh      # builds, then copies dist/ to the web server
```

- `src/`: the pages (home, privacy, terms, 404), the stylesheet, icons and images.
- `partials/`: the header and footer shared by every page.
- `src/img/`: screenshots of the desktop app (`docs/screenshots/desktop-app.png`)
  and of the iOS app in demo mode, resized to WebP.
- `tools/og.html`: the 1200x630 link-preview image (`src/og.png`), captured with
  headless Chrome.
- `deploy/superharness.tech.conf`: a copy of the nginx config on the server.

## App Store link

`APP_STORE_URL` at the top of `build.mjs` is empty while the app is in review, so
the badge reads "Coming soon to the App Store" and links nowhere. When the app is
live, set it to `https://apps.apple.com/app/id6839728222` and run `./deploy.sh`.

## Hosting

The site is served by nginx on lxe.co from `~/www/superharness.tech`. DNS is at
Porkbun: an A record for `superharness.tech` and a CNAME for `www`. The
certificate comes from certbot (webroot, config in `~/letsencrypt` on the server)
and is renewed by the server's existing `certbot renew` cron job.

The site has no analytics, cookies or third-party scripts; the privacy page says
so, so keep it that way or update that page.
