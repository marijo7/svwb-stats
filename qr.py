#!/usr/bin/env python3
"""QR コードの生成 (バイトモード / 誤り訂正レベル L / 型番 1〜5)。

用途は「PC の画面に出した URL をスマホのカメラで読む」ことだけなので、
仕様のうち必要な部分に絞ってある。URL は数十バイトしかなく、型番 5 の
106 バイトで足りる。この範囲はレベル L だと必ず 1 ブロックになるので、
複数ブロックのインターリーブは実装していない。

外部ライブラリは使わない (svwb-stats 自体が依存なしのため)。

    matrix = encode("http://192.168.1.5:8787")   # 暗モジュールの真偽値の 2 次元配列
    print(render(matrix))                        # 端末に出せる文字列
"""

from __future__ import annotations

# 型番ごとのデータ語数 / 誤り訂正語数 (レベル L、いずれも 1 ブロック)。
_DATA_CODEWORDS = {1: 19, 2: 34, 3: 55, 4: 80, 5: 108}
_EC_CODEWORDS = {1: 7, 2: 10, 3: 15, 4: 20, 5: 26}

# モード指示子 4 bit + 文字数指示子 8 bit = 2 語ぶんが常に載る。
MAX_BYTES = _DATA_CODEWORDS[5] - 2

_ECC_L = 0b01  # 形式情報に入れる誤り訂正レベル (L)


# --------------------------------------------------------------------------
# GF(256) — 誤り訂正語の計算に使う
# --------------------------------------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256


def _init_tables() -> None:
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:  # 原始多項式 x^8 + x^4 + x^3 + x^2 + 1
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_tables()


def _mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _generator_poly(degree: int) -> list[int]:
    """(x - a^0)(x - a^1)...(x - a^(degree-1)) の係数 (高次から)。"""
    poly = [1]
    for i in range(degree):
        nxt = [0] * (len(poly) + 1)
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _mul(coef, _EXP[i])
        poly = nxt
    return poly


def _ec_codewords(data: list[int], count: int) -> list[int]:
    gen = _generator_poly(count)
    rem = list(data) + [0] * count
    for i in range(len(data)):
        coef = rem[i]
        if coef:
            for j, g in enumerate(gen):
                rem[i + j] ^= _mul(g, coef)
    return rem[len(data):]


# --------------------------------------------------------------------------
# データの符号化
# --------------------------------------------------------------------------

def _pick_version(length: int) -> int:
    for version in sorted(_DATA_CODEWORDS):
        if length + 2 <= _DATA_CODEWORDS[version]:
            return version
    raise ValueError(f"QR に収まらない長さです ({length} バイト、上限 {MAX_BYTES})")


def _codewords(data: bytes, version: int) -> list[int]:
    capacity = _DATA_CODEWORDS[version]
    bits: list[int] = []

    def put(value: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            bits.append((value >> shift) & 1)

    put(0b0100, 4)      # バイトモード
    put(len(data), 8)   # 文字数指示子 (型番 1〜9 のバイトモードは 8 bit)
    for byte in data:
        put(byte, 8)

    put(0, min(4, capacity * 8 - len(bits)))    # 終端パターン
    bits.extend([0] * (-len(bits) % 8))         # 語境界まで詰める

    words = [int("".join(str(b) for b in bits[i:i + 8]), 2) for i in range(0, len(bits), 8)]
    for pad in _cycle_pad(capacity - len(words)):
        words.append(pad)
    return words


def _cycle_pad(count: int) -> list[int]:
    """余った語を埋める規定のパターン 0xEC / 0x11 の繰り返し。"""
    return [0xEC if i % 2 == 0 else 0x11 for i in range(count)]


# --------------------------------------------------------------------------
# 機能パターンの配置
# --------------------------------------------------------------------------

def _new_matrix(size: int) -> list[list[bool]]:
    return [[False] * size for _ in range(size)]


def _draw_finder(matrix: list[list[bool]], reserved: list[list[bool]],
                 size: int, top: int, left: int) -> None:
    """位置検出パターン (7x7) と、その周りの分離パターン。"""
    for dr in range(-1, 8):
        for dc in range(-1, 8):
            r, c = top + dr, left + dc
            if not (0 <= r < size and 0 <= c < size):
                continue
            ring = max(abs(dr - 3), abs(dc - 3))  # 中心からのチェビシェフ距離
            matrix[r][c] = ring != 2 and ring <= 3
            reserved[r][c] = True


def _draw_alignment(matrix: list[list[bool]], reserved: list[list[bool]],
                    center: int) -> None:
    """位置合わせパターン (5x5)。型番 2〜6 では右下に 1 個だけ置く。"""
    for dr in range(-2, 3):
        for dc in range(-2, 3):
            r, c = center + dr, center + dc
            matrix[r][c] = max(abs(dr), abs(dc)) != 1
            reserved[r][c] = True


def _draw_function_patterns(size: int, version: int) -> tuple[list[list[bool]], list[list[bool]]]:
    matrix = _new_matrix(size)
    reserved = _new_matrix(size)

    _draw_finder(matrix, reserved, size, 0, 0)
    _draw_finder(matrix, reserved, size, 0, size - 7)
    _draw_finder(matrix, reserved, size, size - 7, 0)

    for i in range(size):  # タイミングパターン
        if not reserved[6][i]:
            matrix[6][i] = i % 2 == 0
            reserved[6][i] = True
        if not reserved[i][6]:
            matrix[i][6] = i % 2 == 0
            reserved[i][6] = True

    if version >= 2:
        _draw_alignment(matrix, reserved, size - 7)

    for i in range(9):  # 形式情報の領域を確保しておく
        reserved[8][i] = True
        reserved[i][8] = True
    for i in range(8):
        reserved[8][size - 1 - i] = True
        reserved[size - 1 - i][8] = True

    matrix[size - 8][8] = True  # 常に暗いモジュール
    return matrix, reserved


def _place_data(matrix: list[list[bool]], reserved: list[list[bool]],
                size: int, words: list[int]) -> None:
    """右下から 2 列ずつ、上下に折り返しながらビットを置く。"""
    bits = [(word >> shift) & 1 for word in words for shift in range(7, -1, -1)]
    index = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:  # 縦のタイミングパターンの列は飛ばす
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for c in (col, col - 1):
                if reserved[row][c]:
                    continue
                if index < len(bits):
                    matrix[row][c] = bits[index] == 1
                index += 1  # 残余ビットは 0 のまま
        upward = not upward
        col -= 2


# --------------------------------------------------------------------------
# マスクと形式情報
# --------------------------------------------------------------------------

_MASKS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
]


