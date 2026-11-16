# Rückenwind – Routenplaner fürs Rad

Web-App zum Planen von Radtouren mit Rennrad, Gravelbike oder Alltagsrad. Läuft komplett im Browser (Mac und Handy), ohne eigenen Server, und lässt sich am Handy auf den Startbildschirm legen.

## Was die App kann

- Route von A nach B mit beliebig vielen Zwischenzielen, per Suche oder Tippen auf die Karte
- Wandern mit Schwierigkeitsgrenze nach SAC-Wanderskala (T1 bis T6, mit den Farben des Alpenvereins), Gehzeit nach DIN 33466
- Drei Radprofile (Rennrad, Gravel, Alltag) mit Optionen für Autoverkehr, Höhenmeter, Wald, Flüsse, Ortschaften, Untergrund und mehr
- Sperrzonen, um bestimmte Straßen oder Gebiete zu meiden
- Bis zu vier Routenvarianten
- Höhenprofil mit Steigungsfarben, Untergrund und Wegtypen
- GPX-Export (z. B. für Garmin Edge)
- Einstellungen, Favoriten und die letzte Tour werden lokal im Browser gespeichert

- Hin und zurück sowie automatische Rundtouren nach Wunschlänge, Richtung und Höhenmeter-Vorliebe
- Umweg von A nach B auf Wunschlänge, Stopps an der Strecke (Trinkwasser, Café, Einkehr, Supermarkt, Radladen)
- Anstiege einzeln ausgewiesen, Fahrzeit aus Steigung und Untergrund berechnet
- Tour-Link zum Teilen, Regenradar als Überlagerung, Rundtour über einen Wunschpunkt
- Touren speichern, GPX-Import
- Navigation (nur am Handy oder Tablet): Karte folgt dem Standort in Fahrtrichtung, Abbiegehinweise, Neuberechnung bei Abweichung (mit Internet)
- Offline-Modus: gespeicherte Tour mit Standardkarte (Streifen um die Route) und Stopps aufs Gerät laden, unterwegs mit Standort ansehen
- Wetter und Wind entlang der Strecke zur gewählten Abfahrtszeit, Empfehlung für Startzeit und Fahrtrichtung, Rundtouren mit Rückenwind auf dem Heimweg

## Dienste und Daten

| Zweck | Dienst |
|---|---|
| Routing | [BRouter](https://brouter.de) (öffentlicher Server) |
| Karten | [OpenFreeMap](https://openfreemap.org) (Standard), [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), TopPlusOpen (BKG), basemap.at, Esri (Satellit); Routen-Überlagerung von [Waymarked Trails](https://waymarkedtrails.org) |
| Wetter | [Open-Meteo](https://open-meteo.com) |
| Stopps | [Overpass API](https://overpass-api.de) |
| Regenradar | [RainViewer](https://www.rainviewer.com) |
| Suche | [Photon](https://photon.komoot.io) |
| Kartendaten | © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende |

## Aufbau

- `index.html`, `css/app.css`, `js/` – die App (kein Build-Schritt nötig)
  - `js/app.js` – Oberfläche und Ablauf
  - `js/routing.js` – Profile, BRouter-Abfrage, Auswertung der Strecke, GPX
  - `js/roundtrip.js` – Rundtouren und Umwege auf Wunschlänge
  - `js/weather.js` – Wetter und Wind entlang der Strecke
  - `js/pois.js` – Stopps an der Strecke
  - `js/offline.js` – Offline-Touren
  - `js/elevation.js` – Höhenprofil
- `sw.js` – Service Worker (App-Dateien und Offline-Karte)
- `profiles/` – Routing-Profile, die die App an BRouter schickt
- `tools/build_profiles.py` – erzeugt die Profile aus den offiziellen BRouter-Profilen in `tools/`
- `vendor/` – MapLibre GL JS und die Schrift Barlow

Lokal starten: `python3 -m http.server` im Projektordner, dann `http://localhost:8000` öffnen.

## Lizenzen der enthaltenen Teile

- Routing-Profile: abgeleitet von den BRouter-Profilen `fastbike`, `trekking`, `gravel` und `hiking-mountain` (MIT-Lizenz, © Arndt Brenschede und Mitwirkende)
- MapLibre GL JS: BSD-3-Clause
- Barlow: SIL Open Font License 1.1
