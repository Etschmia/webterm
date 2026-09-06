# term-web — Web-Terminal

Node-Webterminal (`server.js`, Default-Port 7681) hinter einem Reverse Proxy (Caddy).
Bedient als systemd-Unit sowohl eine Standard-Shell als auch das Attachen an benannte
tmux-Sessions (`/api/sessions`).

Instanz-spezifische Werte (Service-Name, Port, Domain, Service-User) stehen **nicht** hier,
sondern in der lokalen `.env` bzw. `deploy/deploy.env` — beide sind gitignored. Lege
Betriebsnotizen zu einer konkreten Installation in eine untrackte Datei unter `docs/`
(gitignored), nicht in diese Datei. `docs/CODE-REVIEW-*.md` wird dagegen versioniert.

## ⚠️ Service-Neustart: NIEMALS `systemctl restart <unit>` direkt

Die Unit läuft mit `KillMode=control-group`. Ein Restart beendet alle Prozesse
**innerhalb ihrer tatsächlichen cgroup**. Ein tmux-Server und seine Panes können darin
liegen oder unabhängig davon betrieben werden. Auch ein Restart per SSH kann fremde
Sitzungen innerhalb der Zielgruppe beenden.

**Immer den geprüften Helfer verwenden:**

```bash
deploy/term-restart --check  # nur prüfen
deploy/term-restart          # prüfen und entkoppelt neu starten
```

Der Helfer prüft tmux-Server, sämtliche Panes und deren Prozessnachfahren gegen die
`ControlGroup` der Ziel-Unit. Das gilt unabhängig vom Tool-Namen, also auch für Codex,
Grok, Claude, Kimi, Muse und normale Shells. Gefährdete oder nicht eindeutig prüfbare
Sitzungen führen zu **Exit 5 vor dem Restart**. In der entkoppelten Phase erfolgt die
Prüfung erneut. Das frühere unvollständige Snapshot/Resume-Verfahren wurde entfernt:
Es konnte weder alle Panes noch die exakte Unterhaltung zuverlässig wiederherstellen.

Bei Exit 5 erst die Arbeit sichern und betroffene Sitzungen kontrolliert beenden bzw.
tmux außerhalb der Webterminal-Unit betreiben. Keine cgroup-Sperre umgehen und keine
laufenden Prozesse automatisch umhängen. Ein Betrieb außerhalb der Service-Gruppe
bewahrt laufende Unterhaltungen einschließlich aller Fenster und Panes beim Restart.

Servicename: `TERM_SERVICE=<unit>` → `deploy/deploy.env` → Erkennung des laufenden
Repo-Backends. Ohne eindeutige Ermittlung wird abgebrochen. System-Units benötigen
passwortloses `sudo` und `systemd-run`; User-Units benötigen einen erreichbaren User-Bus,
aber kein `sudo`. Fehlender User-Bus führt zu Exit 4.

Auf Multi-Instanz-Systemen vor `install.sh` vorhandene Units prüfen: Der Installer
verwendet weiterhin `term-server` als vorgeschlagenen Namen und kann eine gleichnamige
Unit überschreiben. Für Updates `deploy/update` verwenden.

### Stand-Update einspielen: `deploy/update`, nicht `install.sh`

Für „neuen Stand ziehen und aktiv machen" gibt es **`deploy/update`** — **nicht `install.sh`**
(das ist Installer/Konfigurator und startet einen *laufenden* Dienst **nicht** neu; nach
`git pull && install.sh` liefe also weiter der alte `server.js`).

Alle Details — Runtime-Inhaltsvergleich, mdlite-Transport über Git/SSH oder gh/HTTPS,
Servicenamen-Ermittlung, User-Bus-Fallback (Exit 3/4), Version-Skew, Standard-Session-Wrapper,
Self-Update-Icon — stehen im Skill `deploy-update` (`.claude/skills/deploy-update/SKILL.md`);
er wird bei Deploy-/Update-Fragen geladen.

