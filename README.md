# svwb-stats

Shadowverse: Worlds Beyond の戦績管理ツール。ブラウザで 1 試合ずつ記録し、勝率・対面マトリクスを集計する。

- **依存なし** — Python 3.9 以降の標準ライブラリだけで動く。`pip install` も `npm install` も不要
- **データはテキスト** — 戦績は `data/records.jsonl` に 1 行 1 試合で入る。git に乗せればそのまま履歴になる
- **数字は 1 か所で計算** — 集計は Python 側にあり、ブラウザと CLI (`svwb.py stats`) で同じ値が出る

## 使う (Windows)

**`start.bat` をダブルクリックするだけ。** ターミナルは不要。黒い窓が開いてサーバーが立ち上がり、ブラウザが自動で `http://127.0.0.1:8787` を開く。止めるときはその黒い窓を閉じる。

Python が入っていない場合は `start.bat` がその旨を表示する。入れ方:

1. スタートメニューで **「Python 3」** と検索
2. Microsoft Store の Python 3 をインストール（クリックのみ、ターミナル不要）
3. `start.bat` をもう一度ダブルクリック

インストール済みかどうかは、スタートメニューで「Python」を検索して `Python 3.x` が出るかで判断できる。Microsoft Store が開く場合は未インストール。

## 使う (macOS / Linux)

```bash
python3 svwb.py serve --open
```

`http://127.0.0.1:8787` が開く。フォームに入力して「記録する」を押すと即座に集計へ反映される。

同じ LAN のスマホから入力したい場合:

```bash
python3 svwb.py serve --host 0.0.0.0
```

PC の LAN IP (`192.168.x.x` 等) の `:8787` にスマホのブラウザからアクセスする。認証は無いので、信頼できるネットワークでのみ使うこと。

ターミナルで集計だけ見たいとき:

```bash
python3 svwb.py stats                       # 全期間
python3 svwb.py stats --since 2026-08-01    # 期間で絞る
python3 svwb.py stats --my-class エルフ      # クラスで絞る
python3 svwb.py stats --json                # JSON で出す
```

## 記録する項目

| 項目 | 必須 | 内容 |
|---|---|---|
| `played_at` | ○ | 日付 (`YYYY-MM-DD`)。既定は今日 |
| `my_class` | ○ | 自分クラス。7 クラスから選択 |
| `my_deck` | | 自分のデッキ名 (自由入力、入力済みの名前が候補に出る) |
| `opp_class` | ○ | 相手クラス |
| `opp_deck` | | 相手のデッキ名 |
| `turn` | ○ | `first` (先攻) / `second` (後攻) |
| `result` | ○ | `win` / `loss` |
| `rank` | | ランク帯 (`AA2`, `Master` 等) |
| `note` | | メモ |

連戦を記録しやすいよう、送信後も **自分クラス・自分デッキ・ランク・日付は残る**。相手クラスにフォーカスが移るので、次の試合は 3 クリックで記録できる。

## 出る集計

- **全体** — 試合数 / 勝敗 / 勝率
- **先攻・後攻別** — Worlds Beyond で最も効くので常時表示
- **対面マトリクス** — 自分クラス × 相手クラス の勝率。試合数が少ないマスは色を薄くしてあり、1 戦だけのマスが「得意な対面」に見えないようにしている
- **自分デッキ別 / 相手クラス別** — 試合数の多い順

すべて期間・自分クラス・自分デッキで絞り込める。絞り込みは API のクエリ (`/api/stats?since=…`) にもそのまま対応する。

## クラス / ランクを増やす

`config.json` を編集するだけで、入力フォームの選択肢と入力検証の両方に反映される。

```json
{
  "classes": ["エルフ", "ロイヤル", "ウィッチ", "ドラゴン", "ナイトメア", "ビショップ", "ネメシス"],
  "ranks": ["Beginner", "D0", "…", "Master", "Grand Master"]
}
```

新クラスが実装されたら `classes` に足す。過去の戦績に `config.json` へ無いクラスが入っていても、集計マトリクスには行 / 列として残るので古いデータが消えることはない。

## データ

`data/records.jsonl` は 1 行 1 試合の JSON。

```json
{"played_at": "2026-08-03", "my_class": "エルフ", "my_deck": "アグロエルフ", "opp_class": "ロイヤル", "opp_deck": "ミッドロイヤル", "turn": "first", "result": "win", "rank": "AA1", "note": "", "id": "…", "created_at": "…"}
```

追加は追記のみなので、その日足した試合が git の差分にそのまま出る。別のファイルを使いたい場合は `--data` で指定する。

```bash
python3 svwb.py --data /path/to/records.jsonl serve
```

## API

サーバーは以下を返す。UI はこれしか使っていない。

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/api/config` | クラス / ランクの一覧 |
| `GET` | `/api/records` | 戦績一覧 (`since` `until` `my_class` `my_deck` `opp_class` で絞り込み) |
| `POST` | `/api/records` | 追加 |
| `PUT` | `/api/records/{id}` | 更新 |
| `DELETE` | `/api/records/{id}` | 削除 |
| `GET` | `/api/stats` | 集計 (絞り込みパラメータは `/api/records` と同じ) |

## テスト

```bash
python3 -m unittest discover -s tests -v
```

## 構成

```
start.bat        # Windows 用ランチャー (ダブルクリックで起動)
svwb.py          # CLI + HTTP サーバー + 保存 + 集計
config.json      # クラス / ランクの定義
web/             # ブラウザ側 (素の HTML / CSS / JS、ビルド不要)
data/            # 戦績 JSONL の置き場
tests/           # unittest
```

`start.bat` の中のメッセージが英語なのは意図的で、cmd.exe が .bat を読むときのコードページ次第で日本語が化けるため。
