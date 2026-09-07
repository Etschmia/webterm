# term-web

Web-Terminal — Sidebar + Arbeitsfenster (xterm.js), abgesichert über Caddy
(TLS + Basic Auth, vorgeschalteter 2FA/SSO-Dienst oder externer Zugangsschutz). Portabel betreibbar unter eigener Domain oder Unterpfad
— der öffentliche Origin wird über `PUBLIC_ORIGIN` in der `.env` gesetzt.

## Schnellstart
**Voraussetzungen:** Node.js + npm sowie native Build-Tools für `node-pty`
(falls kein Prebuild zur Node-Version passt) — auf Debian/Ubuntu
`sudo apt-get install -y build-essential python3`, auf macOS `xcode-select --install`.
```bash
./install.sh
```
Der interaktive Installer prüft den Port, baut das Projekt (`npm install` + Build),
richtet optional `claude-auto-retry` (Default **nein**, siehe Hinweise; inkl. täglichem
Update-Check per Cron — `deploy/claude-auto-retry-update.sh`) sowie die tmux-Konfiguration (Maussteuerung +
git-Statuszeile, `deploy/git-status.sh` → `~/.tmux/`; ab tmux 3.3 zusätzlich
`allow-passthrough`, `extended-keys`, Truecolor und OSC-52-Clipboard —
`deploy/lib-tmux-conf.sh`, rollt auch `deploy/update` nach) ein und hilft beim
Erzeugen einer Caddy-Konfiguration (dedizierte Subdomain **oder** Unterpfad) — dabei
fragt er den **Zugangsschutz** ab: Basic Auth (bcrypt-Hash wird sofort erzeugt),
`forward_auth` an einen externen 2FA/SSO-Dienst oder gar keinen Block (Schutz extern).
Zusätzlich fragt er nach einer **freiwilligen** IP-/VPN-Allowlist (IPv4/IPv6/CIDR;
leer bedeutet keine zusätzliche Netzbeschränkung). 2FA und Netzregeln sind unabhängig
wählbar. Nachträglich änderbar per `deploy/setup-auth`; nur Netzregeln per
`deploy/setup-auth --ip-only`, die Anmeldung auch über das Zahnrad in der Sidebar. Domain/Unterpfad landen als `PUBLIC_ORIGIN` in `.env`,
woraus `server.js` die erlaubten WS-Origins ableitet.

## Funktionen
- **Standard** (Default): interaktive Login-Shell (`bash -l`) im Home, mit `.bashrc`/Farben.
- **tmux-Sessions**: alle laufenden Sessions werden in der Sidebar gelistet; Klick hängt das
  Arbeitsfenster live an die Session. **Markieren & Kopieren** öffnet ein Browser-Overlay
  mit Terminaltext und tmux-History aus `/api/capture`; Scrollen und Textauswahl erfolgen
  darin unabhängig von der laufenden Terminaleingabe.
- **Shift+Enter** fügt in Claude Code & Co. einen Zeilenumbruch ein statt abzusenden
  (das Frontend schickt `ESC CR` — dieselbe Sequenz, die `claude /terminal-setup`
  Desktop-Terminals beibringt). Außerdem werden **OSC 9**-Notifications (Statuszeile,
  bei Hintergrund-Tab Badge + Desktop-Benachrichtigung) und **OSC 52** (Schreiben in
  die Browser-Zwischenablage, z. B. tmux `set-clipboard`) unterstützt.
- **Sprechende Session-Labels**: Als Label wird – wenn vorhanden – der tmux `pane_title`
  angezeigt (führende Status-Glyphe wie `⠂`/`✳` entfernt), sonst der Session-Name. Hintergrund:
  Claude Code setzt den Terminal-/Pane-Titel automatisch; gibst du `claude` per `-n <name>` einen
  Namen, erscheint **dieser** im Label. So zeigt etwa eine `claude-retry-<pid>-<ts>`-Session (vom
  auto-retry-Wrapper) ihren sprechenden Titel statt des kryptischen Namens. Reine Shell-Sessions
  (Titel leer, = laufendes Kommando oder `user@host`-Prompt) bleiben beim Session-Namen. Intern
  (Attach, Copy-Mode via `-t`) wird immer der echte Session-Name verwendet; der Tooltip zeigt
  beides.
