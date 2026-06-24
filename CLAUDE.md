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
