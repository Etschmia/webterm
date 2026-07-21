#!/usr/bin/env bash
#
# install.sh — Portabler Installer fuer term-web (Web-Terminal mit Sidebar).
#
# Fuehrt schrittweise durch die Einrichtung:
#   1. Prueft, ob der vorgesehene Port frei ist (sonst Alternative erfragen).
#   2. Findet npm/node und baut das Projekt (npm install + npm run build).
#   3. Prueft tmux; bietet ggf. die Installation von claude-auto-retry an
#      (inkl. taeglichem Update-Check per Cron, siehe deploy/claude-auto-retry-update.sh).
#   4. Sorgt fuer "set -g mouse on" in ~/.tmux.conf und rollt die git-Statuszeile
#      aus (deploy/git-status.sh -> ~/.tmux/, status-right in ~/.tmux.conf).
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
  # Projekt-lokale node-Installation (vendor/node) hat Vorrang vor dem PATH:
  # manche Maschinen halten node bewusst aus dem PATH heraus (bun-Nachbarprojekt,
  # bun-'node'-Shims, die eine systemd-Unit auf bun umbiegen wuerden). Liegt der
  # offizielle Tarball unter vendor/node/, ist das hier das *echte*, gewollte node.
  if [ -x "$SCRIPT_DIR/vendor/node/bin/$name" ]; then
    printf '%s' "$SCRIPT_DIR/vendor/node/bin/$name"; return 0
  fi
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

run_npm() {
  # Fuehrt npm ("$@") im Projektverzeichnis aus. Zwei Dinge sind dabei wichtig:
  #  * npm ist selbst ein Node-Skript (Shebang '#!/usr/bin/env node') und die
  #    package.json-Skripte rufen bare 'node' auf (build.mjs, server.js). Ohne
  #    node im PATH scheitert schon der npm-Start ("env: node: not found"). Wir
  #    stellen den Ordner von $NODE_BIN nur fuer diesen Aufruf dem PATH voran
  #    (auf normalen Maschinen ist node ohnehin im PATH -> harmlos).
  #  * Fuer die projekt-lokale vendor/node-Installation duerfen npm-Config und
  #    -Cache NICHT nach ~ schreiben (ein ~/.npmrc wuerde vom bun-Nachbarprojekt
  #    mitgelesen und hat hier schon Schaden angerichtet). Beides wird dann ins
  #    Projekt umgeleitet (vendor/, .npmrc, .npm-cache/ sind gitignored). Auf
  #    Maschinen mit globalem node bleibt die vorhandene npm-Config unberuehrt.
  local node_dir=""
  [ -n "$NODE_BIN" ] && node_dir="$(dirname "$NODE_BIN")"
  if [ "${USING_VENDOR_NODE:-0}" -eq 1 ]; then
    ( cd "$SCRIPT_DIR" \
      && PATH="${node_dir:+$node_dir:}$PATH" \
         NPM_CONFIG_USERCONFIG="$SCRIPT_DIR/.npmrc" \
         NPM_CONFIG_CACHE="$SCRIPT_DIR/.npm-cache" \
         "$NPM_BIN" "$@" )
  else
    ( cd "$SCRIPT_DIR" && PATH="${node_dir:+$node_dir:}$PATH" "$NPM_BIN" "$@" )
  fi
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
# Merken, ob node aus der projekt-lokalen vendor/node-Installation stammt —
# dann braucht npm den PATH-Praefix und eine gekapselte Config (siehe run_npm).
USING_VENDOR_NODE=0
case "$NODE_BIN" in
  "$SCRIPT_DIR/vendor/node/bin/"*) USING_VENDOR_NODE=1 ;;
esac
BUILD_OK=0
if [ -z "$NPM_BIN" ]; then
  err "npm wurde nicht gefunden (PATH, ~/.local/bin, nvm, volta, /usr/local, /usr/bin, homebrew geprueft)."
  warn "Bitte Node.js/npm installieren (z. B. via nvm) und das Skript erneut ausfuehren."