- **Modell & Effort je Agent-Session**: Läuft in einer Session `claude`, `codex`, `grok`,
  `kimi`, `muse` oder `opencode`, steht unter dem Namen eine Chip-Zeile mit dem **aktuell benutzten Modell**
  und dem **Effort** (z. B. `Opus 5` · `medium`). Gelesen wird das vorwiegend aus dem
  Sitzungszustand der Tools unter `$HOME`:
  `~/.claude/sessions/<pid>.json` → Transcript (Modell/Effort stehen dort **pro Turn**, ein
  `/model`-Wechsel ist also sofort sichtbar), bei codex die aktuelle Statuszeile mit passendem Pfad
  (alternativ der letzte `turn_context` eines vom Prozess eindeutig geöffneten Rollouts),
  bei grok `summary.json`, bei kimi das Wire-Log (Effort dort nur global aus der `config.toml`;
  der Tooltip sagt das dazu), bei opencode die jüngste Assistant-Nachricht (`modelID`) der
  passenden Sitzung unter `~/.local/share/opencode/storage/` (einen Effort kennt opencode
  nicht), bei muse die PID-Registry unter
  `~/.local/share/muse/runtime/` → `session.jsonl` (dort steht das Modell am **Anfang**, nicht
  am Ende). Claude und muse führen eine PID-Registry — grok, kimi und opencode werden über
  das Arbeitsverzeichnis des Prozesses zugeordnet; laufen zwei gleiche Tools im **selben**
  Verzeichnis, bleibt die Zeile bewusst leer statt womöglich falsch. Auch muse nutzt das Pane:
  Es protokolliert seinen Effort nirgends, er wird aus dessen Statuszeile gelesen
  — und nur übernommen, wenn die dort genannte Modell-ID zur protokollierten passt. Ergebnisse
  aus Sitzungsdateien werden nach mtime und Größe gecacht; Prozess- und Pane-Abfragen
  bleiben Bestandteil des Pollings.
- **Links-Bereich** (unten, abgegrenzt): erkennt URLs im Terminal-Inhalt und zeigt sie
  anklickbar (öffnen in neuem Tab). Nur sichtbar, wenn URLs vorhanden sind.
- **Zugangsschutz** (Zahnrad unten in der Sidebar): zeigt, womit die eigenen Anfragen gerade
  abgesichert sind (Basic Auth / 2FA-SSO / gar nicht — erkannt an den Headern der eigenen
  Anfrage, nicht aus der Caddy-Datei) und erzeugt den passenden Caddy-Block, um **2FA
  nachzurüsten**. Siehe „Zugangsschutz: Basic Auth, 2FA/SSO oder extern".

## Architektur
```
Browser → Caddy :443 (TLS + Zugangsschutz) → reverse_proxy 127.0.0.1:7681 → Node-Backend
                                                                            ├─ Static (xterm UI)
                                                                            ├─ WS /ws → node-pty
                                                                            └─ GET /api/sessions (tmux)
```
- `server.js` — HTTP-Static + WebSocket→PTY + REST `/api/sessions`. Bindet nur `127.0.0.1:7681`,
  prüft WS-Origins und schützt schreibende HTTP-Endpunkte per Origin + CSRF-Token.
  Weitere APIs vermitteln Datei-Explorer/Editor, Clipboard-Bilder, Self-Update und GitHub-Issues.
- `lib/` — Sicherheitsprüfungen, Telegram, Codex-/Opencode-Modellerkennung und Backend-Version.
- `src/` — Frontend (`index.html`, `app.js`, `styles.css`), Dark-Theme nach dem Depot-Design-System.
- `build.mjs` — esbuild-Bundle (`src/app.js` + xterm) → `public/`.
- `deploy/` — Deployment-Helfer (`term-restart`, Cron-Update-Check, `git-status.sh` für die
  tmux-Statuszeile). systemd-Unit und Caddy-Site erzeugt `./install.sh` hostspezifisch als
  gitignorte `*.local.*`-Datei.

### WS-Protokoll
- Client → Server: JSON-Text-Frames `{t:'start'|'input'|'resize', …}`.
- Server → Client: Binär-Frames = rohe PTY-Ausgabe; JSON-Text = Control (`ready`/`exit`/`error`).

