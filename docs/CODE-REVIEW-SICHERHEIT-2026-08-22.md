# Code-Review Sicherheit und Wartbarkeit – 22.08.2026

## Geltungsbereich

Geprüft wurden `server.js`, das Browser-Frontend unter `src/`, Build und
Abhängigkeiten, `install.sh`, die Skripte unter `deploy/` sowie die direkte
Bibliotheksabhängigkeit `mdlite` im Nachbar-Repository.

Das Webterminal vermittelt absichtlich eine vollständige Shell unter dem
Service-User. Deshalb sind Authentisierung, Origin-Grenzen und eine ausschließliche
Loopback-Bindung keine gewöhnlichen Komfortfunktionen, sondern die zentrale
Sicherheitsgrenze des gesamten Systems.

## Befunde und Umsetzungsstatus

### P0: Vollständige Shell hing allein an Proxy und Konvention

**Befund:** Das Backend authentifiziert nicht selbst. `HOST` ließ sich trotz der
Dokumentation auf eine öffentliche Adresse setzen. Der Installer erzeugte nur
Basic Auth, aber keine zweite Zugriffsschranke.

**Behoben im Code:**

- Der Server verweigert Nicht-Loopback-Adressen. Ein Betrieb auf einer anderen
  Adresse benötigt nun den auffälligen Override `TERM_ALLOW_NON_LOOPBACK=1`.
- Der Caddy-Generator bietet eine optionale IPv4-/IPv6-/CIDR-Allowlist an.
- Server und Caddy setzen CSP, Frame-, MIME-, Referrer-, Permissions- und
  Cross-Origin-Schutzheader; Caddy setzt zusätzlich HSTS.
- Caddy-Login, Hostname, URL und Allowlist werden validiert.
- Lokale Installer-Artefakte werden mit restriktiver Umask erzeugt.
- Das Caddy-Passwort läuft beim Hashen nur noch über stdin und erscheint nicht
  mehr als Kommandozeilenargument in der Prozessliste.

**Verbleibend:** Starke vorgeschaltete Authentisierung, Netzwerkzugriff und
Rate-Limits sind Betriebsaufgaben; siehe den deutlich markierten Abschnitt unten.

### P1: CSRF auf zustandsändernden HTTP-Endpunkten

**Befund:** Die WebSocket-Verbindung prüfte den Origin, HTTP-POST/PATCH/DELETE
dagegen nicht. Damit konnten Browser mit vorhandener HTTP-Basic-Anmeldung zu
fremd initiierten Session-, Datei-, Update- oder GitHub-Aktionen gebracht werden.

**Behoben:** Der Server erzeugt pro Prozess einen kryptographischen CSRF-Token.
Alle unsicheren HTTP-Methoden verlangen den Token im Custom Header; bei
Browserrequests muss zusätzlich der Origin erlaubt sein. Das Frontend liest den
Token same-origin, hängt ihn zentral an alle Mutationen und erneuert ihn nach
einem Backend-Neustart automatisch.

### P1: Ausbruch aus `FS_ROOT` über Symlinks

**Befund:** Die alte Prüfung normalisierte nur den sichtbaren Pfad. Nachfolgende
Dateisystemaufrufe folgten Symlinks und konnten außerhalb von `FS_ROOT` lesen oder
schreiben.

**Behoben:** Bestehende Ziele werden per `realpath` erneut gegen die reale Root
geprüft. Uploads arbeiten im bereits aufgelösten realen Elternverzeichnis,
schreiben mit `O_EXCL | O_NOFOLLOW` in eine zufällige temporäre Datei und ersetzen
das Ziel anschließend atomar. Externe Symlink-Ziele werden abgewiesen. Symlinks
werden in Dateilisten ausdrücklich markiert. Das Clip-Verzeichnis darf selbst
kein Symlink sein und erhält Modus `0700`, Clip-Dateien `0600`.

### P1: Ressourcenerschöpfung über Uploads und WebSockets

**Befund:** Normale Datei-Uploads waren unbegrenzt. WebSocket-Nachrichten,
Verbindungszahl und PTY-Dimensionen hatten keine anwendungsspezifischen Grenzen;
asynchrone `start`-Nachrichten konnten einander überholen.

**Behoben:**

- Datei-Uploads sind auf 100 MiB, Clipboard-Bilder weiter auf 25 MiB begrenzt;
  beide Grenzen werden vorab und während des Streams geprüft.
- WebSocket-Frames sind auf 1 MiB und Verbindungen auf 32 begrenzt.
- Terminalgrößen werden auf 2–500 Spalten und 2–200 Zeilen normalisiert.
- Überholte Session-Starts werden verworfen, PTY- und Message-Fehler abgefangen.
- HTTP-Header- und Request-Timeouts wurden explizit gesetzt.

