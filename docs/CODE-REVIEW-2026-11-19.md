# Code-Review – 19.11.2026 (Änderungen seit 08.11.2026)

Geprüft: Diff `2b367fd..821d421` (drei Commits, ältester zuerst: `acc7b7a` feat(link),
`fad159f` Standard-Sitzung nicht anbieten, `821d421` Standard-Sitzung auch serverseitig
ausschliessen). Elf Dateien: `CLAUDE.md`, `README.md`, `bin/term-link.mjs`,
`lib/link-store.js`, `lib/link.js`, `server.js`, `src/app.js`, `src/index.html`,
`src/styles.css`, `test/link-integration.test.js`, `test/link-store.test.js`.
Ergänzt die [Review vom 08.11.2026](CODE-REVIEW-2026-11-08.md). Nur gelesen; der
Quelltext ist unverändert.

Die Befunde werden seither einzeln behoben, je Befund ein Commit; der Betreff
nennt die ID (`fix(link): M4 …`). Die Spalte „Stand“ und der Absatz
„Umsetzung“ unter dem jeweiligen Befund halten fest, was geändert wurde.

Ergebnis: die dokumentierten Geländer (CSRF, feste Hinweiszeile, Socket ohne
Anlegen/Beitreten, Standard-Sitzung, Rechte, Pfadlänge) sind im Code vorhanden.
Offen waren eine Lücke bei der Socket-Identität, ein dauerhafter Abgleichfehler
bei überlappenden tmux-Abfragen und mehrere engere Korrektheitslücken. Alle acht
Befunde sind inzwischen behoben (Stand der Tabelle); `npm test`: 50/50 grün.

| ID | Stufe | Befund | Stand |
|---|---|---|---|
| H1 | Hoch | Agenten-Socket vertraut der mitgeschickten Pane-ID | Behoben: Absender per `SO_PEERCRED` und Prozessbaum |
| M1 | Mittel | Veraltete Sitzungsliste markiert neue Endpunkte dauerhaft als beendet | Behoben: veraltete Listen verworfen, `gone` klebt nicht |
| M2 | Mittel | Beendete Mitglieder belegen Plätze, die niemand freigeben kann | Behoben: nur lebende Mitglieder zählen |
| M3 | Mittel | Zweite Instanz ohne Socket schreibt trotzdem `state.json` | Behoben: nur die Instanz mit dem Socket schreibt |
| M4 | Mittel | Nachrichtentext geht ungesteuert ins Terminal | Behoben: Steuerzeichen sichtbar ersetzt |
| N1 | Niedrig | Fehlgeschlagenes `capture-pane` gilt als Leerlauf und erlaubt Zustellung | Behoben: Status `unknown`, Zustellung nur bei `idle` |
| N2 | Niedrig | Bei mehreren Agenten-Panes gewinnt nicht das aktive | Behoben: Agent im aktiven Pane hat Vorrang |
| K1 | Kosmetik | Ratenlimit in der README gilt je Mitgliedschaft, nicht je Sitzung | Behoben: README berichtigt |

### H1 — Socket-Identität

`lib/link.js:239` (`agentCall` → `resolvePane`). Die Sitzung ergibt sich nur aus
den JSON-Feldern `tmux` und `pane`. Das CLI kopiert dafür `$TMUX` und
`$TMUX_PANE`; der Aufrufer kann beide setzen. Geprüft wird, dass die Pane-ID
wie `%` plus Ziffern aussieht und dass `display-message` auf diesem
tmux-Server denselben Socket-Pfad nennt. Nicht geprüft wird, ob der Prozess
am Socket in dieser Pane läuft. Wer `agent.sock` öffnen kann (Modus 0600,
derselbe Benutzer), kann das Postfach einer anderen Sitzung lesen und unter
ihrem Namen senden. `inbox` setzt `readSeq` dabei hoch, das echte Postfach ist
danach leer. Dieselbe uid kann `state.json` ohnehin anfassen; der Socket ist
trotzdem die Schnittstelle, die Agenten benutzen sollen, und eine Sandbox, die
das CLI erlaubt und das Zustandsverzeichnis sperrt, ändert daran nichts.
Anlegen, Beitreten und Trennen bietet der Socket nicht an.