## Entwicklung
```bash
npm install
npm run build         # -> public/
npm start             # node server.js  (HOST=127.0.0.1 PORT=7681)
# oder: node build.mjs --watch   (Auto-Rebuild)
```

## Deployment
- **Service**: am einfachsten über `./install.sh` — es erzeugt die Unit mit den Pfaden
  dieses Hosts als `deploy/<service>.local.service` (gitignort, Default-Name `term-server`)
  und installiert sie auf Wunsch gleich selbst. Beim Lauf fragt es, **wo** die Unit landen
  soll: als **System-Unit** (`/etc/systemd/system`, Installation und Restart brauchen sudo)
  oder als **User-Unit** (`~/.config/systemd/user`, komplett ohne sudo — Details unten).
  - Manuell als System-Unit: `sudo cp deploy/<service>.local.service
    /etc/systemd/system/<service>.service`, dann `sudo systemctl daemon-reload &&
    sudo systemctl enable --now <service>`.
  - Manuell als User-Unit: `cp deploy/<service>.local.service
    ~/.config/systemd/user/<service>.service`, dann `systemctl --user daemon-reload &&
    systemctl --user enable --now <service>` (Lingering nicht vergessen, s. u.).
  - **Servicename** ist nicht mehr hart `term-server`. `deploy/update` und
    `deploy/term-restart` ermitteln ihn (via `deploy/lib-service.sh`) in dieser Reihenfolge:
    explizites `TERM_SERVICE=<name>` → `deploy/deploy.env` (gitignored, von `install.sh`
    angelegt) → Auto-Erkennung des laufenden `node <repo>/server.js` dieses Repos über
    `/proc/<pid>/cgroup` (System- **und** User-Unit). Auf Multi-Instanz-Maschinen trotzdem
    `TERM_SERVICE` bzw. `deploy.env` setzen — die Auto-Erkennung ist nur der Fallback.
- **Update einer bereits konfigurierten Installation — `deploy/update`** (nicht erneut
  `install.sh`): `git pull --ff-only` → Build → bei geänderter Backend-Version ein geprüfter
  Restart über `deploy/term-restart`. `--no-pull` überspringt den Pull.
  Die gemeinsame Dateiliste steht in `deploy/backend-paths.json`: `server.js`, Paketmanifeste
  und rekursiv `lib/`. Dateinamen und Inhalte fließen in einen Hash ein; neue oder gelöschte
  Module und Änderungen bei unveränderter mtime werden ebenfalls erkannt.
  Der laufende Server schreibt PID und Start-Hash nach `.backend-running.json` (0600,
  gitignored). Ohne gültigen Stamp ist einmalig ein Restart erforderlich. Reine Frontend-
  oder Doku-Änderungen benötigen keinen Backend-Restart. Ein nötiger Restart ohne passenden
  aktiven Dienst scheitert mit Exit 3, ein unerreichbarer User-Bus mit Exit 4 und gefährdete
  tmux-Sitzungen mit Exit 5. Fehlermeldungen beachten; ein erfolgreicher Build allein
  bestätigt noch keinen vollständig aktivierten Deploy.
- **Versionen sichtbar machen:** `public/version.json` und das Frontend-Bundle enthalten
  den Backend-Inhalts-Hash sowie den HEAD-Kurzhash für den Frontend-Autoreload. Der Server
  berechnet seinen Backend-Hash einmal beim Start und liefert ihn unter `/api/version`.
  Abweichungen zeigen „Backend veraltet“ an. Auch eine reine Änderung in `lib/` wird erfasst.
- **claude/codex/grok/kimi/muse/opencode in eigenen Sessions**: Die Standard-Sitzung ist selbst eine
  tmux-Session — direkt darin gestartete Tools bekämen keine eigene Session mehr.
  `deploy/standard-session-wrappers.sh` (von `install.sh` in die `~/.bashrc` eingehängt)
  legt beim Aufruf von `claude`/`codex`/`grok`/`kimi`/`muse`/`opencode` aus der Standard-Sitzung automatisch eine
  neue tmux-Session an (`<tool>-<verzeichnis>`) und wechselt dorthin; eine vorhandene
  `claude`-Funktion (claude-auto-retry) wird gesichert und weiter durchgereicht.
