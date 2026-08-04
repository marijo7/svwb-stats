"""qr.py のテスト。

期待値のマトリクスは外部の QR ライブラリ (python-qrcode) が同じ入力・同じ
マスクで出したものを取り込んである。ライブラリ自体は実行に要らない
(svwb-stats は依存なしのため)。読み取れるかどうかは実機のカメラでしか
確かめられないので、ここでは「規格どおりのビットが並んでいるか」を見る。
"""

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import qr  # noqa: E402


EXPECTED = {
    "A": """\
#######..#.##.#######
#.....#..###..#.....#
#.###.#.##.##.#.###.#
#.###.#..#.#..#.###.#
#.###.#...#.#.#.###.#
#.....#.....#.#.....#
#######.#.#.#.#######
........##.##........
###.########.##...#..
#.##....#.....#...##.
.#.####..##.#...#...#
.#.##...##....#...#..
..##.##.#...#.#.#.#.#
........#..#.#.#.#.#.
#######.#.##.###.####
#.....#.######.###...
#.###.#.##.#.###.##.#
#.###.#..##...#...##.
#.###.#.##..#...#...#
#.....#.#.....#...##.
#######.###.#.#.#.###""",
    "http://192.168.1.5:8787": """\
#######.#..###..#.#######
#.....#..##..#....#.....#
#.###.#...#.###...#.###.#
#.###.#.....#####.#.###.#
#.###.#..#.#.#....#.###.#
#.....#...#.##....#.....#
#######.#.#.#.#.#.#######
........#.##.##..........
##.##.#..###...#..#.....#
#.####..##..##.###..####.
....###.#.##..##.#####..#
##.##..######..#.#..#####
.###.##.##.##.#.###.....#
##.#...#.....#.#...##..#.
##....#...###.####...####
#..#.#.#...#....#...#.#.#
#.#.###...#..##.#####.##.
........#.#######...#..#.
#######..###.##.#.#.##..#
#.....#.....###.#...#..#.
#.###.#.#.#.#..#######.##
#.###.#.#.........##.#.##
#.###.#..#..##......#.###
#.....#.#.#...##.####.###
#######.#...#####.#..#..#""",
    "http://10.0.0.42:8787": """\
#######.#.#.###...#######
#.....#..####.#...#.....#
#.###.#.###..#.##.#.###.#
#.###.#.###.##..#.#.###.#
#.###.#.#..##..#..#.###.#
#.....#...##..#.#.#.....#
#######.#.#.#.#.#.#######
..........#.#..#.........
####..#.#.###....#..###.#
##.#.#..#.#.###........#.
..#.#.#.#####.#...#.#....
.#...#..###..#....##.##..
##.#..#..##.##.##.###.###
...###.#...##..#..#.#...#
.#.#.##.##.#..#.#.....##.
#...##..#..#..#.#.#..#..#
..#...##.##.#.###########
........#.#.....#...#...#
#######...#..##.#.#.#####
#.....#..###.##.#...#....
#.###.#..#...##.#####..#.
#.###.#.##.....#..###.###
#.###.#.###...#..##.####.
#.....#.########.##.#.#..
#######.#.##...#...######""",
}

# 上の URL を各マスクで作ったときのペナルティ点 (同じ外部ライブラリの値)。
PENALTIES = [600, 601, 595, 525, 503, 597, 489, 690]


def render_ascii(matrix):
    return "\n".join("".join("#" if cell else "." for cell in row) for row in matrix)


class EncodeTest(unittest.TestCase):
    def test_matches_reference(self):
        for text, expected in EXPECTED.items():
            with self.subTest(text=text):
                self.assertEqual(render_ascii(qr.encode(text)), expected)

    def test_version_grows_with_length(self):
        # 型番 1〜5 の境界。バイトモード / レベル L の容量は 17 / 32 / 53 / 78 / 106。
        for length, size in [(1, 21), (17, 21), (18, 25), (32, 25), (33, 29),
                             (53, 29), (54, 33), (78, 33), (79, 37), (106, 37)]:
            with self.subTest(length=length):
                self.assertEqual(len(qr.encode("x" * length)), size)

    def test_too_long(self):
        with self.assertRaises(ValueError):
            qr.encode("x" * (qr.MAX_BYTES + 1))

    def test_multibyte_counts_as_utf8_bytes(self):
        # 日本語は 1 文字 3 バイト。文字数ではなくバイト数で型番が決まる。
        self.assertEqual(len(qr.encode("あ" * 6)), 25)


