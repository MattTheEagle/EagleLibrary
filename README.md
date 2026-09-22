# Eagle Library

Foundry-VTT-Modul **Eagle Library**: die Single Source of Truth für die Eagle Module (eigene Compendien je Art,
Kopieren aus anderen Compendien mit Einmaligkeit pro Version und Umschreiben aller Verweise, ein Fenster mit Suche und
Tastenkürzel). Es ist das zweite Modul der Eagle Modules und der erste Verbraucher von Eagle Flight Control.

**Stand:** Version 0.1.1 (`0.1.0` war der Phasenabschluss und ist weiterhin der Stand von `docs/library-convention.md`,
dem Library-Vertrag; `0.1.1` ist ein reiner Kompatibilitäts-Patch vom 2026-09-22, ausgelöst durch Eagle Homebrews
Meilenstein M2 — keine Regel des Vertrags hat sich geändert). Das Modul meldet sich bei Eagle Flight Control an (API `0.13.0`), bekommt dafür einen Tab im Hub;
der Open-Knopf öffnet das Library-Fenster mit einer Registerkarte je angelegtem Eagle Compendium (Meilenstein M10, Reworks 1 und 2) und einem
Suchfeld für die aktive Registerkarte (Meilenstein M12), und kann von dort fehlende Compendien anlegen; ein weiterer Knopf öffnet das
Copy-Fenster (Meilenstein M11): einzelne oder alle Nicht-Eagle-Compendien mit Fortschritt, Abbruch, Protokoll- und Prüfbericht-Ansicht und
"Erzwingen" kopieren, ohne die Konsole zu brauchen (die Konsolen-Einstiege bleiben zusätzlich bestehen, siehe unten). Zusätzlich öffnet **Strg+L**
von überall in Foundry eine Suchleiste über alle Eagle Compendien mit Ziehen auf Charakterblätter und andere Ziele (Meilenstein M13). Nur Foundry
v13. Es gibt keine Lizenz (Hobbyprojekt). Das Repo ist lokal, hat keinen Remote, und nichts ist veröffentlicht.

## Voraussetzungen

- Foundry VTT v13.
- Eagle Flight Control ab Version `0.7.0` (API `0.13.0`). Das Manifest verlangt es unter `relationships.requires`.

## Was das Modul heute tut

- `init`: schreibt die Zeile `eagle-library | ready (Foundry v13)` in die Konsole.
- `setup`: liest die API von Flight Control (`game.modules.get("eagle-flight-control")?.api`) und ruft `registerModule` einmal auf.
  Das Ergebnis steht in der Konsole (`eagle-library | registerModule result: ok (...)`). Fehlt Flight Control oder lehnt
  es die Anmeldung ab, steht dort eine Warnung; das Modul schaltet nichts ab, weil es noch nichts hat, was abzuschalten
  wäre. Bei der Anmeldung übergibt die Library ein `open`.
- **Open-Knopf im Hub, das Library-Fenster (Meilenstein M10, Reworks 1 und 2; nur Spielleiter/Assistent):** öffnet ein Fenster mit
  drei nebeneinanderstehenden Knöpfen **2014 / 2024 / Both** (Vorauswahl 2014) davor und einer Registerkarte je Eagle Compendium der gewählten Auswahl,
  das in dieser Welt schon existiert (Katalog-Reihenfolge; ein Compendium, das noch nicht angelegt ist, bekommt keine
  Registerkarte). 2014 und 2024 zeigen die jeweils 15 versionierten Arten, Both die 4 Arten ohne Version (Encounters, Groups,
  Roll Tables, Journals); die Beschriftung nennt nur den bloßen Namen der Art (z. B. "Weapons"), nie "Eagle" und nie die
  Version. Jede Registerkarte zeigt ihre Einträge alphabetisch sortiert; ein Klick auf einen Eintrag öffnet seine eigene
  Sheet-Ansicht. Damit das Öffnen des Fensters bei bis zu 34 Registerkarten mit teils hunderten Einträgen (siehe M9-Live-Check)
  nicht alles auf einmal liest, wird nur die aktive Registerkarte geladen; ein Wechsel lädt genau die neue nach, einmal, und
  merkt sie sich für die Lebensdauer des Fensters (auch ein Filterwechsel liest nie doppelt, da die drei Auswahlen einander
  ausschließen). Tab-Leiste und Registerkarten-Inhalt scrollen unabhängig voneinander (`v13/styles/eagle-library.css`, auf
  das Fenster begrenzt, UI-Leitfaden R-13). Nur wenn Compendien fehlen, zeigt eine Statuszeile die Zahl und einen Knopf "Create missing
  compendia" — die Library legt sie nicht selbst an, sondern bittet Flight Control je Compendium um die Anfrage
  `compendium.create` (nur für Spielleiter und Assistent); ein Name, den ein Compendium eines anderen Dokumenttyps trägt, wird
  gemeldet und nicht angefasst. Ein Suchfeld über der Tab-Leiste (Meilenstein M12) filtert nur die gerade aktive Registerkarte:
  Groß-/Kleinschreibung spielt keine Rolle, ein Treffer ist ein Teilstring an beliebiger Stelle im Namen, gefiltert wird bei
  jedem Tastendruck, ohne die Welt erneut zu lesen; der Suchtext bleibt beim Wechsel der Registerkarte oder des Versions-Filters
  erhalten und wirkt sofort auf die neue Auswahl.