- **Ohne sudo (User ohne Root-Rechte)**: die oben genannte **systemd-User-Unit**
  (`~/.config/systemd/user/<service>.service`, `systemctl --user enable --now <service>`).
  Installation *und* spätere Restarts kommen dann komplett ohne sudo aus;
  `deploy/term-restart` erkennt die User-Unit automatisch (Override: `TERM_USER_UNIT=1/0`).
  - **Bei der ersten Installation zwingend: Lingering aktivieren** —
    `loginctl enable-linger <user>` (bzw. einmalig als Admin
    `sudo loginctl enable-linger <user>`, falls polkit das Self-Service nicht erlaubt).
    Ohne aktives Lingering beendet systemd die User-Units beim letzten Logout und startet
    sie **nicht** beim Booten — der Service ist dann kein Dauerdienst. `install.sh` versucht
    das automatisch; prüfen mit `loginctl show-user <user> | grep Linger` (soll `yes`
    zeigen). Betrifft nur die User-Unit; die System-Unit läuft ohne Lingering.
  - **Reihenfolge:** `install.sh` aktiviert Lingering **vor** der Unit-Installation und
    prüft danach, ob der User-Bus erreichbar ist. Grund: ohne Lingering existiert
    `/run/user/<uid>` nur, solange eine echte PAM-Sitzung des Nutzers läuft — in einer
    `su -`-Shell also nicht, und `systemctl --user` scheitert dann mit *„Failed to connect
    to user scope bus via local transport: No such file or directory"*. Ist der Bus auch
    danach nicht erreichbar, nennt der Installer die beiden Auswege: direkt als dieser
    Nutzer anmelden (`ssh <user>@<host>` bzw. `sudo machinectl shell <user>@`) und die drei
    Befehle nachholen — oder die System-Unit wählen.
  - Migration von einer bestehenden System-Unit: erst `sudo systemctl disable --now
    <service>` (einmalig, Admin), dann `install.sh` mit Option User-Unit — parallel geht
    nicht, beide würden denselben Port binden.
- **Neustart — `deploy/term-restart`**: Der Helfer prüft die tatsächliche Service-cgroup
  gegen tmux-Server, alle Panes und deren Nachfahren. Bei gefährdeten oder nicht sicher
  prüfbaren Sitzungen bricht er vor dem Restart mit Exit 5 ab. Das gilt für sämtliche Tools
  und normale Shells. `deploy/term-restart --check` prüft ohne Neustart.
  tmux außerhalb der Webterminal-Unit erhält Fenster, Panes und laufende Unterhaltungen.
  Das frühere unvollständige Snapshot/Resume-Verfahren wurde entfernt. Bei Exit 5 Arbeit
  sichern und betroffene Sitzungen kontrolliert beenden bzw. den unabhängigen tmux-Betrieb
  einrichten. Auch ein direkter Restart per SSH kann Sitzungen in der Zielgruppe beenden.
- **Caddy**: am einfachsten über `./install.sh` (erzeugt eine lokale, gitignorte
  `.caddy`-Datei mit dem gewählten Zugangsschutz). Manuell mit Basic Auth: Hash via
  `caddy hash-password` erzeugen, in einer `deploy/<domain>.caddy` als
  `basic_auth { <user> <hash> }` eintragen, nach `/etc/caddy/sites/` kopieren, dann
  `sudo systemctl reload caddy`. Für 2FA/SSO statt dessen `forward_auth` — siehe
  „Zugangsschutz: Basic Auth, 2FA/SSO oder extern".
  - **Basic-Auth-Direktive ist versionsabhängig**: Caddy **≥ 2.8** verwendet `basic_auth`,
    Caddy **< 2.8** noch `basicauth` (ohne Unterstrich) — es gibt keinen Namen, der auf beiden
    läuft. `./install.sh` erkennt die installierte Version (`caddy version`) und schreibt die
    passende Direktive automatisch; ist kein `caddy` auffindbar, nimmt es `basic_auth` (≥ 2.8)
    als Default. Bei manueller Einrichtung den Namen zur Ziel-Version passend wählen.
  - Hinweis: Die Log-Datei muss vor dem ersten Reload existieren —
    `sudo touch /var/log/caddy/term.access.log && sudo chown caddy:caddy /var/log/caddy/term.access.log`.

## Zugangsschutz: Basic Auth, 2FA/SSO oder extern

