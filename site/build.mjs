// Builds the static site into dist/: copies src/, fills in the shared header,
// footer and App Store badge, and writes the sitemap.
// Run: node build.mjs   Deploy: ./deploy.sh
import { cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://superharness.tech";
const GITHUB = "https://github.com/lxe/super-harness";

// The App Store link. Leave it empty while the app is in review: the badge then
// reads "Coming soon to the App Store" and links nowhere. When the app is live,
// set it to "https://apps.apple.com/app/id6839728222" and run ./deploy.sh.
const APP_STORE_URL = "";

const partial = (name) => readFileSync(join("partials", `${name}.html`), "utf8").trim();

const appleMark =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.54zM14.17 6.1c.61-.74 1.02-1.76.91-2.78-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.7-.93 2.7.98.08 1.98-.5 2.59-1.24z"/></svg>';

const appStoreBadge = APP_STORE_URL
  ? `<a class="store" href="${APP_STORE_URL}">${appleMark}<span><small>Download on the</small>App Store</span></a>`
  : `<span class="store soon" role="img" aria-label="Coming soon to the App Store">${appleMark}<span><small>Coming soon to the</small>App Store</span></span>`;

const vars = {
  SITE,
  GITHUB,
  APP_STORE_BADGE: appStoreBadge,
  BUILD: Date.now().toString(36),
  HEADER: partial("header"),
  FOOTER: partial("footer"),
};
const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

rmSync("dist", { recursive: true, force: true });
cpSync("src", "dist", { recursive: true });

const pages = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(html|txt|xml|webmanifest)$/.test(f)) continue;
    // Two passes: the header and footer contain variables of their own.
    const s = fill(fill(readFileSync(p, "utf8")));
    const left = s.match(/\{\{\w+\}\}/);
    if (left) throw new Error(`${p}: unfilled ${left[0]}`);
    writeFileSync(p, s);
    if (f === "index.html" && !/robots" content="noindex/.test(s)) pages.push(p.slice("dist".length).replace(/index\.html$/, ""));
  }
})("dist");

const today = new Date().toISOString().slice(0, 10);
writeFileSync("dist/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.sort().map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`);
console.log(`built dist/: ${pages.sort().join(", ")}`);
console.log(`  App Store: ${APP_STORE_URL || "coming soon (no link)"}`);