Vorschlag: Peer-PID des Unix-Sockets lesen (Linux `SO_PEERCRED`) und die Pane
nur akzeptieren, wenn dieser Prozess in ihrem Prozessbaum liegt. `tmux` und
`pane` aus dem JSON nicht als Identität verwenden.

Umsetzung: Neues Modul `lib/peer-pid.js`. Bei jeder angenommenen Verbindung
liest das Backend die PID des Absenders per `SO_PEERCRED` und steigt von dort
über `/proc/<pid>/stat` den Prozessbaum hinauf, bis es den ersten Prozess eines
Panes erreicht (`tmux list-panes -a`, also nur Panes des eigenen tmux-Servers).
Dieses innerste Pane bestimmt die Sitzung. Wer in keinem Pane läuft, bekommt
403 `not_in_pane`. `resolvePane` und die Felder `tmux` und `pane` sind
entfallen; das CLI schickt sie nicht mehr, und das Backend liest sie nicht.
Die UID des Absenders wird zusätzlich gegen die des Dienstes geprüft.

node kann `SO_PEERCRED` nicht selbst lesen. Ein Einzeiler in perl, ersatzweise
python3, bekommt den Socket deshalb als Dateideskriptor 3 vererbt und gibt PID
und UID aus. Deskriptor 3 statt 0, weil libuv vererbte Deskriptoren 0 bis 2 im
Kind auf blockierend schaltet und dieses Flag auch für den Socket des Servers
gälte. Der Aufruf kostet etwa 20 ms je Verbindung.

Fail-closed: Nach dem `listen` verbindet sich das Backend einmal mit sich
selbst und erwartet die eigene PID. Scheitert das (kein Linux, weder perl noch
python3, kein Deskriptor), bleibt der Socket aus (`socket: 'error'`, Meldung im
Log und im Verbindungs-Fenster). Einen Rückfall auf die mitgeschickte Pane-ID
gibt es nicht.

Grenzen:

- Linux. Auf anderen Systemen ist das Postfach damit abgeschaltet; eine
  Variante für macOS (`LOCAL_PEERPID`) wäre möglich, ist aber hier nicht
  prüfbar und deshalb nicht enthalten.
- Der Aufruf muss im Prozessbaum des Panes liegen. Ein Werkzeug, das Befehle
  über einen abgekoppelten Hintergrunddienst startet, wird abgewiesen. Für
  Claude Code ist die Kette am laufenden System nachgeprüft (Shell-Werkzeug
  bis zum Pane). Für Codex, Grok, Kimi, Muse und Opencode ist das **nicht**
  einzeln geprüft; scheitert dort `term-link` mit „gehört zu keinem Pane“,
  ist das die Ursache.
- Ein Prozess desselben Benutzers mit Zugriff auf den tmux-Socket kann
  weiterhin in ein fremdes Pane tippen und dort `term-link` ausführen lassen.
  Das liegt außerhalb dessen, was der Socket entscheiden kann.

Tests: `test/peer-pid.test.js` (fremder Kindprozess, eigene Verbindung, beide
Helfer einzeln, Ablehnung ohne Helfer oder Deskriptor, Baumsuche). Im
Integrationstest läuft `term-link` jetzt als Prozess im Pane; neu sind ein
Aufruf aus `beta` mit der Pane-ID von `alpha` (bekommt das eigene Postfach),
ein Aufruf von außerhalb jedes Panes und rohe Anfragen am Socket mit `tmux`
und `pane` im JSON (403), jeweils ohne dass sich das Postfach von `alpha`
ändert. Gegen den alten Code scheitert dieser Test.

### M1 — Veraltete Sitzungsliste

`lib/link.js:98` (`observe`) und `lib/link-store.js:354`. Jede erfolgreiche
Sitzungsliste läuft in `reconcile`. Fehlt ein Endpunkt, wird `gone` gesetzt
und nicht wieder gelöscht (Test `reconcile marks vanished endpoints`).
`listSessionsFull` (`server.js:786`) und `listLive` (jeder Agenten-Aufruf)
starten `list-sessions` und gleichen erst nach der Rückkehr ab. Eine Abfrage,
die vor `set-option` in `ensureEndpoint` begann, kann nach dem Speichern der
neuen Mitgliedschaft zurückkommen. Der neue Endpunkt fehlt in diesem Schnappschuss
und gilt dauerhaft als beendet, obwohl die Sitzung läuft. `memberOf` findet
auch `gone`-Mitglieder, ein erneuter Beitritt scheitert mit `already_member`.
Fehlen beide Seiten, wird die Verbindung gelöscht. Eine fehlgeschlagene
tmux-Abfrage gleicht richtigerweise nichts ab; das Loch ist eine erfolgreiche,
aber veraltete Abfrage. Das Sidebar-Polling alle 4 s und `status`/`inbox`
machen solche Überlappungen wahrscheinlich.