`server.js` authentifiziert **bewusst nicht selbst** — dahinter liegt eine volle Shell, der
Schutz gehört vor den Reverse-Proxy-Hop. Damit ist der Zugangsschutz genau **eine Stelle** in
der Caddy-Konfiguration, und das Projekt bleibt agnostisch gegenüber der Frage, welcher zweite
Faktor dort hängt. `install.sh` fragt in Schritt 5 danach; nachträglich ändert man ihn mit
`deploy/setup-auth` oder über das **Zahnrad „Zugangsschutz"** in der Sidebar.

Drei Betriebsarten:

| | Was passiert | Wofür |
|---|---|---|
| **`basic_auth`** | Login/Passwort (bcrypt-Hash) in der Caddy-Datei | schnell, aber ein Faktor |
| **`forward_auth`** | Caddy fragt vor **jeder** Anfrage einen externen Auth-Dienst; 2xx = durchlassen, 401/302 = Umleitung auf dessen Login-Portal | **2FA/SSO** |
| **kein Block** | Schutz liegt woanders | VPN/Tailscale, Zero-Trust-Proxy, mTLS-Client-Zertifikate |

**`forward_auth` ist eine native Caddy-Direktive** — kein Plugin, kein selbst gebautes
Caddy-Binary. Als Dienst kommt in Frage, was diese Schnittstelle bedient, z. B. **Authelia**
(TOTP, WebAuthn/Passkey, Duo), **oauth2-proxy** (delegiert an die Unternehmens-IdP — Entra ID,
Google Workspace, Keycloak; MFA-Policy und Offboarding bleiben dort), **tinyauth** oder
**Pocket ID**. Für dieses Repo sind das alles derselbe Block:

```caddyfile
term.example.com {
    forward_auth 127.0.0.1:9091 {
        uri /api/verify?rd=https://auth.example.com
        copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy 127.0.0.1:7681 { header_up X-Real-IP {remote_host} }
    # header/encode/log wie bisher
}
```

Zwei Punkte, die speziell für ein *Terminal* zählen:

- **WebSocket**: `/ws` läuft durch denselben Hop — der Upgrade ist ein normaler HTTP-Request
  mit demselben Cookie. Eine **bereits offene** Verbindung endet aber nicht, wenn die Session
  abläuft; erst der nächste Reload verlangt neu.
- **Session-Dauer großzügig setzen**: ein Terminal steht tagelang offen. Die Default-Stunde
  mancher Auth-Dienste heißt sonst „nach jedem Laptop-Zuklappen neu 2FA".

`PUBLIC_ORIGIN` und alles Übrige bleiben unverändert; am Terminal selbst ist für 2FA nichts
anzupassen. Das Portal gehört am besten auf eine eigene Subdomain **derselben** Domain
(`auth.example.com`), sonst greift das Session-Cookie nicht.

**Nachrüsten ohne Neuinstallation**: `deploy/setup-auth` fragt getrennt nach Änderungen
an der Anmeldung und an den optionalen Netzregeln. Standard ist jeweils **unverändert**.
`deploy/setup-auth --ip-only` lässt die Anmeldung unberührt und bietet Netzregeln behalten,
setzen/ersetzen oder entfernen an. Es zählen die Quelladressen, die Caddy sieht; bei
VPN-NAT oder vorgeschalteten Proxys müssen die tatsächlich sichtbaren Netze gewählt werden.
Eine zusätzliche IP-Beschränkung oder 2FA ist keine Pflicht für alle Installationen.
Die Anleitung steht auch ganz oben unter **? → Hilfe & Tipps**.

Das Skript sucht die
aktive Caddy-Datei, zeigt den erkannten Ist-Zustand und schreibt den neuen Block als
gitignorte Datei nach `deploy/<domain>.auth.local.caddy` — plus die Schritte zum Einspielen.
Die gemeinsamen Schutzheader stammen aus `deploy/lib-caddy-security.sh`.
Die Löschung des `Server`-Headers bleibt separat, damit CSP und HSTS auch auf
Authentisierungsfehlern gesetzt werden.

Weder das Skript noch das Panel fassen `/etc/caddy` selbst an oder laden Caddy neu: dort liegen
fremde Sites, und ein Webterminal, das seinen eigenen Türsteher umbauen darf, wäre genau die
Lücke, die der Türsteher schließen soll.

