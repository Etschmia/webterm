---
name: deploy-update
description: Neuen Stand dieses Webterminals einspielen und aktiv machen — `deploy/update` (git pull → build → Restart nur bei Backend-Änderung), warum `install.sh` dafür untauglich ist, plus die Interna der Restart-Heuristik, des mdlite-Transport-Fallbacks, der Servicenamen-Ermittlung, des User-Bus-Fallbacks (Exit 3/4), der Version-Skew-Erkennung, des Standard-Session-Wrappers und des Self-Update-Icons. Nutze diesen Skill bei Deploy, Stand-Update, „neuen Stand ziehen", Build-/Restart-Fragen oder wenn `deploy/update` fehlschlägt.
---

# Stand-Update einspielen: `deploy/update`, nicht `install.sh`

Für „neuen Stand ziehen und aktiv machen" gibt es `deploy/update` (git pull → build → und
**nur bei Backend-Änderung** ein `deploy/term-restart`). **`install.sh` taugt dafür nicht**:
es ist Installer/Konfigurator und startet einen *laufenden* Dienst per `enable --now`
**nicht** neu — nach `git pull && install.sh` liefe also weiter der alte `server.js`
(nur das neu gebaute Frontend käme per Tab-Reload). Wichtige Eigenschaften von
`deploy/update`:

- **Baut immer**, entscheidet den Restart aus dem Inhalts-Hash der Runtime-Dateien
  gegen `.backend-running.json` (PID + Start-Hash des Servers). Build, Server und Update
  verwenden `deploy/backend-paths.json`: `server.js`, Paketmanifeste und rekursiv `lib/`.
  Neue/gelöschte Module und Änderungen mit alter mtime zählen ebenfalls. Ein fehlender
  oder fremder Prozess-Stamp erfordert einen Restart; reine Frontend-/Docs-Änderungen nicht.
- **Restart prüft sämtliche tmux-Prozesse**, unabhängig vom Agent-Namen. Liegen tmux-Server,
  Panes oder deren Nachfahren in der Ziel-cgroup, bricht `deploy/term-restart` mit Exit 5 ab.
  Es gibt kein Snapshot/Resume mehr. `--check` prüft ohne Restart. tmux muss unabhängig
  betrieben oder betroffene Arbeit vorher gesichert und beendet werden.
- **mdlite-Transport:** Git/SSH oder authentifiziertes gh/HTTPS mit scoped Git-Konfiguration;
  beide beziehen den gepinnten Commit. **Kein Tarball-Fallback**, keine temporäre Umstellung
  der Manifeste auf bewegliche Tags. Scheitern beide Transporte, endet das Update mit Fehler.
- `npm install` läuft nur bei geändertem Lockfile-Hash. Lokale Config/Cache bleiben bei
  einer projektlokalen Node-Installation gekapselt.
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
  (Prozess-Evidenz aus `/proc/<pid>`) trotzdem als **aktiv** — statt des
  irreführenden „Dienst ist nicht aktiv" (Exit 3). Ist dann ein Restart fällig, ist der
  ohne Bus aber unmöglich (auch `systemd-run --user` braucht ihn) ⇒ **Exit 4** mit
  Hinweis auf echte Login-Sitzung bzw. `loginctl enable-linger`; `term-restart` bricht
  in dem Fall früh ab, bevor `systemd-run` ins Leere läuft.
- **Version-Skew**: `build.mjs` → Stamp ins Bundle (`__BUILD_STAMP__`) **und**
  `public/version.json`; `server.js` berechnet denselben Runtime-Hash selbst beim Start, liefert `/api/version`; das
  Frontend warnt bei Versatz („Backend veraltet — Deploy unvollständig?"). Ein 404 auf
  `/api/fs/cwd` wird in `fxFollowCwd` einmalig per `console.warn` protokolliert.
- **Standard-Session-Wrapper rollt mit aus**: `update` trägt die Source-Zeile für
  `deploy/standard-session-wrappers.sh` in der `~/.bashrc` nach, falls sie fehlt (Instanzen
  mit altem `install.sh`-Stand), und lässt untätige bash-Panes die `~/.bashrc` per
  `send-keys` neu einlesen; belegte Panes (laufendes claude etc.) werden nur gemeldet —
  dort nach Ende `. ~/.bashrc`. Der Wrapper selbst ist reihenfolge-unabhängig und
  selbstheilend: ein permanenter `PROMPT_COMMAND`-Hook sammelt später definierte
  Fremd-Funktionen (claude-auto-retry) wieder ein und sourct die Wrapper-Datei neu,
  sobald sich ihre mtime ändert — so erreichen Updates auch Shells, die beim
  Update-Lauf belegt waren.
- `--no-pull` überspringt den Pull.
- **Self-Update-Icon** (Sidebar, neben „?"): Backend prüft gedrosselt (TTL 5 min, Klick
  erzwingt) per `git fetch` + `rev-list --count HEAD..@{u}`, ob das Remote voraus ist
  (`/api/update/status`); ist es das, pulsiert das Icon mit Commit-Zähler, Klick startet
  nach Rückfrage `deploy/update` als Kindprozess (`/api/update/run`, Fortschritt über
  `/api/update/log`). Ein Backend-Restart mitten im Lauf kappt Kind + Log — das Frontend
  wertet „Backend weg und mit neuer Version zurück" als Erfolgsende, wartet auf
  `/healthz` und lädt die Seite neu.
