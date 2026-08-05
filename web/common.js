"use strict";

/**
 * ランク戦の画面 (app.js) と大会の画面 (tournament.js) が共通で使う土台。
 *
 * どちらの画面も同じ JSON API しか相手にしない薄い層で、勝率などの計算は
 * 一切ここではやらない。数字は /api/stats の結果をそのまま描く。
 *
 * ES モジュールにはしていない。この定数と関数は script の最上位で宣言されるので、
 * 後から読み込まれる app.js / tournament.js からそのまま見える。
 */

const $ = (id) => document.getElementById(id);

const TURN_LABEL = { first: "先攻", second: "後攻" };
const RESULT_LABEL = { win: "勝ち", loss: "負け" };

/** ローカル時刻の YYYY-MM-DD ("sv-SE" ロケールの日付表記がちょうどこの形)。 */
const today = () => new Date().toLocaleDateString("sv-SE");

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.fields = payload.fields || {};
    throw error;
  }
  return payload;
}

/** 絞り込み条件を querystring にする。空の条件は送らない。 */
function toQuery(filters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

const pct = (rate) => `${(rate * 100).toFixed(1)}%`;

function build(node, props, children) {
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function el(tag, props = {}, children = []) {
  return build(document.createElement(tag), props, children);
}

function replaceOptions(select, values, { placeholder = "" } = {}) {
  const previous = select.value;
  select.replaceChildren();
  if (placeholder !== null) select.appendChild(el("option", { value: "", text: placeholder }));
  for (const value of values) select.appendChild(el("option", { value, text: value }));
  if (values.includes(previous)) select.value = previous;
}

/** 勝率を大きく出すカード。全体 / 先攻 / 後攻 のような数字を並べるのに使う。 */
function statCard(label, tally) {
  return el("div", { class: "stat" }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: tally.games ? pct(tally.winrate) : "—" }),
    el("div", { class: "detail", text: `${tally.games} 戦 ${tally.wins} 勝 ${tally.losses} 敗` }),
  ]);
}

/** デッキ別・クラス別などの内訳テーブル。行は /api/stats の by_* をそのまま渡す。 */
function renderBreakdown(tableId, rows, keyLabel) {
  const table = $(tableId);
  table.replaceChildren();
  table.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", { text: keyLabel }),
      el("th", { text: "試合" }),
      el("th", { text: "勝-敗" }),
      el("th", { text: "勝率" }),
    ]),
  ]));

  if (!rows.length) {
    table.appendChild(el("tbody", {}, [
      el("tr", {}, [el("td", { colspan: "4", class: "empty-cell", text: "データなし" })]),
    ]));
    return;
  }

  const body = el("tbody");
  for (const row of rows) {
    body.appendChild(el("tr", {}, [
      el("td", { text: row.key }),
      el("td", { text: String(row.games) }),
      el("td", { text: `${row.wins}-${row.losses}` }),
      el("td", {}, [
        el("span", { class: "bar", style: `width: ${Math.round(row.winrate * 48)}px;` }),
        document.createTextNode(` ${pct(row.winrate)}`),
      ]),
    ]));
  }
  table.appendChild(body);
}

/** 「クラス / デッキ名」。デッキ名が無ければクラスだけ。 */
const side = (cls, deck) => (deck ? `${cls} / ${deck}` : cls);

/**
 * 表の「相手」欄。2 デッキ制で相手のもう 1 デッキが分かっているときは
 * 「＋…」で添える。当たったデッキと持ち込みを取り違えないよう、列は分けずに
 * 小さい字でぶら下げる。
 */
function opponentCell(record) {
  const nodes = [document.createTextNode(side(record.opp_class, record.opp_deck))];
  if (record.opp_class2 || record.opp_deck2) {
    const other = side(record.opp_class2 || "クラス不明", record.opp_deck2);
    nodes.push(el("span", { class: "sub", title: `相手のもう 1 デッキ: ${other}`, text: ` ＋${other}` }));
  }
  return nodes;
}
