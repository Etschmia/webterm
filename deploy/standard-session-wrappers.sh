# term-web — claude/codex/grok aus der Standard-Sitzung in eigene tmux-Sessions.
#
# Wird aus ~/.bashrc gesourct (install.sh richtet die Zeile ein). Hintergrund:
# Die Standard-Sitzung des Webterminals ist selbst eine tmux-Session
# ("Standard-Webterm"). Startet man dort claude & Co. direkt, laufen sie IN der
# Standard-Sitzung statt in einer eigenen — die Sidebar fuehrt sie nicht als
# eigene Session, und die Standard-Shell ist solange blockiert. Diese Wrapper
# legen beim Aufruf aus der Standard-Sitzung eine neue tmux-Session an
# (Name: <tool>-<verzeichnis>), starten das Tool darin und wechseln den
# tmux-Client dorthin. Ueberall sonst (eigene Sessions, SSH ohne tmux)
# aendert sich nichts.

# Bereits definierte gleichnamige Funktionen (z. B. claude-auto-retry) sichern
# und im Durchreich-Fall weiterverwenden. Deshalb muss diese Datei NACH deren
# Definition gesourct werden — install.sh haengt die Zeile ans Ende der ~/.bashrc.
for _t in claude codex grok; do
  if declare -f "$_t" >/dev/null 2>&1 && ! declare -f "_term_orig_$_t" >/dev/null 2>&1; then
    eval "$(declare -f "$_t" | sed "1s/^$_t/_term_orig_$_t/")"
  fi
done
unset _t

_term_run_orig() {
  local tool="$1"; shift
  if declare -f "_term_orig_$tool" >/dev/null 2>&1; then
    "_term_orig_$tool" "$@"
  else
    command "$tool" "$@"
  fi
}

_term_tool_session() {
  local tool="$1"; shift
  local std="${TERM_STANDARD_SESSION:-Standard-Webterm}"
  # Nur aus der Standard-Sitzung heraus umlenken; sonst normal durchreichen.
  if [ -z "${TMUX:-}" ] || [ "$(tmux display-message -p '#S' 2>/dev/null)" != "$std" ]; then
    _term_run_orig "$tool" "$@"
    return
  fi
  local base name n=2 cmd
  base="$tool-$(basename "$PWD" | tr -c 'A-Za-z0-9_-' '-')"
  base="${base%-}"   # tr ersetzt auch das abschliessende Newline durch '-'
  name="$base"
  while tmux has-session -t "=$name" 2>/dev/null; do name="$base-$n"; n=$((n+1)); done
  cmd="$tool"
  [ $# -gt 0 ] && cmd="$cmd $(printf '%q ' "$@")"
  # Kommando via `bash -ic` starten statt per send-keys hineinzutippen: -i laedt
  # die ~/.bashrc (Wrapper wie claude-auto-retry greifen also auch dort), und
  # send-keys direkt nach new-session verliert Tasten, solange die .bashrc noch
  # laeuft. Nach Programmende ersetzt `exec bash -i` den Prozess durch eine
  # normale Shell — die Session bleibt erhalten.
  tmux new-session -d -s "$name" -c "$PWD" -- bash -ic "$cmd; exec bash -i"
  # Das Webterminal sofort auf die neue Session umschalten: den Session-Namen
  # als OSC 5522 durch die PTY reichen (tmux-Passthrough, BEL-terminiert). Das
  # Frontend faengt die Sequenz ab und wechselt Sidebar + Attach dorthin;
  # andere Terminal-Emulatoren ignorieren die unbekannte Sequenz stillschweigend.
  tmux set-option -p allow-passthrough on 2>/dev/null
  printf '\033Ptmux;\033\033]5522;%s\007\033\\' "$name"
  # Fuer echte tmux-Clients (z. B. SSH-Attach an die Standard-Session) den
  # Client zusaetzlich klassisch umschalten.
  tmux switch-client -t "$name" 2>/dev/null \
    || printf 'Neue Session "%s" gestartet (siehe Sidebar).\n' "$name"
}

claude() { _term_tool_session claude "$@"; }
codex()  { _term_tool_session codex  "$@"; }
grok()   { _term_tool_session grok   "$@"; }
