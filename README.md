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
- **Adresse & Notiz:** Die Adresse lässt sich aus einer Liste der Hausnummern in der Nähe
  (OpenStreetMap/Overpass, ca. 80 m) wählen oder von Hand eingeben. Dazu eine Notiz,
  die im Stempel erscheint. Zuletzt verwendete Adressen und Notizen werden auf dem Handy gemerkt.
- **Kamera:** Taschenlampe, Zoom (Buttons oder zwei Finger), Antippen zum Scharfstellen
  (je nachdem, was das Handy unterstützt).
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
