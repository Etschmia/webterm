# Code-Review und Umsetzung – 06.09.2026

Status: **Codekorrekturen umgesetzt und geprüft; Zugangsschutz optional nachrüstbar, externer Backup-Nachweis offen.**
Diese Datei ersetzt die [Review vom 22.08.2026](CODE-REVIEW-SICHERHEIT-2026-08-22.md).
Die alte Review bleibt als historischer Befund erhalten. Hier stehen der überprüfte
Ist-Zustand, die Umsetzung und verbleibende Voraussetzungen. Installationsspezifische
Adressen, Zugangsdaten und lokale Sicherungen werden nicht versioniert.

## Befunde vom 06.09.2026

| ID | Priorität | Befund | Stand |
|---|---|---|---|
| R01 | Hoch | Überlange WebSocket-Nachricht beendet den gesamten Node-Prozess | Behoben, isoliert reproduziert und nachgetestet |
| R02 | Hoch | `lib/` fehlt bei Restart-Erkennung und Backend-Versionskennung | Behoben, laufender Testserver erkennt Änderungen und Löschungen |
| R03 | Hoch | Restart-Snapshot verliert Codex/Grok bzw. mehrere Panes | Durch Prüfung aller tmux-Prozessgruppen ersetzt; gefährdeter Restart wird abgewiesen |
| R04 | Mittel | CI prüft mit einem `bash -n` nur das erste Skript | Behoben, jedes Skript wird einzeln geprüft |
| R05 | Mittel | Telegram wiederholt fehlgeschlagene Aufträge ohne Verlauf | Behoben, keine automatische Wiederholung mehr |
| R06 | Mittel | README, CLAUDE und Deploy-Skill beschreiben veraltetes Verhalten | Aktualisiert; AGENTS verweist weiterhin auf CLAUDE |
| R07 | Mittel | Schutzheader fehlen auf öffentlichen Proxy-401-Antworten | Generator korrigiert und Terminal-Site aktualisiert; live geprüft |
| R08 | Betrieb | Zusätzliche Zugangsschranken je Umgebung wählbar machen | Optional: Installer und Nachrüst-Dialog, Anleitung oben in der Hilfe |
| R09 | Betrieb | Berechtigungen und Backup-Nachweis unvollständig | Kritische lokale Rechte geprüft/gehärtet; externer Backup-/Restore-Nachweis offen |
| R10 | Wartbarkeit | Großes Backend, wenig Tests für echte Fehlerpfade | Mehrere Module ausgegliedert und Integrationstests ergänzt; weitere Aufteilung bei fachlichen Änderungen |

## R01 – WebSocket-Fehler

**Vorher:** Die Überschreitung von `maxPayload` erzeugte ein unbehandeltes `error`-Event
an der WebSocket-Verbindung. Eine bereits zugelassene Verbindung konnte den Backend-Prozess
mit Exit 1 beenden. Der Befund wurde in einem isolierten Server reproduziert.

**Umsetzung:** `server.js` behandelt `error`, entsorgt das PTY und beendet nur die betroffene
Verbindung. `close` und `error` erhöhen zusätzlich den Start-Zähler, sodass ein ausstehender
asynchroner Session-Check danach kein neues PTY mehr startet.

**Nachweis:** `test/server-integration.test.js` sendet eine Nachricht über 1 MiB und ungültiges
UTF-8 an ein isoliertes Backend. Danach bleibt `/healthz` erreichbar und der Prozess aktiv.
Die Testinstanz verwendet ein temporäres Home und keine produktive Telegram-Konfiguration.

## R02 – Vollständige Backend-Version

**Vorher:** `server.js` und Paketmanifeste bestimmten den Restart und den Commit-Stamp;
Änderungen an importierten Runtime-Modulen konnten unbemerkt inaktiv bleiben.

**Umsetzung:** `deploy/backend-paths.json` ist die gemeinsame Quelle für Server, Build und
Update. Sie enthält `server.js`, die Paketmanifeste und rekursiv `lib/`.
`lib/backend-version.js` bildet einen SHA-256-basierten Inhalts-Hash über Dateinamen und
Inhalte. Hinzugefügte und entfernte Dateien sowie Änderungen mit alter mtime zählen mit.
Reine Änderungen an README, Frontend oder sonstigen Dokumenten verändern den Hash nicht.