### P1/P2: Verwundbare Frontend-Abhängigkeiten

**Befund:** `term` enthielt DOMPurify 3.4.12 über `mdlite` und esbuild 0.24.2.
`npm audit` meldete zwei moderate Advisories. DOMPurify schützt die Stellen, an
denen Dateiinhalte als gerendertes HTML in die Terminal-Origin gelangen.

**Behoben:**

- `mdlite` aktualisiert DOMPurify auf 3.4.14 und besitzt nun XSS-Regressionstests.
- `term` pinnt `mdlite` auf den unveränderlichen Commit
  `c82983dcc1e1be0153d039787774473fa1081714`.
- esbuild wurde auf 0.25.12 aktualisiert.
- Reine Frontend-/Build-Pakete stehen nun in `devDependencies`; die Runtime-
  Abhängigkeiten sind auf `node-pty` und `ws` reduziert.
- Der ungeprüfte Tarball-Fallback im Update-Skript wurde entfernt. Git/SSH und
  authentifiziertes `gh` beziehen beide exakt den gepinnten Commit.
- Produktionsbuilds veröffentlichen keine Sourcemap mehr.

### P2: Ungefangene Request- und PTY-Fehler

**Befund:** Fehlerhafte Prozentkodierung konnte aus `decodeURIComponent` werfen;
der asynchrone HTTP-Listener besaß keinen zentralen Fehlerabschluss. Vergleichbare
Fehlerpfade bestanden beim PTY-Start.

**Behoben:** Fehlerhafte URLs liefern 400. Der HTTP-Server fängt abgewiesene
Promises zentral ab, und WebSocket-/PTY-Nachrichten besitzen einen kontrollierten
Fehlerpfad. Statische Inhalte akzeptieren nur GET und HEAD.

### P2: Supply-Chain-Fallback unterlief das Lockfile

**Befund:** Falls Git und `gh` scheiterten, änderte `deploy/update` die Manifeste
temporär auf einen ungeprüften Tarball eines beweglichen Tags, installierte ihn
und stellte danach nur die Manifestdateien wieder her.

**Behoben:** Der Tarball-Fallback wurde entfernt. Ein Update scheitert nun sicher
und laut, wenn der gepinnte Commit weder per Git/SSH noch per authentifiziertem
`gh` erreichbar ist.

### P2: Fehlende automatisierte Prüfungen und große Backend-Datei

**Befund:** Es gab keine Tests, keinen Testbefehl und keine CI-Konfiguration.
`server.js` bündelt weiterhin HTTP, Dateisystem, Prozesszustand, GitHub, Updates
und PTY-Vermittlung in einer großen Datei.

**Weitgehend behoben:** Sicherheitsprimitiven wurden nach `lib/security.js`
ausgelagert und mit Node-Tests für Loopback-Bindung, Origins, CSRF,
Symlink-Grenzen und Terminaldimensionen versehen. `mdlite` besitzt Vitest-/jsdom-
Tests für Sanitizing und Frontmatter. Beide Repositories besitzen nun eine
GitHub-Actions-Pipeline für reproduzierbare Installation, Tests, Build und den
vollständigen Dependency-Audit; `term` prüft zusätzlich Shell-Syntax und das
Fehlen einer Produktions-Sourcemap.

**Weiterer Wartbarkeitsschritt:** Die übrigen Bereiche von `server.js` sollten
bei künftigen Funktionsänderungen schrittweise in klar abgegrenzte Module
(`fs-api`, `sessions`, `updates`, `bugs`, `pty`) überführt werden. Eine große
Umstrukturierung ohne funktionalen Anlass wurde in diesem Sicherheitsfix bewusst
nicht erzwungen.

### P3: Verwaister Code und Dokumentationsdrift

**Befund:** Die Konstante `SHELL` war unbenutzt. Architekturtexte beschrieben
nur Static/Sessions/PTY, obwohl das Backend inzwischen Datei-, Upload-, Update-
und GitHub-Schreibzugriffe besitzt.

**Behoben:** `SHELL` wurde entfernt. README und Betriebsdokumentation werden mit
den neuen Grenzen, Abhängigkeiten und Endpunkten aktualisiert. Generierte
Produktions-Sourcemaps werden nicht mehr ausgeliefert.

## Verifikation

Ausgeführt und erfolgreich:

- `node --check server.js` und `node --check src/app.js`
- `bash -n install.sh deploy/*.sh deploy/update deploy/term-restart`
- `npm test`, `npm run build` und vollständiges `npm audit` in `term`
- Prüfung, dass `public/app.bundle.js.map` nach dem Produktionsbuild fehlt
- `npm test`, `npm run build` und vollständiges `npm audit` in `mdlite`
- HTTP-Laufzeittest: Schutzheader vorhanden, CSRF-loser POST → 403,
  fehlerhafte Prozentkodierung → 400
