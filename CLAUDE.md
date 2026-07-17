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