- **Tastenkürzel Strg+L, die Such-Overlay-Leiste (Meilenstein M13, für jede Rolle, kein Spielleiter-Guard):** öffnet von
  überall in Foundry eine rahmenlose Leiste, die über **alle** existierenden Eagle Compendien sucht (Teilstring, ohne
  Groß-/Kleinschreibung, wie M12), höchstens 20 Treffer, jeweils mit Name und Art. Der Index über alle Compendien wird
  beim ersten Öffnen einmal aufgebaut und danach für die Sitzung gemerkt (kein Aufbau beim Weltstart, kein erneuter
  Aufbau bei einem weiteren Öffnen). Pfeiltasten wählen einen Treffer, Enter öffnet seine Sheet-Ansicht und schließt die
  Leiste, Escape oder ein Klick außerhalb schließt sie ebenfalls, ein erneuter Tastendruck bei offener Leiste schließt
  sie (statt eine zweite zu öffnen). Jede Trefferzeile lässt sich ziehen (natives `{type, uuid}`, dasselbe Format wie ein
  gewöhnlicher Compendium-Eintrag) — auf ein Charakterblatt oder jedes andere Foundry-Ziel, das Dokumente annimmt; was
  ein Ziel damit tut (z. B. dnd5es Levelauswahl bei einer Klasse), ist dessen eigenes, unverändertes Verhalten. Das
  Tastenkürzel ist umbelegbar (Foundrys Steuerungs-Einstellungen).

- **Ein Dokument kopieren (Konsole; Teil des Library-Vertrags seit M14):** `await game.modules.get("eagle-library").api.copyDocument(uuid)`
  (nur Spielleiter und Assistent). `uuid` ist die UUID eines Dokuments in einem Compendium, das kein Eagle Compendium ist.
  Die Library bestimmt die Art, die Version und das Ziel nach der Konvention (`docs/library-convention.md`, R10) und bittet
  Flight Control um `compendium.import`; bei einem Behälter kommt sein Inhalt in dasselbe Compendium mit. Die Antwort ist
  `{ ok: true, pack, target, created, existed }` oder `{ ok: false, reason, detail }` (`reason`: `not-gm`,
  `no-flight-control`, `source-not-found`, `source-not-supported`, `no-art`, `read-failed`, `already-copied`, `duplicate`,
  `no-target`, `container-too-deep`, `too-many`, `version-required`, `closure-too-large`, `request-failed`, `unknown-outcome`); sie wirft nie. Änderungen an diesem Einstieg
  sind seit M14 Vertragsänderungen, keine beiläufigen; andere Module dürfen sich darauf stützen (`docs/library-convention.md`, R10). Das Copy-Fenster (unten) deckt dasselbe für mehrere Compendien auf einmal ab.

- **Einmaligkeit, Protokoll, Erzwingen (Konsole; Teil des Library-Vertrags seit M14):** Ein Eintrag ist derselbe wie ein anderer, wenn Name **und** Voraussetzung
  (`system.requirements`) gleich sind (Konvention R5). Was die Regeln oder Grenzen der Library nicht übertragen (`duplicate`, `no-art`,
  `too-many`, `container-too-deep`), steht im **Protokoll** (Welteinstellung `eagle-library.protocol`, höchstens 500 Einträge; R11):
  `game.modules.get("eagle-library").api.protocol()` liest es, `api.clearProtocol()` leert es. Ein Duplikat lässt sich erzwingen:
  `await game.modules.get("eagle-library").api.copyDocument(uuid, { force: true, version: "2014" })` legt es als "Name (Duplicate)" mit
  neuer ID ab (Konvention R12; die Version wählt der Spielleiter). Auch das ist seit M14 Teil des Vertrags (R11, R12).