else
  ok "npm:  $NPM_BIN"
  [ -n "$NODE_BIN" ] && ok "node: $NODE_BIN" || warn "node-Binary nicht separat gefunden — systemd-Unit braucht den Pfad."
  [ "$USING_VENDOR_NODE" -eq 1 ] && note "    (projekt-lokale vendor/node-Installation — npm laeuft mit gekapseltem PATH/Config)"
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
    if run_npm install; then
      info "Frontend bauen (npm run build) …"
      if run_npm run build; then
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
        have_car=1
      else
        warn "claude-auto-retry-Binary nach der Installation nicht gefunden — PATH/npm-Prefix pruefen."
      fi
    else
      err "npm i -g claude-auto-retry fehlgeschlagen (evtl. Rechte? -> ggf. mit sudo, oder npm-Prefix auf ~/.local setzen)."
    fi
  else
    info "claude-auto-retry uebersprungen."
  fi

  # claude-auto-retry hat keinen eigenen Update-Mechanismus. Ohne regelmaessigen
  # Check bleibt ein installiertes Paket auf ewig auf dem Stand der Erstinstallation —
  # so geschehen bei einem Bug im Enter/Paste-Handling, der Monate nach Erscheinen
  # des offiziellen Fixes noch aktiv war, weil nichts das Update angestossen hat.
  if [ "$have_car" -eq 1 ]; then
    CRON_SCRIPT="$DEPLOY_DIR/claude-auto-retry-update.sh"
    if crontab -l 2>/dev/null | grep -qF "$CRON_SCRIPT"; then
      ok "Taeglicher claude-auto-retry-Update-Check ist bereits im Crontab eingetragen."
    elif ! command -v crontab >/dev/null 2>&1; then
      warn "crontab nicht gefunden — taeglicher claude-auto-retry-Update-Check uebersprungen."
      note "    Manuell einrichten: $CRON_SCRIPT"
    elif ask_yes_no "Taeglichen Update-Check fuer claude-auto-retry per Cron einrichten (07:45 Uhr)?" "y"; then
      CRON_LINE="45 7 * * * $CRON_SCRIPT >/dev/null 2>&1"
      { crontab -l 2>/dev/null || true; printf '%s\n' "$CRON_LINE"; } | crontab -
      ok "Cron-Eintrag hinzugefuegt: $CRON_LINE"
      note "    Log: \$HOME/.claude-auto-retry/logs/update-check.log"
    else
      info "Cron-Update-Check uebersprungen."
    fi
  fi
else
  warn "tmux ist NICHT installiert. Die Sidebar-Session-Funktion bleibt ohne tmux leer."
  note "    Debian/Ubuntu: sudo apt install tmux   ·   macOS: brew install tmux"
fi

# --------------------------------------------------------------------------
# 4. ~/.tmux.conf: Maus-Unterstuetzung + git-Status in der Statuszeile
# --------------------------------------------------------------------------
step "4/6  tmux-Konfiguration (Maus + git-Status)"

# 4a) git-status.sh nach ~/.tmux/ ausrollen — die Statuszeile ruft es dort per
#     fixem Pfad auf. Quelle liegt im Repo (deploy/git-status.sh); Zielverzeichnis
#     ggf. anlegen, Skript aktuell halten und ausfuehrbar machen.
GITSTATUS_SRC="$DEPLOY_DIR/git-status.sh"
TMUX_DIR="$HOME/.tmux"
GITSTATUS_DST="$TMUX_DIR/git-status.sh"
if [ ! -f "$GITSTATUS_SRC" ]; then
  warn "deploy/git-status.sh fehlt im Repo — git-Statuszeile wird uebersprungen."
