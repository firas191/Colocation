"""Generate the ingestion test fixtures (synthetic texts written for the tests;
they are not legal texts and must never be used as a source of law).
    python3 tests/fixtures/kb/make_fixtures.py
"""
from pathlib import Path

D = Path(__file__).resolve().parent

(D / "robots.txt").write_text("User-agent: *\nDisallow: /private/\n\nUser-agent: FlatshareKB\nDisallow: /private/\nDisallow: /blocked-for-us.html\n")

articles = "\n".join(
    f"<p><b>Article {n}</b></p><p>Texte synthétique de test numéro {n}. Le preneur paie le loyer convenu au bailleur "
    f"chaque mois. Cette phrase sert seulement au test du découpage en articles.</p>" for n in range(1, 13))
(D / "law_fr.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8"><title>Test</title>
<style>body{{}}</style><script>var tracking = 1;</script></head><body>
<nav><a href="/">Accueil</a> | <a href="/codes">Codes</a></nav>
<div id="content">
<h1>CODE DE TEST (synthétique)</h1>
<h2>TITRE PREMIER - DU LOUAGE DE TEST</h2>
{articles}
<h2>TITRE DEUXIÈME - DU DÉPÔT DE TEST</h2>
<p><b>Article 13</b></p><p>Le dépôt de garantie de test est restitué à la fin du bail fictif.</p>
</div>
<footer>© site de test</footer></body></html>""", encoding="utf-8")

ar = """<!doctype html><html><head><meta charset="windows-1256"><title>اختبار</title></head><body>
<div id="content"><h1>مجلة اختبار (نص مصطنع)</h1>
<p>الفصل 1 ـ هذا نص مصطنع للاختبار فقط. يدفع المكتري معين الكراء للمكري كل شهر.</p>
<p>الفصل 2 ـ يرجع الضمان عند انتهاء الكراء في هذا المثال المصطنع.</p>
<p>الفصل 3 ـ لا يجوز للمكتري أن يكري المحل لغيره إلا بإذن كتابي من المكري في هذا النص المصطنع للاختبار.</p>
<p>الفصل 4 ـ هذا الفصل موجود فقط ليكون النص أطول من الحد الأدنى المطلوب لاستخراج النصوص في الاختبارات.</p>
</div></body></html>"""
(D / "law_ar.html").write_bytes(ar.encode("cp1256"))

(D / "private" / "secret.html").write_text("<p>This page is disallowed by robots.txt and must never be fetched.</p>")
(D / "blocked-for-us.html").write_text("<p>Disallowed for FlatshareKB only.</p>")
(D / "empty.html").write_text("<html><body><nav>menu</nav></body></html>")


def pdf(pages):
    """Minimal text PDF, Helvetica, WinAnsi encoding (Latin-1 characters only)."""
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(len(pages)))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    font_id = 3 + 2 * len(pages)
    for i, lines in enumerate(pages):
        content = "BT /F1 11 Tf 72 760 Td 14 TL\n" + "\n".join(
            "(" + l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") '" for l in lines) + "\nET"
        data = content.encode("cp1252")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {4 + 2 * i} 0 R >>".encode())
        objs.append(b"<< /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, o in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


header = "GUIDE DE TEST (synthetique)"
p1 = [header, "Article 1", "Le guide de test explique que le contrat fictif doit etre enregistre dans un delai",
      "de soixante jours. Cette phrase est coupee sur deux lignes pour tester la jonction.", "Page 1"]
p2 = [header, "Article 2", "Le droit fixe fictif est de dix dinars par page dans ce document de test.", "Page 2"]
p3 = [header, "Article 3", "La colocation fictive exige l'accord ecrit du bailleur dans cet exemple.", "Page 3"]
(D / "guide.pdf").write_bytes(pdf([p1, p2, p3]))
print("fixtures written to", D)
