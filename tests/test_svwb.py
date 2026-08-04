"""svwb-stats のテスト。標準ライブラリのみ。

    python3 -m unittest discover -s tests -v
"""

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import svwb  # noqa: E402

CONFIG = {
    "classes": ["エルフ", "ロイヤル", "ウィッチ", "ドラゴン", "ナイトメア", "ビショップ", "ネメシス"],
    "ranks": ["A0", "AA0", "Master", "Grand Master"],
    "grades": ["EPIC未満", "EPIC", "ULTIMATE", "LEGEND", "BEYOND"],
    "grade_rank": "Grand Master",
}


def make_record(**overrides):
    record = {
        "played_at": "2026-08-01",
        "my_class": "エルフ",
        "my_deck": "アグロエルフ",
        "opp_class": "ロイヤル",
        "opp_deck": "",
        "turn": "first",
        "result": "win",
        "rank": "",
        "grade": "",
        "note": "",
    }
    record.update(overrides)
    return record


class TestConfig(unittest.TestCase):
    def test_shipped_config_is_loadable(self):
        config = svwb.load_config()
        self.assertEqual(len(config["classes"]), 7)
        self.assertIn("ナイトメア", config["classes"])
        # Worlds Beyond でネクロマンサー / ヴァンパイアはナイトメアに統合された。
        self.assertNotIn("ネクロマンサー", config["classes"])
        self.assertEqual(config["ranks"], ["Master", "Grand Master"])
        self.assertEqual(config["grade_rank"], "Grand Master")
        self.assertEqual(config["grades"],
                         ["EPIC未満", "EPIC", "ULTIMATE", "LEGEND", "BEYOND"])

    def test_grade_rank_must_exist_in_ranks(self):
        # config を書き換えたときに typo で結び付けが黙って外れないようにする。
        bad = {"classes": ["エルフ"], "ranks": ["Master"], "grade_rank": "Grand Master"}
        path = Path(tempfile.mkdtemp()) / "config.json"
        path.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        with self.assertRaises(ValueError) as ctx:
            svwb.load_config(path)
        self.assertIn("grade_rank", str(ctx.exception))

    def test_grades_default_to_empty(self):
        minimal = {"classes": ["エルフ"], "ranks": ["Master"]}
        path = Path(tempfile.mkdtemp()) / "config.json"
        path.write_text(json.dumps(minimal, ensure_ascii=False), encoding="utf-8")
        config = svwb.load_config(path)
        self.assertEqual(config["grades"], [])
        self.assertEqual(config["grade_rank"], "")


