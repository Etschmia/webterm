# deploy/lib-service.sh — gemeinsame, robuste Ermittlung des systemd-Unit-Namens
# fuer diese term-web-Instanz. Von deploy/update UND deploy/term-restart per
# `source` geladen, damit beide denselben Dienst treffen.
#
# Warum: frueher defaulteten beide Skripte hart auf 'term-server'. Auf einer Box,
# deren Unit anders heisst (z. B. ag-webterm) und ohne gesetztes TERM_SERVICE,
# pruefte update den falschen (nicht existierenden) Dienst, meldete beruhigend
# "laeuft nicht — kein Restart" und liess so ein Backend-Update stumm liegen.
#
# term_resolve_service ermittelt den Namen in dieser Reihenfolge:
#   (a) explizit gesetztes $TERM_SERVICE
#   (b) deploy/deploy.env (install-lokal, gitignored) mit TERM_SERVICE=…
#   (c) Auto-Erkennung: der laufende `node <repo>/server.js`-Prozess DIESES Repos,
#       dessen systemd-Unit ueber /proc/<pid>/cgroup abgeleitet wird.
#
# Setzt nach dem Aufruf:
#   SERVICE           Unit-Name ('' wenn nichts gefunden)
#   SERVICE_SOURCE    'TERM_SERVICE' | 'deploy.env' | 'auto' | 'auto:proc-no-unit' | 'none'
#   REPO_BACKEND_PID  PID des erkannten server.js-Prozesses ('' wenn keiner)
#   TERM_USER_UNIT    0/1 (nur in der Auto-Erkennung gesetzt, falls nicht schon vorgegeben)
# Rueckgabewert: 0 = Unit-Name ermittelt, 1 = kein Backend-Prozess, 2 = Prozess
# gefunden, aber keiner systemd-Unit zuzuordnen.
#
# Keine Seiteneffekte beim Sourcen ausser dem Setzen von TERM_REPO_DIR/DEPLOY_ENV.

TERM_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV="$TERM_REPO_DIR/deploy/deploy.env"

# PID eines laufenden `node <repo>/server.js` DIESES Repos (leer, wenn keiner).
# Match ueber die absolute server.js aus der cmdline; als Fallback server.js +
# cwd == Repo. Nur Prozesse des eigenen Users sind lesbar — genau die suchen wir.
term_detect_repo_backend_pid(){
  local d pid cmd cwd
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ -r "$d/cmdline" ] || continue
    cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)" || continue
    case "$cmd" in *server.js*) : ;; *) continue ;; esac
    case " $cmd " in
      *" $TERM_REPO_DIR/server.js "*) printf '%s' "$pid"; return 0 ;;
    esac
    cwd="$(readlink -f "$d/cwd" 2>/dev/null || true)"
    if [ "$cwd" = "$TERM_REPO_DIR" ]; then
      case "$cmd" in *node*server.js*) printf '%s' "$pid"; return 0 ;; esac
    fi
  done
  return 1
}

# systemd-Unit-Name aus /proc/<pid>/cgroup (letztes '<name>.service' im Pfad).
# system: /system.slice/ag-webterm.service ; user: …/user@1000.service/…/tbterm.service
term_unit_from_pid(){
  local pid="$1" unit
  [ -r "/proc/$pid/cgroup" ] || return 1
  unit="$(grep -oE '[A-Za-z0-9@:._\\-]+\.service' "/proc/$pid/cgroup" 2>/dev/null | tail -n1)"
  [ -n "$unit" ] || return 1
  # user@<uid>.service ist der User-Manager selbst, nicht die App-Unit — ignorieren.
  case "$unit" in user@*.service) return 1 ;; esac
  printf '%s' "${unit%.service}"
}

# 0/1: laeuft der Prozess in einer User-Slice (=> User-Unit, kein sudo)?
term_user_unit_from_pid(){
  grep -q 'user@[0-9]' "/proc/$1/cgroup" 2>/dev/null && printf '1' || printf '0'
}

# User-Bus erreichbar? Repariert vorher die gaengigen Umgebungsfehler und probt
# dann erneut. Hintergrund (Vorfall 21.07.2026, Instanz jeb-webterm): in einer
# Webterminal-Shell zeigte die geerbte Umgebung auf einen nicht zugreifbaren Bus
# ("Failed to connect to user scope bus ... Operation not permitted") — update
# hielt den nachweislich laufenden User-Dienst daraufhin fuer inaktiv. Die
# Skripte setzten XDG_RUNTIME_DIR bisher nur, wenn es LEER war; ein geerbter
# falscher Wert blieb stehen. Hier wird bei fehlgeschlagener Probe hart auf
# /run/user/<uid> korrigiert und ein evtl. verwaistes DBUS_SESSION_BUS_ADDRESS
# entfernt. Rueckgabe 0 = User-Bus erreichbar, 1 = auch danach nicht.
term_user_bus_repair(){
  systemctl --user show-environment >/dev/null 2>&1 && return 0
  local rd="/run/user/$(id -u)"
  [ -d "$rd" ] || return 1
  export XDG_RUNTIME_DIR="$rd"
  unset DBUS_SESSION_BUS_ADDRESS
  systemctl --user show-environment >/dev/null 2>&1
}

term_resolve_service(){
  SERVICE="" ; SERVICE_SOURCE="" ; REPO_BACKEND_PID=""
  # (a) explizit
  if [ -n "${TERM_SERVICE:-}" ]; then
    SERVICE="$TERM_SERVICE" ; SERVICE_SOURCE="TERM_SERVICE" ; return 0
  fi
  # (b) install-lokale deploy.env
  if [ -f "$DEPLOY_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; . "$DEPLOY_ENV"; set +a
    if [ -n "${TERM_SERVICE:-}" ]; then
      SERVICE="$TERM_SERVICE" ; SERVICE_SOURCE="deploy.env" ; return 0
    fi
  fi
  # (c) Auto-Erkennung ueber den laufenden server.js-Prozess dieses Repos
  REPO_BACKEND_PID="$(term_detect_repo_backend_pid || true)"
  if [ -n "$REPO_BACKEND_PID" ]; then
    local u
    u="$(term_unit_from_pid "$REPO_BACKEND_PID" || true)"
    if [ -n "$u" ]; then
      SERVICE="$u" ; SERVICE_SOURCE="auto"
      [ -z "${TERM_USER_UNIT:-}" ] && TERM_USER_UNIT="$(term_user_unit_from_pid "$REPO_BACKEND_PID")"
      return 0
    fi
    SERVICE_SOURCE="auto:proc-no-unit" ; return 2   # Prozess da, aber keine Unit
  fi
  SERVICE_SOURCE="none" ; return 1                  # kein Backend-Prozess gefunden
}
