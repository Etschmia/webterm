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
richtet optional `claude-auto-retry` und tmux-Maussteuerung ein und hilft beim
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
- `deploy/` — systemd-Unit und Caddy-Site (Vorlagen für das Deployment).

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
- **Service**: `deploy/term-server.service` → `/etc/systemd/system/`,
  `sudo systemctl daemon-reload && sudo systemctl enable --now term-server`.
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