class TestValidation(unittest.TestCase):
    def test_accepts_a_full_record(self):
        record = svwb.validate_record(make_record(rank="AA0", note="メモ"), CONFIG)
        self.assertEqual(record["my_class"], "エルフ")
        self.assertEqual(record["rank"], "AA0")
        self.assertEqual(record["note"], "メモ")

    def test_optional_fields_default_to_empty(self):
        payload = {"my_class": "エルフ", "opp_class": "ロイヤル", "turn": "second", "result": "loss"}
        record = svwb.validate_record(payload, CONFIG)
        self.assertEqual(record["my_deck"], "")
        self.assertEqual(record["opp_deck"], "")
        self.assertEqual(record["rank"], "")
        # 日付未指定なら今日。
        self.assertRegex(record["played_at"], r"^\d{4}-\d{2}-\d{2}$")

    def test_drops_unknown_keys_and_client_supplied_id(self):
        record = svwb.validate_record(make_record(id="spoofed", junk=1), CONFIG)
        self.assertNotIn("id", record)
        self.assertNotIn("junk", record)

    def test_rejects_unknown_class(self):
        with self.assertRaises(svwb.ValidationError) as ctx:
            svwb.validate_record(make_record(my_class="ネクロマンサー"), CONFIG)
        self.assertIn("my_class", ctx.exception.errors)

    def test_rejects_bad_date(self):
        for bad in ("2026-13-01", "20260801", "きのう"):
            with self.subTest(bad=bad), self.assertRaises(svwb.ValidationError):
                svwb.validate_record(make_record(played_at=bad), CONFIG)

    def test_rejects_bad_turn_and_result(self):
        with self.assertRaises(svwb.ValidationError):
            svwb.validate_record(make_record(turn="先攻"), CONFIG)
        with self.assertRaises(svwb.ValidationError):
            svwb.validate_record(make_record(result="draw"), CONFIG)

    def test_rejects_unknown_rank_but_allows_empty(self):
        with self.assertRaises(svwb.ValidationError):
            svwb.validate_record(make_record(rank="B9"), CONFIG)
        self.assertEqual(svwb.validate_record(make_record(rank=""), CONFIG)["rank"], "")

    def test_grade_is_accepted_at_grand_master(self):
        record = svwb.validate_record(make_record(rank="Grand Master", grade="EPIC"), CONFIG)
        self.assertEqual(record["grade"], "EPIC")

    def test_rejects_unknown_grade(self):
        with self.assertRaises(svwb.ValidationError) as ctx:
            svwb.validate_record(make_record(rank="Grand Master", grade="MYTHIC"), CONFIG)
        self.assertIn("grade", ctx.exception.errors)

    def test_rejects_grade_below_grand_master(self):
        # CR グレードはグラマス昇格後にしか存在しない。
        for rank in ("", "AA0", "Master"):
            with self.subTest(rank=rank), self.assertRaises(svwb.ValidationError) as ctx:
                svwb.validate_record(make_record(rank=rank, grade="EPIC"), CONFIG)
            self.assertIn("grade", ctx.exception.errors)

    def test_empty_grade_is_fine_at_any_rank(self):
        for rank in ("", "AA0", "Grand Master"):
            with self.subTest(rank=rank):
                record = svwb.validate_record(make_record(rank=rank, grade=""), CONFIG)
                self.assertEqual(record["grade"], "")

    def test_grade_rank_coupling_is_optional(self):
        # grade_rank が空の config ではランクとの結び付けを行わない。
        loose = {**CONFIG, "grade_rank": ""}
        record = svwb.validate_record(make_record(rank="AA0", grade="EPIC"), loose)
        self.assertEqual(record["grade"], "EPIC")

    def test_reports_every_bad_field_at_once(self):
        with self.assertRaises(svwb.ValidationError) as ctx:
            svwb.validate_record({"my_class": "?", "opp_class": "?", "turn": "?", "result": "?"}, CONFIG)
        self.assertEqual(set(ctx.exception.errors), {"my_class", "opp_class", "turn", "result"})

    def test_rejects_overlong_text(self):
        with self.assertRaises(svwb.ValidationError):
            svwb.validate_record(make_record(my_deck="あ" * 121), CONFIG)


class TestStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = svwb.RecordStore(Path(self.tmp.name) / "records.jsonl")

    def test_missing_file_reads_as_empty(self):
        self.assertEqual(self.store.list(), [])

    def test_add_assigns_id_and_persists(self):
        added = self.store.add(make_record())
        self.assertTrue(added["id"])
        self.assertIn("created_at", added)
        reread = svwb.RecordStore(self.store.path).list()
        self.assertEqual(len(reread), 1)
        self.assertEqual(reread[0]["id"], added["id"])

    def test_one_line_per_record(self):
        for _ in range(3):
            self.store.add(make_record())
        lines = self.store.path.read_text(encoding="utf-8").strip().split("\n")
        self.assertEqual(len(lines), 3)
        for line in lines:
            json.loads(line)

    def test_list_is_sorted_by_played_at(self):
        self.store.add(make_record(played_at="2026-08-03"))
        self.store.add(make_record(played_at="2026-08-01"))
        self.store.add(make_record(played_at="2026-08-02"))
        self.assertEqual([r["played_at"] for r in self.store.list()],
                         ["2026-08-01", "2026-08-02", "2026-08-03"])

    def test_update_keeps_id_and_changes_fields(self):
        added = self.store.add(make_record())
        updated = self.store.update(added["id"], make_record(result="loss", opp_class="ウィッチ"))
        self.assertEqual(updated["id"], added["id"])
        self.assertEqual(updated["result"], "loss")
        self.assertEqual(self.store.list()[0]["opp_class"], "ウィッチ")

    def test_update_unknown_id_returns_none(self):
        self.assertIsNone(self.store.update("nope", make_record()))

    def test_delete(self):
        keep = self.store.add(make_record(note="keep"))
        drop = self.store.add(make_record(note="drop"))
        self.assertTrue(self.store.delete(drop["id"]))
        self.assertFalse(self.store.delete(drop["id"]))
        self.assertEqual([r["id"] for r in self.store.list()], [keep["id"]])

    def test_blank_lines_are_ignored(self):
        self.store.add(make_record())
        with self.store.path.open("a", encoding="utf-8") as fp:
            fp.write("\n\n")
        self.assertEqual(len(self.store.list()), 1)

    def test_corrupt_line_raises_with_line_number(self):
        self.store.add(make_record())
        with self.store.path.open("a", encoding="utf-8") as fp:
            fp.write("{ broken\n")
        with self.assertRaises(ValueError) as ctx:
            self.store.list()
        self.assertIn(":2", str(ctx.exception))

    def test_concurrent_adds_do_not_lose_records(self):
        def worker():
            for _ in range(20):
                self.store.add(make_record())

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        records = self.store.list()
        self.assertEqual(len(records), 80)
        self.assertEqual(len({r["id"] for r in records}), 80)


