# Sicherheitsheader SOFORT setzen. '-Server' muss getrennt bleiben: im selben
# Block wuerde Caddy alle Header bis zur Antwort verzoegern und bei einem
# basic_auth-Fehler (401) verwerfen. Upstream darf CSP z. B. auf sandbox verengen.
term_security_headers(){
  local ind="${1:-    }"
  while IFS= read -r line; do printf '%s%s\n' "$ind" "$line"; done <<'HEADERS'
header {
    X-Content-Type-Options nosniff
    X-Frame-Options SAMEORIGIN
    Referrer-Policy strict-origin-when-cross-origin
    Strict-Transport-Security "max-age=31536000"
    Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    Cross-Origin-Resource-Policy same-origin
}
header -Server
HEADERS
}
