"use strict";
// Airlock: eigene Web-Projekte auf dem Homeserver – Zustand, Befunde, Besucher und Verfügbarkeit
// aus GET /api/v1/summary. Braucht ein Airlock-Token mit Umfang «Nur lesen»
// (Airlock › Einstellungen › Tokens › Vorlage «Für HomeBento»); es kann nichts ändern.
//
// Einrichten: diese Datei nach data/plugins/airlock.js von HomeBento kopieren, HomeBento neu
// starten, einen Dienst mit der Adresse von Airlock (z. B. https://deployer.int.example.ch)
// anlegen, als Art «Airlock» wählen und das Token eintragen. Die Projekt-Container schlägt
// HomeBento über ihre Labels (homebento.name/href/icon) selbst als Kacheln vor.
const L = (de, en) => ({ de, en });

const STATUS = { ok: "ok", info: "ok", neutral: "warn", warn: "warn", bad: "bad" };
const pct = (v) => (typeof v === "number" ? `${v.toLocaleString("de-CH", { maximumFractionDigits: 2 })} %` : null);

module.exports = {
	kind: "airlock",
	label: "Airlock",
	match: /(^|[^a-z])airlock([^a-z]|$)/,
	ttl: 60000,
	fields: [
		{
			key: "apiKey",
			label: L("API-Token (nur lesen)", "API token (read only)"),
			help: L("Airlock › Einstellungen › Tokens › Vorlage «Für HomeBento»", "Airlock › Settings › Tokens › template “For HomeBento”"),
			secret: true
		}
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API token missing");
		const s = await json(`${url.replace(/\/+$/, "")}/api/v1/summary`, { headers: { Authorization: `Bearer ${secrets.apiKey}` } });
		if (!s || !Array.isArray(s.projects)) throw new Error("Unexpected answer from Airlock");
		const t = s.totals || {};
		const f = t.findings || {};
		const urgent = (f.critical || 0) + (f.high || 0);
		const cert = s.certificate && typeof s.certificate.daysLeft === "number" ? s.certificate.daysLeft : null;

		const warnings = s.projects.filter((p) => p.attention).map((p) => `${p.name}: ${p.attentionReason}`);
		if (cert !== null && cert < 14) warnings.push(`Zertifikat läuft in ${cert} Tagen ab`);

		return {
			metrics: [
				{ value: `${t.running ?? 0}/${t.projects ?? 0}`, label: L("laufen", "running") },
				{ value: t.attention ?? 0, label: L("Aufmerksamkeit", "attention"), warn: (t.attention ?? 0) > 0 },
				{ value: urgent, label: L("Befunde hoch+", "high+ findings"), warn: urgent > 0 },
				{ value: t.visitorsToday ?? null, label: L("Besucher heute", "visitors today") }
			],
			items: s.projects
				.slice()
				.sort((a, b) => Number(b.attention) - Number(a.attention) || a.name.localeCompare(b.name))
				.map((p) => ({
					title: p.name,
					sub: [
						p.attention ? p.attentionReason : p.state && p.state.label,
						p.public ? "öffentlich" : null,
						p.grade ? `Note ${p.grade}` : null,
						typeof p.visitorsToday === "number" ? `${p.visitorsToday} Besucher` : null,
						pct(p.uptime30d) ? `${pct(p.uptime30d)} (30 T.)` : null
					].filter(Boolean).join(" · "),
					status: p.attention ? (p.attentionTone === "warn" ? "warn" : "bad") : STATUS[(p.state && p.state.tone) || "ok"] || "ok"
				})),
			warnings,
			summary: (s.deploying || []).length ? `Deploy läuft: ${s.deploying.map((d) => d.name).join(", ")}` : null
		};
	}
};