Vorschlag: Schnappschüsse verwerfen, die vor der letzten Endpunkt-Änderung
gestartet wurden (Generation oder eine Sperre um Liste, `ensureEndpoint` und
Speichern). `gone` nicht kleben lassen, wenn eine neuere erfolgreiche Liste
den Endpunkt wieder enthält.

Umsetzung, drei Teile:

- `lib/link.js` zählt jede Endpunkt-Änderung in `epGen`, einmal vor und einmal
  nach dem `set-option`. Wer eine Liste abgleichen will, holt vor dem
  tmux-Aufruf `link.snapshot()` und gibt den Wert `observe` mit; `listLive`
  und `listSessionsFull` tun das. Hat sich der Stand seither geändert oder
  fehlt er, wird die Liste wie eine fehlgeschlagene Abfrage behandelt und
  nicht abgeglichen.
- `ensureEndpoint` läuft nacheinander und fragt tmux vor dem Setzen nach dem
  Endpunkt (`show-options -qv`). Die Zeile aus der Sitzungsliste kann selbst
  veraltet sein: zwei Anfragen für dieselbe Sitzung (Doppelklick, zwei Tabs)
  hätten sonst zwei Kennungen vergeben, und die Mitgliedschaft der ersten wäre
  beim nächsten Abgleich beendet gewesen. Das stand nicht im Befund, ist aber
  dieselbe Fehlerklasse.
- `reconcile` nimmt `gone` zurück, wenn eine spätere Liste den Endpunkt wieder
  nennt. Die Kennung ist zufällig und wird nie neu vergeben; taucht sie wieder
  auf, lebt die Sitzung. Damit erholt sich auch ein Zustand, der vor dieser
  Korrektur falsch vermerkt wurde. Eine Verbindung, die schon gelöscht wurde,
  weil alle Mitglieder als beendet galten, kommt dadurch nicht zurück.

Tests: `a session list that started before an endpoint was set is not
reconciled`, `two requests for the same session share one endpoint`, und der
Store-Test erwartet jetzt, dass ein wieder auftauchender Endpunkt lebt.

### M2 — Plätze und beendete Mitglieder

`lib/link-store.js:176` (`join`), dieselbe Zählung in `inviteValid`
(`lib/link-store.js:102`) und `renewInvite` (`lib/link-store.js:197`).
Gezählt wird `members.length`. `reconcile` setzt `gone`, entfernt die Zeile
aber nicht. `leave` entfernt nur den Aufrufer, nicht die beendete Gegenstelle.
In einer Gruppe mit freien Soll-Plätzen bleibt der Platz damit belegt:
Beitritt und Code-Erneuern antworten `link_full`. Die Oberfläche zeigt
dieselbe Zahl (`Mitglieder von Plätzen`).

Vorschlag: Nur Mitglieder mit `gone !== true` auf `seats` anrechnen. Die
`gone`-Zeile für die Anzeige „beendet“ behalten.

Umsetzung: `seatsTaken` in `lib/link-store.js` zählt nur Mitglieder ohne
`gone`; `join`, `renewInvite`, `inviteValid` und die Einladung in `view`
rechnen damit. Die `gone`-Zeile bleibt für die Anzeige stehen, bis jemand den
Platz übernimmt: `join` löst dann die älteste „beendet“-Zeile ab. Eine
Verbindung hat so nie mehr Zeilen als Plätze, auch wenn über die Zeit viele
Sitzungen kommen und gehen. `view` liefert die belegten Plätze als `taken`,
die Oberfläche zeigt diese Zahl (mit Rückfall auf die eigene Zählung bei einem
älteren Backend). Test: `a seat held by an ended session becomes free again`.

### M3 — Zweite Instanz