`deploy/backend-paths.json` ist die gemeinsame Liste für Build, Server und Update:
`server.js`, Paketmanifeste und rekursiv `lib/`. `lib/backend-version.js` berechnet einen
Inhalts-Hash einschließlich Dateinamen; auch neue/gelöschte Module und Änderungen mit alter
mtime zählen. Der Server hält den Hash beim Start fest, liefert ihn als `/api/version`
und schreibt `.backend-running.json` mit PID und Hash (0600, gitignored).
`deploy/update` vergleicht gegen die tatsächliche Dienst-PID. Fehlender/ungültiger Stamp
führt einmalig zum sicheren Restart. Frontend- und reine Doku-Änderungen ändern diesen
Hash nicht. Bei neuen Runtime-Verzeichnissen das Manifest ergänzen.


## Öffentlicher Origin: `PUBLIC_ORIGIN` setzen

`server.js` prüft beim WebSocket-Upgrade den `Origin`-Header (gegen Cross-Site-WS-Hijacking).
Erlaubt sind ab Werk nur die lokalen Origins (`HOST:PORT`, `localhost`, `127.0.0.1`). Läuft
die Instanz hinter einer Domain, **muss** deren Origin in der `.env` stehen, sonst schlägt
der Upgrade fehl und das Terminal bleibt leer:

```
PUBLIC_ORIGIN=https://terminal.example.com
```

Mehrere Origins kommagetrennt. Es gibt bewusst keinen Domain-Default im Code.

## Zugangsschutz sitzt in Caddy — eine Stelle, drei Betriebsarten

`server.js` authentifiziert bewusst nicht selbst (s. u.). Der Zugangsschutz ist deshalb genau
**ein Block** in der Caddy-Site, und das Projekt bleibt agnostisch gegenüber der Frage, ob und
womit eine Installation 2FA macht. Betriebsarten: `basic_auth` (ein Faktor), `forward_auth` an
einen externen Auth-Dienst (**2FA/SSO** — Authelia, oauth2-proxy, tinyauth, Pocket ID …) oder
gar kein Block (Schutz extern per VPN/Zero-Trust/mTLS). `forward_auth` ist **Caddy-Bordmittel**,
kein Plugin — das war der Grund, es dem Plugin `caddy-security` (eigenes Caddy-Binary nötig)
vorzuziehen.

Für 2FA ist am Terminal **nichts** anzupassen: `PUBLIC_ORIGIN` bleibt, der WS-Upgrade läuft
durch denselben Hop.

Erzeugt werden die Blöcke an genau **einer** Stelle: `deploy/lib-caddy-auth.sh`. Drei
Konsumenten:

- `install.sh` (Schritt 5, Erstinstallation) — sourct die Lib, Dialog per `auth_prompt`.
- `deploy/setup-auth` — Nachrüsten einer laufenden Installation (derselbe Dialog, ohne Build
  und ohne `.env`-Änderung); `--print` gibt nur den Block aus.
- Panel „Zugangsschutz" (Zahnrad in der Sidebar, `/api/authguard/*`) — ruft für das Snippet
  `deploy/setup-auth --print` auf (execFile ohne Shell, Werte doppelt validiert).

Die Ausgabe-/Eingabe-Helfer (`note`, `ask_value`, …) liegen geteilt in `deploy/lib-ask.sh`;
`install.sh` sourct sie, statt sie selbst zu definieren.

⚠️ **Panel und Skript fassen `/etc/caddy` nicht an und laden Caddy nicht neu.** Das ist
Absicht: dort liegen fremde Sites, und ein Webterminal, das seinen eigenen Türsteher umbauen
darf, wäre genau die Lücke, die der Türsteher schließen soll. Diesen Riegel nicht
wegoptimieren — auch nicht „nur ein Reload-Knopf".

Der **Ist-Zustand** im Panel kommt nicht aus der Caddy-Datei (für den Service-User meist gar
nicht lesbar), sondern aus den Headern der laufenden Anfrage: `Authorization: Basic` →
Basic Auth, `Remote-User`/`X-Forwarded-User` (von `copy_headers`) → Forward-Auth, sonst
„ungeschützt?". Diese Header sind reine **Anzeige** — es hängt keine Autorisierung daran.

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

