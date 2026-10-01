"""Windows PowerShell 5.1 reads a .ps1 file without a byte-order mark as the
ANSI code page, so any non-ASCII character in a script is changed before it
runs (FAILURES F-027). Scripts stay ASCII; non-ASCII text is written as escapes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_powershell_scripts_are_ascii():
    for p in sorted((ROOT / "scripts" / "windows").glob("*.ps1")):
        data = p.read_bytes()
        bad = [i for i, b in enumerate(data) if b > 127]
        assert not bad, f"{p.name}: non-ASCII byte at offset {bad[0]}"
