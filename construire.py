#!/usr/bin/env python3
"""Assemble www/index.html à partir de la page de l'appli (source/trajet.html) et du carnet local."""
import pathlib, re
racine = pathlib.Path(__file__).resolve().parent.parent
page = (racine / "source" / "trajet.html").read_text(encoding="utf-8")
carnet = (racine / "outils" / "carnet-local.js").read_text(encoding="utf-8")
# Pas de réseau : les polices en ligne sont retirées, le téléphone utilise les siennes
page = re.sub(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts\.googleapis\.com[^>]*>\n?', "", page)
m = re.match(r"\s*<title>(.*?)</title>\n?", page)
titre = m.group(1) if m else "Trajet"
page = page[m.end():] if m else page
tete = f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>{titre}</title>
<style>:root{{color-scheme:light dark;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;padding:0;-webkit-text-size-adjust:100%}}img{{max-width:100%}}[hidden]:not([hidden=until-found i]){{display:none!important}}button,input,textarea{{-webkit-tap-highlight-color:transparent}}</style>
<script>
{carnet}</script>
</head><body>
"""
(racine / "www").mkdir(exist_ok=True)
(racine / "www" / "index.html").write_text(tete + page + "\n</body></html>\n", encoding="utf-8")
print("www/index.html écrit,", len(tete + page), "caractères")