## Telegram-Bot: Brücke zu lokalem Claude Code (`lib/telegram.js`)

Die Sidebar-Zeile „Telegram" (`/api/telegram/*`) verbindet die Installation mit einem eigenen
Telegram-Bot: Nachrichten an den Bot laufen als `claude -p --output-format json` in
`~/.term-telegram/work`, Folge-Nachrichten per `--resume` (Session-ID aus der JSON-Antwort);
die Antwort geht zurück in den Chat. Verbindung per **Long-Polling** (getUpdates) im
Serverprozess — kein Webhook, keine öffentliche Erreichbarkeit nötig.

- **Konfiguration pro Installation** in `~/.term-telegram/config.json` (0600): Token,
  Bot-Identität, verknüpfter Chat, `enabled`, angefangener Setup-Schritt. Der
  Einrichtungs-Assistent im Frontend liest seinen Fortschritt von dort — Schließen und
  später weitermachen funktioniert deshalb browserübergreifend.
- **Genau ein Chat** ist verknüpft (wer beim Einrichten den `/start <linkCode>`-Deep-Link
  benutzt); alle anderen Absender werden abgewiesen. Kein `--dangerously-skip-permissions`.
- **Voraussetzung** ist ein lokal auffindbares `claude`-Binary (Auflösung wie beim gh-CLI:
  `CLAUDE_BIN` → `~/.local/bin` → übliche Pfade → PATH); fehlt es, ist die Zeile ausgegraut.
- Fehlgeschlagene Aufträge werden **nie automatisch wiederholt**, auch nicht bei Timeout
  oder fehlender Resume-Sitzung. Der Verlauf bleibt erhalten; `/new` startet auf ausdrücklichen
  Wunsch ein neues Gespräch.
- „Löschen" entfernt nur die hiesige Einrichtung — den Bot selbst löscht man bei
  @BotFather (`/deletebot`), das kann die Bot-API nicht.

## Sicherheit: `server.js` authentifiziert nicht selbst

Dahinter liegt eine **volle Shell** unter dem Service-User. Der Schutz liegt vollständig beim
Reverse Proxy (TLS + Basic Auth, sinnvollerweise plus IP-Allowlist) und der Bindung an
`127.0.0.1`. Niemals einen dieser Pfade ohne diese Schranken exponieren, und die Bindung nie
auf `0.0.0.0` ändern. Der Server verweigert Nicht-Loopback-Adressen inzwischen fail-closed;
`TERM_ALLOW_NON_LOOPBACK=1` ist ausschließlich ein ausdrücklicher Spezialfall-Override.
Schreibende HTTP-Endpunkte verlangen zusätzlich einen pro Prozess erzeugten CSRF-Token und bei
Browserrequests einen erlaubten Origin. Originlose WebSockets sind ab Werk verboten; der Override
`TERM_ALLOW_ORIGINLESS_WS=1` ist nur für kontrollierte Nicht-Browser-Clients gedacht.

WebSocket-Fehler (z. B. Payload > 1 MiB oder ungültiges UTF-8) schließen nur die jeweilige
Verbindung und ihr PTY. `close` und `error` verwerfen ausstehende Session-Starts.
Integrationstests starten isolierte Backends ohne produktive Telegram-Konfiguration.

Caddy-Header kommen aus `deploy/lib-caddy-security.sh`. `header -Server` bleibt ein
**eigener** Block: Im gemeinsamen Block verzögert die Löschoperation alle Header;
bei einem Auth-Fehler fehlen sie dann auf der 401-Antwort. Unmittelbar gesetzte CSP/HSTS
bleiben auch dort erhalten, zusätzliche CSP-Sandbox-Regeln des Backends bleiben wirksam.


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

## Modell/Effort der Agent-Sessions: Sitzungszustand und Statuszeile

