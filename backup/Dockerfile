# Backup-Container (docs/MILESTONE-BACKUP.md): restic in fester Version und
# pg_dump in derselben Hauptversion wie der Datenbank-Container
# (compose.yaml: postgres:17-alpine) – ein älteres pg_dump verweigert den
# Abzug eines neueren Servers.
#
# Läuft dauerhaft und tut nichts: Airlock führt restic und pg_dump per exec
# über den Socket-Proxy aus (packages/api/src/backup/service.ts).
ARG RESTIC_VERSION=0.17.3
ARG POSTGRES_IMAGE=postgres:17-alpine

FROM restic/restic:${RESTIC_VERSION} AS restic

FROM ${POSTGRES_IMAGE}
# restic ist ein statisches Go-Programm und läuft so auf Alpine
COPY --from=restic /usr/bin/restic /usr/bin/restic
RUN restic version
# Kein Datenbank-Server hier: Einstieg des Postgres-Images abschalten
ENTRYPOINT []
CMD ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]