Der Server hält seinen Start-Hash fest, liefert ihn als `/api/version` und schreibt
`.backend-running.json` (PID und Hash, Modus 0600, gitignored). `deploy/update` vergleicht
gegen die tatsächliche Dienst-PID. Ein fehlender oder nicht zu diesem Prozess gehörender
Stamp verlangt einen Restart. Das deckt auch das erste Update einer älteren Installation ab.
Der Frontend-Autoreload behält seinen separaten HEAD-Stamp.

**Nachweis:** Unit-Test für Hinzufügen, Ändern, Löschen und reine Doku-Änderung. Zusätzlich
ändert und entfernt ein Integrationstest ein Modul neben einem laufenden Testserver:
Der Server meldet weiter seinen ursprünglichen Hash, der Deploy-Vergleich erkennt die
Abweichung. Eine fremde PID wird als ungültiger Stamp erkannt.

## R03 – Restart ohne verlorene Sitzungen

**Vorher:** Der Snapshot erkannte nur Claude, Kimi und Muse, reduzierte mehrere Panes auf
einen Eintrag und wählte teilweise lediglich die neueste Unterhaltung im Verzeichnis.
Eine zuverlässige Wiederherstellung war damit nicht gewährleistet.

**Umsetzung:** Das Snapshot/Resume-Verfahren wurde entfernt. `deploy/term-restart` prüft
vor dem Start der entkoppelten Unit und unmittelbar vor dem eigentlichen Restart die
ControlGroup der Ziel-Unit. `deploy/restart-check.mjs` und `lib/restart-safety.js` prüfen
alle bekannten tmux-Server, die aktuellen Panes und deren Prozessnachfahren, einschließlich
Servern auf zusätzlichen Sockets. Toolnamen spielen keine Rolle.

Gefährdete Prozesse oder nicht eindeutig lesbare relevante Prozessgruppen führen zu
**Exit 5**, bevor systemd die Unit beendet. `--check` prüft ohne Restart. Damit schützt
der Helfer Codex, Grok, Claude, Kimi, Muse, Shells und mehrere Panes gleichermaßen.

**Betrieb:** tmux muss für unterbrechungsfreie Restarts außerhalb der Webterminal-Unit
laufen. Bei Exit 5 Arbeit sichern und Sitzungen kontrolliert beenden bzw. unabhängigen
Betrieb einrichten. Es findet keine automatische Prozessmigration und keine geratene
Wiederaufnahme statt. Auch ein direkter Restart per SSH kann fremde Sitzungen gefährden.

**Nachweis:** Tests für gefährdete Server, mehrere Panes, migrierte Nachfahren, ähnliche
cgroup-Namen und fehlende Prozessdaten. Die Prüfung der laufenden Installation bestätigt,
dass deren tmux-Sitzungen außerhalb der Zielgruppe liegen.

## R04 – Shell-Prüfung in CI

**Vorher:** `bash -n install.sh deploy/*.sh ...` prüft nur `install.sh`; die übrigen Namen
werden als Argumente übergeben. Ein absichtlich fehlerhaftes zweites Testskript bestätigte
den blinden Fleck.

**Umsetzung:** Die CI führt `bash -n` in einer Schleife für jedes Skript aus, einschließlich
`deploy/setup-auth` und der neuen Security-Header-Library. Jeder Fehler bricht den Schritt
ab. Für die Proxy-Integrationstests installiert die CI zusätzlich Caddy.

**Nachweis:** Sämtliche Shell-Skripte wurden einzeln lokal geprüft.

## R05 – Telegram-Aufträge höchstens einmal automatisch starten

**Vorher:** Jeder Fehler einer fortgesetzten Claude-Anfrage löschte die Session-Zuordnung
und startete denselben Auftrag erneut ohne Verlauf. Auch nach einem Timeout konnten schon
Teilaktionen ausgeführt worden sein.

**Umsetzung:** `lib/telegram-session.js` startet pro Auftrag genau einen Lauf. Fehler
lassen die bisherige Session-Zuordnung unverändert. Der Bot meldet den Fehler und erklärt,
dass nichts automatisch wiederholt wurde. Selbst bei einer fehlenden Sitzung entscheidet
der Benutzer mit `/new` über einen frischen Verlauf. Das ist bewusst konservativer als eine
heuristische Fehlertext-Erkennung für automatische Resume-Fallbacks.

**Nachweis:** Tests für Timeout, API-Fehler, fehlende Session und erfolgreiche erste Anfrage.
Es werden keine Testnachrichten an Telegram gesendet.

## R06 – Dokumentationsabgleich