else
  mkdir -p "$TMUX_DIR"
  if [ ! -f "$GITSTATUS_DST" ] || ! cmp -s "$GITSTATUS_SRC" "$GITSTATUS_DST"; then
    cp "$GITSTATUS_SRC" "$GITSTATUS_DST"
    ok "git-status.sh nach ~/.tmux/ kopiert."
  else
    ok "~/.tmux/git-status.sh ist aktuell."
  fi
  if [ ! -x "$GITSTATUS_DST" ]; then
    chmod +x "$GITSTATUS_DST"
    info "~/.tmux/git-status.sh ausfuehrbar gemacht."
  fi
fi

# 4b) ~/.tmux.conf sicherstellen: mouse on, status-interval und die git-Statuszeile.
TMUX_CONF="$HOME/.tmux.conf"
TMUX_CHANGED=0
[ -f "$TMUX_CONF" ] || info "~/.tmux.conf existiert nicht — wird angelegt."

if grep -Eq '^[[:space:]]*[^#].*\bmouse[[:space:]]+on\b' "$TMUX_CONF" 2>/dev/null; then
  ok "'mouse on' ist in ~/.tmux.conf bereits gesetzt."
else
  printf '\n# Maus-Unterstuetzung (von term-web/install.sh hinzugefuegt)\nset -g mouse on\n' >> "$TMUX_CONF"
  ok "'set -g mouse on' zu ~/.tmux.conf hinzugefuegt."
  TMUX_CHANGED=1
fi

# git-Status erkennbar am Aufruf von git-status.sh in einer status-right-Zeile.
# Nur ausrollen, wenn das Skript im Repo vorhanden ist (sonst zeigt die Zeile nichts).
if grep -Eq '^[[:space:]]*[^#].*git-status\.sh' "$TMUX_CONF" 2>/dev/null; then
  ok "git-Status in der tmux-Statuszeile ist bereits konfiguriert."
elif [ -f "$GITSTATUS_SRC" ]; then
  cat >> "$TMUX_CONF" <<'EOF'

# git Infos anzeigen (von term-web/install.sh hinzugefuegt)
set -g status-interval 10
set -g status-right '#[fg=colour245]#(~/.tmux/git-status.sh #{pane_current_path})#[default] | %H:%M'
EOF
  ok "git-Statuszeile (status-interval + status-right) zu ~/.tmux.conf hinzugefuegt."
  TMUX_CHANGED=1
fi

if [ "$TMUX_CHANGED" -eq 1 ] && [ "$HAVE_TMUX" -eq 1 ] && tmux info >/dev/null 2>&1; then
  tmux source-file "$TMUX_CONF" >/dev/null 2>&1 && info "Laufende tmux-Server neu geladen." || true
fi

# claude/codex/grok aus der Standard-Sitzung (selbst eine tmux-Session) heraus
# in eigene tmux-Sessions umlenken — sonst laufen sie IN der Standard-Sitzung
# und tauchen nicht als eigene Session in der Sidebar auf.
# Die Position in der ~/.bashrc ist egal: der Wrapper sammelt spaeter
# definierte Fremd-Funktionen (z. B. claude-auto-retry) vor dem ersten
# Prompt per PROMPT_COMMAND-Hook noch einmal ein.
WRAP_SRC="$DEPLOY_DIR/standard-session-wrappers.sh"
BASHRC="$HOME/.bashrc"
if grep -qF "standard-session-wrappers.sh" "$BASHRC" 2>/dev/null; then
  ok "Standard-Session-Wrapper sind in ~/.bashrc bereits eingebunden."
else
  printf '\n# term-web: claude/codex/grok aus der Standard-Sitzung in eigene tmux-Sessions\n[ -f "%s" ] && . "%s"\n' \
    "$WRAP_SRC" "$WRAP_SRC" >> "$BASHRC"
  ok "Standard-Session-Wrapper in ~/.bashrc eingebunden."
  note "    Gilt fuer neue Shells — in offenen Sitzungen: source ~/.bashrc"