- **Verweise umschreiben (Logik, noch nicht eingebunden):** `core/uuid.ts`, `core/link-map.ts` und `core/rewrite-links.ts` erkennen Compendium-UUIDs
  (mit und ohne Dokumenttyp, in Feldern und in Text), bilden die Quellen auf ihre Kopien ab, schreiben die Verweise um (`rewriteLinks`) und
  melden jeden Verweis, der nicht in einem Eagle Compendium endet (`scanLinks`, `summarizeReferences`); die Herkunftsfelder bleiben auf der
  Quelle (N10). Reine Funktionen ohne Foundry; der Kopiervorgang benutzt sie erst mit Meilenstein M7 (Konvention R13).

- **Verweise beim Kopieren und Zauberlisten (Meilenstein M7, Konvention R14 und R15):** `copyDocument` schreibt die Verweise eines Dokuments
  (und eines Behälters mit Inhalt) **beim Anlegen** auf die Library-Kopien um, in derselben Anfrage; Ziele, die die Library nicht
  hat, bleiben stehen und stehen im Bericht der Antwort (`links`, `map`). `await game.modules.get("eagle-library").api.checkLinks(uuid)` gibt den
  Bericht für ein Dokument in einem Eagle Compendium. Beim Kopieren eines Journals merkt sich die Library seine Zauberlisten-Seiten
  (Welteinstellung `eagle-library.spell-lists`); jeder Client meldet sie beim Start bei dnd5e an. Vorhandene Kopien werden nicht nachgebessert.

- **Abhängigkeiten mitkopieren, Untergattungen (Meilenstein M8, Konvention R16 bis R18; Konsole, Teil des Library-Vertrags seit M14):** `copyDocument(uuid)` kopiert jetzt
  auch **alles, worauf das Dokument verweist** (Felder und Text), und was diese wieder verweisen, bis nichts Neues mehr kommt
  (Hülle, R17). Geschrieben wird in Portionen zu höchstens 100 Dokumenten je Compendium; bricht eine Portion ab, macht ein neuer Aufruf
  weiter (`closure: { documents, written, remaining }` in der Fehlerantwort). Mehr als `maxDocuments` (Standard 5.000) Dokumente
  ergeben `closure-too-large` und nichts wird geschrieben; `{ closure: false }` kopiert nur das Dokument (und den Inhalt eines Behälters).
  `await game.modules.get("eagle-library").api.plan(uuid)` zeigt die Hülle, ohne zu schreiben. Arten (Spezies) bekommen beim Kopieren, wo die
  Daten es klar sagen, den Marker `flags.eagle-library.subspecies` (R18); von Hand: `api.setSubspeciesMarker(uuid, "Elf")`,
  `api.removeSubspeciesMarker(uuid)`, `api.readSubspeciesMarker(uuid)`. Die Herkunft einer Kopie wird nicht gesondert festgehalten (R16).

- **Große Mengen (Meilenstein M9, Konvention R19; Konsole, Teil des Library-Vertrags seit M14):** `await game.modules.get("eagle-library").api.copyCompendia(auswahl)` kopiert
  jedes Dokument mit einer Art (R2) aus einem, mehreren oder — mit `"all"` — allen Nicht-Eagle-Compendien der Welt (System, Modul oder Welt,
  gleich behandelt); `auswahl` ist ein Compendium-Name, eine Liste davon oder `"all"`. Jedes Dokument wird für sich über das unveränderte
  `copyDocument` kopiert (voller Abschluss, R17); `already-copied` und `duplicate` sind erwartete Ausgänge und stoppen nichts. Erst nach
  mehreren Fehlschlägen **in Folge** (Standard 5, `{ maxConsecutiveFailures }`) bricht der ganze Lauf ab, oder wenn `{ signal }` (ein
  `AbortSignal`, Meilenstein M11) schon abgebrochen ist; ein erneuter Aufruf mit derselben Auswahl macht dort weiter, wo er aufgehört hat
  (nichts wird doppelt geschrieben). `await game.modules.get("eagle-library").api.planCompendia(auswahl)` zeigt vorher die genaue Größe,
  ohne zu schreiben — eine Abhängigkeit, die mehrere Wurzeln der Auswahl teilen, wird dabei nur einmal gezählt; auch das lässt sich per
  `signal` abbrechen. Beide nehmen ein `{ onProgress }` (ein Rückruf je Dokument, zusätzlich zur Konsole). Kein neuer Anfragetyp an
  Flight Control.

