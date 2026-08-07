#!/usr/bin/env python3
"""svwb-stats — Shadowverse: Worlds Beyond の戦績管理ツール。

ブラウザから戦績を入力し、勝率を集計する。標準ライブラリのみで動作する。

    python3 svwb.py serve            # http://127.0.0.1:8787 を開く
    python3 svwb.py serve --host 0.0.0.0   # 同じ LAN のスマホからも入力できるようにする
    python3 svwb.py stats            # 集計をターミナルに出す
    python3 svwb.py stats --json     # 集計を JSON で出す

戦績は JSONL (1 行 1 試合) として data/records.jsonl に追記される。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import threading
import unicodedata
import uuid
import webbrowser
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

if sys.version_info < (3, 9):
    # start.bat は「Python が動くか」しか見ていないので、
    # 古すぎる Python を掴んだ場合はここで分かりやすく止める。
    raise SystemExit(
        "svwb-stats needs Python 3.9 or newer "
        f"(this is {sys.version.split()[0]}).\n"
        "Windows: install Python 3 from the Microsoft Store, then try again."
    )

import qr  # 同じディレクトリの自作モジュール (LAN 起動時の QR 表示にだけ使う)

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
CONFIG_PATH = ROOT / "config.json"
DEFAULT_DATA_PATH = ROOT / "data" / "records.jsonl"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TURNS = ("first", "second")
RESULTS = ("win", "loss")

#: 記録した画面。ランクマッチ (index.html) と大会 (tournament.html) を分ける。
#: mode を持たない古い戦績はすべてランクマッチとして扱う。
MODES = ("ladder", "tournament")
DEFAULT_MODE = "ladder"

#: 絞り込みで指定できるモード。"all" は絞り込まない、という指定であって
#: 戦績に保存される値ではない (保存できるのは MODES のみ)。
#:
#: 何も指定しないときが "all" ではなく "ladder" なのは、ランクマッチと大会が
#: 別形式 (大会は 2 デッキ BO1) で、混ぜた勝率が何を意味するのか説明できないため。
#: 混ぜたいときは指定して混ぜる。
FILTER_MODES = MODES + ("all",)

#: 集計の対象としてターミナルに出す表示名。
MODE_LABELS = {"ladder": "ランクマッチ", "tournament": "大会 (2 デッキ BO1)",
               "all": "ランクマッチ + 大会"}

#: 入力を受け付ける自由記述フィールドの最大長。
MAX_TEXT = 120
MAX_NOTE = 1000

#: CR の受け付け上限。ゲーム側の上限ではなく、桁の打ち間違いを弾くための入力ガード。
MAX_CR = 99999

#: ラウンド数の受け付け上限。CR と同じく打ち間違いを弾くための入力ガード。
MAX_ROUND = 99


# --------------------------------------------------------------------------
# 設定
# --------------------------------------------------------------------------

def load_config(path: Path = CONFIG_PATH) -> dict:
    """クラス / ランク / グレードの一覧を読む。

    増減は config.json を編集するだけで UI と検証の両方に反映される。

    `grade_rank` は「グレードが付くランク」の名前 (Grand Master)。CR グレードは
    グラマス昇格後にしか存在しないので、相手ランクがこの値と一致するときだけ
    相手グレードと相手 CR を受け付ける。空にすると結び付けを行わない。

    `grade_thresholds` は「そのグレードに必要な最低 CR」。相手 CR を入力したときの
    相手グレード自動設定に使う。CR だけでは決まらないグレード (BEYOND は LEGEND の
    うちランキング上位のみ) は載せない。載っていないグレードは自動設定の対象外に
    なり、手で選んだ値として扱われる。
    """
    with path.open(encoding="utf-8") as fp:
        config = json.load(fp)
    classes = [str(c) for c in config.get("classes", [])]
    ranks = [str(r) for r in config.get("ranks", [])]
    grades = [str(g) for g in config.get("grades", [])]
    grade_rank = str(config.get("grade_rank", "") or "")
    if not classes:
        raise ValueError(f"{path}: classes が空です")
    if grade_rank and grade_rank not in ranks:
        raise ValueError(f"{path}: grade_rank '{grade_rank}' が ranks にありません")

    thresholds: dict[str, int] = {}
    for grade, min_cr in (config.get("grade_thresholds") or {}).items():
        if grade not in grades:
            raise ValueError(f"{path}: grade_thresholds の '{grade}' が grades にありません")
        if not isinstance(min_cr, int) or isinstance(min_cr, bool):
            raise ValueError(f"{path}: grade_thresholds['{grade}'] は整数で指定してください")
        thresholds[str(grade)] = min_cr

    return {"classes": classes, "ranks": ranks, "grades": grades,
            "grade_rank": grade_rank, "grade_thresholds": thresholds}


# --------------------------------------------------------------------------
# 検証
# --------------------------------------------------------------------------

class ValidationError(ValueError):
    """入力エラー。まとめて返せるようにフィールド単位のメッセージを持つ。"""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


def _text(value, field: str, limit: int, errors: dict[str, str]) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        errors[field] = "文字列で指定してください"
        return ""
    value = value.strip()
    if len(value) > limit:
        errors[field] = f"{limit} 文字以内で指定してください"
    return value


def validate_record(payload: dict, config: dict) -> dict:
    """API から受け取った 1 試合分の入力を検証して正規化する。

    未知のキーは落とす。id / created_at はサーバー側で採番するため入力を無視する。
    """
    if not isinstance(payload, dict):
        raise ValidationError({"_": "オブジェクトを送ってください"})

    errors: dict[str, str] = {}
    record: dict = {}

    played_at = payload.get("played_at") or date.today().isoformat()
    if not isinstance(played_at, str) or not DATE_RE.match(played_at):
        errors["played_at"] = "YYYY-MM-DD 形式で指定してください"
    else:
        try:
            date.fromisoformat(played_at)
        except ValueError:
            errors["played_at"] = "存在しない日付です"
    record["played_at"] = played_at

    for field in ("my_class", "opp_class"):
        value = payload.get(field)
        if value not in config["classes"]:
            errors[field] = "クラスを選択してください"
        record[field] = value if isinstance(value, str) else ""

    for field, limit in (("my_deck", MAX_TEXT), ("opp_deck", MAX_TEXT), ("note", MAX_NOTE)):
        record[field] = _text(payload.get(field), field, limit, errors)

    turn = payload.get("turn")
    if turn not in TURNS:
        errors["turn"] = "先攻 / 後攻 を選択してください"
    record["turn"] = turn if turn in TURNS else ""

    result = payload.get("result")
    if result not in RESULTS:
        errors["result"] = "勝ち / 負け を選択してください"
    record["result"] = result if result in RESULTS else ""

    # 相手のランク帯。相手グレード / 相手 CR を受け付けるかの判定にも使う
    # (グレードと CR はグラマス昇格後にしか存在しないため)。
    rank = payload.get("opp_rank") or ""
    if rank and rank not in config["ranks"]:
        errors["opp_rank"] = "ランクの選択肢にありません"
    record["opp_rank"] = rank if isinstance(rank, str) else ""

    # 相手のグレード。CR と同じく、その帯にしかグレードが無いので
    # 自分のランクが grade_rank のときだけ受け付ける。
    grade = payload.get("opp_grade") or ""
    grade_rank = config.get("grade_rank", "")
    if grade and grade not in config.get("grades", []):
        errors["opp_grade"] = "グレードの選択肢にありません"
    elif grade and grade_rank and record["opp_rank"] != grade_rank:
        errors["opp_grade"] = f"相手グレードは相手が {grade_rank} のときだけ記録できます"
    record["opp_grade"] = grade if isinstance(grade, str) else ""

    # 相手の CR。グレードと同じくグラマス帯のみ (CR 自体がその帯にしか無い)。
    # 未入力は "" ではなく None で持つ (数値フィールドなので、空文字より null の
    # ほうが後段で扱いやすい)。
    record["opp_cr"] = None
    cr_raw = payload.get("opp_cr")
    if cr_raw is not None and cr_raw != "":
        if isinstance(cr_raw, bool):
            errors["opp_cr"] = "整数で指定してください"
        else:
            try:
                opp_cr = int(cr_raw)
            except (TypeError, ValueError):
                errors["opp_cr"] = "整数で指定してください"
            else:
                if not 0 <= opp_cr <= MAX_CR:
                    errors["opp_cr"] = f"0〜{MAX_CR} の範囲で指定してください"
                elif grade_rank and record["opp_rank"] != grade_rank:
                    errors["opp_cr"] = f"相手 CR は相手が {grade_rank} のときだけ記録できます"
                else:
                    record["opp_cr"] = opp_cr

    # 大会 (2 デッキ BO1) 用の項目。ランクマッチの記録には付かない。
    mode = payload.get("mode") or DEFAULT_MODE
    if mode not in MODES:
        errors["mode"] = "モードの選択肢にありません"
        mode = DEFAULT_MODE
    record["mode"] = mode
    tournament = mode == "tournament"

    # 大会名・対戦相手・ラウンド・相手のもう 1 デッキは大会モード専用。ランクマッチの
    # 記録に紛れ込むと「この大会だけの集計」が信用できなくなるので、ここで弾く。
    for field in ("event", "opponent", "opp_deck2"):
        value = _text(payload.get(field), field, MAX_TEXT, errors)
        if value and not tournament:
            errors[field] = "大会モードのときだけ記録できます"
        record[field] = value

    # 相手が持ち込んだもう 1 デッキのクラス。BO1 では当たらないことも多いので、
    # 対戦したクラス (opp_class) と違って未入力を許す。
    opp_class2 = payload.get("opp_class2") or ""
    if opp_class2 and opp_class2 not in config["classes"]:
        errors["opp_class2"] = "クラスの選択肢にありません"
    elif opp_class2 and not tournament:
        errors["opp_class2"] = "大会モードのときだけ記録できます"
    record["opp_class2"] = opp_class2 if isinstance(opp_class2, str) else ""

    record["round"] = None
    round_raw = payload.get("round")
    if round_raw is not None and round_raw != "":
        if isinstance(round_raw, bool):
            errors["round"] = "整数で指定してください"
        else:
            try:
                round_no = int(round_raw)
            except (TypeError, ValueError):
                errors["round"] = "整数で指定してください"
            else:
                if not 1 <= round_no <= MAX_ROUND:
                    errors["round"] = f"1〜{MAX_ROUND} の範囲で指定してください"
                elif not tournament:
                    errors["round"] = "大会モードのときだけ記録できます"
                else:
                    record["round"] = round_no

    if errors:
        raise ValidationError(errors)
    return record


# --------------------------------------------------------------------------
# 永続化
# --------------------------------------------------------------------------

class RecordStore:
    """JSONL ファイルを 1 行 1 試合として読み書きする。

    追加は追記のみ。更新 / 削除のときだけ全体を書き直す。行単位なので
    git の差分がそのまま「その日足した試合」になる。
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        records = []
        with self.path.open(encoding="utf-8") as fp:
            for lineno, line in enumerate(fp, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{self.path}:{lineno} が壊れています: {exc}") from exc
        return records

    def _write_all(self, records: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fp:
            for record in records:
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")
        tmp.replace(self.path)

    def list(self) -> list[dict]:
        with self._lock:
            records = self._read_all()
        records.sort(key=lambda r: (r.get("played_at", ""), r.get("created_at", "")))
        return records

    def add(self, record: dict) -> dict:
        record = dict(record)
        record["id"] = uuid.uuid4().hex
        record["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    def update(self, record_id: str, fields: dict) -> dict | None:
        with self._lock:
            records = self._read_all()
            updated = None
            for record in records:
                if record.get("id") == record_id:
                    record.update(fields)
                    record["id"] = record_id
                    updated = record
                    break
            if updated is None:
                return None
            self._write_all(records)
        return updated

    def delete(self, record_id: str) -> bool:
        with self._lock:
            records = self._read_all()
            remaining = [r for r in records if r.get("id") != record_id]
            if len(remaining) == len(records):
                return False
            self._write_all(remaining)
        return True


# --------------------------------------------------------------------------
# 集計
# --------------------------------------------------------------------------

def _rate(wins: int, games: int) -> float:
    return wins / games if games else 0.0


def _tally(records: list[dict]) -> dict:
    wins = sum(1 for r in records if r.get("result") == "win")
    games = len(records)
    return {"games": games, "wins": wins, "losses": games - wins, "winrate": _rate(wins, games)}


def _breakdown(records: list[dict], key: str, fallback: str = "(未設定)",
               sub_key: str = "") -> list[dict]:
    """key ごとに集計し、試合数の多い順に並べて返す。

    sub_key を渡すと、各行の中をさらにその項目で割った内訳を "sub" に入れる
    (相手クラス別の中の相手デッキ別など)。画面はこれを畳んで持っておき、
    行を開いたときに出す。ここでも数えるのは Python 側だけ。
    """
    buckets: dict[str, list[dict]] = {}
    for record in records:
        buckets.setdefault(record.get(key) or fallback, []).append(record)
    rows = []
    for name, rs in buckets.items():
        row = {"key": name, **_tally(rs)}
        if sub_key:
            row["sub"] = _breakdown(rs, sub_key, fallback)
        rows.append(row)
    rows.sort(key=lambda row: (-row["games"], row["key"]))
    return rows


def filter_records(records: list[dict], since: str = "", until: str = "",
                   my_class: str = "", my_deck: str = "", opp_class: str = "",
                   opp_grade: str = "", mode: str = "", event: str = "",
                   turn: str = "") -> list[dict]:
    """期間 / クラス / デッキ / 相手グレード / モード / 大会 / 先後で絞り込む。

    空文字の条件は無視する。mode は空文字と "all" のどちらも「絞り込まない」で、
    ここでは既定を持たない (何も指定しなければ全部返す)。CLI と HTTP は
    それぞれの入口で DEFAULT_MODE を既定にしている。

    mode を持たない古い戦績はランクマッチとして扱うので、`mode="ladder"` には
    大会機能を足す前の記録も含まれる。
    """
    out = []
    for record in records:
        played_at = record.get("played_at", "")
        if since and played_at < since:
            continue
        if until and played_at > until:
            continue
        if my_class and record.get("my_class") != my_class:
            continue
        if my_deck and (record.get("my_deck") or "") != my_deck:
            continue
        if opp_class and record.get("opp_class") != opp_class:
            continue
        if opp_grade and (record.get("opp_grade") or "") != opp_grade:
            continue
        if mode and mode != "all" and (record.get("mode") or DEFAULT_MODE) != mode:
            continue
        if event and (record.get("event") or "") != event:
            continue
        if turn and record.get("turn") != turn:
            continue
        out.append(record)
    return out


def _order_by(rows: list[dict], order: list[str]) -> list[dict]:
    """rows を指定の並び (梯子順) に並べ替える。order に無いキーは末尾へ。"""
    rank = {key: i for i, key in enumerate(order)}
    return sorted(rows, key=lambda row: (rank.get(row["key"], len(rank)), row["key"]))


def compute_stats(records: list[dict], classes: list[str],
                  grades: list[str] | None = None) -> dict:
    """全体 / 先後別 / クラス対面マトリクス / デッキ別の勝率をまとめて返す。

    マトリクスは config のクラス順に全マスを作る。0 戦のマスも「まだ当たって
    いない」という情報なので落とさない。config に無いクラス (旧データなど) が
    出てきた場合は行 / 列を後ろに足す。
    """
    order = list(classes)
    for record in records:
        for field in ("my_class", "opp_class"):
            value = record.get(field)
            if value and value not in order:
                order.append(value)

    matrix = {mine: {opp: {"games": 0, "wins": 0, "losses": 0, "winrate": 0.0}
                     for opp in order}
              for mine in order}
    for record in records:
        mine, opp = record.get("my_class"), record.get("opp_class")
        if mine not in matrix or opp not in matrix[mine]:
            continue
        cell = matrix[mine][opp]
        cell["games"] += 1
        if record.get("result") == "win":
            cell["wins"] += 1
    for row in matrix.values():
        for cell in row.values():
            cell["losses"] = cell["games"] - cell["wins"]
            cell["winrate"] = _rate(cell["wins"], cell["games"])

    return {
        "classes": order,
        "overall": _tally(records),
        "turn_order": {turn: _tally([r for r in records if r.get("turn") == turn])
                       for turn in TURNS},
        "matchup_matrix": matrix,
        "by_my_class": _breakdown(records, "my_class"),
        # 相手クラスの行はデッキ内訳を抱えている (画面で開くと出る)。
        "by_opp_class": _breakdown(records, "opp_class", sub_key="opp_deck"),
        "by_my_deck": _breakdown(records, "my_deck"),
        # 相手グレードは Grand Master 帯でしか付かないので、未設定しか無い場合は
        # 行を出さない (グラマス未到達のユーザーに空の表を見せない)。
        # 他の内訳と違い試合数順ではなく config の梯子順で並べる。EPIC未満 →
        # BEYOND という順序自体が読む側の求める情報なので。
        "by_opp_grade": _order_by(
            _breakdown([r for r in records if r.get("opp_grade")], "opp_grade"), grades or []),
    }


# --------------------------------------------------------------------------
# HTTP サーバー
# --------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "svwb-stats"
    store: RecordStore
    config: dict

    # ---- helpers ---------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 1_000_000:
            raise ValidationError({"_": "リクエストが大きすぎます"})
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValidationError({"_": f"JSON として読めません: {exc}"}) from exc

    def _query_filters(self, query: dict[str, list[str]]) -> dict:
        filters = {name: (query.get(name) or [""])[0]
                   for name in ("since", "until", "my_class", "my_deck", "opp_class",
                                "opp_grade", "mode", "event", "turn")}
        # モードを指定しないときはランクマッチ。混ぜた数字を既定にしないための
        # 既定値で、両方まとめて見たいときは mode=all を明示する。
        filters["mode"] = filters["mode"] or DEFAULT_MODE
        return filters

    def _record_id(self, path: str) -> str:
        return unquote(path[len("/api/records/"):]).strip("/")

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB_DIR / relative).resolve()
        # WEB_DIR の外へ出る参照 (../ など) は配信しない。
        if not target.is_file() or WEB_DIR.resolve() not in target.parents:
            self.send_error(404, "Not Found")
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- routes ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler の命名規約)
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path == "/api/config":
                self._send_json(200, self.config)
            elif path == "/api/records":
                records = filter_records(self.store.list(), **self._query_filters(query))
                self._send_json(200, {"records": records})
            elif path == "/api/stats":
                records = filter_records(self.store.list(), **self._query_filters(query))
                self._send_json(200, compute_stats(
                    records, self.config["classes"], self.config.get("grades")))
            elif path.startswith("/api/"):
                self._send_json(404, {"error": "不明なエンドポイントです"})
            else:
                self._serve_static(path)
        except Exception as exc:  # サーバーを落とさずブラウザにエラーを返す
            self._send_json(500, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/records":
            self._send_json(404, {"error": "不明なエンドポイントです"})
            return
        try:
            record = validate_record(self._read_json(), self.config)
            self._send_json(201, self.store.add(record))
        except ValidationError as exc:
            self._send_json(400, {"error": "入力を確認してください", "fields": exc.errors})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/records/"):
            self._send_json(404, {"error": "不明なエンドポイントです"})
            return
        try:
            record = validate_record(self._read_json(), self.config)
            updated = self.store.update(self._record_id(path), record)
            if updated is None:
                self._send_json(404, {"error": "その戦績は見つかりません"})
            else:
                self._send_json(200, updated)
        except ValidationError as exc:
            self._send_json(400, {"error": "入力を確認してください", "fields": exc.errors})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/records/"):
            self._send_json(404, {"error": "不明なエンドポイントです"})
            return
        try:
            if self.store.delete(self._record_id(path)):
                self._send_json(200, {"deleted": True})
            else:
                self._send_json(404, {"error": "その戦績は見つかりません"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def lan_ip() -> str:
    """この PC の LAN IP。取れなければ空文字。

    UDP ソケットを「繋ぐ」だけで、パケットは 1 つも出ない。OS が経路表を引いて
    送信元アドレスを決めるので、既定の経路に使っている NIC の IP が分かる。
    ホスト名の逆引きだと 127.0.0.1 が返る環境があるため、この方法を使う。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))  # 文書用に予約されたアドレス。実在しなくてよい
        ip = sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()
    return "" if ip.startswith("127.") else ip


def _ansi_ready() -> bool:
    """端末が色指定 (ANSI エスケープ) を解せるか。"""
    if not sys.stdout.isatty():
        return False
    if os.name != "nt":
        return True
    # Windows 10 以降のコンソールは、明示的に有効化すれば ANSI を解する。
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def _print_qr(url: str) -> None:
    """URL の QR を端末に出す。出せない環境では黙って諦める (URL 自体は上に出ている)。"""
    if not _ansi_ready():
        return
    try:
        print()
        print(qr.render(qr.encode(url)))
        print()
    except (ValueError, UnicodeEncodeError):
        pass  # URL が長すぎる / 端末が半角ブロックを出せない


def cmd_serve(args: argparse.Namespace) -> int:
    config = load_config()
    store = RecordStore(Path(args.data))

    handler = type("BoundHandler", (Handler,), {"store": store, "config": config})
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"

    print(f"svwb-stats: {url}")
    print(f"戦績ファイル: {store.path}")
    if args.host == "0.0.0.0":
        ip = lan_ip()
        if ip:
            lan_url = f"http://{ip}:{args.port}"
            print(f"スマホなど LAN 内の端末からは {lan_url}")
            if not args.no_qr:
                _print_qr(lan_url)
        else:
            print("LAN 内の端末からも入れますが、この PC の IP を取得できませんでした。")
            print("Windows は ipconfig、macOS / Linux は ip addr で調べてください。")
        print("認証は無いので、信頼できるネットワークだけで使ってください。")
    print("停止は Ctrl-C。")
    if args.open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました。")
    finally:
        httpd.server_close()
    return 0


def _display_width(text: str) -> int:
    """端末上の見た目の桁数。クラス名やデッキ名は全角なので len() では揃わない。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def _pad(text: str, width: int, align: str = "left") -> str:
    """見た目の桁数で寄せる。width を超える分は切り詰める。"""
    while _display_width(text) > width:
        text = text[:-1]
    space = " " * max(0, width - _display_width(text))
    return text + space if align == "left" else space + text


def _bar(rate: float, width: int = 20) -> str:
    filled = round(rate * width)
    return "█" * filled + "·" * (width - filled)


def _format_tally(label: str, tally: dict, width: int = 12) -> str:
    return (f"{_pad(label, width)} {tally['games']:>4}戦 {tally['wins']:>3}勝{tally['losses']:>3}敗  "
            f"{tally['winrate'] * 100:5.1f}%  {_bar(tally['winrate'])}")


def cmd_stats(args: argparse.Namespace) -> int:
    config = load_config()
    store = RecordStore(Path(args.data))
    records = filter_records(
        store.list(),
        since=args.since or "", until=args.until or "",
        my_class=args.my_class or "", my_deck=args.my_deck or "",
        opp_class=args.opp_class or "", opp_grade=args.opp_grade or "",
        mode=args.mode or "", event=args.event or "", turn=args.turn or "",
    )
    stats = compute_stats(records, config["classes"], config["grades"])

    if args.json:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 0

    # 何を数えているかを先に出す。既定がランクマッチのみなので、大会の分が
    # 入っていないことに気付かないまま数字を読まないようにする。
    print(f"対象: {MODE_LABELS[args.mode]}")
    print()

    if not records:
        print("条件に合う戦績がありません。")
        return 0

    print("== 全体 ==")
    print(_format_tally("全体", stats["overall"]))
    print()

    print("== 先攻 / 後攻 ==")
    for turn, label in (("first", "先攻"), ("second", "後攻")):
        print(_format_tally(label, stats["turn_order"][turn]))
    print()

    print("== 対面マトリクス (自分クラス × 相手クラス / 勝率・試合数) ==")
    classes = stats["classes"]
    matrix = stats["matchup_matrix"]
    # 使ったクラスだけ行にする。列は「まだ当たっていない相手」も見たいので全部残す。
    played = [mine for mine in classes if any(matrix[mine][opp]["games"] for opp in classes)]

    label_width = max(_display_width(c) for c in played)
    cell_width = 11  # 「ナイトメア」等の 5 文字クラス名 (全角 10 桁) + 区切りの 1 桁
    print(_pad("自分\\相手", label_width) + "".join(_pad(c, cell_width, "right") for c in classes))
    for mine in played:
        cells = []
        for opp in classes:
            cell = matrix[mine][opp]
            cells.append("-" if not cell["games"]
                         else f"{cell['winrate'] * 100:3.0f}% {cell['wins']}-{cell['losses']}")
        print(_pad(mine, label_width) + "".join(_pad(c, cell_width, "right") for c in cells))
    print()

    if stats["by_my_deck"] and (len(stats["by_my_deck"]) > 1
                                or stats["by_my_deck"][0]["key"] != "(未設定)"):
        print("== 自分デッキ別 ==")
        width = max(_display_width(row["key"]) for row in stats["by_my_deck"])
        for row in stats["by_my_deck"]:
            print(_format_tally(row["key"], row, width))
        print()

    if stats["by_opp_grade"]:
        print("== 相手グレード別 ==")
        width = max(_display_width(row["key"]) for row in stats["by_opp_grade"])
        for row in stats["by_opp_grade"]:
            print(_format_tally(row["key"], row, width))
        print()

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="svwb", description="Shadowverse: Worlds Beyond 戦績管理ツール")
    parser.add_argument("--data", default=str(DEFAULT_DATA_PATH),
                        help=f"戦績 JSONL のパス (既定: {DEFAULT_DATA_PATH})")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="ブラウザ用のサーバーを起動する")
    serve.add_argument("--host", default="127.0.0.1",
                       help="待ち受けホスト。0.0.0.0 にすると LAN 内から入力できる (既定: 127.0.0.1)")
    serve.add_argument("--port", type=int, default=8787, help="待ち受けポート (既定: 8787)")
    serve.add_argument("--open", action="store_true", help="起動後にブラウザを開く")
    serve.add_argument("--no-qr", dest="no_qr", action="store_true",
                       help="LAN 起動時に URL の QR コードを表示しない")
    serve.set_defaults(func=cmd_serve)

    stats = sub.add_parser("stats", help="集計を表示する")
    stats.add_argument("--since", help="この日以降 (YYYY-MM-DD)")
    stats.add_argument("--until", help="この日以前 (YYYY-MM-DD)")
    stats.add_argument("--my-class", dest="my_class", help="自分クラスで絞り込む")
    stats.add_argument("--my-deck", dest="my_deck", help="自分デッキ名で絞り込む")
    stats.add_argument("--opp-class", dest="opp_class", help="相手クラスで絞り込む")
    stats.add_argument("--opp-grade", dest="opp_grade", help="相手グレードで絞り込む (EPIC 等)")
    stats.add_argument("--turn", choices=TURNS, help="先攻 / 後攻で絞り込む")
    stats.add_argument("--mode", choices=FILTER_MODES, default=DEFAULT_MODE,
                       help="集計する対象 (既定: ランクマッチのみ。all で大会も混ぜる)")
    stats.add_argument("--event", help="大会名で絞り込む")
    stats.add_argument("--json", action="store_true", help="JSON で出力する")
    stats.set_defaults(func=cmd_stats)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        # `svwb.py stats | head` のように読み手が先に閉じた場合。
        # stdout を devnull に差し替えてから戻り、終了時の再フラッシュで
        # 同じ例外がトレースバックとして出るのを防ぐ。
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
