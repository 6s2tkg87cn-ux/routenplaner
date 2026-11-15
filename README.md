# Rückenwind – Routenplaner fürs Rad

Web-App zum Planen von Radtouren mit Rennrad, Gravelbike oder Alltagsrad. Läuft komplett im Browser (Mac und Handy), ohne eigenen Server, und lässt sich am Handy auf den Startbildschirm legen.

## Was die App kann

- Route von A nach B mit beliebig vielen Zwischenzielen, per Suche oder Tippen auf die Karte
- Drei Profile (Rennrad, Gravel, Alltag) mit Optionen für Autoverkehr, Höhenmeter, Wald, Flüsse, Ortschaften, Untergrund und mehr
- Sperrzonen, um bestimmte Straßen oder Gebiete zu meiden
- Bis zu vier Routenvarianten
- Höhenprofil mit Steigungsfarben, Untergrund und Wegtypen
- GPX-Export (z. B. für Garmin Edge)
- Einstellungen, Favoriten und die letzte Tour werden lokal im Browser gespeichert

- Hin und zurück sowie automatische Rundtouren nach Wunschlänge, Richtung und Höhenmeter-Vorliebe
- Umweg von A nach B auf Wunschlänge, Stopps an der Strecke (Trinkwasser, Café, Einkehr, Supermarkt, Radladen)
- Touren speichern, GPX-Import
- Wetter und Wind entlang der Strecke zur gewählten Abfahrtszeit, Empfehlung für Startzeit und Fahrtrichtung, Rundtouren mit Rückenwind auf dem Heimweg

## Dienste und Daten

| Zweck | Dienst |
|---|---|
| Routing | [BRouter](https://brouter.de) (öffentlicher Server) |
| Karten | [OpenFreeMap](https://openfreemap.org) (Standard), [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), Esri (Satellit) |
| Wetter | [Open-Meteo](https://open-meteo.com) |
| Stopps | [Overpass API](https://overpass-api.de) |
| Suche | [Photon](https://photon.komoot.io) |
| Kartendaten | © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende |

## Aufbau

- `index.html`, `css/app.css`, `js/` – die App (kein Build-Schritt nötig)
- `profiles/` – Routing-Profile, die die App an BRouter schickt
- `tools/build_profiles.py` – erzeugt die Profile aus den offiziellen BRouter-Profilen in `tools/`
- `vendor/` – MapLibre GL JS und die Schrift Barlow

Lokal starten: `python3 -m http.server` im Projektordner, dann `http://localhost:8000` öffnen.

## Lizenzen der enthaltenen Teile

- Routing-Profile: abgeleitet von den BRouter-Profilen `fastbike`, `trekking` und `gravel` (MIT-Lizenz, © Arndt Brenschede und Mitwirkende)
- MapLibre GL JS: BSD-3-Clause
- Barlow: SIL Open Font License 1.1
