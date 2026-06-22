#!/usr/bin/env bash
#
# install.sh — Portabler Installer fuer term-web (Web-Terminal mit Sidebar).
#
# Fuehrt schrittweise durch die Einrichtung:
#   1. Prueft, ob der vorgesehene Port frei ist (sonst Alternative erfragen).
#   2. Findet npm/node und baut das Projekt (npm install + npm run build).
#   3. Prueft tmux; bietet ggf. die Installation von claude-auto-retry an.
#   4. Sorgt fuer "set -g mouse on" in ~/.tmux.conf.
#   5. Hilft optional beim Erstellen einer Caddy-Datei (Subdomain oder Unterpfad),
#      inkl. sofortiger bcrypt-Hash-Erzeugung fuer Basic Auth.
#   6. Generiert eine systemd-Unit und bietet die Aktivierung an.
#
# Das Skript ist idempotent: mehrfaches Ausfuehren ist gefahrlos.
# Erzeugte Konfiguration landet in <projekt>/.env sowie in deploy/*.local.* —
# beides ist von git ausgeschlossen.

set -euo pipefail

# --------------------------------------------------------------------------
# Grundlagen
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DEPLOY_DIR="$SCRIPT_DIR/deploy"
DEFAULT_PORT="7681"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''
fi

info() { printf '%s %s\n' "${C_CYAN}•${C_RESET}" "$*"; }
ok()   { printf '%s %s\n' "${C_GREEN}✓${C_RESET}" "$*"; }
warn() { printf '%s %s\n' "${C_YELLOW}!${C_RESET}" "$*" >&2; }
err()  { printf '%s %s\n' "${C_RED}✗${C_RESET}" "$*" >&2; }
step() { printf '\n%s\n' "${C_BOLD}== $* ==${C_RESET}"; }
note() { printf '%s\n' "${C_DIM}$*${C_RESET}"; }

INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

# --------------------------------------------------------------------------
# Eingabe-Helfer (lesen/schreiben ueber /dev/tty, damit sie auch bei
# umgeleitetem stdout/stderr funktionieren)
# --------------------------------------------------------------------------
ask_yes_no() {
  # $1 = Frage, $2 = Default ("y"|"n")
  local q="$1" def="${2:-n}" ans hint
  if [ "$def" = "y" ]; then hint="[J/n]"; else hint="[j/N]"; fi
  if [ "$INTERACTIVE" -eq 0 ]; then
    [ "$def" = "y" ]
    return
  fi
  while true; do
    printf '%s %s ' "$q" "$hint" > /dev/tty
    read -r ans < /dev/tty || ans=""
    ans="${ans:-$def}"
    case "${ans,,}" in
      j|ja|y|yes) return 0 ;;
      n|nein|no)  return 1 ;;
      *) printf 'Bitte j oder n eingeben.\n' > /dev/tty ;;
    esac
  done
}

ask_value() {
  # $1 = Prompt, $2 = Default (optional). Ergebnis -> stdout.
  local q="$1" def="${2:-}" ans
  if [ -n "$def" ]; then printf '%s [%s]: ' "$q" "$def" > /dev/tty
  else printf '%s: ' "$q" > /dev/tty; fi
  read -r ans < /dev/tty || ans=""
  printf '%s' "${ans:-$def}"
}

ask_password() {
  # Liest ein Passwort zweimal ohne Echo und vergleicht. Ergebnis -> stdout.
  local p1 p2
  while true; do
    printf 'Passwort: ' > /dev/tty
    read -rs p1 < /dev/tty || p1=""; printf '\n' > /dev/tty
    printf 'Passwort (Wiederholung): ' > /dev/tty
    read -rs p2 < /dev/tty || p2=""; printf '\n' > /dev/tty
    if [ -z "$p1" ]; then printf 'Leer — bitte erneut.\n' > /dev/tty; continue; fi
    if [ "$p1" != "$p2" ]; then printf 'Stimmt nicht ueberein — bitte erneut.\n' > /dev/tty; continue; fi
    printf '%s' "$p1"; return 0
  done
}