fi

# --------------------------------------------------------------------------
# 5. Caddy-Datei
# --------------------------------------------------------------------------
step "5/6  Caddy-Konfiguration"
HAVE_CADDY=0
command -v caddy >/dev/null 2>&1 && HAVE_CADDY=1

# Basic-Auth-Direktive passend zur installierten Caddy-Version waehlen.
CADDY_BASICAUTH="$(caddy_basicauth_directive)"
if [ "$HAVE_CADDY" -eq 1 ]; then
  note "Caddy gefunden ($(caddy version 2>/dev/null | head -n1)) — verwende Direktive '$CADDY_BASICAUTH'."
else
  note "Caddy nicht gefunden — verwende '$CADDY_BASICAUTH' (passt fuer Caddy >= 2.8)."
  note "Auf Caddy < 2.8 die Direktive im Snippet in 'basicauth' (ohne Unterstrich) umbenennen."
fi

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
    ${CADDY_BASICAUTH} {
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
        ${CADDY_BASICAUTH} {
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
  # Default 'term-server': README, CLAUDE.md und deploy/term-restart gehen von diesem
  # Namen aus. Ein abweichender Name muss term-restart per TERM_SERVICE mitgegeben werden.
  SERVICE_NAME="$(ask_value 'Service-Name' 'term-server')"
  SERVICE_NAME="$(printf '%s' "$SERVICE_NAME" | tr -cd 'A-Za-z0-9_-')"
  [ -z "$SERVICE_NAME" ] && SERVICE_NAME="term-server"
  CUR_USER="$(id -un)"

  printf '%s\n' "Wie soll der Service laufen?"
  printf '%s\n' "  1) System-Unit  (/etc/systemd/system — Installation und Restart brauchen sudo)"
  printf '%s\n' "  2) User-Unit    (~/.config/systemd/user — komplett ohne sudo, auch spaeter"
  printf '%s\n' "                   beim deploy/term-restart; richtig fuer Nutzer ohne sudo)"
  UNIT_MODE="$(ask_value 'Auswahl (1/2)' '1')"

  # Servicenamen (+ System-/User-Modus) fuer deploy/update & deploy/term-restart
  # hinterlegen — so treffen beide die richtige Instanz OHNE gesetztes TERM_SERVICE.
  # Gitignored (deploy/deploy.env); die Auto-Erkennung ueber den laufenden
  # server.js-Prozess bleibt nur der Fallback, falls diese Datei fehlt.
  if [ "$UNIT_MODE" = "2" ]; then TERM_USER_UNIT_VAL=1; else TERM_USER_UNIT_VAL=0; fi
  DEPLOY_ENV_OUT="$DEPLOY_DIR/deploy.env"
  {
    printf '# Von install.sh erzeugt — Instanz fuer deploy/update & deploy/term-restart.\n'
    printf '# Gitignored. Ueberschreibt die Auto-Erkennung; per Umgebung ($TERM_SERVICE) uebersteuerbar.\n'
    printf 'TERM_SERVICE=%s\n' "$SERVICE_NAME"
    printf 'TERM_USER_UNIT=%s\n' "$TERM_USER_UNIT_VAL"
  } > "$DEPLOY_ENV_OUT"
  ok "Servicename hinterlegt: $DEPLOY_ENV_OUT (TERM_SERVICE=$SERVICE_NAME, TERM_USER_UNIT=$TERM_USER_UNIT_VAL)"

  if [ "$UNIT_MODE" = "2" ]; then
    # ---- User-Unit: laeuft ohnehin als dieser Nutzer, daher kein User=;
    # default.target ist das multi-user.target des User-Managers.
    # PTY-/SSH-Umgebungen setzen XDG_RUNTIME_DIR nicht immer — ohne das
    # erreicht `systemctl --user` den User-Manager nicht.
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
      export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    fi
    UNIT_OUT="$DEPLOY_DIR/${SERVICE_NAME}.local.service"
    cat > "$UNIT_OUT" <<EOF
[Unit]
Description=term-web — Web-Terminal (User-Unit)
After=network.target

[Service]
Type=simple
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
WantedBy=default.target
EOF
    ok "systemd-User-Unit geschrieben: $UNIT_OUT"

    if ask_yes_no "User-Unit jetzt installieren und starten (ohne sudo)?" "y"; then
      USER_UNIT_DIR="$HOME/.config/systemd/user"
      if mkdir -p "$USER_UNIT_DIR" \
         && cp "$UNIT_OUT" "$USER_UNIT_DIR/${SERVICE_NAME}.service" \
         && systemctl --user daemon-reload \
         && systemctl --user enable --now "$SERVICE_NAME"; then
        ok "User-Service '${SERVICE_NAME}' installiert und gestartet."
        note "    Status:  systemctl --user status $SERVICE_NAME"
        note "    Logs:    journalctl --user -u $SERVICE_NAME -f"
      else
        err "Installation der User-Unit fehlgeschlagen."
      fi
    else
      printf '%s\n' "Manuelle Installation:"
      note "    mkdir -p ~/.config/systemd/user && cp '$UNIT_OUT' ~/.config/systemd/user/${SERVICE_NAME}.service"
      note "    systemctl --user daemon-reload && systemctl --user enable --now $SERVICE_NAME"
    fi

    # Ohne Lingering beendet systemd alle User-Units beim letzten Logout —
    # der Service waere dann kein Dauerdienst. Aktive Sitzungen duerfen das
    # per polkit meist fuer sich selbst setzen (set-self-linger), sonst muss
    # einmalig ein Admin ran.
    if loginctl show-user "$CUR_USER" 2>/dev/null | grep -q '^Linger=yes'; then
      ok "Lingering ist aktiv — der Service laeuft auch ohne offene Sitzung weiter."
    elif loginctl enable-linger 2>/dev/null; then
      ok "Lingering aktiviert (loginctl enable-linger) — Service ueberlebt den Logout."
    else
      warn "Lingering konnte nicht aktiviert werden — ohne Lingering stoppt der Service beim Logout!"
      note "    Einmalig als Admin ausfuehren: sudo loginctl enable-linger $CUR_USER"
    fi
    note "deploy/term-restart erkennt die User-Unit automatisch und kommt dann ohne sudo aus."

  else
    # ---- System-Unit (bisheriger Weg) -----------------------------------
    UNIT_OUT="$DEPLOY_DIR/${SERVICE_NAME}.local.service"
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
fi

# --------------------------------------------------------------------------
# Zusammenfassung
# --------------------------------------------------------------------------
step "Fertig"
ok "Konfiguration: $ENV_FILE"
if [ "$BUILD_OK" -eq 1 ]; then
  ok "Build vorhanden (public/)."
elif [ "$USING_VENDOR_NODE" -eq 1 ]; then
  warn "Kein erfolgreicher Build — 'npm run build' nachholen (mit vendor/node im PATH, s. u.)."
else
  warn "Kein erfolgreicher Build — 'npm run build' nachholen."
fi
if [ "$USING_VENDOR_NODE" -eq 1 ]; then
  # vendor/node liegt bewusst nicht im PATH: server.js direkt mit dem absoluten
  # node-Pfad starten (npm start wuerde bare 'node' aufrufen und ohne PATH scheitern).
  note "Lokal testen:   ( cd '$SCRIPT_DIR' && '$NODE_BIN' server.js )   -> http://127.0.0.1:$PORT"
else
  note "Lokal testen:   ( cd '$SCRIPT_DIR' && '${NPM_BIN:-npm}' start )   -> http://127.0.0.1:$PORT"
fi
note "Generierte, NICHT versionierte Dateien liegen unter: $DEPLOY_DIR/*.local.*"