## Prüfungen und Review

`npm test` prüft Sicherheitsgrenzen, Backend-Versionen, Restart-Schutz, Telegram-Aufträge
und isolierte HTTP-/WebSocket-Server. Ist Caddy installiert, laufen zusätzlich echte
Proxy-Tests für 200/401/403 und die SVG-Sandbox. `npm audit` umfasst auch die gebündelten
Frontend-Abhängigkeiten. Die CI prüft jedes Shell-Skript einzeln.

Aktueller Befund- und Umsetzungsstand: [Code-Review vom 06.09.2026](docs/CODE-REVIEW-2026-09-06.md).
Die Review vom 22.08.2026 ist historisch. Instanzdetails und lokale Rückfallkopien gehören
weiterhin nicht ins Git-Repository.

## Telegram

Der optionale Sidebar-Bot vermittelt Nachrichten an lokales Claude Code. Fehlgeschlagene
Aufträge werden nicht automatisch erneut ausgeführt; auch nach einem Timeout bleibt der
bisherige Verlauf erhalten. Eine nicht mehr vorhandene Sitzung kann bewusst mit `/new`
verlassen werden. Konfiguration und Token liegen lokal unter `~/.term-telegram/`.

## Hinweise
- **Fenstergröße bei mehreren tmux-Clients**: tmux-Default ist `window-size latest` (neuester
  Client gewinnt). Stört das eine parallel laufende Session, global in `~/.tmux.conf` auf
  `set -g window-size largest` (bzw. `manual`) umstellen.
- **Sicherheit**: Voller Shell-Zugriff als der Service-User. Schutz = TLS + Zugangsschutz in
  Caddy (Basic Auth **oder** `forward_auth` mit 2FA/SSO, siehe oben) + localhost-Bindung. Der Server verweigert Nicht-Loopback-Bindungen, solange nicht ausdrücklich
  `TERM_ALLOW_NON_LOOPBACK=1` gesetzt ist. Der Installer bietet zusätzlich eine IP-Allowlist an;
  für öffentliche Erreichbarkeit wird darüber hinaus VPN/mTLS/Identity-Aware Proxy empfohlen.
  Credentials geheim halten. Schreibende Browser-Requests benötigen einen pro Prozess erzeugten
  CSRF-Token. Uploadlimits: Dateien 100 MiB, Clipboard-Bilder 25 MiB.
- **claude-auto-retry ist seit Claude Code 2.1.234 nur noch Ergänzung**: Usage-Limits wartet
  die CLI selbst aus („Continue automatically at usage limit", `/config`, ab Werk an) — das war
  der Hauptzweck des Pakets, deshalb fragt `install.sh` es jetzt mit Default **nein**. Was das
  Paket weiterhin abdeckt: Retry bei anhaltendem API-Overload (529), Retry bei
  Safeguard-Fehlalarmen und Wiederaufnahme, wenn der `claude`-Prozess die Wartezeit nicht
  überlebt (nativ gilt „relaunched/exited during the wait → task will not resume" — etwa bei ungeprüften Prozessabbrüchen). **Beides parallel auf denselben Fall anzusetzen ist keine
  gute Idee**: der Monitor scrapet das Pane und weiß nichts vom nativen Warten, im Zweifel
  landet nach dem Reset ein doppeltes „continue" in der Session. Dann entweder in
  `~/.claude-auto-retry/config.json` den Usage-Limit-Pfad abschalten oder in `/config` das
  native Fortsetzen.
- **claude-auto-retry-Update-Check**: Das Paket hat keinen eigenen Update-Mechanismus —
  `./install.sh` richtet dafür optional einen täglichen Cron ein
  (`deploy/claude-auto-retry-update.sh`, Log unter `~/.claude-auto-retry/logs/update-check.log`).
  Startet laufende `monitor.js`-Prozesse bei einem Versionswechsel automatisch neu, da deren
  ES-Module-Code sonst bis zum nächsten Prozessstart auf dem alten Stand bleibt. Das Skript
  stellt dem PATH das Verzeichnis des gefundenen `node` voran — `npm` ist selbst ein
  node-Skript, und ohne `node` im dürftigen Cron-PATH scheitert `npm root -g` still, womit der
  Check ergebnislos durchläuft, statt zu melden.