# --------------------------------------------------------------------------
# .env-Helfer
# --------------------------------------------------------------------------
set_env() {
  # $1 = KEY, $2 = VALUE. Legt .env an / ersetzt den Schluessel.
  local key="$1" val="$2" tmp
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
    mv "$tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

get_env() {
  # $1 = KEY -> Wert (oder leer)
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

# --------------------------------------------------------------------------
# Such-/Pruef-Helfer
# --------------------------------------------------------------------------
find_cmd() {
  # Sucht $1 in PATH und gaengigen Node-Installationsorten. Pfad -> stdout.
  local name="$1" p latest
  if p="$(command -v "$name" 2>/dev/null)"; then printf '%s' "$p"; return 0; fi
  for p in \
    "$HOME/.local/bin/$name" \
    "$HOME/.volta/bin/$name" \
    "/usr/local/bin/$name" \
    "/usr/bin/$name" \
    "/opt/homebrew/bin/$name"; do
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    latest="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -n1)"
    if [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/$latest/bin/$name" ]; then
      printf '%s' "$HOME/.nvm/versions/node/$latest/bin/$name"; return 0
    fi
  fi
  return 1
}

port_in_use() {
  # 0 = belegt, 1 = frei. Prueft auf einen LISTEN-Socket fuer Port $1.
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN -P -n >/dev/null 2>&1
  else
    # Fallback: Verbindungsversuch auf 127.0.0.1 (erfolgreich => belegt).
    (exec 3<>"/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; } || return 1
  fi
}

show_port_owner() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH 2>/dev/null | awk '{print $4"  "$6}' | grep -E "[:.]${p}\b" || true
  fi
}

caddy_hash() {
  # bcrypt-Hash fuer Caddy basic_auth. Probiert mehrere CLI-Varianten.
  local pw="$1" out
  out="$(caddy hash-password --plaintext "$pw" 2>/dev/null)" && { printf '%s' "$out"; return 0; }
  out="$(caddy hash-password -plaintext "$pw" 2>/dev/null)"  && { printf '%s' "$out"; return 0; }
  out="$(printf '%s' "$pw" | caddy hash-password 2>/dev/null)" && { printf '%s' "$out"; return 0; }
  return 1
}

install_hint_toolchain() {
  # Gibt den OS-passenden Befehl zur Installation der C/C++-Build-Tools aus.
  if [ "$(uname -s)" = "Darwin" ]; then
    note "    xcode-select --install"
  elif command -v apt-get >/dev/null 2>&1; then
    note "    sudo apt-get update && sudo apt-get install -y build-essential python3"
  elif command -v dnf >/dev/null 2>&1; then
    note "    sudo dnf install -y gcc-c++ make python3"
  elif command -v yum >/dev/null 2>&1; then
    note "    sudo yum install -y gcc-c++ make python3"
  elif command -v pacman >/dev/null 2>&1; then
    note "    sudo pacman -S --needed base-devel python"
  elif command -v zypper >/dev/null 2>&1; then
    note "    sudo zypper install -y gcc-c++ make python3"
  elif command -v apk >/dev/null 2>&1; then
    note "    sudo apk add build-base python3"
  else
    note "    (make, ein C++-Compiler wie g++/clang++ und python3 werden benoetigt)"
  fi
}

check_build_toolchain() {
  # node-pty ist ein natives Modul. Fehlt fuer die laufende Node-Version ein
  # Prebuild, wird aus dem Quellcode kompiliert — dafuer braucht es make, einen
  # C++-Compiler und python3. Gibt 0 zurueck, wenn alles da ist, sonst 1.
  local missing=""
  command -v make >/dev/null 2>&1 || missing="$missing make"
  if ! command -v g++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1 \
     && ! command -v c++ >/dev/null 2>&1; then
    missing="$missing C++-Compiler"
  fi
  command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 || missing="$missing python3"
  [ -z "$missing" ] && return 0
  warn "Build-Werkzeuge fehlen:${missing}. node-pty muss nativ kompiliert werden."
  note "Installieren mit:"
  install_hint_toolchain
  return 1
}

# --------------------------------------------------------------------------
# Start
# --------------------------------------------------------------------------
printf '%s\n' "${C_BOLD}term-web — Installer${C_RESET}"
note "Projekt: $SCRIPT_DIR"
[ "$INTERACTIVE" -eq 0 ] && warn "Kein TTY erkannt — interaktive Schritte werden uebersprungen."

# --------------------------------------------------------------------------
# 1. Port pruefen
# --------------------------------------------------------------------------
step "1/6  Port pruefen"
PORT="$(get_env PORT)"; PORT="${PORT:-$DEFAULT_PORT}"
while port_in_use "$PORT"; do
  warn "Port $PORT ist bereits belegt:"
  show_port_owner "$PORT" | sed 's/^/    /' || true
  if [ "$INTERACTIVE" -eq 0 ]; then
    warn "Nicht-interaktiv: behalte $PORT — bitte selbst pruefen."
    break
  fi
  newp="$(ask_value "Anderer Port (leer = trotzdem $PORT behalten)")"
  [ -z "$newp" ] && break
  if ! [[ "$newp" =~ ^[0-9]+$ ]] || [ "$newp" -lt 1 ] || [ "$newp" -gt 65535 ]; then
    warn "Ungueltige Portnummer."; continue
  fi
  PORT="$newp"
done
ok "Port: $PORT (Backend bindet nur 127.0.0.1:$PORT)"
set_env PORT "$PORT"
set_env HOST "127.0.0.1"

# --------------------------------------------------------------------------
# 2. npm/node finden und bauen
# --------------------------------------------------------------------------
step "2/6  npm/node finden und bauen"
NPM_BIN="$(find_cmd npm || true)"
NODE_BIN="$(find_cmd node || true)"
BUILD_OK=0
if [ -z "$NPM_BIN" ]; then
  err "npm wurde nicht gefunden (PATH, ~/.local/bin, nvm, volta, /usr/local, /usr/bin, homebrew geprueft)."
  warn "Bitte Node.js/npm installieren (z. B. via nvm) und das Skript erneut ausfuehren."
else
  ok "npm:  $NPM_BIN"
  [ -n "$NODE_BIN" ] && ok "node: $NODE_BIN" || warn "node-Binary nicht separat gefunden — systemd-Unit braucht den Pfad."
  # node-pty kompiliert nativ, falls kein Prebuild zur Node-Version passt.
  PROCEED_INSTALL=1
  if ! check_build_toolchain; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      ask_yes_no "Trotzdem 'npm install' versuchen?" "n" || PROCEED_INSTALL=0
    fi
  fi
  if [ "$PROCEED_INSTALL" -eq 0 ]; then
    warn "npm install uebersprungen — Build-Tools installieren (siehe oben), dann Skript erneut ausfuehren."
  else
    info "Abhaengigkeiten installieren (npm install) …"
    if ( cd "$SCRIPT_DIR" && "$NPM_BIN" install ); then
      info "Frontend bauen (npm run build) …"
      if ( cd "$SCRIPT_DIR" && "$NPM_BIN" run build ); then
        BUILD_OK=1; ok "Build erfolgreich (-> public/)."
      else
        err "Build fehlgeschlagen."
      fi
    else
      err "npm install fehlgeschlagen."
      note "Bei node-gyp-/'make'-Fehlern fehlen die Build-Tools:"
      install_hint_toolchain
    fi
  fi
fi

# --------------------------------------------------------------------------
# 3. tmux + claude-auto-retry
# --------------------------------------------------------------------------
step "3/6  tmux & claude-auto-retry"
HAVE_TMUX=0
if command -v tmux >/dev/null 2>&1; then
  HAVE_TMUX=1
  ok "tmux ist installiert ($(tmux -V 2>/dev/null))."

  have_car=0
  if command -v claude-auto-retry >/dev/null 2>&1; then
    have_car=1
  elif [ -n "$NPM_BIN" ]; then
    gprefix="$("$NPM_BIN" prefix -g 2>/dev/null || true)"
    [ -n "$gprefix" ] && [ -x "$gprefix/bin/claude-auto-retry" ] && have_car=1
    "$NPM_BIN" ls -g --depth=0 claude-auto-retry >/dev/null 2>&1 && have_car=1
  fi

  if [ "$have_car" -eq 1 ]; then
    ok "claude-auto-retry ist bereits installiert."
  elif [ -z "$NPM_BIN" ]; then
    warn "claude-auto-retry kann ohne npm nicht installiert werden — uebersprungen."
  elif ask_yes_no "claude-auto-retry global installieren (npm i -g claude-auto-retry)?" "y"; then
    if "$NPM_BIN" i -g claude-auto-retry; then
      car_bin="$(command -v claude-auto-retry 2>/dev/null || true)"
      if [ -z "$car_bin" ]; then
        gprefix="$("$NPM_BIN" prefix -g 2>/dev/null || true)"
        [ -n "$gprefix" ] && car_bin="$gprefix/bin/claude-auto-retry"
      fi
      if [ -n "$car_bin" ] && [ -x "$car_bin" ]; then
        info "claude-auto-retry install (richtet bash-Funktion in ~/.bashrc ein) …"
        "$car_bin" install || warn "'claude-auto-retry install' meldete einen Fehler."
        # .bashrc neu einlesen (in diesem Prozess; betrifft NICHT die laufende Shell).
        if [ -f "$HOME/.bashrc" ]; then
          info ".bashrc neu einlesen …"
          set +eu
          # shellcheck disable=SC1090,SC1091
          source "$HOME/.bashrc" >/dev/null 2>&1 || true
          set -eu
          warn "Damit die Funktion in DEINER aktuellen Shell aktiv wird:"
          note "    source ~/.bashrc   (oder ein neues Terminal oeffnen)"
        fi
        ok "claude-auto-retry eingerichtet."
      else
        warn "claude-auto-retry-Binary nach der Installation nicht gefunden — PATH/npm-Prefix pruefen."
      fi
    else
      err "npm i -g claude-auto-retry fehlgeschlagen (evtl. Rechte? -> ggf. mit sudo, oder npm-Prefix auf ~/.local setzen)."
    fi
  else
    info "claude-auto-retry uebersprungen."
  fi
else
  warn "tmux ist NICHT installiert. Die Sidebar-Session-Funktion bleibt ohne tmux leer."
  note "    Debian/Ubuntu: sudo apt install tmux   ·   macOS: brew install tmux"
fi

# --------------------------------------------------------------------------
# 4. ~/.tmux.conf: set -g mouse on
# --------------------------------------------------------------------------
step "4/6  tmux-Maus-Unterstuetzung"
TMUX_CONF="$HOME/.tmux.conf"
if grep -Eq '^[[:space:]]*[^#].*\bmouse[[:space:]]+on\b' "$TMUX_CONF" 2>/dev/null; then
  ok "'mouse on' ist in ~/.tmux.conf bereits gesetzt."
else
  if [ ! -f "$TMUX_CONF" ]; then
    info "~/.tmux.conf existiert nicht — wird angelegt."
  fi
  printf '\n# Maus-Unterstuetzung (von term-web/install.sh hinzugefuegt)\nset -g mouse on\n' >> "$TMUX_CONF"
  ok "'set -g mouse on' zu ~/.tmux.conf hinzugefuegt."
  if [ "$HAVE_TMUX" -eq 1 ] && tmux info >/dev/null 2>&1; then
    tmux source-file "$TMUX_CONF" >/dev/null 2>&1 && info "Laufende tmux-Server neu geladen." || true
  fi
fi

# --------------------------------------------------------------------------
# 5. Caddy-Datei
# --------------------------------------------------------------------------
step "5/6  Caddy-Konfiguration"
HAVE_CADDY=0
command -v caddy >/dev/null 2>&1 && HAVE_CADDY=1

write_caddy_credentials_note() {
  note "Hinweis: Das Passwort wird NICHT gespeichert. Es wird sofort per"
  note "'caddy hash-password' in einen bcrypt-Hash umgewandelt; nur dieser Hash"
  note "landet in der .caddy-Datei. Notiere dir Loginname + Passwort gut!"
}

prompt_credentials() {
  # Setzt globale CADDY_USER und CADDY_HASH.
  CADDY_USER="$(ask_value 'Loginname')"
  while [ -z "$CADDY_USER" ]; do
    warn "Loginname darf nicht leer sein."
    CADDY_USER="$(ask_value 'Loginname')"
  done
  if [ "$HAVE_CADDY" -eq 1 ]; then
    write_caddy_credentials_note
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
    note "Es wird ein Platzhalter eingsetzt. Erzeuge den Hash spaeter mit:"
    note "    caddy hash-password"
    note "und trage ihn in die Datei ein."
    CADDY_HASH="CHANGEME_BCRYPT_HASH"
  fi
}

if ask_yes_no "Beim Erstellen einer Caddy-Datei helfen?" "y"; then
  PUBLIC_ORIGIN=""
  CADDY_OUT=""
  printf '%s\n' "Wo soll das Tool laufen?"
  printf '%s\n' "  1) Eigene (dedizierte) Subdomain   — z. B. term.example.com"
  printf '%s\n' "  2) Unterpfad einer bestehenden, bereits per Caddy konfigurierten Subdomain"
  MODE="$(ask_value 'Auswahl (1/2)' '1')"

  if [ "$MODE" = "1" ]; then
    # ---- dedizierte Subdomain -------------------------------------------
    HOST_NAME="$(ask_value 'Vollstaendiger Subdomain-Name (z. B. term.example.com)')"
    while [ -z "$HOST_NAME" ]; do HOST_NAME="$(ask_value 'Subdomain-Name')"; done
    warn "DNS: Lege einen A-/AAAA-Record fuer '$HOST_NAME' auf diesen Server an,"
    note "    bevor du Caddy neu laedst (sonst kann kein TLS-Zertifikat ausgestellt werden)."
    prompt_credentials
    PUBLIC_ORIGIN="https://$HOST_NAME"
    CADDY_OUT="$DEPLOY_DIR/${HOST_NAME}.local.caddy"
    cat > "$CADDY_OUT" <<EOF
# term-web — generiert von install.sh
# Echte Zugangsdaten — NICHT ins Repo committen (per .gitignore ausgeschlossen).
$HOST_NAME {
    # HTTP Basic Auth (Hash via 'caddy hash-password')
    basic_auth {
        $CADDY_USER $CADDY_HASH
    }

    # Backend bindet nur localhost; Caddy reicht den WebSocket-Upgrade
    # automatisch durch, Basic Auth deckt auch den WS-Handshake ab.
    reverse_proxy 127.0.0.1:$PORT {
        header_up X-Real-IP {remote_host}
    }

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }

    encode gzip zstd

    log {
        output file /var/log/caddy/${HOST_NAME}.access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
EOF
    ok "Caddy-Datei geschrieben: $CADDY_OUT"
    printf '%s\n' "Naechste Schritte:"
    note "    sudo mkdir -p /var/log/caddy"
    note "    sudo touch /var/log/caddy/${HOST_NAME}.access.log && sudo chown caddy:caddy /var/log/caddy/${HOST_NAME}.access.log"
    note "    sudo cp '$CADDY_OUT' /etc/caddy/sites/${HOST_NAME}.caddy   # bzw. in deinen Caddyfile-Import"
    note "    sudo systemctl reload caddy"

  else
    # ---- Unterpfad ------------------------------------------------------
    FULL_URL="$(ask_value 'Vollstaendige Wunsch-URL (z. B. https://tools.example.com/term)')"
    while [ -z "$FULL_URL" ]; do FULL_URL="$(ask_value 'Wunsch-URL')"; done
    scheme="${FULL_URL%%://*}"; [ "$scheme" = "$FULL_URL" ] && scheme="https"
    rest="${FULL_URL#*://}"
    HOST_NAME="${rest%%/*}"
    if [ "$rest" = "$HOST_NAME" ]; then URL_PATH="/"; else URL_PATH="/${rest#*/}"; fi
    URL_PATH="/$(printf '%s' "$URL_PATH" | sed 's#^/*##; s#/*$##')"   # auf /term normalisieren
    PUBLIC_ORIGIN="$scheme://$HOST_NAME"

    info "Suche eine bestehende Caddy-Konfiguration fuer '$HOST_NAME' …"
    FOUND=""
    for f in /etc/caddy/Caddyfile /etc/caddy/sites/*.caddy /etc/caddy/conf.d/*.caddy /etc/caddy/*.caddy; do
      [ -r "$f" ] || continue
      if grep -qE "(^|[[:space:]])${HOST_NAME//./\\.}([[:space:]]|\{|,|:)" "$f" 2>/dev/null; then
        FOUND="$f"; break
      fi
    done
    if [ -n "$FOUND" ]; then
      ok "Gefunden in: $FOUND"
      note "Fuege den folgenden Block INNERHALB des bestehenden '$HOST_NAME { … }'-Blocks ein."
    else
      warn "Keine lesbare bestehende Caddy-Datei fuer '$HOST_NAME' gefunden"
      note "(evtl. nur mit sudo lesbar). Ich erzeuge das Snippet 'ins Blaue' —"
      note "du fuegst es manuell in den passenden Site-Block ein."
    fi

    prompt_credentials
    CADDY_OUT="$DEPLOY_DIR/${HOST_NAME}${URL_PATH//\//_}.path.local.caddy"
    cat > "$CADDY_OUT" <<EOF
# term-web — Unterpfad-Snippet, generiert von install.sh
# Einzufuegen INNERHALB des bestehenden Site-Blocks:  $HOST_NAME { … }
# Echte Zugangsdaten — NICHT committen (per .gitignore ausgeschlossen).

    # Ohne abschliessenden Slash auf /-Form umleiten (relative Assets!)
    redir $URL_PATH ${URL_PATH}/

    # Pfad-Praefix abschneiden und ans term-web-Backend weiterreichen.
    handle_path ${URL_PATH}/* {
        basic_auth {
            $CADDY_USER $CADDY_HASH
        }
        reverse_proxy 127.0.0.1:$PORT {
            header_up X-Real-IP {remote_host}
        }
    }
EOF
    ok "Caddy-Snippet geschrieben: $CADDY_OUT"
    printf '%s\n' "Naechste Schritte:"
    note "    Snippet in den '$HOST_NAME { … }'-Block deiner Caddy-Konfiguration einfuegen"
    note "    sudo systemctl reload caddy"
    note "Hinweis: Das Frontend nutzt relative Pfade und laeuft daher unter dem Unterpfad,"
    note "solange der abschliessende Slash erzwungen wird (die 'redir'-Zeile oben)."
  fi

  # Oeffentlichen Origin in .env hinterlegen (server.js erlaubt damit den WS-Origin).
  if [ -n "$PUBLIC_ORIGIN" ]; then
    set_env PUBLIC_ORIGIN "$PUBLIC_ORIGIN"
    ok "PUBLIC_ORIGIN=$PUBLIC_ORIGIN in .env hinterlegt."
  fi
else
  info "Caddy-Schritt uebersprungen."
  note "Wichtig: Ohne gesetztes PUBLIC_ORIGIN in .env lehnt server.js WS-Verbindungen"
  note "von fremden Domains ab. Fuer Remote-Betrieb PUBLIC_ORIGIN=https://deine-domain setzen."
fi

# --------------------------------------------------------------------------
# 6. systemd-Unit
# --------------------------------------------------------------------------
step "6/6  systemd-Service"
if [ -z "$NODE_BIN" ]; then
  warn "node-Pfad unbekannt — systemd-Unit kann nicht zuverlaessig erzeugt werden."
  note "Installiere node bzw. setze den Pfad und fuehre das Skript erneut aus."
else
  SERVICE_NAME="$(ask_value 'Service-Name' 'term-web')"
  SERVICE_NAME="$(printf '%s' "$SERVICE_NAME" | tr -cd 'A-Za-z0-9_-')"
  [ -z "$SERVICE_NAME" ] && SERVICE_NAME="term-web"
  UNIT_OUT="$DEPLOY_DIR/${SERVICE_NAME}.local.service"
  CUR_USER="$(id -un)"
  cat > "$UNIT_OUT" <<EOF
[Unit]
Description=term-web — Web-Terminal
After=network.target

[Service]
Type=simple
User=$CUR_USER
WorkingDirectory=$SCRIPT_DIR
Environment=HOME=$HOME
Environment=LANG=en_US.UTF-8
# Port/HOST/PUBLIC_ORIGIN kommen aus der .env (von install.sh gepflegt).
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $SCRIPT_DIR/server.js
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  ok "systemd-Unit geschrieben: $UNIT_OUT"

  if ask_yes_no "Service jetzt per sudo installieren und starten?" "n"; then
    if sudo cp "$UNIT_OUT" "/etc/systemd/system/${SERVICE_NAME}.service" \
       && sudo systemctl daemon-reload \
       && sudo systemctl enable --now "$SERVICE_NAME"; then
      ok "Service '${SERVICE_NAME}' installiert und gestartet."
      note "    Status:  sudo systemctl status $SERVICE_NAME"
      note "    Logs:    journalctl -u $SERVICE_NAME -f"
    else
      err "Installation des Service fehlgeschlagen."
    fi
  else
    printf '%s\n' "Manuelle Installation:"
    note "    sudo cp '$UNIT_OUT' /etc/systemd/system/${SERVICE_NAME}.service"
    note "    sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE_NAME"
  fi
fi

# --------------------------------------------------------------------------
# Zusammenfassung
# --------------------------------------------------------------------------
step "Fertig"
ok "Konfiguration: $ENV_FILE"
[ "$BUILD_OK" -eq 1 ] && ok "Build vorhanden (public/)." || warn "Kein erfolgreicher Build — 'npm run build' nachholen."
note "Lokal testen:   ( cd '$SCRIPT_DIR' && '${NPM_BIN:-npm}' start )   -> http://127.0.0.1:$PORT"
note "Generierte, NICHT versionierte Dateien liegen unter: $DEPLOY_DIR/*.local.*"
