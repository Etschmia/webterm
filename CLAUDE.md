# term-web — Web-Terminal

Node-Webterminal (`server.js`, Default-Port 7681) hinter einem Reverse Proxy (Caddy).
Bedient als systemd-Unit sowohl eine Standard-Shell als auch das Attachen an benannte
tmux-Sessions (`/api/sessions`).

Instanz-spezifische Werte (Service-Name, Port, Domain, Service-User) stehen **nicht** hier,
sondern in der lokalen `.env` bzw. `deploy/deploy.env` — beide sind gitignored. Lege
Betriebsnotizen zu einer konkreten Installation in eine untrackte Datei unter `docs/`
(ebenfalls gitignored), nicht in diese Datei.

## ⚠️ Service-Neustart: NIEMALS `systemctl restart <unit>` direkt

Die Unit läuft mit `KillMode=control-group`. Das Webterminal hostet **alle** tmux-Sessions
(inkl. jeder darin laufenden Claude-Instanz, auch fremder) im **selben cgroup**. Ein direkter
`systemctl restart` reißt das komplette cgroup ab und killt dadurch sämtliche laufenden
Sessions — du killst dich u. U. **selbst** mitten im Deploy. (Genau so sind schon zwei
fremde Claude-Sessions verloren gegangen.)

**Stattdessen immer:**

```bash
deploy/term-restart
```

Das Skript snapshottet die aktiven Agent-Panes (Erkennung über `comm=claude`/`kimi` im
Prozess-Subtree, robust gegen den `claude-auto-retry`-Wrapper), startet den Service aus einer
**entkoppelten** transienten systemd-Unit neu (eigenes cgroup unter `system.slice`,
`KillMode=none` → überlebt den Abriss) und setzt danach jede Session wieder auf — claude per
`claude --resume <neueste-session-id>`, kimi per `kimi --continue` (findet die neueste Session
im cwd selbst). Voraussetzung: passwortloses `sudo` und `systemd-run`.

Der Service-Name defaultet auf `term-server`; abweichende Installationen setzen ihn per
`TERM_SERVICE=<unit>` bzw. dauerhaft in `deploy/deploy.env`:

```bash
TERM_SERVICE=<unit> deploy/term-restart
```

⚠️ Laufen mehrere Instanzen auf derselben Maschine, ist der Service-Name die kritische
Stelle: `install.sh` schlägt `term-server` als Default vor und würde eine fremde Unit per
`sudo cp` überschreiben und auf dieses Verzeichnis umbiegen — inklusive Abriss aller dort
laufenden tmux-/Claude-Sessions. Vor `install.sh` immer prüfen, welche Units schon existieren.

Wenn du den Restart von **außerhalb** des Webterminals fährst (echte SSH-Sitzung, nicht im
Service-cgroup), ist ein direktes `systemctl restart` unkritisch — aber `deploy/term-restart`
schadet auch dort nicht und stellt die Sessions ebenso wieder her.

### Stand-Update einspielen: `deploy/update`, nicht `install.sh`

Für „neuen Stand ziehen und aktiv machen" gibt es **`deploy/update`** — **nicht `install.sh`**
(das ist Installer/Konfigurator und startet einen *laufenden* Dienst **nicht** neu; nach
`git pull && install.sh` liefe also weiter der alte `server.js`).

Alle Details — Restart-Heuristik aus dem Ist-Zustand, mdlite-Transport-Fallback,
Servicenamen-Ermittlung, User-Bus-Fallback (Exit 3/4), Version-Skew, Standard-Session-Wrapper,
Self-Update-Icon — stehen im Skill `deploy-update` (`.claude/skills/deploy-update/SKILL.md`);
er wird bei Deploy-/Update-Fragen geladen.

## Öffentlicher Origin: `PUBLIC_ORIGIN` setzen

`server.js` prüft beim WebSocket-Upgrade den `Origin`-Header (gegen Cross-Site-WS-Hijacking).
Erlaubt sind ab Werk nur die lokalen Origins (`HOST:PORT`, `localhost`, `127.0.0.1`). Läuft
die Instanz hinter einer Domain, **muss** deren Origin in der `.env` stehen, sonst schlägt
der Upgrade fehl und das Terminal bleibt leer:

