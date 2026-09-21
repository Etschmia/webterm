# Optionale IP-/VPN-Netze: gemeinsamer Dialog fuer Installation und Nachruestung.
# Die Liste ist unabhaengig von Basic Auth, Forward-Auth oder externem Schutz.

ip_allowlist_node(){
  # Pfad zum node-Binary fuer die Adresspruefung -> stdout (1 = keins gefunden).
  # Reihenfolge wie in install.sh: die projekt-lokale vendor/node-Installation
  # hat Vorrang, weil auf Maschinen ohne globales node (bun-Nachbarprojekte)
  # genau dort das einzige echte node liegt.
  local node_bin="" candidate
  if declare -F find_cmd >/dev/null; then node_bin="$(find_cmd node || true)"; fi
  if [ -z "$node_bin" ]; then
    for candidate in "${DEPLOY_DIR:-.}/../vendor/node/bin/node" "$(command -v node || true)" "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
      if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
    done
  fi
  [ -n "$node_bin" ] || return 1
  printf '%s' "$node_bin"
}

normalize_ip_allowlist(){
  # Prueft und normalisiert die Eingabe. Rueckgabe:
  #   0 = ok (normalisierte Liste -> stdout)
  #   2 = ungueltige Adresse/CIDR
  #   3 = kein node gefunden (Pruefung nicht moeglich)
  [[ "$1" =~ ^[[:space:],]*$ ]] && return 0
  local node_bin
  node_bin="$(ip_allowlist_node)" || return 3
  "$node_bin" --input-type=module -e '
    import { isIP } from "node:net";
    const entries = process.argv[1].trim().split(/[\s,]+/).filter(Boolean);
    for (const entry of entries) {
      const [address, prefix, extra] = entry.split("/");
      const version = isIP(address);
      if (!version || extra !== undefined || address.includes("%") ||
          (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
        console.error("Ungueltige IP-Adresse oder CIDR: " + entry); process.exit(2);
      }
    }
    process.stdout.write([...new Set(entries)].join(" "));
  ' "$1"
}

ip_allowlist_no_node_hint(){
  # Ohne node kann nichts validiert werden — und ungeprueft darf nichts in einen
  # Caddy-Matcher wandern. Statt endlos weiterzufragen: Weg zum Nachruesten zeigen.
  IP_ALLOWLIST_SKIPPED=1
  CADDY_ALLOWED_IPS=""
  warn "Kein node gefunden — die optionale IP-/VPN-Beschraenkung wird uebersprungen."
  note "Die Adressen werden mit node geprueft (node:net); ungeprueft landet hier nichts"
  note "in einer Caddy-Regel. Auf Maschinen ohne globales node (z. B. bun-Projekte)"
  note "gehoert das offizielle Tarball nach <projekt>/vendor/node/ — install.sh bietet"
  note "das in Schritt 2 an. Danach nachruestbar mit:  deploy/setup-auth --ip-only"
}

prompt_ip_allowlist(){
  # Ergebnis in CADDY_ALLOWED_IPS (leer = keine Beschraenkung). Rueckgabe immer 0,
  # damit Aufrufer mit 'set -e' weiterlaufen; ob uebersprungen wurde, steht in
  # IP_ALLOWLIST_SKIPPED.
  local raw status
  IP_ALLOWLIST_SKIPPED=0
  if ! ip_allowlist_node >/dev/null 2>&1; then
    ip_allowlist_no_node_hint
    return 0
  fi
  note "Optional: Zugriff auf feste IP-Adressen oder VPN-Netze begrenzen (IPv4/IPv6/CIDR)."
  note "Leer lassen bedeutet keine zusaetzliche Netzbeschraenkung; 2FA ist ebenfalls freiwillig."
  note "Beispiele: 203.0.113.7, 10.8.0.0/24, fd00:1234::/64 — eigene Netze einsetzen."
  note "Es zaehlt die Quell-IP, die Caddy sieht. VPN mit NAT/weitere Proxys dabei beachten."
  note "Spaeter aendern: deploy/setup-auth --ip-only (ohne Neuinstallation)."
  while true; do
    raw="$(ask_value 'Erlaubte IP-Adressen/VPN-Netze (komma-separiert; leer = keine)' '')"
    CADDY_ALLOWED_IPS="$(normalize_ip_allowlist "$raw")" && return 0
    status=$?
    if [ "$status" -eq 3 ]; then ip_allowlist_no_node_hint; return 0; fi
    warn "Bitte gueltige IPv4-/IPv6-Adressen oder CIDR-Netze eingeben."
  done
}

ip_allowlist_block(){
  local ind="${1:-    }" prefix="${2:-}"
  [ -n "${CADDY_ALLOWED_IPS:-}" ] || return 0
  printf '%s@term_denied {\n' "$ind"
  if [ -n "$prefix" ]; then printf '%s    path %s %s/*\n' "$ind" "$prefix" "$prefix"; fi
  printf '%s    not remote_ip %s\n' "$ind" "$CADDY_ALLOWED_IPS"
  printf '%s}\n' "$ind"
  printf '%srespond @term_denied "Forbidden" 403\n' "$ind"
}

prompt_network_change(){
  local selection
  note "IP-/VPN-Beschraenkung ist optional und unabhaengig von der Anmeldung."
  note "  1) Bestehende Netzregeln unveraendert lassen (Default)"
  note "  2) Erlaubte IP-Adressen/VPN-Netze setzen oder ersetzen"
  note "  3) Zusaetzliche Netzbeschraenkung entfernen"
  while true; do
    selection="$(ask_value 'Netzregeln (1/2/3)' '1')"
    case "$selection" in
      1) NETWORK_ACTION=keep; return ;;
      2) prompt_ip_allowlist
         if [ -n "$CADDY_ALLOWED_IPS" ]; then NETWORK_ACTION=set
         else
           NETWORK_ACTION=keep
           if [ "${IP_ALLOWLIST_SKIPPED:-0}" -eq 1 ]; then
             note "Keine Pruefung moeglich: vorhandene Regeln bleiben unveraendert."
           else
             note "Keine Liste eingegeben: vorhandene Regeln bleiben unveraendert."
           fi
         fi
         return ;;
      3) NETWORK_ACTION=remove; return ;;
      *) warn "Bitte 1, 2 oder 3 waehlen." ;;
    esac
  done
}
