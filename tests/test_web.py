"""ブラウザ側 (web/) の最低限の検査。

見た目や動きはここでは分からない。実際に開いて確かめるしかない部分は
CLAUDE.md のとおり。ここで見るのは「開く前に分かる壊れ方」だけ:

- HTML が読み込んでいる .js / .css が実在するか
- そのページが読み込む JS をつなげて構文が通るか (node があるときだけ)

2 つめは、この構成でいちばん起きやすい壊れ方を捕まえるためにある。
web/ の JS は ES モジュールではなく、common.js → stats.js → app.js の順に
読まれて最上位の const を共有する。関数を別ファイルへ移したときに宣言が
両方に残ると、読み込んだ瞬間に Identifier has already been declared で
ページが真っ白になる。1 ファイルずつ調べても見つからないので、
ページ単位でつなげてから調べる。
"""

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import svwb  # noqa: E402

PAGES = sorted(svwb.WEB_DIR.glob("*.html"))
SCRIPT_RE = re.compile(r'<script[^>]+src="([^"]+)"')
STYLE_RE = re.compile(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"')

NODE = shutil.which("node")


def scripts_of(page: Path) -> list[Path]:
    """そのページが読み込む JS を、書かれている順に返す。"""
    html = page.read_text(encoding="utf-8")
    return [svwb.WEB_DIR / src.lstrip("/") for src in SCRIPT_RE.findall(html)]


class TestWebAssets(unittest.TestCase):
    def test_pages_exist(self):
        self.assertIn("index.html", [p.name for p in PAGES])
        self.assertIn("tournament.html", [p.name for p in PAGES])

    def test_referenced_files_exist(self):
        """<script src> と <link href> の指す先が web/ にあるか。

        名前を変えたときの付け替え忘れは、開くまで気付かない (404 になった
        JS は黙って読まれないだけなので、画面が動かない理由も分からない)。
        """
        for page in PAGES:
            html = page.read_text(encoding="utf-8")
            for src in SCRIPT_RE.findall(html) + STYLE_RE.findall(html):
                with self.subTest(page=page.name, src=src):
                    self.assertTrue((svwb.WEB_DIR / src.lstrip("/")).is_file(),
                                    f"{page.name} が読み込む {src} が web/ に無い")

    @unittest.skipUnless(NODE, "node が無い環境では飛ばす (構文検査にだけ使う)")
    def test_each_page_parses(self):
        """ページが読み込む JS をつなげて構文検査する。

        node --check は構文しか見ない (実行はしない)。最上位の const が
        ファイルをまたいで重複していれば、ここで SyntaxError になる。
        """
        for page in PAGES:
            scripts = scripts_of(page)
            self.assertTrue(scripts, f"{page.name} が JS を 1 つも読み込んでいない")
            source = "\n".join(path.read_text(encoding="utf-8") for path in scripts)
            with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8") as tmp:
                tmp.write(source)
                tmp.flush()
                result = subprocess.run([NODE, "--check", tmp.name],
                                        capture_output=True, text=True)
            with self.subTest(page=page.name):
                self.assertEqual(result.returncode, 0,
                                 f"{page.name} ({' + '.join(p.name for p in scripts)}):\n"
                                 f"{result.stderr}")


if __name__ == "__main__":
    unittest.main()
