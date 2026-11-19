# Hier & Jetzt

Web-App (PWA) für Android: Fotos und Videos aufnehmen und automatisch mit
**Datum/Uhrzeit**, **GPS-Koordinaten** (mit Genauigkeit) und **Adresse** stempeln.
Das Ergebnis wird angezeigt und kann heruntergeladen oder geteilt werden.

- **Foto:** Stempel wird beim Auslösen ins Bild geschrieben.
- **Video:** mit Ton, max. 2 Minuten, Full HD. Der Stempel läuft live mit
  (Uhrzeit sekundengenau, Koordinaten/Adresse aktualisieren sich bei Bewegung).
  Wird die App während der Aufnahme verlassen, wird das Video beendet und gespeichert.
- **Vorher / Nachher:** Vorher-Bild aus der Galerie wählen, Nachher-Foto live aufnehmen
  (Vorher-Bild wird zum Ausrichten halbtransparent eingeblendet). Beide Bilder werden
  zu einem Bild zusammengesetzt (Hochformat nebeneinander, Querformat untereinander).
- **Adresse & Notiz:** Die Adresse kann nur aus der direkten Umgebung gewählt werden
  (Hausnummern im Umkreis von ca. 80 m laut OpenStreetMap/Overpass, nur bei GPS-Genauigkeit
  bis ±100 m) – keine freie Eingabe, damit nicht manipuliert werden kann. Zuletzt verwendete
  Adressen erscheinen nur in der Nähe und lassen sich löschen. Dazu eine Notiz im Stempel.
- **Serie:** In der Foto-Kamera „Serie“ wählen, beliebig viele Fotos am Stück aufnehmen,
  mit „Fertig“ abschließen. Danach alle herunterladen, teilen, als ZIP oder als PDF-Bericht.
- **PDF-Bericht:** Fotobericht mit Firmenlogo, Adresse, Zeitraum und allen Fotos mit
  Zeit, Adresse, Koordinaten und Notiz (wird direkt auf dem Handy erzeugt).
- **Firmenlogo:** erscheint rechts im Stempel und im PDF-Kopf. Zum Austauschen einfach
  `branding/firmenlogo.png` ersetzen (PNG mit transparentem Hintergrund, am besten im Querformat).
- **Zeitabgleich:** Die Uhrzeit wird mit der Uhrzeit des Webservers abgeglichen. Der Stempel
  nutzt die geprüfte Zeit und zeigt „✓ Zeit geprüft“. Ohne Internet wird die Handyuhr
  verwendet und „Zeit ungeprüft“ angezeigt. Eine verstellte Handyuhr ändert die geprüfte Zeit nicht.
- **Name:** In den Einstellungen (Zahnrad oben rechts) den eigenen Namen eintragen. Er erscheint
  im Stempel („Aufgenommen von …“), im PDF-Bericht und in den EXIF-Daten.
- **Markieren:** Pfeil, Kreis, Stift und Text in vier Farben auf ein fertiges Foto zeichnen
  (Einzelfoto, Vorher/Nachher, Serien-Fotos in der Großansicht). Der Stempel bleibt unverändert,
  die Datei bekommt den Zusatz `_markiert`.
- **Verlauf:** Alle Aufnahmen bleiben 30 Tage nur auf dem Handy gespeichert (IndexedDB) und
  lassen sich später erneut herunterladen, teilen, markieren oder als PDF ausgeben.
- **Kamera:** Taschenlampe, Zoom (Buttons oder zwei Finger), Antippen zum Scharfstellen,
  Weitwinkel „0,6×“ (bei Handys wie Samsung als eigene Rückkamera erkannt).
- **Dateien:** Aufnahmezeit, GPS und Beschreibung stehen zusätzlich in den EXIF-Daten
  (z. B. für die Kartenansicht in Google Fotos). Dateiname mit Straße, z. B.
  `Foto_2026-11-19_14-32-05_Musterstrasse-12.jpg`.

- Keine Anmeldung, kein Server, keine Datenspeicherung online.
- Für die Adresse wird nur die GPS-Position an OpenStreetMap (Nominatim) gesendet.
- Ohne GPS wird das Foto trotzdem gespeichert, mit dem Hinweis „Kein Standort verfügbar“.
- Ohne Internet gibt es keine Adresse („Adresse nicht verfügbar“), Zeit und Koordinaten schon.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Seitenaufbau (Kamera, Verarbeitung, Ergebnis) |
| `style.css` | Aussehen |
| `app.js` | Kamera, GPS, Adresse, Stempel, Video, Vorher/Nachher, Download |
| `export.js` | PDF-Bericht und ZIP-Datei erzeugen |
| `branding/firmenlogo.png` | Firmenlogo (derzeit Testlogo) |
| `history.js` | Verlauf (Speicherung auf dem Handy, 30 Tage) |
| `editor.js` | Markieren (Pfeil, Kreis, Stift, Text) |
| `exif.js` | EXIF-Daten schreiben (Zeit, GPS, Beschreibung) und Aufnahmedatum lesen |
| `manifest.webmanifest`, `icons/` | Installation als App auf dem Handy |
| `sw.js` | Service Worker (App startet auch offline) |

Reines HTML/CSS/JavaScript, kein Build-Schritt nötig.

## Veröffentlichen mit GitHub Pages

1. Auf GitHub im Repository: **Settings → Pages**
2. Bei *Build and deployment*: Source **Deploy from a branch**, Branch **main**, Ordner **/ (root)** → **Save**
3. Nach ca. 1 Minute läuft die App unter `https://<benutzername>.github.io/fotoapp/`

Kamera und GPS funktionieren nur über **HTTPS**. Das erfüllt GitHub Pages automatisch.

## Auf dem Android-Handy installieren

1. Die Adresse in **Chrome** öffnen.
2. Kamera und Standort erlauben.
3. Menü (⋮) → **Zum Startbildschirm hinzufügen** / **App installieren**.

Heruntergeladene Fotos landen im Ordner **Downloads** und erscheinen in der Galerie bzw. in Google Fotos.

## Nach Änderungen

In `sw.js` die Versionsnummer (`fotoapp-v4` → `fotoapp-v5` …), in `index.html` die `?v=`-Nummer bei `style.css` und `app.js` sowie die angezeigte „Version“ erhöhen. Sonst kann das Handy eine Mischung aus alten und neuen Dateien laden.
