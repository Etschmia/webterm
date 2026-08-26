# deploy/lib-caddy-auth.sh — Zugangsschutz vor dem Webterminal: Auswahl-Dialog
# und Erzeugung des passenden Caddy-Blocks. EINZIGE Quelle fuer diese Bloecke;
# geladen von install.sh (Erstinstallation), deploy/setup-auth (Nachruesten) und
# indirekt vom Panel „Zugangsschutz" in der Sidebar (/api/authguard/* ruft
# `deploy/setup-auth --print` auf).
#
# Warum ueberhaupt: server.js authentifiziert bewusst NICHT selbst — dahinter
# liegt eine volle Shell, der Schutz gehoert vor den Reverse-Proxy-Hop. Damit
# ist der Zugangsschutz genau eine Stelle in der Caddy-Datei, und dieses Projekt
# bleibt agnostisch gegenueber der Frage, WELCHER zweite Faktor dort haengt.
#
# Drei Betriebsarten (AUTH_MODE):
#   basic    HTTP Basic Auth mit bcrypt-Hash — Caddy-Bordmittel, ein Faktor.
#   forward  forward_auth an einen externen Auth-Dienst (2FA/SSO). Ebenfalls
#            eine native Caddy-Direktive, KEIN Plugin: Caddy fragt vor jeder
#            Anfrage einen kleinen Dienst (Authelia, oauth2-proxy, tinyauth,
#            Pocket ID, Keycloak-Proxy …); 2xx = durchlassen, 401/302 = auf
#            dessen Login-Portal umleiten. Welcher Faktor dort geprueft wird
#            (TOTP, Passkey, Unternehmens-IdP), sieht dieses Projekt nie.
#   none     Kein Auth-Block — Schutz liegt woanders (VPN/Zero-Trust/mTLS).
#
# Setzt/liest die Globals: AUTH_MODE, CADDY_BASICAUTH, CADDY_USER, CADDY_HASH,
# AUTH_FWD_UPSTREAM, AUTH_FWD_PORTAL, AUTH_FWD_URI.
# Braucht die Helfer aus deploy/lib-ask.sh (note/warn/ok/err/ask_value/…).

# --------------------------------------------------------------------------
# Caddy-Bordmittel
# --------------------------------------------------------------------------
caddy_hash() {
  # Passwort nur ueber stdin uebergeben: --plaintext wuerde es waehrend des
  # Hashens fuer andere lokale Nutzer in der Prozessliste sichtbar machen.
  local pw="$1" out
  out="$(printf '%s\n%s\n' "$pw" "$pw" | caddy hash-password 2>/dev/null)" \
    && { printf '%s' "$out"; return 0; }
  return 1
}

caddy_basicauth_directive() {
  # Der Direktiven-Name fuer HTTP Basic Auth haengt von der Caddy-Version ab:
  #   Caddy <  2.8.0  ->  'basicauth'   (alte Schreibweise)
  #   Caddy >= 2.8.0  ->  'basic_auth'  (ab 2.8.0; 'basicauth' ist dort entfernt)
  # Es gibt KEINEN Namen, der auf beiden Versionen funktioniert. Laesst sich die
  # Version nicht ermitteln (caddy fehlt o. ae.), nehmen wir die neuere Schreibweise.
  local ver
  ver="$(caddy version 2>/dev/null | head -n1 | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | sed 's/^v//')"
  if [ -z "$ver" ]; then printf 'basic_auth'; return 0; fi
  # Ist die kleinere von {2.8.0, $ver} genau 2.8.0, dann gilt $ver >= 2.8.0.
  if [ "$(printf '%s\n' "2.8.0" "$ver" | sort -V | head -n1)" = "2.8.0" ]; then
    printf 'basic_auth'
  else
    printf 'basicauth'
  fi
}

# --------------------------------------------------------------------------
# Presets: Verify-Endpunkt der gaengigen Auth-Dienste
# Nur Textbausteine — das Projekt installiert und kennt keinen dieser Dienste.
# %PORTAL% wird durch die Portal-URL ersetzt.
# --------------------------------------------------------------------------
auth_fwd_preset_uri() {
  case "$1" in
    authelia)     printf '/api/verify?rd=%%PORTAL%%' ;;
    oauth2-proxy) printf '/oauth2/auth' ;;
    tinyauth)     printf '/api/auth/caddy' ;;
    *)            printf '' ;;
  esac
}

