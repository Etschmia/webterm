# Code-Review – 08.11.2026 (Änderungen seit 06.09.2026)

Geprüft: Diff `217105a..HEAD` (`server.js`, `lib/`, `src/app.js`, `install.sh`, `deploy/`,
`build.mjs`) durch einen separaten Claude-Subagenten (nur lesend), Schwerpunkte Explorer-Git-
Endpunkte, tmux-Start außerhalb der Unit, Installer, Frontend-XSS. `npm test`: 28/28 grün,
`npm audit --omit=dev`: 0 Schwachstellen. Ergänzt die [Review vom 06.09.2026](CODE-REVIEW-2026-09-06.md).

Ergebnis: keine kritischen oder hohen Befunde.

| ID | Stufe | Befund | Stand |
|---|---|---|---|
| L1 | Niedrig | `install_vendor_node` entpackte das Node-Tarball auch ohne prüfbare Prüfsumme | Behoben: Abbruch |
| L2 | Niedrig | Liegt `FS_ROOT` in einem übergeordneten Git-Repo, lieferten Log/Show Historie außerhalb | Behoben: `GIT_CEILING_DIRECTORIES` |
| L3 | Niedrig | Repo-lokales `core.fsmonitor` könnte bei `git diff` ein Programm starten | Behoben für Patch-Aufrufe (`-c core.fsmonitor=false`) |
| L4 | Kosmetik | Git-Timeout meldet „Commit nicht gefunden" | Offen |

Geprüft und unauffällig: `rev`-Validierung (`^[0-9a-f]{7,64}$`, `--` vor Pfadspecs),
`execFile` ohne Shell, Größen-/Zeitlimits, Pfadprüfung über `safeExistingPath`, Frontend nur mit
`textContent`/`createElement`.