```
PUBLIC_ORIGIN=https://terminal.example.com
```

Mehrere Origins kommagetrennt. Es gibt bewusst keinen Domain-Default im Code.

## Bugtracker: GitHub Issues (kein lokaler Speicher)

Das Käfer-Icon in der Sidebar (`/api/bugs` in `server.js`) hängt an den **GitHub-Issues des
Projekt-Repos** — bewusst **kein** lokaler Speicher. So melden **alle** Installationen in
**dieselbe** Liste; jeder sieht die Bugs der anderen. Mapping: Anlegen → Issue erstellen;
Erledigt-Häkchen → Issue schließen/öffnen; „Löschen" → **schließen** (die API kann Issues nur
mit Admin-Recht hart löschen, ein normaler Collaborator nicht — deshalb kein Hard-Delete im UI).

- **Repo**: automatisch aus `git remote get-url origin` abgeleitet; überschreibbar per
  `BUGS_GITHUB_REPO=owner/repo`.
- **Auth pro Installation über `gh`**: jede Installation muss **einmalig** `gh auth login` mit
  Zugriff aufs Repo machen; der Issue-Autor ist dann die meldende Person. Alternativ nimmt gh
  `GH_TOKEN`/`GITHUB_TOKEN` aus der Umgebung. Das gh-Binary wird robust aufgelöst
  (`GH_BIN` → `~/.local/bin/gh` → `/usr/local/bin` → `/usr/bin` → PATH), weil die systemd-Unit
  `~/.local/bin` evtl. nicht im PATH hat.
- **Ohne Zugang „Nur GitHub"**: `/api/bugs` liefert **503** mit handlungsleitender Meldung
  (nicht angemeldet → „`gh auth login` …"; kein Zugriff → „als Collaborator hinzufügen"), und
  das Panel zeigt statt der Liste einen Einrichtungs-Hinweis — **nie** ein stiller lokaler
  Fallback.
- Jeder Issue-Text bekommt einen Herkunfts-Stempel `_via webterm · <host> · <user>_` (nach dem
  Trenner `\n\n---\n`, da es keinen Login in der App gibt); das Frontend blendet ihn in der
  Kompaktliste aus, GitHub zeigt ihn voll.

## Sicherheit: `server.js` authentifiziert nicht selbst

Dahinter liegt eine **volle Shell** unter dem Service-User. Der Schutz liegt vollständig beim
Reverse Proxy (TLS + Basic Auth, sinnvollerweise plus IP-Allowlist) und der Bindung an
`127.0.0.1`. Niemals einen dieser Pfade ohne diese Schranken exponieren, und die Bindung nie
auf `0.0.0.0` ändern.

## Runtime: node, nicht bun

**bun scheidet als Runtime aus**: node-pty lädt zwar, aber die PTY beendet sich sofort und
liefert keine Daten (bun-Lücke bei `net.Socket({fd})`) — ein Webterminal ohne PTY-I/O ist tot.

Auf Maschinen ohne globales node/npm (etwa weil dort bun-Projekte liegen, die ein globales
`~/.npmrc` mitlesen würden) gehört eine projekt-lokale node-Installation nach `vendor/node/`
(gitignored, offizielles Tarball). Sie ist bewusst **nie im PATH** — ein global auffindbares
`node` wäre eine Falle: `install.sh` fände es per `find_cmd node` und baute eine systemd-Unit,
die `server.js` unter bun startet, womit node-pty tot wäre. Aufruf dann immer so (der
PATH-Präfix gilt nur für diesen einen Prozess, npm-Config/Cache bleiben im Projekt statt in `~`):

```bash
PATH="$PWD/vendor/node/bin:$PATH" \
NPM_CONFIG_USERCONFIG="$PWD/.npmrc" \
NPM_CONFIG_CACHE="$PWD/.npm-cache" \
npm install          # bzw. npm run build
```

Der PATH-Präfix ist beim Bauen zwingend: `node-pty` ist nativ, und sein `binding.gyp` ruft
intern `node` auf.