def _apply_mask(matrix: list[list[bool]], reserved: list[list[bool]],
                size: int, mask: int) -> list[list[bool]]:
    rule = _MASKS[mask]
    out = [row[:] for row in matrix]
    for r in range(size):
        for c in range(size):
            if not reserved[r][c] and rule(r, c):
                out[r][c] = not out[r][c]
    return out


def _penalty(matrix: list[list[bool]], size: int) -> int:
    score = 0

    # 規則 1: 同色が 5 つ以上並ぶ
    for line in list(matrix) + [list(col) for col in zip(*matrix)]:
        run = 1
        for i in range(1, size):
            if line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)

    # 規則 2: 同色の 2x2
    for r in range(size - 1):
        for c in range(size - 1):
            if matrix[r][c] == matrix[r][c + 1] == matrix[r + 1][c] == matrix[r + 1][c + 1]:
                score += 3

    # 規則 3: 位置検出パターンに似た並び
    a = [True, False, True, True, True, False, True, False, False, False, False]
    b = list(reversed(a))
    for line in list(matrix) + [list(col) for col in zip(*matrix)]:
        for i in range(size - 10):
            window = line[i:i + 11]
            if window == a or window == b:
                score += 40

    # 規則 4: 暗モジュールの比率が 50% からどれだけ離れているか (5% 刻み)
    total = size * size
    dark = sum(row.count(True) for row in matrix)
    score += 10 * (abs(dark * 100 - total * 50) // (total * 5))
    return score


def _format_bits(mask: int) -> int:
    """形式情報 15 bit (誤り訂正レベル + マスク番号 + BCH 誤り訂正 + 規定の XOR)。"""
    data = (_ECC_L << 3) | mask
    rem = data << 10
    while rem.bit_length() > 10:
        rem ^= 0x537 << (rem.bit_length() - 11)
    return ((data << 10) | rem) ^ 0x5412


def _place_format(matrix: list[list[bool]], size: int, mask: int) -> None:
    bits = _format_bits(mask)

    def bit(i: int) -> bool:
        return (bits >> i) & 1 == 1

    for i in range(6):
        matrix[i][8] = bit(i)
    matrix[7][8] = bit(6)
    matrix[8][8] = bit(7)
    matrix[8][7] = bit(8)
    for i in range(9, 15):
        matrix[8][14 - i] = bit(i)

    for i in range(8):
        matrix[8][size - 1 - i] = bit(i)
    for i in range(8, 15):
        matrix[size - 15 + i][8] = bit(i)

    matrix[size - 8][8] = True


# --------------------------------------------------------------------------
# 公開 API
# --------------------------------------------------------------------------

def encode(text: str) -> list[list[bool]]:
    """text を QR にする。True が暗モジュール。余白 (クワイエットゾーン) は含まない。"""
    data = text.encode("utf-8")
    version = _pick_version(len(data))
    size = 17 + 4 * version

    words = _codewords(data, version)
    words += _ec_codewords(words, _EC_CODEWORDS[version])

    base, reserved = _draw_function_patterns(size, version)
    _place_data(base, reserved, size, words)

    best = None
    for mask in range(8):
        candidate = _apply_mask(base, reserved, size, mask)
        _place_format(candidate, size, mask)
        score = _penalty(candidate, size)
        if best is None or score < best[0]:
            best = (score, candidate)
    return best[1]


def render(matrix: list[list[bool]], quiet: int = 4) -> str:
    """端末に出せる文字列にする。1 文字の上下半分で 2 行ぶんを表す。

    背景色に依存しないよう、明暗を ANSI の色指定で明示する。端末が ANSI を
    解さない場合は読めない見た目になるので、呼び出し側で判断すること。
    """
    size = len(matrix)
    width = size + quiet * 2
    blank = [False] * width
    rows = [blank] * quiet
    rows += [[False] * quiet + row + [False] * quiet for row in matrix]
    rows += [blank] * quiet
    if len(rows) % 2:
        rows.append(blank)

    lines = []
    for i in range(0, len(rows), 2):
        top, bottom = rows[i], rows[i + 1]
        line = []
        current = None
        for c in range(width):
            # 暗モジュールを黒、明モジュールを白で塗る。文字の上半分が top。
            pair = (30 if top[c] else 37, 40 if bottom[c] else 47)
            if pair != current:
                line.append("\x1b[%d;%dm" % pair)
                current = pair
            line.append("▀")
        lines.append("".join(line) + "\x1b[0m")
    return "\n".join(lines)
