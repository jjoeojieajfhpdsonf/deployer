#!/bin/sh
# Alter Weg (compose.tls.yaml): Cloudflare-Token aus dem Compose-Secret in
# die Umgebung von Caddy; die Konfiguration enthält dann {env.CF_API_TOKEN}.
#
# Neu (System → Cloudflare verbinden): Airlock schreibt das Token nach
# /run/caddy-secrets/cloudflare_token, die Konfiguration enthält nur
# {file./run/caddy-secrets/cloudflare_token}. In beiden Fällen steht das
# Token weder in docker inspect noch in Caddys autosave.json.
set -eu
if [ -r /run/secrets/cloudflare_token ]; then
  CF_API_TOKEN="$(tr -d '\r\n' < /run/secrets/cloudflare_token)"
  export CF_API_TOKEN
fi
exec "$@"