class TestFilter(unittest.TestCase):
    def setUp(self):
        self.records = [
            make_record(played_at="2026-07-30", my_class="エルフ", my_deck="A", opp_class="ロイヤル"),
            make_record(played_at="2026-08-01", my_class="エルフ", my_deck="B", opp_class="ウィッチ"),
            make_record(played_at="2026-08-05", my_class="ドラゴン", my_deck="C", opp_class="ロイヤル"),
        ]

    def test_no_filter_returns_everything(self):
        self.assertEqual(len(svwb.filter_records(self.records)), 3)

    def test_since_and_until_are_inclusive(self):
        got = svwb.filter_records(self.records, since="2026-08-01", until="2026-08-05")
        self.assertEqual([r["played_at"] for r in got], ["2026-08-01", "2026-08-05"])

    def test_class_and_deck_filters_combine(self):
        self.assertEqual(len(svwb.filter_records(self.records, my_class="エルフ")), 2)
        self.assertEqual(len(svwb.filter_records(self.records, my_class="エルフ", my_deck="B")), 1)
        self.assertEqual(len(svwb.filter_records(self.records, opp_class="ロイヤル")), 2)

    def test_grade_filter(self):
        records = [
            make_record(rank="Grand Master", grade="EPIC"),
            make_record(rank="Grand Master", grade="ULTIMATE"),
            make_record(rank="AA0", grade=""),
        ]
        self.assertEqual(len(svwb.filter_records(records, grade="EPIC")), 1)
        self.assertEqual(len(svwb.filter_records(records)), 3)


