# deploy/lib-tmux-conf.sh — Claude-Code-taugliche tmux-Optionen in ~/.tmux.conf
# sicherstellen. Geteilt zwischen install.sh (Schritt 4c) und deploy/update
# (Phase 3c), damit auch Bestandsinstallationen die Zeilen beim Stand-Update
# bekommen — analog zur bashrc-Zeile der Standard-Session-Wrapper.
#
# Idempotenz-Waechter ist 'allow-passthrough' (auch von Hand gesetzt zaehlt);
# die Versions-Schwelle ist 3.3 (allow-passthrough gibt es erst dort, die
# uebrigen Optionen ab 3.2 — eine Schwelle reicht, aeltere tmux bleiben ohne).
#
# tmux_conf_ensure_claude [conf] — Rueckgabe 0, wenn der Block hinzugefuegt
# wurde (laufende tmux-Server werden dann gleich per source-file nachgezogen),
# sonst 1 (kein tmux, zu alt, oder schon vorhanden).
tmux_conf_ensure_claude(){
  local conf="${1:-$HOME/.tmux.conf}" ver
  command -v tmux >/dev/null 2>&1 || return 1
  ver="$(tmux -V 2>/dev/null | sed 's/[^0-9.]//g')"
  [ -n "$ver" ] || return 1
  [ "$(printf '%s\n3.3\n' "$ver" | sort -V | head -n1)" = "3.3" ] || return 1
  grep -Eq '^[[:space:]]*[^#].*allow-passthrough' "$conf" 2>/dev/null && return 1
  cat >> "$conf" <<'EOF'

# Claude Code & Co. (von term-web hinzugefuegt):
# - allow-passthrough: DCS-gewrappte Sequenzen (OSC-Notifications, Session-
#   Autowechsel der Standard-Session-Wrapper) erreichen das aeussere Terminal
# - extended-keys/extkeys: modifizierte Tasten (z. B. Shift+Enter als CSI-u)
#   an Anwendungen durchreichen, die sie anfordern
# - RGB: Truecolor fuer die Hex-Farben der TUIs (z. B. Diff-Hintergruende)
# - clipboard/set-clipboard: OSC 52 ans aeussere Terminal weitergeben (/copy)
set -g allow-passthrough on
set -s extended-keys on
set -g set-clipboard on
set -as terminal-features 'xterm*:RGB:clipboard:extkeys'
EOF
  # Laufende tmux-Server sofort nachziehen (best effort). Bewusst
  # list-sessions statt `tmux info`: info braucht einen ATTACHED Client und
  # schlaegt von aussen (SSH, deploy/update) fehl, obwohl der Server laeuft.
  if tmux list-sessions >/dev/null 2>&1; then
    tmux source-file "$conf" >/dev/null 2>&1 || true
  fi
  return 0
}
