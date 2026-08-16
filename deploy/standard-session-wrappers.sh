# term-web — claude/codex/grok/kimi aus der Standard-Sitzung in eigene tmux-Sessions.
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

# Bereits definierte gleichnamige Fremd-Funktionen (z. B. claude-auto-retry)
# sichern und im Durchreich-Fall weiterverwenden. Wird beim Sourcen UND noch
# einmal vor dem ersten Prompt aufgerufen (siehe _term_wrappers_rearm unten) —
# die Reihenfolge in der ~/.bashrc ist damit egal.
_term_install_wrappers() {
  local t
  for t in claude codex grok kimi; do
    if declare -f "$t" >/dev/null 2>&1 \
       && [[ "$(declare -f "$t")" != *_term_tool_session* ]]; then
      eval "$(declare -f "$t" | sed "1s/^$t/_term_orig_$t/")"
    fi
    eval "$t() { _term_tool_session $t \"\$@\"; }"
  done
}

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

_term_install_wrappers

# Ein spaeter in der ~/.bashrc definiertes claude()/codex()/grok()/kimi() (z. B. der
# claude-auto-retry-Block, der hinter dieser Source-Zeile stehen kann) wuerde
# die Wrapper wieder ueberschreiben — genau so lief claude einmal doch in der
# Standard-Sitzung. Zweites Problem: Shells in tmux-Sessions laufen wochenlang
# und behalten die beim Start gesourcte Version dieser Datei — neu aufgenommene
# Tools (z. B. kimi) kaemen dort nie an, wenn der Pane beim deploy/update-Lauf
# gerade belegt ist. Deshalb laeuft vor JEDEM Prompt ein Hook, der
# (1) nachtraeglich definierte Fremd-Funktionen einsammelt (als _term_orig_<tool>
#     gesichert und vom Wrapper durchgereicht) und
# (2) diese Datei neu sourct, sobald sie sich auf der Platte geaendert hat.
_TERM_WRAPPERS_FILE="${BASH_SOURCE[0]}"
_TERM_WRAPPERS_MTIME="$(stat -c %Y "$_TERM_WRAPPERS_FILE" 2>/dev/null)"

_term_wrappers_hook() {
  _term_install_wrappers
  local m
  m="$(stat -c %Y "$_TERM_WRAPPERS_FILE" 2>/dev/null)"
  if [ -n "$m" ] && [ "$m" != "${_TERM_WRAPPERS_MTIME:-}" ]; then
    . "$_TERM_WRAPPERS_FILE"
  fi
}

# Hook genau einmal in PROMPT_COMMAND haengen (auch beim Neu-Sourcen der Datei).
case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  'declare -a'*)
    [[ " ${PROMPT_COMMAND[*]} " == *" _term_wrappers_hook "* ]] \
      || PROMPT_COMMAND+=(_term_wrappers_hook) ;;
  *)
    case ";${PROMPT_COMMAND:-};" in
      *";_term_wrappers_hook;"*) ;;
      *) PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}_term_wrappers_hook" ;;
    esac ;;
esac
