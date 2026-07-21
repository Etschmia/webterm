# term — Web-Terminal (term.martuni.de)

Node-Webterminal (`server.js`, PORT 7681) hinter Caddy. Bedient unter `term-server.service`
sowohl eine Standard-Shell als auch das Attachen an benannte tmux-Sessions (`/api/sessions`).

## ⚠️ Service-Neustart: NIEMALS `systemctl restart term-server` direkt

`term-server.service` läuft mit `KillMode=control-group`. Das Webterminal hostet **alle**
tmux-Sessions (inkl. jeder darin laufenden Claude-Instanz, auch fremder) im **selben cgroup**.
Ein direkter `systemctl restart term-server` reißt das komplette cgroup ab und killt dadurch
sämtliche laufenden Sessions — du killst dich u. U. **selbst** mitten im Deploy.
(So geschehen am 24.06.2026: zwei fremde Claude-Sessions gingen verloren.)

**Stattdessen immer:**

```bash
deploy/term-restart
```

Das Skript snapshottet die aktiven Claude-Panes (Erkennung über `comm=claude` im
Prozess-Subtree, robust gegen den `claude-auto-retry`-Wrapper), startet den Service aus einer
**entkoppelten** transienten systemd-Unit neu (eigenes cgroup unter `system.slice`,
`KillMode=none` → überlebt den Abriss) und setzt danach jede Session per
`claude --resume <neueste-session-id>` automatisch wieder auf. Voraussetzung: passwortloses
`sudo` (vorhanden) und `systemd-run`.

Wenn du den Restart doch von außerhalb des Webterminals fährst (z. B. echte SSH-Sitzung,
nicht im `term-server`-cgroup), ist ein direktes `systemctl restart` unkritisch — aber
`deploy/term-restart` schadet auch dort nicht und stellt die Sessions ebenso wieder her.

### Stand-Update einspielen: `deploy/update`, nicht `install.sh`

Für „neuen Stand ziehen und aktiv machen" gibt es `deploy/update` (git pull → build → und
**nur bei Backend-Änderung** ein `deploy/term-restart`). **`install.sh` taugt dafür nicht**:
es ist Installer/Konfigurator und startet einen *laufenden* Dienst per `enable --now`
**nicht** neu — nach `git pull && install.sh` liefe also weiter der alte `server.js`
(nur das neu gebaute Frontend käme per Tab-Reload). Wichtige Eigenschaften von
`deploy/update`:

- **Baut immer**, entscheidet den Restart aber aus dem **Ist-Zustand** (Datei-mtime von
  `server.js`/`package*.json` vs. `ActiveEnterTimestamp` des Dienstes), **nicht** aus dem
  Pull-Diff. Das ist bewusst so: beim allerersten Lauf ging ein manuelles `git pull` voraus,
  das interne `git pull` meldet dann „up to date" — ein leerer Diff heißt hier **nicht**
  „nichts zu tun".
- Reine Frontend-Änderung ⇒ **kein** Restart (nur Tab-Reload) — schont fremde Sessions.
- `npm install` läuft nur bei echter Lockfile-Änderung (Hash-Stamp in
  `node_modules/.term-deps-stamp`; die mtime wird sonst wiederhergestellt, damit sie die
  Restart-Heuristik nicht verfälscht).
- **Servicename wird ermittelt, nicht mehr hart `term-server`** (`deploy/lib-service.sh`,
  von `update` **und** `term-restart` gesourct): explizit `TERM_SERVICE` → `deploy/deploy.env`
  (gitignored, von `install.sh` angelegt) → Auto-Erkennung des laufenden
  `node <repo>/server.js` dieses Repos über `/proc/<pid>/cgroup` (System-/User-Unit). Grund:
  eine Instanz hieß `ag-webterm`; mit hartem `term-server`-Default prüfte `update` den
  falschen Dienst, meldete „läuft nicht — kein Restart" und ließ das Backend-Update **stumm**
  liegen. Auf Multi-Instanz-Maschinen trotzdem `TERM_SERVICE`/`deploy.env` setzen.