auth_fwd_preset_default_upstream() {
  case "$1" in
    authelia)     printf '127.0.0.1:9091' ;;
    oauth2-proxy) printf '127.0.0.1:4180' ;;
    tinyauth)     printf '127.0.0.1:3000' ;;
    *)            printf '127.0.0.1:9091' ;;
  esac
}

# --------------------------------------------------------------------------
# Validierung (auch fuer den nicht-interaktiven Aufruf aus dem Panel)
# --------------------------------------------------------------------------
auth_valid_upstream() {
  # host:port oder unix//pfad — bewusst eng, der Wert landet unveraendert in der Config.
  printf '%s' "$1" | grep -qE '^([A-Za-z0-9._-]+:[0-9]{1,5}|unix//[A-Za-z0-9._/-]+)$'
}

auth_valid_portal() {
  printf '%s' "$1" | grep -qE '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
}

auth_valid_uri() {
  # Pfad mit optionalem Query; keine Anfuehrungszeichen/geschweiften Klammern,
  # die den Caddyfile-Block sprengen koennten.
  printf '%s' "$1" | grep -qE '^/[A-Za-z0-9._~/%=&?+-]*$'
}

# --------------------------------------------------------------------------
# Erklaerung + Auswahl
# --------------------------------------------------------------------------
auth_explain_modes() {
  printf '%s\n' "Wer das Webterminal erreicht, bekommt eine volle Shell auf diesem Server."
  printf '%s\n' "Der Zugangsschutz sitzt deshalb VOR dem Terminal, in Caddy — server.js selbst"
  printf '%s\n' "prueft absichtlich keine Anmeldung."
  printf '\n'
  printf '%s\n' "  1) HTTP Basic Auth (Caddy-Bordmittel, ein Faktor)"
  note "     Login/Passwort direkt in der Caddy-Datei (nur als bcrypt-Hash)."
  note "     Schnell eingerichtet, aber kein zweiter Faktor."
  printf '%s\n' "  2) Forward-Auth an einen externen Auth-Dienst (2FA / SSO)"
  note "     Caddy fragt vor jeder Anfrage einen kleinen Dienst (Authelia,"
  note "     oauth2-proxy, tinyauth, Pocket ID …) und laesst erst nach dessen OK"
  note "     durch — sonst Umleitung auf dessen Login-Portal. Der zweite Faktor"
  note "     (TOTP, Passkey, Unternehmens-IdP) lebt komplett in diesem Dienst;"
  note "     dieses Projekt kennt ihn nicht und muss dafuer nicht angepasst werden."
  note "     'forward_auth' ist eine native Caddy-Direktive — kein Plugin noetig."
  printf '%s\n' "  3) Kein Auth-Block hier — Schutz liegt woanders"
  note "     Sinnvoll hinter VPN/Tailscale, Zero-Trust-Proxy oder mit"
  note "     mTLS-Client-Zertifikaten. Sonst stuende das Terminal offen im Netz."
}

auth_prompt_mode() {
  # Setzt AUTH_MODE (basic|forward|none). Default: bisheriger Stand bzw. basic.
  local def="${1:-1}" sel
  auth_explain_modes
  sel="$(ask_value 'Auswahl (1/2/3)' "$def")"
  case "$sel" in
    2) AUTH_MODE="forward" ;;
    3) AUTH_MODE="none" ;;
    *) AUTH_MODE="basic" ;;
  esac
}