`lib/link.js:302`. Ist `agent.sock` schon belegt, setzt `boot` nur
`socketState = 'busy'` und kehrt zurück. Der Speicherstand aus
`createLinkStore` bleibt an HTTP und an `link.observe` hängen und schreibt
weiter die gemeinsame `state.json`. Die Instanz mit dem Socket hat eine
zweite Kopie im Speicher und schreibt ebenfalls die ganze Datei. Die letzte
Schreibung gewinnt; Nachrichten, die nur die Socket-Instanz angenommen hat,
können nach einem Neustart fehlen. Der Hinweis in der Oberfläche sagt nur,
dass Agenten dieser Instanz ihr Postfach nicht erreichen.

Vorschlag: Solange `socketState` nicht `ok` ist, ändernde `/api/link/`-Routen
ablehnen und beim Abgleich nicht speichern. Alternativ vor jedem Schreiben
exklusiv sperren und neu laden. Einen lebendigen Socket nicht ersetzen.

Umsetzung: Es schreibt genau die Instanz, der der Agenten-Socket gehört
(`owner` in `lib/link.js`). Ohne ihn lehnen `create`, `join`, `connect`,
`leave`, `renewInvite`, `deliver` und die Aufrufe am Socket mit 503
`not_owner` ab, und zwar vor dem ersten tmux-Aufruf: auch die Session-Option
setzt nur die schreibende Instanz. `observe` gleicht dann nicht ab und
speichert nicht, sondern liest über `store.refresh()` den Stand der anderen
Instanz neu, sobald sich `state.json` geändert hat. Die zweite Instanz zeigt
also den aktuellen Stand an, statt mit ihrer Kopie vom Start weiterzuarbeiten.
Das gilt für jeden Zustand außer `ok`, auch für die kurze Zeit vor dem Start
des Sockets und für `error`.

`owner` prüft außerdem Gerät und Inode der Socket-Datei gegen die beim
`listen` gemerkten Werte. Starten zwei Instanzen gleichzeitig, sehen beide
keinen lebenden Socket, und die zweite ersetzt die Datei der ersten; die erste
bemerkt das beim nächsten Zugriff, schließt ihren Socket und schreibt nicht
mehr. Einen lebenden Socket ersetzt `boot` weiterhin nicht.

Nicht umgesetzt: Die Instanz ohne Socket übernimmt ihn nicht von selbst, wenn
die andere endet. Sie bleibt bis zu ihrem Neustart bei der Anzeige. Die
Meldung in der Oberfläche und im Fehlertext nennt den Ausweg (`TERM_LINK_DIR`
für ein eigenes Verzeichnis). Test: `only the instance that owns the agent
socket changes the shared state`.

### M4 — Steuerzeichen im Nachrichtentext

`bin/term-link.mjs:126` (`printMessages`). `m.text` wird unverändert auf die
Standardausgabe geschrieben. `cleanName` entfernt Steuerzeichen aus Namen,
weil die in fremden Ausgaben landen; der Nachrichtentext, also der unzuverlässige
Kanal, nicht. `inbox` und `history` benutzen dieselbe Ausgabe, und die liegt
im tmux-Pane, das an xterm.js hängt. xterm.js beantwortet Statusabfragen, indem
es auf die Terminaleingabe zurückschreibt (`InputHandler.deviceStatus`). Die
Installation schaltet Clipboard-Passthrough in tmux an, damit gilt das auch
für OSC im Text. Die Zufallsmarke verhindert eine gefälschte Endzeile für das
Modell; sie hält das Terminal nicht davon ab, die Bytes auszuführen. Die
Hinweiszeile per `send-keys` enthält den Text weiterhin nicht.

Vorschlag: C0/C1 im Text vor dem Drucken neutralisieren, Zeilenumbruch und
Tabulator behalten. Dieselbe Regel für jede Ausgabe von `text` und für den
ungesäuberten Sitzungsnamen in `status`.