- **Anhängiges Backend-Update ohne aktiven Dienst ⇒ lauter Fehlschlag (Exit 3)** mit
  `TERM_SERVICE=<name>`-Hinweis — nie mehr still nur das Frontend bauen.
- **User-Bus-Fallback** (`term_user_bus_repair` in `deploy/lib-service.sh`, von `update`
  und `term-restart` genutzt): Scheitert `systemctl --user` an einem unerreichbaren
  User-Bus („Failed to connect to user scope bus … Operation not permitted", Vorfall
  21.07.2026 auf `jeb-webterm`), wird erst die Umgebung repariert (XDG_RUNTIME_DIR hart
  auf `/run/user/<uid>`, verwaistes DBUS_SESSION_BUS_ADDRESS weg) und erneut geprobt.
  Bleibt der Bus weg, gilt eine User-Unit mit nachweislich laufendem `server.js`
  (Prozess-Evidenz, Startzeit aus `/proc/<pid>`) trotzdem als **aktiv** — statt des
  irreführenden „Dienst ist nicht aktiv" (Exit 3). Ist dann ein Restart fällig, ist der
  ohne Bus aber unmöglich (auch `systemd-run --user` braucht ihn) ⇒ **Exit 4** mit
  Hinweis auf echte Login-Sitzung bzw. `loginctl enable-linger`; `term-restart` bricht
  in dem Fall früh ab, bevor Snapshot/`systemd-run` ins Leere laufen.
