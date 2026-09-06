# Optionale IP-/VPN-Netze: gemeinsamer Dialog fuer Installation und Nachruestung.
# Die Liste ist unabhaengig von Basic Auth, Forward-Auth oder externem Schutz.
normalize_ip_allowlist(){
  [[ "$1" =~ ^[[:space:],]*$ ]] && return 0
  local node_bin="" candidate
  if declare -F find_cmd >/dev/null; then node_bin="$(find_cmd node || true)"; fi
  if [ -z "$node_bin" ]; then
    for candidate in "${DEPLOY_DIR:-.}/../vendor/node/bin/node" "$(command -v node || true)" "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node; do
      if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
    done
  fi
  [ -n "$node_bin" ] || { printf 'node fuer die IP-Pruefung nicht gefunden.\n' >&2; return 2; }
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

prompt_ip_allowlist(){
  local raw
  note "Optional: Zugriff auf feste IP-Adressen oder VPN-Netze begrenzen (IPv4/IPv6/CIDR)."
  note "Leer lassen bedeutet keine zusaetzliche Netzbeschraenkung; 2FA ist ebenfalls freiwillig."
  note "Beispiele: 203.0.113.7, 10.8.0.0/24, fd00:1234::/64 — eigene Netze einsetzen."
  note "Es zaehlt die Quell-IP, die Caddy sieht. VPN mit NAT/weitere Proxys dabei beachten."
  note "Spaeter aendern: deploy/setup-auth --ip-only (ohne Neuinstallation)."
  while true; do
    raw="$(ask_value 'Erlaubte IP-Adressen/VPN-Netze (komma-separiert; leer = keine)' '')"
    if CADDY_ALLOWED_IPS="$(normalize_ip_allowlist "$raw")"; then return 0; fi
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
         else NETWORK_ACTION=keep; note "Keine Liste eingegeben: vorhandene Regeln bleiben unveraendert."; fi
         return ;;
      3) NETWORK_ACTION=remove; return ;;
      *) warn "Bitte 1, 2 oder 3 waehlen." ;;
    esac
  done
}