class TestStats(unittest.TestCase):
    def setUp(self):
        self.classes = CONFIG["classes"]
        self.records = [
            make_record(my_class="エルフ", opp_class="ロイヤル", turn="first", result="win"),
            make_record(my_class="エルフ", opp_class="ロイヤル", turn="second", result="loss"),
            make_record(my_class="エルフ", opp_class="ウィッチ", turn="first", result="win"),
            make_record(my_class="ドラゴン", my_deck="ランプ", opp_class="ロイヤル",
                        turn="second", result="win"),
        ]

    def test_empty_input_is_all_zero(self):
        stats = svwb.compute_stats([], self.classes)
        self.assertEqual(stats["overall"], {"games": 0, "wins": 0, "losses": 0, "winrate": 0.0})
        self.assertEqual(stats["turn_order"]["first"]["games"], 0)
        self.assertEqual(stats["by_my_deck"], [])
        # マトリクスは 0 戦でも全マスある。
        self.assertEqual(len(stats["matchup_matrix"]), len(self.classes))

    def test_overall(self):
        overall = svwb.compute_stats(self.records, self.classes)["overall"]
        self.assertEqual(overall, {"games": 4, "wins": 3, "losses": 1, "winrate": 0.75})

    def test_turn_order(self):
        turn = svwb.compute_stats(self.records, self.classes)["turn_order"]
        self.assertEqual(turn["first"], {"games": 2, "wins": 2, "losses": 0, "winrate": 1.0})
        self.assertEqual(turn["second"], {"games": 2, "wins": 1, "losses": 1, "winrate": 0.5})

    def test_matchup_matrix(self):
        matrix = svwb.compute_stats(self.records, self.classes)["matchup_matrix"]
        self.assertEqual(matrix["エルフ"]["ロイヤル"],
                         {"games": 2, "wins": 1, "losses": 1, "winrate": 0.5})
        self.assertEqual(matrix["エルフ"]["ウィッチ"]["winrate"], 1.0)
        # 未対戦のマスは 0 戦として残る (勝率 0% と混同しないよう games で判断する)。
        self.assertEqual(matrix["ネメシス"]["ビショップ"]["games"], 0)
        # 自分クラスと相手クラスは別軸。逆向きは埋まらない。
        self.assertEqual(matrix["ロイヤル"]["エルフ"]["games"], 0)

    def test_matrix_keeps_classes_outside_config(self):
        legacy = make_record(my_class="ネクロマンサー", opp_class="エルフ")
        stats = svwb.compute_stats(self.records + [legacy], self.classes)
        self.assertEqual(stats["classes"][-1], "ネクロマンサー")
        self.assertEqual(stats["matchup_matrix"]["ネクロマンサー"]["エルフ"]["games"], 1)

    def test_deck_breakdown_is_sorted_by_games(self):
        rows = svwb.compute_stats(self.records, self.classes)["by_my_deck"]
        self.assertEqual([row["key"] for row in rows], ["アグロエルフ", "ランプ"])
        self.assertEqual(rows[0]["games"], 3)

    def test_deck_breakdown_labels_blank_decks(self):
        rows = svwb.compute_stats([make_record(my_deck="")], self.classes)["by_my_deck"]
        self.assertEqual(rows[0]["key"], "(未設定)")

    def test_grade_breakdown_only_counts_records_with_a_grade(self):
        records = [
            make_record(rank="Grand Master", grade="EPIC", result="win"),
            make_record(rank="Grand Master", grade="EPIC", result="loss"),
            make_record(rank="Grand Master", grade="ULTIMATE", result="win"),
            make_record(rank="AA0", grade="", result="win"),
        ]
        rows = svwb.compute_stats(records, self.classes, CONFIG["grades"])["by_grade"]
        by_key = {row["key"]: row for row in rows}
        self.assertEqual(set(by_key), {"EPIC", "ULTIMATE"})
        self.assertEqual(by_key["EPIC"], {"key": "EPIC", "games": 2, "wins": 1,
                                          "losses": 1, "winrate": 0.5})

    def test_grade_breakdown_follows_the_ladder_not_game_count(self):
        # 試合数順に並べると BEYOND が EPIC未満 の上に来たり下に来たりして
        # 梯子として読めない。config の並び順を維持する。
        records = ([make_record(rank="Grand Master", grade="ULTIMATE")] * 5
                   + [make_record(rank="Grand Master", grade="EPIC未満")]
                   + [make_record(rank="Grand Master", grade="BEYOND")] * 3
                   + [make_record(rank="Grand Master", grade="EPIC")] * 2)
        rows = svwb.compute_stats(records, self.classes, CONFIG["grades"])["by_grade"]
        self.assertEqual([row["key"] for row in rows],
                         ["EPIC未満", "EPIC", "ULTIMATE", "BEYOND"])

    def test_grade_breakdown_keeps_unknown_grades_at_the_end(self):
        records = [
            make_record(rank="Grand Master", grade="MYTHIC"),
            make_record(rank="Grand Master", grade="EPIC"),
        ]
        rows = svwb.compute_stats(records, self.classes, CONFIG["grades"])["by_grade"]
        self.assertEqual([row["key"] for row in rows], ["EPIC", "MYTHIC"])

    def test_grade_breakdown_is_empty_without_grades(self):
        # グラマス未到達なら空。UI 側はこれを見てセクションごと隠す。
        self.assertEqual(svwb.compute_stats(self.records, self.classes)["by_grade"], [])

    def test_opponent_class_breakdown(self):
        rows = svwb.compute_stats(self.records, self.classes)["by_opp_class"]
        by_key = {row["key"]: row for row in rows}
        self.assertEqual(by_key["ロイヤル"]["games"], 3)
        self.assertEqual(by_key["ウィッチ"]["winrate"], 1.0)


