# term-web

Web-Terminal — Sidebar + Arbeitsfenster (xterm.js), abgesichert über Caddy
(TLS + HTTP Basic Auth). Portabel betreibbar unter eigener Domain oder Unterpfad;
die Referenz-Instanz läuft unter **term.martuni.de**.

## Schnellstart
**Voraussetzungen:** Node.js + npm sowie native Build-Tools für `node-pty`
(falls kein Prebuild zur Node-Version passt) — auf Debian/Ubuntu
`sudo apt-get install -y build-essential python3`, auf macOS `xcode-select --install`.
```bash
./install.sh
```
Der interaktive Installer prüft den Port, baut das Projekt (`npm install` + Build),
richtet optional `claude-auto-retry` (inkl. täglichem Update-Check per Cron —
`deploy/claude-auto-retry-update.sh`) sowie die tmux-Konfiguration (Maussteuerung +
git-Statuszeile, `deploy/git-status.sh` → `~/.tmux/`) ein und hilft beim
Erzeugen einer Caddy-Konfiguration (dedizierte Subdomain **oder** Unterpfad) inkl.
bcrypt-Hash für Basic Auth. Domain/Unterpfad landen als `PUBLIC_ORIGIN` in `.env`,
woraus `server.js` die erlaubten WS-Origins ableitet.

## Funktionen
- **Standard** (Default): interaktive Login-Shell (`bash -l`) im Home, mit `.bashrc`/Farben.
- **tmux-Sessions**: alle laufenden Sessions werden in der Sidebar gelistet; Klick hängt das
  Arbeitsfenster live an die Session. Der aktive Session-Eintrag zeigt einen **Copy-Mode-Toggle**
  (tmux `copy-mode` an/aus).
- **Sprechende Session-Labels**: Als Label wird – wenn vorhanden – der tmux `pane_title`
  angezeigt (führende Status-Glyphe wie `⠂`/`✳` entfernt), sonst der Session-Name. Hintergrund:
  Claude Code setzt den Terminal-/Pane-Titel automatisch; gibst du `claude` per `-n <name>` einen
  Namen, erscheint **dieser** im Label. So zeigt etwa eine `claude-retry-<pid>-<ts>`-Session (vom
  auto-retry-Wrapper) ihren sprechenden Titel statt des kryptischen Namens. Reine Shell-Sessions
  (Titel leer, = laufendes Kommando oder `user@host`-Prompt) bleiben beim Session-Namen. Intern
  (Attach, Copy-Mode via `-t`) wird immer der echte Session-Name verwendet; der Tooltip zeigt
  beides.
- **Links-Bereich** (unten, abgegrenzt): erkennt URLs im Terminal-Inhalt und zeigt sie
  anklickbar (öffnen in neuem Tab). Nur sichtbar, wenn URLs vorhanden sind.

## Architektur
```
Browser → Caddy :443 (TLS + basic_auth) → reverse_proxy 127.0.0.1:7681 → Node-Backend
                                                                            ├─ Static (xterm UI)
                                                                            ├─ WS /ws → node-pty
                                                                            └─ GET /api/sessions (tmux)
```
- `server.js` — HTTP-Static + WebSocket→PTY + REST `/api/sessions`. Bindet nur `127.0.0.1:7681`,
  prüft den WS-`Origin`.
- `src/` — Frontend (`index.html`, `app.js`, `styles.css`), Dark-Theme nach dem Depot-Design-System.
- `build.mjs` — esbuild-Bundle (`src/app.js` + xterm) → `public/`.
- `deploy/` — Deployment-Helfer (`term-restart`, Cron-Update-Check, `git-status.sh` für die
  tmux-Statuszeile). systemd-Unit und Caddy-Site erzeugt `./install.sh` hostspezifisch als
  gitignorte `*.local.*`-Datei.

### WS-Protokoll
- Client → Server: JSON-Text-Frames `{t:'start'|'input'|'resize'|'copyMode', …}`.
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
  `install.sh`): `install.sh` ist Installer/Konfigurator (fragt `.env`, Service-Namen,
  Caddy … ab) und startet einen *laufenden* Dienst per `enable --now` **nicht** neu — ein
  reines `git pull && install.sh` würde also nur das Frontend neu bauen, Backend-Änderungen
  in `server.js` blieben inaktiv. `deploy/update` macht stattdessen `git pull --ff-only` →
  Build → und startet **nur dann** über `deploy/term-restart` neu (also sessions-schonend),
  wenn sich das Backend (`server.js`/`package*.json`) gegenüber dem *laufenden Prozess*
  geändert hat; reine Frontend-Änderungen brauchen nur einen **Tab-Reload**. Die
  Restart-Entscheidung fällt aus dem Ist-Zustand (Datei-mtime vs. `ActiveEnterTimestamp`),
  **nicht** aus dem Pull-Diff — so zieht auch der allererste Lauf (dem ein manuelles
  `git pull` vorausging) korrekt nach. `--no-pull` überspringt den Pull; der Servicename wird
  ermittelt (s. o.). Findet `deploy/update` ein anhängiges Backend-Update, aber **keinen**
  passenden aktiven Dienst, bricht es **laut mit Exit 3** ab (statt still nur das Frontend zu
  bauen) und nennt das nötige `TERM_SERVICE=<name>`.
