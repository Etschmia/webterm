# Sicherheit

## Wichtig vor dem Betrieb

term-web gibt Zugriff auf eine **vollständige Shell** unter dem Service-User. Das
Backend (`server.js`) authentifiziert bewusst **nicht selbst**. Der Schutz besteht aus:

1. Bindung an `127.0.0.1` (der Server verweigert andere Adressen),
2. einem Reverse Proxy (Caddy) mit TLS **und** Zugangsschutz (Basic Auth, 2FA/SSO per
   `forward_auth` oder ein externer Schutz wie VPN/Zero-Trust/mTLS),
3. optional einer IP-/VPN-Allowlist.

**Ohne Zugangsschutz davor niemals aus dem Internet erreichbar machen.** Eine offene
Instanz ist eine offene Shell. Details: README, Abschnitt „Zugangsschutz".

## Schwachstellen melden

Bitte **nicht** als öffentliches Issue, sondern über GitHub:
*Security → Report a vulnerability* in diesem Repository (Private Vulnerability Reporting).
Alternativ per E-Mail an den Maintainer (siehe Git-Commits). Ich antworte in der Regel
innerhalb weniger Tage.

Hilfreich sind: betroffene Version/Commit, Schritte zur Reproduktion und die Auswirkung.

## Stand

Der letzte dokumentierte Review steht in `docs/` (`CODE-REVIEW-*.md`).
