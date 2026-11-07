#!/bin/sh
# Liest das Cloudflare-Token aus dem Compose-Secret in die Umgebung von
# Caddy. Die Konfiguration enthält nur den Platzhalter {env.CF_API_TOKEN};
# so steht das Token weder in docker inspect noch in Caddys autosave.json.
set -eu
if [ -r /run/secrets/cloudflare_token ]; then
  CF_API_TOKEN="$(tr -d '\r\n' < /run/secrets/cloudflare_token)"
  export CF_API_TOKEN
else
  echo "deployer-caddy: /run/secrets/cloudflare_token fehlt - Zertifikate per DNS-Challenge gehen nicht" >&2
fi
exec "$@"
