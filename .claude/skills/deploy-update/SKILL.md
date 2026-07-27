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

- **Baut immer**, entscheidet den Restart aber aus dem **Ist-Zustand** (Datei-mtime von
  `server.js`/`package*.json` vs. `ActiveEnterTimestamp` des Dienstes), **nicht** aus dem
  Pull-Diff. Das ist bewusst so: beim allerersten Lauf ging ein manuelles `git pull` voraus,
  das interne `git pull` meldet dann „up to date" — ein leerer Diff heißt hier **nicht**
  „nichts zu tun".
- Reine Frontend-Änderung ⇒ **kein** Restart (nur Tab-Reload) — schont fremde Sessions.
- `npm install` läuft nur bei echter Lockfile-Änderung (Hash-Stamp in
  `node_modules/.term-deps-stamp`; die mtime wird sonst wiederhergestellt, damit sie die
  Restart-Heuristik nicht verfälscht).
- **mdlite-Dependency mit Transport-Fallback** (`install_deps_resilient` in `deploy/update`):
  Die Markdown-Vorschau bindet `github:Etschmia/mdlite` als git-Dependency ein — npm
  normalisiert die im Lockfile aber **immer** auf `git+ssh`, sodass Server ohne GitHub-SSH-Key
  am Clone scheitern würden. Der Install probiert daher der Reihe nach: **git (ssh)** →
  **gh** (authentifiziertes `gh`-CLI, scoped `GIT_CONFIG_GLOBAL` mit `insteadOf`-HTTPS-Umleitung,
  färbt `~/.gitconfig` nicht ein) → **Tarball** (`.../archive/refs/tags/<tag>.tar.gz`, reines
  HTTPS ohne git). Der Tarball-Fallback biegt die `mdlite`-Spec nur temporär um (`npm pkg set`)
  und stellt `package.json`/`package-lock.json` danach wieder auf die committete git-Form her —
  `node_modules` bleibt gefüllt, der Tree sauber. Beim Tag-Bump von mdlite auch
  `MDLITE_REPO_SSH`/`MDLITE_TARBALL` in `deploy/update` mitziehen.
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