- **Version-Skew sichtbar machen**: `build.mjs` brennt einen Build-Stamp (Commit-Kurzhash) ins
  Frontend-Bundle **und** nach `public/version.json`; `server.js` liest ihn einmal beim Start
  und liefert ihn unter `/api/version`. Das Frontend vergleicht beim Laden seinen eingebauten
  Stamp mit `/api/version` und warnt bei Versatz sichtbar („Backend veraltet — Deploy
  unvollständig?"). So fällt ein *neues Frontend gegen altes Backend* (Restart vergessen)
  sofort auf, statt dass Feature-Aufrufe stumm ins Leere laufen.
- **claude/codex/grok/kimi in eigenen Sessions**: Die Standard-Sitzung ist selbst eine
  tmux-Session — direkt darin gestartete Tools bekämen keine eigene Session mehr.
  `deploy/standard-session-wrappers.sh` (von `install.sh` in die `~/.bashrc` eingehängt)
  legt beim Aufruf von `claude`/`codex`/`grok`/`kimi` aus der Standard-Sitzung automatisch eine
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
  - Migration von einer bestehenden System-Unit: erst `sudo systemctl disable --now
    <service>` (einmalig, Admin), dann `install.sh` mit Option User-Unit — parallel geht
    nicht, beide würden denselben Port binden.
- **Neustart — IMMER `deploy/term-restart` statt `systemctl restart term-server`**:
  Das Webterminal hostet *alle* tmux-Sessions im cgroup von `term-server.service`. Ein
  direktes `systemctl restart` reißt wegen `KillMode=control-group` das ganze cgroup ab
  und killt damit jede laufende Claude-/Kimi-Sitzung (auch fremde) — genau das ist am
  24.06.2026 passiert. `deploy/term-restart` snapshottet die aktiven Agent-Panes, startet
  aus einer **entkoppelten** transienten systemd-Unit neu (überlebt den cgroup-Abriss) und
  setzt jede Sitzung danach automatisch wieder auf — claude per `claude --resume`,
  kimi per `kimi --continue`.
- **Caddy**: am einfachsten über `./install.sh` (erzeugt eine lokale, gitignorte
  `.caddy`-Datei mit bcrypt-Hash). Manuell: Hash via `caddy hash-password` erzeugen, in
  einer `deploy/<domain>.caddy` als `basic_auth { <user> <hash> }` eintragen, nach
  `/etc/caddy/sites/` kopieren, dann `sudo systemctl reload caddy`.
  - **Basic-Auth-Direktive ist versionsabhängig**: Caddy **≥ 2.8** verwendet `basic_auth`,
    Caddy **< 2.8** noch `basicauth` (ohne Unterstrich) — es gibt keinen Namen, der auf beiden
    läuft. `./install.sh` erkennt die installierte Version (`caddy version`) und schreibt die
    passende Direktive automatisch; ist kein `caddy` auffindbar, nimmt es `basic_auth` (≥ 2.8)
    als Default. Bei manueller Einrichtung den Namen zur Ziel-Version passend wählen.
  - Hinweis: Die Log-Datei muss vor dem ersten Reload existieren —
    `sudo touch /var/log/caddy/term.access.log && sudo chown caddy:caddy /var/log/caddy/term.access.log`.

## Hinweise
- **Fenstergröße bei mehreren tmux-Clients**: tmux-Default ist `window-size latest` (neuester
  Client gewinnt). Stört das eine parallel laufende Session, global in `~/.tmux.conf` auf
  `set -g window-size largest` (bzw. `manual`) umstellen.
- **Sicherheit**: Voller Shell-Zugriff als `librechat`. Schutz = TLS + Basic Auth (Caddy) +
  localhost-Bindung. Credentials geheim halten.
- **claude-auto-retry-Update-Check**: Das Paket hat keinen eigenen Update-Mechanismus —
  `./install.sh` richtet dafür optional einen täglichen Cron ein
  (`deploy/claude-auto-retry-update.sh`, Log unter `~/.claude-auto-retry/logs/update-check.log`).
  Startet laufende `monitor.js`-Prozesse bei einem Versionswechsel automatisch neu, da deren
  ES-Module-Code sonst bis zum nächsten Prozessstart auf dem alten Stand bleibt.