Umsetzung: Neues Modul `lib/link-text.js` ohne Abhängigkeiten. `printable`
ersetzt jedes C0- und C1-Zeichen sowie DEL sichtbar (ESC wird `␛`, C1 wird
`�`), statt es zu entfernen — der Agent sieht, dass dort etwas stand.
Zeilenumbruch und Tabulator bleiben, CRLF wird LF; ein einzelnes CR wird
ersetzt, weil es die Zeile im Terminal überschreiben würde. `printableLine`
nimmt für einzeilige Werte zusätzlich Umbruch und Tabulator heraus.
`bin/term-link.mjs` schickt damit alles, was vom Backend kommt, durch eine der
beiden Funktionen: Nachrichtentext, Absender, Verbindungs-IDs, Sitzungsname in
`status`, Empfänger in `send` und Fehlermeldungen. Gespeichert wird der Text
weiterhin unverändert; die Oberfläche setzt ihn über `textContent`. Tests:
`test/link-text.test.js` und im Integrationstest eine Nachricht mit
Statusabfrage, OSC 52, 8-Bit-CSI und CR für `inbox` und `history`.

### N1 — Capture-Fehler gilt als Leerlauf

`server.js:663`. `deliverCheck` (`lib/link.js:63`) tippt, sobald der Status
nicht `working` und nicht `blocked` ist. Schlägt `capture-pane` fehl, liefert
`agentPaneStatus` `idle`. Eine unlesbare Pane ist damit dasselbe wie ein
ruhiger Prompt, und der Klick kann einen Dialog bestätigen, den die Prüfung
nicht gesehen hat. Der 300-ms-Abstand nach einer gelungenen Lesung ist so
beabsichtigt; ein Lesefehler nicht. Die Rückgabe `idle` in `agentPaneStatus`
ist älter, die Zustellung tippt deshalb neu.

Vorschlag: Bei Capture-Fehler einen eigenen Status zurückgeben und in
`deliverCheck` ablehnen. Ziel wie bei `/api/capture` exakt adressieren.

Umsetzung: `agentPaneStatus` liefert bei fehlgeschlagenem `capture-pane` den
Status `unknown`. `deliverCheck` erlaubt die Zustellung nur noch bei `idle`
und lehnt jeden anderen Wert ab, statt nur `working` und `blocked`
auszuschließen; ein später hinzukommender Status ist damit von selbst
gesperrt. Gelesen wird über die Pane-ID des aktiven Panes (`%N`) statt über
den Sitzungsnamen, den tmux als Präfix oder Muster deutet. Status und Ziel der
Zustellung beziehen sich so auf dasselbe Pane. Die Oberfläche bekommt
`unknown` weiterhin als `idle`: Ampel und „fertig“-Benachrichtigung ändern
sich nicht. Test: `deliverCheck` mit `unknown`, `null` und einem unbekannten
Wert.

### N2 — Erstes Agenten-Pane

`server.js:247`. `agentSessions` merkt sich weiterhin den ersten Agenten einer
Sitzung und seit dieser Änderung auch dessen Pane-ID. `deliver` tippt in
`agentPane`, `deliverCheck` verlangt Gleichheit mit dem aktiven Pane. Läuft
im Hintergrund ein weiterer Agent und wird der zuerst gefunden, scheitert die
Zustellung, obwohl das aktive Pane selbst ein untätiger Agent ist und der
Status von dort stammt. Es wird nicht ins Hintergrund-Pane getippt; der Klick
erreicht nur den sichtbaren Agenten nicht.

Vorschlag: Gibt es mehrere Agenten-Panes, dasjenige nehmen, dessen Pane-ID das
aktive Pane der Sitzung ist.

Umsetzung: `agentSessions` liefert je Sitzung alle Panes mit Agent statt nur
des ersten. `agentOfSession` wählt den Agenten im aktiven Pane und fällt auf
den ersten zurück, wenn dort keiner läuft. Davon hängen `agent`, `agentPid`
und `agentPane` der Zeile ab: Name, Modell-Chip, Status und Ziel der
Zustellung beschreiben jetzt denselben, sichtbaren Agenten. Läuft der Agent
nur in einem Hintergrund-Pane, lehnt `deliverCheck` wie bisher ab. Der
Integrationstest öffnet ein zweites Fenster mit einem Agenten und erwartet den
Hinweis dort; ohne die Korrektur scheitert er mit „nicht im aktiven Pane“.

### K1 — Ratenlimit in der README

`README.md:311`. Dort stehen 30 Nachrichten pro Minute und Sitzung. `send` in
`lib/link-store.js` zählt `sendLog` nach `member.id`, und jede Mitgliedschaft
hat eine eigene ID. Mehrere Verbindungen derselben Sitzung haben damit je
30 pro Minute. Der Zähler liegt nur im Speicher und ist nach einem Neustart
leer; das sagt der Kommentar im Store, die README nicht.

