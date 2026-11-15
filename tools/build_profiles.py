#!/usr/bin/env python3
"""Erzeugt die drei Routing-Profile der App aus den offiziellen BRouter-Profilen
(fastbike, trekking, gravel; BRouter 1.7.8, MIT-Lizenz) und ergänzt gewichtbare
Variablen (kv_*), die die App vor dem Hochladen einsetzt.
Aufruf: python3 tools/build_profiles.py
"""
import pathlib, sys
here = pathlib.Path(__file__).parent
out = here.parent / "profiles"

def patch(text, old, new, count=1):
    if text.count(old) < 1:
        sys.exit(f"Patch-Stelle nicht gefunden: {old[:60]!r}")
    return text.replace(old, new, count)

KV_COMMON = """
# --- App-Variablen (werden von der App gesetzt) ---
assign kv_traffic = 1.0
assign kv_noise   = 0.0
assign kv_river   = 0.0
assign kv_forest  = 0.0
assign kv_town    = 0.0
assign kv_nomain  = 0.0
"""

# ---------------------------------------------------------------- Rennrad
t = (here / "fastbike.brf").read_text()
t = patch(t, "assign consider_traffic      = 1 ", "assign consider_traffic      = 1.0 ")
for k in ("noise", "river", "forest", "town"):
    t = patch(t, f"assign consider_{k}        = false".replace("        ", " " * (13 - len(k))), f"assign consider_{k} = true ")
t = patch(t, "---context:way", KV_COMMON + """assign kv_cobble   = 1.5
assign kv_unpaved  = 0.0
assign kv_cycleway = 1.15

---context:way""")
t = patch(t, """  add trafficpenalty
  add town_penalty
  add no_forest_penalty
  add no_river_penalty
  add noise_penalty
""", """  add multiply kv_traffic trafficpenalty
  add multiply kv_town town_penalty
  add multiply kv_forest no_forest_penalty
  add multiply kv_river no_river_penalty
  add multiply kv_noise noise_penalty
  add ( if highway=primary|primary_link|trunk|trunk_link then kv_nomain else 0 )
  add ( if surface=cobblestone|sett then kv_cobble else 0 )
  add ( if isunpaved then kv_unpaved else 0 )
""")
t = patch(t, "  switch    highway=cycleway                          1.3",
             "  switch    highway=cycleway                          kv_cycleway")
(out / "rennrad.brf").write_text(t)

# ---------------------------------------------------------------- Alltag
t = (here / "trekking.brf").read_text()
for k in ("noise  ", "river  ", "forest ", "town   ", "traffic"):
    t = patch(t, f"assign   consider_{k}         = false", f"assign   consider_{k}         = true ")
t = patch(t, "---context:way", KV_COMMON + "\n---context:way")
t = patch(t, """  add town_penalty
  add no_forest_penalty
  add no_river_penalty
  add noise_penalty
  add traffic_penalty
""", """  add multiply kv_town town_penalty
  add multiply kv_forest no_forest_penalty
  add multiply kv_river no_river_penalty
  add multiply kv_noise noise_penalty
  add multiply kv_traffic traffic_penalty
  add ( if highway=primary|primary_link|trunk|trunk_link then kv_nomain else 0 )
""")
(out / "alltag.brf").write_text(t)

# ---------------------------------------------------------------- Gravel
t = (here / "gravel.brf").read_text()
for old in ("consider_traffic_estimate false", "prefer_forests false", "prefer_rivers false",
            "avoid_towns false", "avoid_noise false"):
    t = patch(t, "assign " + old, "assign " + old.replace("false", "true "))
t = patch(t, "---context:way", KV_COMMON.replace("kv_nomain  = 0.0", "kv_nomain  = 1.0") + """assign kv_path = 1.5

---context:way""")
t = patch(t, """    multiply noforestpenalty multiply noisepenalty
    multiply trafficpenalty multiply townpenalty
""", """    multiply ( add 1 multiply kv_forest ( sub noforestpenalty 1 ) )
    multiply ( add 1 multiply kv_noise ( sub noisepenalty 1 ) )
    multiply ( add 1 multiply kv_traffic ( sub trafficpenalty 1 ) )
    multiply ( add 1 multiply kv_town ( sub townpenalty 1 ) )
    multiply ( switch highway=primary|primary_link|trunk|trunk_link kv_nomain 1 )
""")
t = patch(t, "    multiply notcycleroutepenalty multiply noriverpenalty",
             "    multiply notcycleroutepenalty multiply ( add 1 multiply kv_river ( sub noriverpenalty 1 ) )")
t = patch(t, "    switch    highway=path                                      pathpenalty",
             "    switch    highway=path                                      ( max 1 multiply kv_path pathpenalty )")
(out / "gravel.brf").write_text(t)
print("ok")