auth_prompt_forward() {
  # Setzt AUTH_FWD_UPSTREAM, AUTH_FWD_PORTAL, AUTH_FWD_URI.
  local preset sel
  printf '%s\n' "Welcher Auth-Dienst? (nur Vorbelegung der Adressen — austauschbar)"
  printf '%s\n' "  1) Authelia        — TOTP, WebAuthn/Passkey, Duo; Nutzer aus Datei oder LDAP"
  printf '%s\n' "  2) oauth2-proxy    — delegiert an eure IdP (Entra ID, Google, Keycloak …);"
  printf '%s\n' "                       2FA-Policy und Offboarding bleiben dort"
  printf '%s\n' "  3) tinyauth        — sehr kleiner Dienst, TOTP"
  printf '%s\n' "  4) etwas anderes   — Adressen selbst eintragen"
  sel="$(ask_value 'Auswahl (1/2/3/4)' '1')"
  case "$sel" in
    2) preset="oauth2-proxy" ;;
    3) preset="tinyauth" ;;
    4) preset="custom" ;;
    *) preset="authelia" ;;
  esac

  note "Der Dienst muss NICHT von aussen erreichbar sein — Caddy spricht ihn lokal an."
  AUTH_FWD_UPSTREAM="$(ask_value 'Adresse des Auth-Dienstes (host:port)' "$(auth_fwd_preset_default_upstream "$preset")")"
  while ! auth_valid_upstream "$AUTH_FWD_UPSTREAM"; do
    warn "Bitte 'host:port' (z. B. 127.0.0.1:9091) oder 'unix//pfad' eingeben."
    AUTH_FWD_UPSTREAM="$(ask_value 'Adresse des Auth-Dienstes (host:port)' "$(auth_fwd_preset_default_upstream "$preset")")"
  done

  note "Das Login-Portal ist die Seite, auf die nicht angemeldete Besucher umgeleitet"
  note "werden. Am besten eine eigene Subdomain derselben Domain (Cookie-Bereich!),"
  note "z. B. https://auth.example.com."
  AUTH_FWD_PORTAL="$(ask_value 'URL des Login-Portals' '')"
  while ! auth_valid_portal "$AUTH_FWD_PORTAL"; do
    warn "Bitte eine vollstaendige URL angeben, z. B. https://auth.example.com"
    AUTH_FWD_PORTAL="$(ask_value 'URL des Login-Portals' '')"
  done

  AUTH_FWD_URI="$(auth_fwd_preset_uri "$preset")"
  if [ -z "$AUTH_FWD_URI" ]; then
    AUTH_FWD_URI="$(ask_value 'Verify-Endpunkt des Dienstes (Pfad)' '/api/verify?rd=%PORTAL%')"
    while ! auth_valid_uri "$AUTH_FWD_URI"; do
      warn "Bitte einen Pfad wie /api/verify?rd=%PORTAL% angeben."
      AUTH_FWD_URI="$(ask_value 'Verify-Endpunkt des Dienstes (Pfad)' '/api/verify?rd=%PORTAL%')"
    done
  fi
  if [ "$preset" = "oauth2-proxy" ]; then
    note "Hinweis oauth2-proxy: Der Callback-Pfad /oauth2/* muss ebenfalls erreichbar"
    note "sein — ueblicherweise ueber die Portal-Domain. Laeuft oauth2-proxy ohne"
    note "eigene Domain, zusaetzlich 'handle /oauth2/* { reverse_proxy <upstream> }'"
    note "in denselben Site-Block aufnehmen."
  fi
}

# --------------------------------------------------------------------------
# Blockerzeugung
# --------------------------------------------------------------------------
auth_block() {
  # $1 = Einrueckung (Leerzeichen-String). Gibt den Auth-Block fuer AUTH_MODE aus.
  local ind="${1:-    }" uri
  case "${AUTH_MODE:-basic}" in
    basic)
      printf '%s# HTTP Basic Auth (Hash via '\''caddy hash-password'\'')\n' "$ind"
      printf '%s%s {\n' "$ind" "${CADDY_BASICAUTH:-basic_auth}"
      printf '%s    %s %s\n' "$ind" "$CADDY_USER" "$CADDY_HASH"
      printf '%s}\n' "$ind"
      ;;
    forward)
      uri="${AUTH_FWD_URI//%PORTAL%/$AUTH_FWD_PORTAL}"
      printf '%s# Zugangsschutz per Forward-Auth (2FA/SSO). Caddy fragt vor JEDER Anfrage\n' "$ind"
      printf '%s# den Auth-Dienst: 2xx = durchlassen, 401/302 = Umleitung aufs Login-Portal.\n' "$ind"
      printf '%s# Deckt auch den WebSocket-Upgrade (/ws) ab — der Handshake ist ein\n' "$ind"
      printf '%s# normaler HTTP-Request und traegt dasselbe Session-Cookie.\n' "$ind"
      printf '%s# Achtung: Eine BEREITS offene Terminal-Verbindung endet nicht, wenn die\n' "$ind"
      printf '%s# Session ablaeuft — erst der naechste Reload verlangt neu. Umgekehrt sind\n' "$ind"
      printf '%s# kurze Session-Zeiten hier laestig: ein Terminal steht tagelang offen.\n' "$ind"
      printf '%sforward_auth %s {\n' "$ind" "$AUTH_FWD_UPSTREAM"
      printf '%s    uri %s\n' "$ind" "$uri"
      printf '%s    copy_headers Remote-User Remote-Groups Remote-Name Remote-Email\n' "$ind"
      printf '%s}\n' "$ind"
      ;;
    *)
      printf '%s# KEIN Auth-Block: Der Zugang ist ausserhalb geregelt (VPN/Zero-Trust/mTLS).\n' "$ind"
      printf '%s# Ohne eine solche Schranke stuende hier eine volle Shell offen im Netz.\n' "$ind"
      ;;
  esac
}