## claude-auto-retry: seit Claude Code 2.1.234 nur noch Ergänzung

Claude Code wartet ein erreichtes Usage-Limit **selbst** aus — Schalter
`autoContinueAtUsageLimit` („Continue automatically at usage limit", `/config`, **ab Werk
an**). Das war der Hauptzweck von `claude-auto-retry`; das Paket ist damit **optional**
(`install.sh` fragt es weiterhin, aber mit Default **nein**).

Was nativ **nicht** abgedeckt ist und wofür das Paket weiterhin taugt:

- **Overload-Retry** bei anhaltendem `API Error: 529` / `overloaded_error` im Pane.
- **Safeguard-Retry** bei „safeguards flagged this message"-Fehlalarmen.
- **Überleben eines Prozess-Neustarts.** Das native Warten läuft *im* claude-Prozess
  („relaunched/exited during the wait, so the task will not resume"). `deploy/term-restart`
  reißt genau diesen Prozess ab. Der externe Monitor wird per `reconcile`-Timer neu armiert
  und schickt nach dem Reset trotzdem „continue".

⚠️ **Beide gleichzeitig können sich ins Gehege kommen.** Der Monitor scrapet das Pane und
weiß nichts vom nativen Warten; erkennt er dessen Zeile („Continuing automatically when your
limit resets · esc to cancel") nicht als „working", tippt er nach *seiner* geparsten
Resetzeit sein `retryMessage` in eine Session, die ohnehin schon weiterläuft — doppelter Turn
oder Text im wartenden Prompt. Wenn das auftritt: in `~/.claude-auto-retry/config.json` den
Usage-Limit-Pfad abschalten und nur Overload/Safeguard laufen lassen (oder umgekehrt in
`/config` das native Fortsetzen aus). Nie beide auf denselben Fall ansetzen.

Das Paket hat keinen eigenen Update-Mechanismus; `deploy/claude-auto-retry-update.sh` (Cron)
holt das nach. Achtung, hier steckte ein stiller Fehler: `npm` ist selbst ein node-Skript mit
`#!/usr/bin/env node` — ohne `node` im (dürftigen) Cron-PATH scheitert `npm root -g` still,
das Paket gilt als „nicht installiert" und der Check läuft wochenlang als No-op. Das Skript
stellt dem PATH deshalb das Verzeichnis des gefundenen `node` voran.

## claude-auto-retry unter bun

Ist `claude-auto-retry` per `bun add -g` statt per npm installiert, ruft das Paket an drei
Stellen hart `node` auf, was ohne globales node scheitert.
`deploy/claude-auto-retry-update.sh` erkennt beide Installationsarten automatisch (es richtet
sich danach, **wo** das Paket liegt, nicht danach, welcher Paketmanager existiert).

Die nötigen Anpassungen liegen alle **außerhalb** dieses Repos:

| Stelle | Problem | Lösung |
|--------|---------|--------|
| `bun add -g` verlinkt auf `bin/cli.js` (Shebang `#!/usr/bin/env node`) | CLI nicht startbar | Wrapper `~/.local/bin/claude-auto-retry` ruft bun auf (liegt im PATH **vor** `~/.bun/bin`) |
| `src/wrapper.sh` schreibt `node <launcher>` in die `~/.bashrc` | `claude` wäre tot | Block in `~/.bashrc` auf bun geändert |
| `launcher.js` schreibt sich als `node <launcher>` in die tmux-Session | Session stirbt sofort | `node`-Shim in `~/.claude-auto-retry/nodeshim/`, den die `claude()`-Funktion dem PATH voranstellt; tmux erbt ihn (launcher forwardet die Umgebung) |

Der Shim gehört bewusst **nicht** in den normalen PATH (siehe `install.sh`-Falle oben).

Paket-Updates (auch per Cron) überschreiben nur `launcher.js`/`cli.js`, nicht die `~/.bashrc`
und nicht den Shim — die Anpassungen überleben also. Nur ein erneutes
`claude-auto-retry install` schreibt den `~/.bashrc`-Block mit der `node`-Vorlage zurück;
danach die beiden Zeilen dort wieder herstellen (der Block ist entsprechend kommentiert).