Die Chip-Zeile der Sidebar liest Modell und Effort vorwiegend aus dem Sitzungszustand der
Tools: `~/.claude/sessions/<pid>.json` → `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
(dort je Assistant-Record `message.model` + `effort`), grok aus `summary.json`,
kimi aus dem Wire-Log (+ `[thinking].effort` der
`config.toml`), muse aus `~/.local/share/muse/runtime/muse/sessions/<id>.json`
(`process_generation_hint: "pid=…"`) → `…/muse/sessions/<Y>/<M>/<D>/<id>/session.jsonl`.

Codex liest die **letzte nichtleere Pane-Zeile**, sofern sie dem Format
`<modell> <effort> · <pfad>` entspricht und der vollständige Pfad zum Prozess-cwd passt.
Damit stimmen auch ein frischer Start und `/model` vor dem nächsten Turn. Fehlt die Zeile,
dient ausschließlich ein eindeutig über `/proc/<pid>/fd` zugeordnetes offenes Rollout als
Fallback (letzter `turn_context`). **Nie das neueste Rollout nur anhand des cwd wählen**:
Das kann eine alte CLI-, Desktop- oder Subagent-Sitzung mit einem anderen Modell sein.
Fehlen beide sicheren Quellen, bleibt der Chip leer.

Wichtig für Änderungen daran: **nur Claude und muse führen eine PID-Registry** — grok und
kimi werden über `/proc/<pid>/cwd` zugeordnet. Laufen zwei Prozesse desselben Tools im selben
Verzeichnis, ist die Zuordnung nicht mehr eindeutig; `listSessions()` zeigt dann bewusst
nichts an. Diesen Riegel nicht wegoptimieren.

Zwei muse-Eigenheiten, die man leicht falsch macht:

- **Modell steht am ANFANG des Logs, nicht am Ende.** muse schreibt es nur beim Start
  (`run.model.configured`) bzw. bei `/model` — `tailLines()` allein findet in einer
  gewachsenen `session.jsonl` gar nichts, deshalb zusätzlich `headLines()`. Records sind
  teils in „retained frames" gebündelt und stecken dort als **String** in
  `children[].record_json`.
- **Den Effort schreibt muse nirgends weg** (weder Log noch `~/.config/muse/settings.json`;
  `/effort` ändert ihn nur im Prozess). Er kommt aus
  der muse-Statuszeile `"<modell> · <effort> · <pfad>"` — und wird nur übernommen, wenn die
  dort genannte Modell-ID exakt der aus dem Log entspricht. Damit liefert eine
  abgeschnittene, gescrollte oder fremde Zeile nichts statt etwas Falschem.

Erkannt wird muse über den Prozessnamen mit **Präfix** `muse-bin-`: der Launcher
`~/.local/bin/muse` ist ein Shell-Skript, das das versionierte Binary exec't
(`comm` = `muse-bin-1.0.3-R2198.1`, von Linux auf 15 Zeichen gekürzt). Ein
Gleichheitsvergleich wie bei den anderen Tools greift nie.

## claude-auto-retry: seit Claude Code 2.1.234 nur noch Ergänzung

Claude Code wartet ein erreichtes Usage-Limit **selbst** aus — Schalter
`autoContinueAtUsageLimit` („Continue automatically at usage limit", `/config`, **ab Werk
an**). Das war der Hauptzweck von `claude-auto-retry`; das Paket ist damit **optional**
(`install.sh` fragt es weiterhin, aber mit Default **nein**).

Was nativ **nicht** abgedeckt ist und wofür das Paket weiterhin taugt:

- **Overload-Retry** bei anhaltendem `API Error: 529` / `overloaded_error` im Pane.
- **Safeguard-Retry** bei „safeguards flagged this message"-Fehlalarmen.
- **Überleben eines Prozess-Neustarts.** Das native Warten läuft *im* claude-Prozess
  („relaunched/exited during the wait, so the task will not resume"). Der geprüfte `deploy/term-restart` verhindert inzwischen den Abriss gehosteter
  tmux-Sitzungen; andere Prozessabbrüche können weiterhin auftreten. Ein externer Monitor
  kann über seinen `reconcile`-Timer erneut armiert werden.

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
