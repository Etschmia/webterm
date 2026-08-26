# deploy/lib-ask.sh — gemeinsame Ausgabe- und Eingabe-Helfer der Setup-Skripte.
# Per `source` geladen von install.sh und deploy/setup-auth, damit beide Dialoge
# identisch aussehen und sich identisch verhalten (Farben, j/n-Defaults, das
# Lesen ueber /dev/tty, die Passwort-Doppeleingabe).
#
# Keine Seiteneffekte ausser dem Setzen der C_*-Variablen und INTERACTIVE.

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
