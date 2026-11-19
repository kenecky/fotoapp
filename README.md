# FotoApp

Web-App (PWA) für Android: Fotos und Videos aufnehmen und automatisch mit
**Datum/Uhrzeit**, **GPS-Koordinaten** (mit Genauigkeit) und **Adresse** stempeln.
Das Ergebnis wird angezeigt und kann heruntergeladen oder geteilt werden.

- **Foto:** Stempel wird beim Auslösen ins Bild geschrieben.
- **Video:** mit Ton, max. 2 Minuten, Full HD. Der Stempel läuft live mit
  (Uhrzeit sekundengenau, Koordinaten/Adresse aktualisieren sich bei Bewegung).
  Wird die App während der Aufnahme verlassen, wird das Video beendet und gespeichert.

- Keine Anmeldung, kein Server, keine Datenspeicherung online.
- Für die Adresse wird nur die GPS-Position an OpenStreetMap (Nominatim) gesendet.
- Ohne GPS wird das Foto trotzdem gespeichert, mit dem Hinweis „Kein Standort verfügbar“.
- Ohne Internet gibt es keine Adresse („Adresse nicht verfügbar“), Zeit und Koordinaten schon.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Seitenaufbau (Kamera, Verarbeitung, Ergebnis) |
| `style.css` | Aussehen |
| `app.js` | Kamera, GPS, Adresse, Stempel, Download |
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

In `sw.js` die Versionsnummer (`fotoapp-v1` → `fotoapp-v2` …) erhöhen, damit die Handys die neue Version sicher laden.