auth_mode_label() {
  case "${AUTH_MODE:-basic}" in
    basic)   printf 'HTTP Basic Auth' ;;
    forward) printf 'Forward-Auth (2FA/SSO) an %s' "$AUTH_FWD_UPSTREAM" ;;
    *)       printf 'kein Auth-Block (extern geregelt)' ;;
  esac
}

# --------------------------------------------------------------------------
# Basic Auth: Zugangsdaten erfragen (Passwort wird nie gespeichert)
# Erwartet HAVE_CADDY (0/1) — ohne caddy-Binary kann kein Hash erzeugt werden.
# --------------------------------------------------------------------------
auth_prompt_basic() {
  # Setzt CADDY_USER und CADDY_HASH.
  CADDY_BASICAUTH="${CADDY_BASICAUTH:-$(caddy_basicauth_directive)}"
  if [ "${HAVE_CADDY:-0}" -ne 1 ]; then
    note "Caddy nicht gefunden — verwende die Direktive '$CADDY_BASICAUTH' (Caddy >= 2.8)."
    note "Auf Caddy < 2.8 im Snippet in 'basicauth' (ohne Unterstrich) umbenennen."
  fi
  CADDY_USER="$(ask_value 'Loginname')"
  while ! printf '%s' "$CADDY_USER" | grep -qE '^[A-Za-z0-9._-]+$'; do
    warn "Loginname darf nur Buchstaben, Ziffern, Punkt, _ und - enthalten."
    CADDY_USER="$(ask_value 'Loginname')"
  done
  if [ "${HAVE_CADDY:-0}" -eq 1 ]; then
    note "Hinweis: Das Passwort wird NICHT gespeichert. Es wird sofort per"
    note "'caddy hash-password' in einen bcrypt-Hash umgewandelt; nur dieser Hash"
    note "landet in der .caddy-Datei. Notiere dir Loginname + Passwort gut!"
    local pw; pw="$(ask_password)"
    if CADDY_HASH="$(caddy_hash "$pw")"; then
      ok "bcrypt-Hash erzeugt."
    else
      err "'caddy hash-password' ist fehlgeschlagen — setze Platzhalter."
      CADDY_HASH="CHANGEME_BCRYPT_HASH"
    fi
    unset pw
  else
    warn "caddy-Binary nicht gefunden — ich kann jetzt keinen Hash erzeugen."
    note "Es wird ein Platzhalter eingesetzt. Erzeuge den Hash spaeter mit:"
    note "    caddy hash-password"
    note "und trage ihn in die Datei ein."
    CADDY_HASH="CHANGEME_BCRYPT_HASH"
  fi
}

# Kompletter Zugangsschutz-Dialog: Auswahl + die Rueckfragen der gewaehlten Art.
# $1 = vorbelegte Auswahl ("1"|"2"|"3"), Default "1".
auth_prompt() {
  auth_prompt_mode "${1:-1}"
  case "$AUTH_MODE" in
    basic)   auth_prompt_basic ;;
    forward) auth_prompt_forward ;;
    none)
      warn "Es wird KEIN Auth-Block erzeugt. Stelle sicher, dass der Zugang"
      warn "anderweitig beschraenkt ist (VPN, Zero-Trust-Proxy, mTLS, IP-Allowlist)."
      ;;
  esac
}