- **Copy-Fenster (Meilenstein M11, nur Spielleiter/Assistent):** ein Knopf im Library-Fenster ("Copy from other compendia…") öffnet ein
  eigenes Fenster (bewusst kein weiterer Reiter des Library-Fensters, Entscheidung des Projektleiters: Kopieren aus fremden Compendien ist
  ein anderes Werkzeug als das Durchsehen der eigenen). Es zeigt jedes Nicht-Eagle-Compendium der Welt als Kästchen (alphabetisch, mit
  "Select all"), fragt vor einer Massenkopie nach ("Start"; eine "Vorschau" zeigt vorher die echten Zahlen über `planCompendia`, ohne
  jede Bestätigung durch einen mehrminütigen Trockenlauf zu verzögern) und zeigt den Fortschritt über Foundrys eigenen Fortschrittsbalken;
  ein "Abbrechen"-Knopf während eines Laufs bricht ihn wirklich ab (`AbortSignal`), der Rest der Auswahl bleibt für einen erneuten Lauf
  übrig. Nach einem Lauf: eine Protokoll-Ansicht (offene Einträge, "Force" nur bei einem Duplikat, mit Versionsdialog nur bei einer
  versionierten Art) und, falls eine Kopie noch außerhalb der Library verweist, eine Prüfbericht-Ansicht mit einem Klick zur Sheet-Ansicht.
  Kein neuer Anfragetyp an Flight Control; die Konsolen-Einstiege bleiben unverändert zusätzlich bestehen.

## Bau

Voraussetzung: Node.js 24, für `npm run package` zusätzlich das Werkzeug `zip`.

```
npm ci              # installiert genau die Versionen aus package-lock.json
npm run build       # baut v13/dist/module.js
npm run typecheck   # Typprüfung v13 gegen die gepinnten Foundry-Types
npm run test        # Vitest-Suite (core/-Logik, ohne Foundry-Laufzeit)
npm run package     # baut release/eagle-library-v13.zip und release/module.json; veröffentlicht nichts
```

**Foundry-Types:** `v13/tsconfig.json` verweist relativ auf die gemeinsame, gepinnte Foundry-Referenz
(`foundry-vtt-reference-v13`, Tag `v13.345.1`), die mehrere Projekte teilen. Der Ordner dieses Repos liegt zwei Ebenen
unter dem Ordner, der auch `foundry-vtt-reference-v13` enthält. Ohne sie schlägt `npm run typecheck` fehl; Bau und Tests
brauchen sie nicht.

**Hinweis zu `npm audit`:** `npm ci` meldet Advisories in den Entwicklungswerkzeugen (`esbuild`, `vite`, `vitest`). Alle
betreffen Entwicklungs-Server oder die Vitest-Oberfläche. Die Skripte hier starten keinen solchen Server (`vitest run`,
`esbuild --bundle`, `tsc`), und die Werkzeuge sind nicht Teil des Pakets. Beheben ließe es sich nur mit neuen
Hauptversionen; das wäre eine Dependency-Änderung mit eigener Freigabe.

## Struktur

```
core/   reine Logik ohne Foundry-Laufzeit, mit Tests (Vitest): Anmeldung, Katalog der Compendien, Version, Namensregeln,
        Anlegen der Compendien
docs/   library-convention.md: Library-Vertrag für Verbraucher-Module (Konvention, seit Meilenstein M14 Vertrag)
v13/    dünne Foundry-Hülle: Manifest, Einstiegspunkt, Library-Fenster, Copy-Fenster, Sprachdatei, Stylesheet beider Fenster,
        Typen der Flight-Control-API, Paketierung
```

Es gibt keinen gemeinsamen Code mit anderen Modulen. Die Kopplung an Flight Control läuft nur über dessen API-Vertrag
(`docs/api-contract.md` im Repo von Flight Control) und `relationships.requires`. Die Typen der API stehen als Kopie in
`v13/flight-control-api.d.ts` und werden zusammen mit `REQUIRED_API_VERSION` in `core/flight-control.ts` nachgeführt,
wenn sich die API ändert.

## Projekt und Prozess

Der Prozess (DAD-M) und alle Pläne liegen nicht in diesem Repo, sondern im Workspace-Ordner darüber (`dadm/`).