- **Version-Skew**: `build.mjs` → Stamp ins Bundle (`__BUILD_STAMP__`) **und**
  `public/version.json`; `server.js` liest ihn beim Start, liefert `/api/version`; das
  Frontend warnt bei Versatz („Backend veraltet — Deploy unvollständig?"). Ein 404 auf
  `/api/fs/cwd` wird in `fxFollowCwd` einmalig per `console.warn` protokolliert.
- **Standard-Session-Wrapper rollt mit aus**: `update` trägt die Source-Zeile für
  `deploy/standard-session-wrappers.sh` in der `~/.bashrc` nach, falls sie fehlt (Instanzen
  mit altem `install.sh`-Stand), und lässt untätige bash-Panes die `~/.bashrc` per
  `send-keys` neu einlesen; belegte Panes (laufendes claude etc.) werden nur gemeldet —
  dort nach Ende `. ~/.bashrc`. Der Wrapper selbst ist reihenfolge-unabhängig: ein
  `PROMPT_COMMAND`-Hook sammelt später definierte Fremd-Funktionen (claude-auto-retry)
  vor dem ersten Prompt wieder ein.
- `--no-pull` überspringt den Pull.
- **Self-Update-Icon** (Sidebar, neben „?"): Backend prüft gedrosselt (TTL 5 min, Klick
  erzwingt) per `git fetch` + `rev-list --count HEAD..@{u}`, ob das Remote voraus ist
  (`/api/update/status`); ist es das, pulsiert das Icon mit Commit-Zähler, Klick startet
  nach Rückfrage `deploy/update` als Kindprozess (`/api/update/run`, Fortschritt über
  `/api/update/log`). Ein Backend-Restart mitten im Lauf kappt Kind + Log — das Frontend
  wertet „Backend weg und mit neuer Version zurück" als Erfolgsende, wartet auf
  `/healthz` und lädt die Seite neu.

## ⚠️ Diese Instanz (butlive) hat KEIN globales node/npm — `vendor/node` benutzen

Auf dieser Maschine ist bewusst **kein node/npm installiert**. Nebenan liegt `../but2-react`,
das unter **bun** läuft; ein globales node/npm bzw. ein `~/.npmrc` (das bun mitliest) hat hier
schon einmal Schaden angerichtet. Ein nacktes `npm install` schlägt daher fehl — das ist
Absicht, **nicht** ein Grund, node global oder per nvm nachzuinstallieren.

Stattdessen liegt eine projekt-lokale node-Installation in `vendor/node/` (gitignored,
offizielles Tarball, v26.5.0 wie bei der csc-Instanz). Sie ist **nie im PATH**. Immer so
aufrufen — der PATH-Präfix gilt nur für diesen einen Prozess, und npm-Config/Cache bleiben
im Projekt statt in `~`:

```bash
PATH="/home/butlive/webterm/vendor/node/bin:$PATH" \
NPM_CONFIG_USERCONFIG=/home/butlive/webterm/.npmrc \
NPM_CONFIG_CACHE=/home/butlive/webterm/.npm-cache \
npm install          # bzw. npm run build
```

Der PATH-Präfix ist beim Bauen zwingend: `node-pty` ist nativ, und sein `binding.gyp` ruft
intern `node` auf. **bun scheidet als Runtime aus**: node-pty lädt zwar, aber die PTY beendet
sich sofort und liefert keine Daten (bun-Lücke bei `net.Socket({fd})`) — ein Webterminal ohne
PTY-I/O ist tot.

## Zwei Instanzen auf dieser Maschine — Service-Namen nicht verwechseln

| Instanz | User    | Service            | Port | URL                                   |
|---------|---------|--------------------|------|---------------------------------------|
| butlive | butlive | `tbterm.service`   | 7682 | `https://login.but-konto.de/tbterm/`  |
| csc     | csc     | `term-server.service` | 7681 | `https://login.but-konto.de/cscterm/` |

⚠️ **`install.sh` schlägt als Service-Namen `term-server` vor — das ist csc's Unit.** Ein
Durchlauf mit dem Default würde sie per `sudo cp` überschreiben und auf dieses Verzeichnis
umbiegen (inkl. Abriss aller laufenden tmux-/Claude-Sessions von csc). Für diese Instanz
immer `tbterm` angeben. Auch `deploy/term-restart` defaultet auf `term-server` — hier also:

```bash
TERM_SERVICE=tbterm deploy/term-restart
```

Beide Terminals sind in Caddy (`/etc/caddy/sites/login.but-konto.de.caddy`) doppelt
abgesichert: IP-Filter auf `213.217.118.51` **plus** `basic_auth`. `server.js` hat **keine**
eigene Authentifizierung — dahinter liegt eine volle Shell (butlive hat sudo). Niemals einen
dieser Pfade ohne beide Schranken exponieren.

## claude-auto-retry unter bun (nur butlive)

Bei butlive ist das Paket per `bun add -g claude-auto-retry` installiert, bei csc/martuni
weiterhin per npm. `deploy/claude-auto-retry-update.sh` erkennt beides automatisch (es
richtet sich danach, **wo** das Paket liegt, nicht danach, welcher Paketmanager existiert)
und läuft für butlive täglich um 07:45 per Cron.

Das Paket ruft an drei Stellen hart `node` auf, was hier ohne globales node scheitert.
Deshalb gibt es drei Abweichungen — alle **außerhalb** dieses Repos:

| Stelle | Problem | Lösung |
|--------|---------|--------|
| `bun add -g` verlinkt auf `bin/cli.js` (Shebang `#!/usr/bin/env node`) | CLI nicht startbar | Wrapper `~/.local/bin/claude-auto-retry` ruft bun auf (liegt im PATH **vor** `~/.bun/bin`) |
| `src/wrapper.sh` schreibt `node <launcher>` in die `~/.bashrc` | `claude` wäre tot | Block in `~/.bashrc` auf bun geändert |
| `launcher.js:150` schreibt sich als `node <launcher>` in die tmux-Session | Session stirbt sofort | `node`-Shim in `~/.claude-auto-retry/nodeshim/`, den die `claude()`-Funktion dem PATH voranstellt; tmux erbt ihn (`launcher.js:157-164` forwardet die Umgebung) |

⚠️ Der Shim liegt bewusst **nicht** im normalen PATH. Ein global auffindbares `node` wäre
eine Falle: `install.sh` fände es per `find_cmd node` und baute eine systemd-Unit, die
`server.js` unter bun startet — womit node-pty tot wäre.

Paket-Updates (auch der Cron) überschreiben nur `launcher.js`/`cli.js`, nicht die `~/.bashrc`
und nicht den Shim — die Anpassungen überleben also. Nur ein erneutes
`claude-auto-retry install` schreibt den `~/.bashrc`-Block mit der `node`-Vorlage zurück;
danach die beiden Zeilen dort wieder herstellen (der Block ist entsprechend kommentiert).
