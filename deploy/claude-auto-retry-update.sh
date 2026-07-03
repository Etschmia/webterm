#!/usr/bin/env bash
# claude-auto-retry-update.sh — taeglicher Update-Check fuer das global installierte
# npm-Paket claude-auto-retry (per Cron).
#
# Hintergrund: claude-auto-retry hat keinen eigenen Update-Mechanismus. Ein Fix im
# Paket selbst (z.B. der Enter/Paste-Bug aus Version 0.5.0: Text+Enter in EINEM
# tmux send-keys landen als ein pty-Chunk, Claude Codes TUI haelt das fuer ein
# Paste und fuegt das Enter nur als Zeilenumbruch ein statt abzusenden — die
# Retry-Nachricht stapelt sich dann unabgesendet im Prompt) nuetzt nichts, wenn
# das Paket nie aktualisiert wird.
#
# Dieses Skript:
#   1. Prueft die installierte gegen die neueste npm-Version.
#   2. Aktualisiert bei Bedarf (npm i -g claude-auto-retry@latest).
#   3. Startet laufende monitor.js-Hintergrundprozesse neu, falls sich die
#      Version geaendert hat — der ES-Module-Code eines bereits laufenden
#      Prozesses bleibt sonst bis zu dessen Neustart auf dem alten Stand
#      eingefroren, auch nach einem erfolgreichen npm-Update.
#
# Portabel: npm/node werden zur Laufzeit gesucht (PATH, ~/.local/bin, nvm, volta,
# /usr/local, /usr/bin, homebrew) — kein hartkodierter nvm-Node-Pfad. Cron hat
# kaum Umgebung, daher wird $HOME explizit gesetzt und die Suche deckt gaengige
# Installationsorte ab.
set -euo pipefail

export HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"

LOG_DIR="$HOME/.claude-auto-retry/logs"
LOG="$LOG_DIR/update-check.log"
mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

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

NPM_BIN="$(find_cmd npm || true)"
NODE_BIN="$(find_cmd node || true)"

log "=== claude-auto-retry-Update gestartet ==="

if [ -z "$NPM_BIN" ] || [ -z "$NODE_BIN" ]; then
  log "FEHLER: npm/node nicht gefunden (PATH, ~/.local/bin, nvm, volta, /usr/local, /usr/bin, homebrew geprueft)."
  exit 1
fi

GLOBAL_ROOT="$("$NPM_BIN" root -g 2>/dev/null || true)"
PKG_JSON="$GLOBAL_ROOT/claude-auto-retry/package.json"
MONITOR_JS="$GLOBAL_ROOT/claude-auto-retry/src/monitor.js"

read_version() {
  if [ -r "$PKG_JSON" ]; then
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$PKG_JSON" \
      | head -1 | cut -d'"' -f4
  else
    echo "nicht installiert"
  fi
}

VOR="$(read_version)"
log "Vor Update: $VOR"

if [ "$VOR" = "nicht installiert" ]; then
  log "claude-auto-retry ist nicht global installiert — nichts zu tun."
  log "=== claude-auto-retry-Update beendet ==="
  exit 0
fi

if "$NPM_BIN" install -g claude-auto-retry@latest >> "$LOG" 2>&1; then
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
      nohup "$NODE_BIN" "$MONITOR_JS" "$PANE" "$CLAUDE_PID" </dev/null >/dev/null 2>&1 &
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
