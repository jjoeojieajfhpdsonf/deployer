# Firewall-Dienst von Airlock (Nacht 3, Etappe 4: Container-Ausgang begrenzen).
#
# Klein und ohne Netzdienst: nft (eigene Tabelle inet airlock), jq (status.json)
# und tcpdump (liest die protokollierten Pakete aus NFLOG). Die Logik steht in
# airlock-fw; Airlock schreibt nur die gewünschten Regeln in das Volume.
#
# Basis fest gepinnt (alpine 3.24.0 vom 9. Juni 2026). Die Pakete kommen aus
# demselben Zweig (Sicherheitsupdates bei jedem Neubau); nftables 1.1.6,
# jq 1.8.2, tcpdump 4.99.6 beim Pinnen.
FROM alpine:3.24.0
RUN apk add --no-cache nftables jq tcpdump && nft -v && jq --version && tcpdump --version
COPY airlock-fw /usr/local/bin/airlock-fw
RUN chmod 0755 /usr/local/bin/airlock-fw && sh -n /usr/local/bin/airlock-fw
ENTRYPOINT []
CMD ["/usr/local/bin/airlock-fw", "run"]
