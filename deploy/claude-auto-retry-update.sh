#!/usr/bin/env bash
# claude-auto-retry-update.sh — taeglicher Update-Check fuer das global installierte
# Paket claude-auto-retry (per Cron).
#
# Hintergrund: claude-auto-retry hat keinen eigenen Update-Mechanismus. Ein Fix im
# Paket selbst (z.B. der Enter/Paste-Bug aus Version 0.5.0: Text+Enter in EINEM
# tmux send-keys landen als ein pty-Chunk, Claude Codes TUI haelt das fuer ein
# Paste und fuegt das Enter nur als Zeilenumbruch ein statt abzusenden — die
# Retry-Nachricht stapelt sich dann unabgesendet im Prompt) nuetzt nichts, wenn
# das Paket nie aktualisiert wird.
#
# Dieses Skript:
#   1. Findet heraus, unter WELCHEM Paketmanager claude-auto-retry global liegt.
#   2. Prueft die installierte gegen die neueste Version und aktualisiert bei Bedarf.
#   3. Startet laufende monitor.js-Hintergrundprozesse neu, falls sich die
#      Version geaendert hat — der ES-Module-Code eines bereits laufenden
#      Prozesses bleibt sonst bis zu dessen Neustart auf dem alten Stand
#      eingefroren, auch nach einem erfolgreichen Update.
#
# bun ODER npm: Auf Maschinen ohne globales node (z.B. neben einem bun-Projekt,
# siehe webterm/CLAUDE.md) liegt das Paket unter bun, sonst unter npm. Massgeblich
# ist nicht, welcher Paketmanager existiert, sondern wo das Paket TATSAECHLICH
# installiert ist — sonst aktualisiert das Skript einen anderen Ort als den, aus
# dem der Wrapper laedt. claude-auto-retry hat null Dependencies und nutzt nur
# node:-Builtins, laeuft unter bun also unveraendert.
#
# Portabel: Binaries werden zur Laufzeit gesucht (PATH, ~/.bun/bin, ~/.local/bin,
# nvm, volta, /usr/local, /usr/bin, homebrew) — keine hartkodierten Pfade. Cron hat
# kaum Umgebung, daher wird $HOME explizit gesetzt und die Suche deckt gaengige
# Installationsorte ab.
set -euo pipefail

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"

LOG_DIR="$HOME/.claude-auto-retry/logs"
LOG="$LOG_DIR/update-check.log"
mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

find_cmd() {
  # Sucht $1 in PATH und gaengigen Installationsorten. Pfad -> stdout.
  local name="$1" p latest
  if p="$(command -v "$name" 2>/dev/null)"; then printf '%s' "$p"; return 0; fi
  for p in \
    "${BUN_INSTALL:-$HOME/.bun}/bin/$name" \
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

BUN_BIN="$(find_cmd bun || true)"
NPM_BIN="$(find_cmd npm || true)"
NODE_BIN="$(find_cmd node || true)"

# npm ist selbst ein node-Skript mit Shebang '#!/usr/bin/env node'. Cron hat kaum PATH,
# und liegt node nicht in /usr/bin, scheitert JEDER npm-Aufruf still mit
# "env: 'node': No such file or directory" — 'npm root -g' liefert dann leer, das Paket
# gilt faelschlicherweise als "nicht installiert" und das Skript beendet sich als No-op.
# Genau so lief dieser Cron wochenlang leer (0.6.0 statt 0.7.3). Also: node-Verzeichnis
# dem PATH voranstellen, sobald wir es gefunden haben.
if [ -n "$NODE_BIN" ]; then
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
fi

log "=== claude-auto-retry-Update gestartet ==="

# Installationsort bestimmen. Reihenfolge: bun zuerst, dann npm. Gesetzt werden
# PM (Anzeige), PKG_ROOT (globales node_modules) und RUNTIME_BIN (fuer monitor.js).
PM=""; PKG_ROOT=""; RUNTIME_BIN=""
if [ -n "$BUN_BIN" ]; then
  cand="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"
  if [ -r "$cand/claude-auto-retry/package.json" ]; then
    PM="bun"; PKG_ROOT="$cand"; RUNTIME_BIN="$BUN_BIN"
  fi
fi
if [ -z "$PM" ] && [ -n "$NPM_BIN" ]; then
  cand="$("$NPM_BIN" root -g 2>/dev/null || true)"
  if [ -n "$cand" ] && [ -r "$cand/claude-auto-retry/package.json" ]; then
    if [ -z "$NODE_BIN" ]; then
      log "FEHLER: claude-auto-retry liegt unter npm ($cand), aber node fehlt — Monitor-Neustart unmoeglich."
      exit 1
    fi
    PM="npm"; PKG_ROOT="$cand"; RUNTIME_BIN="$NODE_BIN"
  fi
fi

if [ -z "$PM" ]; then
  log "claude-auto-retry ist global weder unter bun noch unter npm installiert — nichts zu tun."
  log "=== claude-auto-retry-Update beendet ==="
  exit 0
fi

PKG_JSON="$PKG_ROOT/claude-auto-retry/package.json"
MONITOR_JS="$PKG_ROOT/claude-auto-retry/src/monitor.js"

read_version() {
  if [ -r "$PKG_JSON" ]; then
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$PKG_JSON" \
      | head -1 | cut -d'"' -f4
  else
    echo "nicht installiert"
  fi
}

VOR="$(read_version)"
log "Paketmanager: $PM ($PKG_ROOT)"
log "Vor Update: $VOR"

# 'bun add -g <pkg>@latest' entspricht 'npm i -g <pkg>@latest': beide ziehen die
# neueste Version. 'bun update -g' bliebe dagegen im Semver-Range des Eintrags.
if [ "$PM" = "bun" ]; then
  UPDATE_CMD=("$BUN_BIN" add -g claude-auto-retry@latest)
else
  UPDATE_CMD=("$NPM_BIN" install -g claude-auto-retry@latest)
fi

if "${UPDATE_CMD[@]}" >> "$LOG" 2>&1; then
  NACH="$(read_version)"
  if [ "$VOR" = "$NACH" ]; then
    log "Update OK – Version unveraendert ($NACH, bereits aktuell)"
  else
    log "Update OK – $VOR -> $NACH"

    RESTARTED=0
    # "pid pane claude_pid" pro laufendem Monitor, z.B. "429812 %1 363822"
    while read -r PID PANE CLAUDE_PID; do
      [ -z "$PID" ] && continue
      kill "$PID" 2>/dev/null || true
      sleep 1
      nohup "$RUNTIME_BIN" "$MONITOR_JS" "$PANE" "$CLAUDE_PID" </dev/null >/dev/null 2>&1 &
      disown
      RESTARTED=$((RESTARTED + 1))
      log "Monitor fuer Pane $PANE (claude PID $CLAUDE_PID) neu gestartet (alter PID $PID)"
    done < <(ps -eo pid,args | grep -F "$MONITOR_JS" | grep -v grep | awk '{print $1, $(NF-1), $NF}')
    log "$RESTARTED laufende(r) Monitor-Prozess(e) neu gestartet"
  fi
else
  log "FEHLER beim Update (siehe Log oben)"
  exit 2
fi

log "=== claude-auto-retry-Update beendet ==="