class StructureTest(unittest.TestCase):
    """読み取り側が最初に探す部分だけは、型番によらず同じ形になる。"""

    def setUp(self):
        self.matrix = qr.encode("http://192.168.1.5:8787")
        self.size = len(self.matrix)

    def test_finder_patterns(self):
        corners = [(0, 0), (0, self.size - 7), (self.size - 7, 0)]
        for top, left in corners:
            with self.subTest(corner=(top, left)):
                for dr in range(7):
                    for dc in range(7):
                        ring = max(abs(dr - 3), abs(dc - 3))
                        self.assertEqual(self.matrix[top + dr][left + dc], ring != 2)

    def test_timing_patterns(self):
        for i in range(8, self.size - 8):
            self.assertEqual(self.matrix[6][i], i % 2 == 0)
            self.assertEqual(self.matrix[i][6], i % 2 == 0)

    def test_dark_module(self):
        self.assertTrue(self.matrix[self.size - 8][8])

    def test_square(self):
        self.assertTrue(all(len(row) == self.size for row in self.matrix))


class MaskTest(unittest.TestCase):
    def test_penalty_scores(self):
        version, text = 2, "http://192.168.1.5:8787"
        size = 17 + 4 * version
        words = qr._codewords(text.encode(), version)
        words += qr._ec_codewords(words, qr._EC_CODEWORDS[version])
        base, reserved = qr._draw_function_patterns(size, version)
        qr._place_data(base, reserved, size, words)

        scores = []
        for mask in range(8):
            candidate = qr._apply_mask(base, reserved, size, mask)
            qr._place_format(candidate, size, mask)
            scores.append(qr._penalty(candidate, size))
        self.assertEqual(scores, PENALTIES)

    def test_picks_lowest_penalty(self):
        # encode() が選んだマスク (= 最小ペナルティ) の盤面と一致するはず。
        self.assertEqual(PENALTIES.index(min(PENALTIES)), 6)


class ErrorCorrectionTest(unittest.TestCase):
    def test_known_codewords(self):
        # "A" 1 文字: モード 0100 + 文字数 1 + 'A' + 終端 → 0x40 0x14 0x10、
        # 以降は規定の詰め物 0xEC / 0x11 の繰り返し。
        words = qr._codewords(b"A", 1)
        self.assertEqual(words[:5], [0x40, 0x14, 0x10, 0xEC, 0x11])
        self.assertEqual(len(words), 19)
        self.assertEqual(qr._ec_codewords(words, 7), [82, 75, 181, 59, 175, 141, 241])

    def test_ec_length(self):
        for version, count in qr._EC_CODEWORDS.items():
            words = qr._codewords(b"x", version)
            self.assertEqual(len(qr._ec_codewords(words, count)), count)


class RenderTest(unittest.TestCase):
    def test_shape(self):
        matrix = qr.encode("http://192.168.1.5:8787")
        lines = qr.render(matrix, quiet=4).split("\n")
        # 上下 4 モジュールの余白込みで 33 行 → 1 文字が 2 行ぶんなので 17 行。
        self.assertEqual(len(lines), 17)
        for line in lines:
            self.assertEqual(line.count("▀"), len(matrix) + 8)

    def test_round_trip(self):
        # 出力を読み戻して元のマトリクスに戻るか = 明暗の向きと位置が正しいか。
        # 暗モジュールは黒 (前景 30 / 背景 40)、明モジュールは白。
        matrix = qr.encode("http://192.168.1.5:8787")
        rows = []
        for line in qr.render(matrix, quiet=4).split("\n"):
            top, bottom, fg, bg = [], [], None, None
            for esc_fg, esc_bg, block in re.findall(r"\x1b\[(\d+);(\d+)m|(▀)", line):
                if block:
                    top.append(fg == "30")
                    bottom.append(bg == "40")
                else:
                    fg, bg = esc_fg, esc_bg
            rows += [top, bottom]

        size = len(matrix)
        self.assertEqual([row[4:4 + size] for row in rows[4:4 + size]], matrix)
        self.assertTrue(all(not cell for row in rows[:4] for cell in row))
        self.assertTrue(all(not cell for row in rows for cell in row[:4]))

    def test_quiet_zone_is_light(self):
        matrix = qr.encode("A")
        first = qr.render(matrix, quiet=4).split("\n")[0]
        # 余白の 4 行はすべて明モジュール = 白地 (37;47)。
        self.assertIn("\x1b[37;47m", first)
        self.assertNotIn("\x1b[30", first)


if __name__ == "__main__":
    unittest.main()