Vorschlag: „je Mitgliedschaft“ schreiben oder das Limit am Endpunkt erzwingen,
und den Neustart erwähnen.

Umsetzung: Die README nennt das Limit jetzt je Mitgliedschaft (Sitzung und
Verbindung) mit einem Beispiel und sagt, dass der Zähler nur im Speicher liegt
und nach einem Neustart neu beginnt. Das Verhalten ist unverändert: die Bremse
soll Schleifen innerhalb einer Verbindung aufhalten, nicht eine Sitzung mit
mehreren Verbindungen ausbremsen.

## Geprüft und unauffällig

- Schreibende HTTP-Routen laufen vor dem Router durch `csrfRequestAllowed`
  (`server.js`, `validCsrfRequest`). `lkPost` sendet `X-Term-CSRF` über
  `protectedFetch`. GET `/api/link/state` und `/api/link/history` sind nur
  lesend, wie die übrigen GET-Auskünfte. Ein Test erwartet 403 ohne Token.
- Die Standard-Sitzung hat in der Sidebar keinen Ketten-Knopf; die Auswahl
  filtert `!x.standard`. `create`, `join` und `connect` antworten 400, wenn
  `row.standard` oder `body.peer === STANDARD_SESSION`. Umbenennen auf oder
  von diesem Namen ist an der bestehenden Rename-Route verboten. Trennen und
  Lesen bleiben für eine ältere Mitgliedschaft erlaubt; die Oberfläche bietet
  dafür an der Standard-Zeile keinen Knopf, nur die API.
- Der Endpunkt steht in der Session-Option `@term-link-ep` und wird über die
  Session-ID gesetzt, nicht über den Namen. `reconcile` läuft nur aus
  `observe` nach erfolgreicher Liste. Schlägt `list-sessions` fehl, liefert
  `listSessionsFull` eine leere Liste ohne `observe`; `listLive` setzt
  `ok: false` und gleicht nicht ab.
- `wakeLine` und `introLine` sind feste Sätze plus `shellQuote` des
  CLI-Pfads. `send-keys` bekommt den Text mit `-l`, danach Enter, Ziel ist
  die Pane-ID. Namen und Nachrichtentext stehen nicht in dieser Zeile. Der
  Integrationstest prüft, dass der fremde Text nicht im Pane landet.
- Zustellung nur über POST `/api/link/deliver`. `deliverCheck` verlangt einen
  erkannten Agenten im aktiven Pane, keinen Kopiermodus und weder `blocked`
  noch `working`. `delivering` sperrt einen zweiten Klick derselben Sitzung.
  `markWoken` läuft erst nach erfolgreichem Enter.
- Der Socket bedient nur `/status`, `/inbox`, `/history` und `/send`. Andere
  Pfade liefern 404. Anlegen und Beitreten gibt es dort nicht.
- Vor `listen` prüft `socketPathOk` 107 bzw. 103 Bytes. `boot` setzt das
  Zustandsverzeichnis auf 0700, den Socket danach auf 0600. `state.json`
  wird mit Modus 0600 geschrieben. `TERM_LINK_DIR` verlegt das Verzeichnis.
- tmux-Argumente gehen über `execFile` ohne Shell. Die Pane-ID für
  `resolvePane` ist auf `%` plus Ziffern begrenzt. Die Sidebar sucht die
  Sitzung per exaktem Namen aus der Liste, nicht per tmux-Präfix.
- Obergrenze Nachricht 16 KB, Socket-Body 64 KB, HTTP-Body über
  `readJsonBody` 64 KB, Verlauf 500 Nachrichten und 2 MB je Verbindung.
- Die neue Oberfläche setzt Nachrichtentext und Namen über `textContent`
  (`tgEl`). `innerHTML` am Ketten-Knopf ist ein festes SVG.
- Der Integrationstest legt einen eigenen tmux-Server über einen `tmux`-Starter
  im PATH an (`-L`, `unset TMUX`) und beendet nur diesen.

Diese Review hat keinen Quelltext, keine Tests und keine Konfiguration geändert
und keinen Dienst neu gestartet.
