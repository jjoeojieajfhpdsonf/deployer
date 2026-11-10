# Caddy mit dem DNS-Modul für Cloudflare (M4: Wildcard-Zertifikat per DNS-01).
# Nur für compose.tls.yaml; der Basis-Stack nimmt das offizielle caddy:2-alpine.
ARG CADDY_VERSION=2.10.0

FROM caddy:${CADDY_VERSION}-builder-alpine AS build
ARG CF_MODULE_VERSION=v0.2.4
# M8: Ratenlimit für die CSP-Meldungen, die Caddy vom Host eines Projekts an Airlock weiterleitet
ARG RATELIMIT_MODULE_VERSION=v0.1.0
RUN xcaddy build \
  --with github.com/caddy-dns/cloudflare@${CF_MODULE_VERSION} \
  --with github.com/mholt/caddy-ratelimit@${RATELIMIT_MODULE_VERSION}

FROM caddy:${CADDY_VERSION}-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY entrypoint.sh /usr/local/bin/airlock-caddy-entrypoint
RUN chmod 0755 /usr/local/bin/airlock-caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/airlock-caddy-entrypoint"]
