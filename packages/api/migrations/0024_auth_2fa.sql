-- Nacht 3, Etappe 1 «Passkey und 2FA»: Sitzungen als Tabelle, Passkeys,
-- Authenticator-App (TOTP), Wiederherstellungscodes. Nur neue Tabellen.
--
-- Bisher war die Sitzung ein signiertes Cookie mit dem Anmeldezeitpunkt.
-- Jetzt steht jede Sitzung hier (Liste im Konto, einzeln abmelden, erneute
-- Bestätigung). Alte Cookies passen zu keiner Zeile: nach dem Update meldet
-- man sich einmal neu an.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 (hex) des Cookie-Werts; der Wert selbst steht nur im Cookie
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            text,
  user_agent    text,
  -- password | password_totp | password_recovery | passkey
  method        text NOT NULL,
  -- erneute Bestätigung (sudo) gilt bis
  sudo_until    timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions (revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS auth_passkeys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Base64URL der Credential-ID
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  device_type    text,
  backed_up      boolean,
  name           text NOT NULL,
  -- Adresse, für die der Passkey gilt (RP-ID)
  rp_id          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

-- Genau eine Zeile (id = 1): Geheimnis verschlüsselt mit der Schlüsseldatei
CREATE TABLE IF NOT EXISTS auth_totp (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret_enc   bytea,
  enabled_at   timestamptz,
  -- zuletzt angenommenes Zeitfenster: jeder Code gilt nur einmal
  last_step    bigint NOT NULL DEFAULT -1,
  -- beim Einrichten, bis der erste Code bestätigt ist
  pending_enc  bytea,
  pending_at   timestamptz
);

-- HMAC-SHA256 (Schlüssel aus der Schlüsseldatei) je Code, nie der Code selbst
CREATE TABLE IF NOT EXISTS auth_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