README und CLAUDE beschreiben nun das Browser-Overlay für Markieren/Kopieren, das tatsächliche
WS-Protokoll, den cgroup-basierten Restart-Schutz, die Dienstnamenermittlung, System-/User-Units,
die neue Runtime-Versionskennung und das Telegram-Fehlerverhalten.

Der Deploy-Skill beschreibt nur noch Git/SSH und authentifiziertes gh/HTTPS für den gepinnten
mdlite-Commit. Der veraltete Tarball-Fallback wurde aus der Anleitung entfernt. Review-Dateien
werden durch eine ausdrückliche Ausnahme in `.gitignore` versioniert; Betriebsnotizen bleiben
ignoriert. Die Review vom 22.08. ist deutlich als veraltet gekennzeichnet und verlinkt hierher.

## R07 – Caddy-Header auf Fehlerantworten

**Ursache:** `-Server` im selben `header`-Block verzögert alle Header-Operationen. Liefert
`basic_auth` einen Fehler, fehlen die verzögerten Schutzheader auf der 401-Antwort.
Das Verhalten wurde mit einem isolierten Caddy-Prozess verglichen.

**Umsetzung:** Die gemeinsame Funktion in `deploy/lib-caddy-security.sh` setzt HSTS, CSP,
MIME-, Frame-, Referrer-, Permissions- und Cross-Origin-Schutz unmittelbar. `header -Server`
steht separat. Beide Installer-Varianten verwenden diese Funktion. Zusätzliche CSP-Sandbox-
Regeln des Backends bleiben als weitere Policy erhalten.

Die bestehende Terminal-Site wurde nach gesicherter Rückfallkopie angepasst. Die vollständige
Caddy-Konfiguration wurde validiert; ein Vergleich der adaptierten Konfigurationen bestätigte,
dass nur die Terminal-Route verändert wurde. Anschließend wurde Caddy neu geladen.

**Nachweis:** Tests für 200, 401, 403, erhaltene Auth-Challenge und die zusätzliche Sandbox.
Die öffentliche, nicht authentifizierte Anfrage liefert nun 401 mit HSTS, CSP und `nosniff`.