class TestHttpApi(unittest.TestCase):
    """実際にサーバーを立てて API を一周させる。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        store = svwb.RecordStore(Path(cls.tmp.name) / "records.jsonl")
        handler = type("TestHandler", (svwb.Handler,), {"store": store, "config": CONFIG})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.thread.join(timeout=5)
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, payload=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_01_config(self):
        status, body = self.request("GET", "/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(body["classes"], CONFIG["classes"])

    def test_02_crud_roundtrip(self):
        status, created = self.request("POST", "/api/records", make_record(note="初手キープ"))
        self.assertEqual(status, 201)
        record_id = created["id"]

        status, body = self.request("GET", "/api/records")
        self.assertEqual(status, 200)
        self.assertIn(record_id, [r["id"] for r in body["records"]])

        status, updated = self.request(
            "PUT", f"/api/records/{record_id}", make_record(result="loss", note="返し targeted"))
        self.assertEqual(status, 200)
        self.assertEqual(updated["result"], "loss")
        self.assertEqual(updated["id"], record_id)

        status, body = self.request("DELETE", f"/api/records/{record_id}")
        self.assertEqual(status, 200)
        status, body = self.request("GET", "/api/records")
        self.assertNotIn(record_id, [r["id"] for r in body["records"]])

    def test_03_validation_error_is_400_with_fields(self):
        status, body = self.request("POST", "/api/records", make_record(my_class="ネクロマンサー"))
        self.assertEqual(status, 400)
        self.assertIn("my_class", body["fields"])

    def test_04_stats_respects_query_filters(self):
        self.request("POST", "/api/records", make_record(played_at="2026-07-01", result="win"))
        self.request("POST", "/api/records", make_record(played_at="2026-09-01", result="loss"))

        status, body = self.request("GET", "/api/stats?since=2026-08-15")
        self.assertEqual(status, 200)
        self.assertEqual(body["overall"]["games"], 1)
        self.assertEqual(body["overall"]["losses"], 1)

        status, body = self.request("GET", "/api/stats?my_class=%E3%83%89%E3%83%A9%E3%82%B4%E3%83%B3")
        self.assertEqual(body["overall"]["games"], 0)

    def test_045_grade_roundtrip_and_filter(self):
        _, created = self.request("POST", "/api/records",
                                  make_record(rank="Grand Master", grade="ULTIMATE"))
        self.assertEqual(created["grade"], "ULTIMATE")

        status, body = self.request("GET", "/api/stats?grade=ULTIMATE")
        self.assertEqual(status, 200)
        self.assertEqual(body["overall"]["games"], 1)
        self.assertEqual([r["key"] for r in body["by_grade"]], ["ULTIMATE"])

        status, body = self.request("POST", "/api/records",
                                    make_record(rank="AA0", grade="ULTIMATE"))
        self.assertEqual(status, 400)
        self.assertIn("grade", body["fields"])

        self.request("DELETE", f"/api/records/{created['id']}")

    def test_05_unknown_id_is_404(self):
        self.assertEqual(self.request("DELETE", "/api/records/deadbeef")[0], 404)
        self.assertEqual(self.request("PUT", "/api/records/deadbeef", make_record())[0], 404)

    def test_06_unknown_api_route_is_404(self):
        self.assertEqual(self.request("GET", "/api/nope")[0], 404)

    def test_07_serves_the_page(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("svwb-stats", response.read().decode("utf-8"))

    def test_08_does_not_serve_outside_web_dir(self):
        req = urllib.request.Request(self.base + "/../config.json")
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                served = response.status
        except urllib.error.HTTPError as exc:
            served = exc.code
        self.assertEqual(served, 404)


if __name__ == "__main__":
    unittest.main()
