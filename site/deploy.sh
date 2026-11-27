#!/bin/sh
# Builds the site and copies it to lxe.co:www/superharness.tech (nginx serves it;
# config in deploy/superharness.tech.conf).
set -e
cd "$(dirname "$0")"
node build.mjs
rsync -az --delete -e "ssh -o BatchMode=yes" dist/ lxe.co:www/superharness.tech/
echo "deployed to https://superharness.tech/"