Quellen: [Caddy header](https://caddyserver.com/docs/caddyfile/directives/header) und
[Caddy handle_errors](https://caddyserver.com/docs/caddyfile/directives/handle_errors).

## R08 – Freiwilliger Zugangsschutz für unterschiedliche Umgebungen

**Präzisierung des Projektinhabers:** Zusätzliche 2FA oder IP-/VPN-Netzbeschränkungen sind
keine Voraussetzung für jede Installation. Das Projekt wird von vielen Nutzern in
unterschiedlichen Umgebungen betrieben. Eine zentrale Vorgabe von IP-Adressen oder ein
zwangsweise eingerichteter Auth-Dienst wäre deshalb falsch.

Der Installer bietet Basic Auth, Forward-Auth an einen externen Dienst oder anderweitigen
Schutz an. Der gemeinsame IP-/VPN-Dialog erklärt IPv4, IPv6 und CIDR; eine leere Liste
bedeutet keine zusätzliche Netzbeschränkung. Die Liste wird syntaktisch validiert.
`deploy/setup-auth` erlaubt Anmeldung und Netzregeln unabhängig voneinander beizubehalten
oder zu ändern. `--ip-only` erlaubt das Setzen, Ersetzen oder Entfernen von Netzregeln ohne
Änderung der Anmeldung. Es werden ausschließlich lokale Snippets erzeugt; Einspielen und
Prüfen bleiben bei der jeweiligen Administration.

Zusätzliche Tests prüfen gültige und ungültige IP-/CIDR-Listen, unveränderte Defaults,
IP-only-Nachrüstung ohne Auth-Änderung, das Entfernen und Caddy-Unterpfadfilter.

Die Nachrüst-Anleitung steht ganz oben im „Hilfe & Tipps“-Dialog und in README/CLAUDE.
Ein vorhandener IP-Filter wird beim bloßen Ändern der Anmeldung nicht stillschweigend
entfernt. Bei Unterpfaden wird der Netzfilter auf den Terminalpfad begrenzt. Es zählt die
bei Caddy sichtbare Quell-IP; Proxys werden nicht automatisch als vertrauenswürdig behandelt.

In der geprüften Installation bleiben TLS, Basic Auth, Loopback-Bindung und CrowdSec aktiv.
Eine zusätzliche Netzsperre oder 2FA wird nur auf konkrete Betreiberentscheidung eingerichtet;
dieser optionale Ausbau blockiert weder das Projekt noch den Abschluss der Codekorrekturen.

## R09 – Berechtigungen und Sicherungen

Geprüft: `.env`, GitHub-CLI-Zugangsdaten, privater SSH-Schlüssel und Telegram-Konfiguration
besitzen 0600; SSH- und Telegram-Verzeichnisse 0700. Die produktive Terminal-Caddy-Datei
wurde von 0664 auf 0640 mit Eigentümer root und Gruppe caddy gehärtet.
Lokale Rückfallkopien der Proxyänderung liegen in einem ignorierten Verzeichnis mit 0700;
die Konfigurationskopien besitzen 0600. Zugangsdaten gelangen nicht in diese Review.

**Offen:** Ein vollständiger externer Backup-/Restore-Nachweis für Terminal-Konfiguration,
Agent-Verläufe und sonstige Benutzerdaten liegt nicht vor. Die geprüften Cron-/Timer-Einträge
belegen Datenbank-Dumps, aber kein vollständiges Terminal-Backup. Eine lokale Rückfallkopie
ist kein Schutz gegen den Verlust des Hosts. Für die Einrichtung einer externen Sicherung
werden Ziel, Umfang, Aufbewahrung und vorhandener Zugang benötigt. Dieser Punkt wird daher
nicht als erledigt ausgegeben.

## Abgleich mit der Review vom 22.08.2026

| Alter Befund | Nachprüfung am 06.09. |
|---|---|
| Loopback/Proxy als Sicherheitsgrenze | Bindung eingeschränkt; zusätzliche Zugangskontrolle siehe R08 |
| CSRF auf HTTP-Mutationen | Weiterhin behoben; ohne Token 403, Integrationstest ergänzt |
| Symlink-Ausbruch aus FS_ROOT | Weiterhin behoben; externer Upload-Symlink wird mit 409 abgewiesen, Ziel unverändert |
| Upload-/WS-Ressourcengrenzen | Grenzen bestehen; unbehandelter WS-Fehler durch R01 geschlossen |
| Verwundbare Frontend-Abhängigkeiten | Gepinnte korrigierte Versionen vorhanden; aktueller vollständiger Audit ohne Befund |
| Ungefangene URL-/Request-Fehler | Fehlerhafte Kodierung liefert 400; HTTP- und WS-Fehlerpfade getestet |
| Unsicherer Tarball-Fallback | Weiterhin entfernt; Anleitung durch R06 korrigiert |
| Fehlende automatisierte Prüfungen | Tests/CI vorhanden und erweitert; falscher Shell-Aufruf durch R04 korrigiert |
| Große Backend-Datei | Version, Restart-Prüfung und Telegram-Sessionlogik modularisiert; weitere Aufteilung bei fachlichen Änderungen |
| Verwaister Code/Dokumentationsdrift | Damalige Bereinigung besteht; neue Abweichungen durch R06 korrigiert |
| mdlite zuerst veröffentlichen | Beide damals genannten Commits sind im überprüften aktuellen Remote-main enthalten |
| Betriebsaufgaben: Auth, Logging, Header, Backups | Konkreter Stand und offene Voraussetzungen unter R07–R09 |

## Verifikation

- 24 Node-Tests einschließlich echter isolierter HTTP-/WebSocket- und Caddy-Prozesse.
- JavaScript-Syntaxprüfung sowie einzelne `bash -n`-Aufrufe für alle Shell-Skripte.
- Vollständiges `npm audit`: 0 bekannte Schwachstellen.
- Produktionsbuild; keine Produktions-Sourcemap.
- Live-Prüfung von Loopback-Bindung, Proxy-401 samt Schutzheadern und Restart-Sicherheit.
- Nach Aktivierung: Backend-Hash in `/api/version`, Prozess-Stamp und Build stimmen überein;
  die vorhandenen tmux-Sitzungen bleiben mit denselben Pane-PIDs erhalten.
- Zweiter Lauf von `deploy/update --no-pull`: kein weiterer Restart, da der Inhalts-Hash
  unverändert ist. Die Sidebar liefert weiterhin GPT-6-astra / high.

Die Tests wurden lokal ausgeführt. Ein zukünftiger GitHub-Actions-Lauf ist dadurch nicht
behauptet. Der externe Backup-Nachweis aus R09 bleibt bis zu den erforderlichen Betreiberangaben
ausdrücklich offen. Zusätzliche Zugangsschranken aus R08 sind eine freiwillige Betriebsentscheidung.