- WebSocket-Laufzeittest: ohne Origin → 403, erlaubter Origin → Verbindung
- Bindetest: `HOST=0.0.0.0` ohne Override → Startabbruch
- Dateisystem-Laufzeittest: normaler atomarer Upload → 200/Modus `0600`,
  Upload auf externen Symlink → 409 und externes Ziel unverändert
- Caddy-Parseprüfung mit Caddy 2.11.3 für dedizierte Domain und Unterpfad,
  jeweils einschließlich IP-Allowlist und Security-Headern

Zugehörige Commits:

- `mdlite` `c82983d`: DOMPurify-Update und XSS-Regressionstests
- `mdlite` `e153bc2`: CI für Tests, Build und vollständigen Audit
- `term` `38bdfc8`: Sicherheits-, Robustheits-, Dependency- und CI-Fixes
- separater `term`-Dokumentationscommit: enthält dieses Review

## ⚠️ VERPFLICHTENDE HINWEISE FÜR PROJEKTINHABER UND ADMINISTRATOREN

Die folgenden Punkte können nicht zuverlässig im Anwendungscode erzwungen werden
und liegen in der Obliegenheit des Projektinhabers beziehungsweise des Admins der
jeweiligen Installation:

1. **`mdlite` zuerst veröffentlichen.** Die lokalen `mdlite`-Commits `c82983d`
   und `e153bc2` sind noch nicht gepusht. `term` pinnt den unveränderlichen Commit
   `c82983dcc1e1be0153d039787774473fa1081714`; vor einem `term`-Deploy muss daher
   zuerst der aktuelle `mdlite`-Branch auf dessen GitHub-Remote gepusht werden.
2. **`term` niemals direkt ins Internet stellen.** `TERM_ALLOW_NON_LOOPBACK=1`
   darf nur in einer bewusst abgesicherten Netzwerkarchitektur verwendet werden.
   Normalbetrieb ist `127.0.0.1` hinter einem TLS-Reverse-Proxy.
3. **Starke Zugangskontrolle betreiben.** Basic Auth allein ist für eine
   vollständige Shell nur die Mindestschranke. Empfohlen sind VPN/Zero-Trust-
   Zugang, mTLS oder ein Identity-Aware Proxy, zusätzlich möglichst eine
   IP-Allowlist. Zugangsdaten müssen einzigartig und lang sein.
4. **Rate-Limits und Angriffserkennung am Proxy/Netzrand konfigurieren.** Caddy
   Core besitzt kein allgemeines Login-Rate-Limit. Je nach Umgebung sind ein
   geeignetes Caddy-Modul, CrowdSec/fail2ban oder vorgelagerte Infrastruktur zu
   verwenden. Logs sind zu überwachen und datenschutzgerecht zu rotieren.
5. **TLS und Header prüfen.** Nach Installation oder Proxyänderungen müssen
   Zertifikat, HSTS, CSP, WebSocket-Upgrade und die Basic-/starke Authentisierung
   von außen geprüft werden. Bei Unterpfadbetrieb dürfen übergeordnete Caddy-
   Handler die Schutzheader oder Authentisierung nicht umgehen.
6. **`PUBLIC_ORIGIN` exakt pflegen.** Jede produktive Browser-Origin muss als
   vollständige `http(s)://host[:port]`-Origin ohne Pfad eingetragen sein. Keine
   Wildcards verwenden. Originless WebSockets nicht über
   `TERM_ALLOW_ORIGINLESS_WS=1` freischalten, außer ein kontrollierter Nicht-
   Browser-Client benötigt dies wirklich.
7. **Updates kontrolliert ausrollen.** Erst `mdlite`, dann `term` veröffentlichen;
   danach `deploy/update` benutzen und den Build-/Restart-Status kontrollieren.
   Niemals den in `CLAUDE.md` beschriebenen direkten systemd-Restart aus einer
   gehosteten Session verwenden.
8. **Regelmäßig Audits und Tests ausführen.** Mindestens `npm audit`, `npm test`
   und `npm run build` in beiden Repositories vor Releases ausführen. Eine CI mit
   genau diesen Gates sollte auf der tatsächlich verwendeten Git-Plattform
   eingerichtet werden.
9. **Backups und Berechtigungen prüfen.** Der Service-User hat definitionsgemäß
   weitreichenden Zugriff. `FS_ROOT`, Home, GitHub-Token, SSH-Schlüssel, `.env`,
   Caddy-Hashdateien und Backups müssen mit dem Least-Privilege-Prinzip gepflegt
   werden. Der Browser-Dateieditor ersetzt keine Versionierung oder Datensicherung.
