"use strict";

/**
 * svwb-stats のフロントエンド。
 *
 * サーバー (svwb.py serve) の JSON API だけを相手にする薄い画面で、
 * 勝率などの計算は一切ここではやらず /api/stats の結果を描画する。
 * 集計ロジックを Python 側に一本化しておくと、CLI (`svwb.py stats`) と
 * ブラウザで数字がずれない。
 */

const $ = (id) => document.getElementById(id);

const TURN_LABEL = { first: "先攻", second: "後攻" };
const RESULT_LABEL = { win: "勝ち", loss: "負け" };

/** 直近の入力。連戦を記録するとき毎回選び直さずに済むよう引き継ぐ。 */
const CARRY_FIELDS = ["my_class", "my_deck", "rank", "grade"];

/** 絞り込みに使う入力欄の id。 */
const FILTER_IDS = ["filter-since", "filter-until", "filter-my_class", "filter-my_deck", "filter-grade"];

/** 履歴の既定表示件数。 */
const LOG_PAGE_SIZE = 30;

const state = {
  config: { classes: [], ranks: [], grades: [], grade_rank: "", grade_thresholds: {} },
  records: [],
  stats: null,
  editingId: null,
  logExpanded: false,
  pieScope: "my",      // クラス別円グラフの対象 ("my" = 自分クラス / "opp" = 相手クラス)
};

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
function filterQuery() {
  const params = new URLSearchParams();
  for (const [id, name] of [
    ["filter-since", "since"],
    ["filter-until", "until"],
    ["filter-my_class", "my_class"],
    ["filter-my_deck", "my_deck"],
    ["filter-grade", "grade"],
  ]) {
    if ($(id).value) params.set(name, $(id).value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

const pct = (rate) => `${(rate * 100).toFixed(1)}%`;

const SVG_NS = "http://www.w3.org/2000/svg";

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

/** SVG は名前空間が違うので createElement では作れない (中身は el と同じ)。 */
function svgEl(tag, props = {}, children = []) {
  return build(document.createElementNS(SVG_NS, tag), props, children);
}

/**
 * 勝率をセルの背景色にする。
 * 試合数が少ないマスは色を薄くして、たまたま 1 勝しただけのマスが
 * 「得意な対面」に見えないようにする。
 */
function heatStyle(cell) {
  if (!cell.games) return "";
  const hue = cell.winrate >= 0.5 ? "var(--win)" : "var(--loss)";
  const distance = Math.abs(cell.winrate - 0.5) * 2;      // 0.5 から離れるほど濃く
  const confidence = Math.min(cell.games / 8, 1);          // 8 戦で最大の濃さ
  const strength = Math.round(distance * confidence * 55);
  return `background: color-mix(in srgb, ${hue} ${strength}%, transparent);`;
}

function replaceOptions(select, values, { placeholder = "" } = {}) {
  const previous = select.value;
  select.replaceChildren();
  if (placeholder !== null) select.appendChild(el("option", { value: "", text: placeholder }));
  for (const value of values) select.appendChild(el("option", { value, text: value }));
  if (values.includes(previous)) select.value = previous;
}

// ---------------------------------------------------------------------------
// 集計の描画
// ---------------------------------------------------------------------------

function renderHeadline(stats) {
  const cards = [
    { label: "全体", tally: stats.overall },
    { label: "先攻", tally: stats.turn_order.first },
    { label: "後攻", tally: stats.turn_order.second },
  ];
  $("headline").replaceChildren(...cards.map(({ label, tally }) =>
    el("div", { class: "stat" }, [
      el("div", { class: "label", text: label }),
      el("div", { class: "value", text: tally.games ? pct(tally.winrate) : "—" }),
      el("div", { class: "detail", text: `${tally.games} 戦 ${tally.wins} 勝 ${tally.losses} 敗` }),
    ])));
}

function renderMatrix(stats) {
  const classes = stats.classes;
  const table = $("matrix");
  table.replaceChildren();

  // 列 (相手クラス) は全部出す。「まだ当たっていない相手」も知りたい情報なので。
  // 行 (自分クラス) は使ったクラスだけ。7 クラス全部並べると空行だらけになる。
  const played = classes.filter((mine) =>
    classes.some((opp) => stats.matchup_matrix[mine][opp].games > 0));

  const head = el("tr", {}, [el("th", { text: "自分 \\ 相手" })]);
  for (const opp of classes) head.appendChild(el("th", { text: opp }));
  head.appendChild(el("th", { text: "計" }));
  table.appendChild(el("thead", {}, [head]));

  const body = el("tbody");
  for (const mine of played) {
    const row = el("tr", {}, [el("th", { text: mine })]);
    let games = 0;
    let wins = 0;
    for (const opp of classes) {
      const cell = stats.matchup_matrix[mine][opp];
      games += cell.games;
      wins += cell.wins;
      if (!cell.games) {
        row.appendChild(el("td", { class: "empty-cell", text: "–" }));
      } else {
        row.appendChild(el("td", {
          class: "cell",
          style: heatStyle(cell),
          title: `${mine} → ${opp}: ${cell.wins} 勝 ${cell.losses} 敗`,
        }, [
          document.createTextNode(pct(cell.winrate)),
          el("span", { class: "games", text: `(${cell.wins}-${cell.losses})` }),
        ]));
      }
    }
    row.appendChild(el("td", {
      text: games ? `${pct(wins / games)} (${games})` : "–",
      class: games ? "" : "empty-cell",
    }));
    body.appendChild(row);
  }
  table.appendChild(body);
}

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

// ---------------------------------------------------------------------------
// クラス別の円グラフ
// ---------------------------------------------------------------------------

/** 用意してある系列色 (--series-1 …) の数。あふれたクラスは「その他」にまとめる。 */
const PIE_SLOTS = 7;

/** ドーナツの寸法 (viewBox 200×200 上)。r は帯の中心線、width は帯の太さ。 */
const PIE = { cx: 100, cy: 100, r: 68, width: 30, gap: 2 };

/**
 * 内訳の行に色を割り当て、config のクラス順に並べ替える。
 *
 * 色はクラスに固定する。試合数順に振ると絞り込むたびに同じクラスの色が変わり、
 * 前の画面と見比べられなくなる。並び順も同じ理由で config 順に揃える
 * (試合数順にすると、1 戦増えただけで扇が入れ替わる)。
 */
function pieSlices(rows, classes) {
  const slot = new Map(classes.map((name, index) => [name, index]));
  const slices = [];
  let other = null;
  for (const row of rows) {
    const index = slot.has(row.key) ? slot.get(row.key) : PIE_SLOTS;
    if (index < PIE_SLOTS) {
      slices.push({ ...row, index, color: `var(--series-${index + 1})` });
    } else {
      // config に無いクラス (旧データ) と 8 クラス目以降の受け皿。
      other = other || { key: "その他", games: 0, wins: 0, losses: 0, winrate: 0,
                         index: PIE_SLOTS, color: "var(--series-other)" };
      other.games += row.games;
      other.wins += row.wins;
      other.losses += row.losses;
      other.winrate = other.wins / other.games;
    }
  }
  slices.sort((a, b) => a.index - b.index);
  if (other) slices.push(other);
  return slices;
}

function sliceTitle(slice, total) {
  return `${slice.key}: ${slice.games} 戦 (${pct(slice.games / total)}) / `
    + `${slice.wins} 勝 ${slice.losses} 敗 · 勝率 ${pct(slice.winrate)}`;
}

/**
 * ドーナツを描く。扇は circle の破線 (dasharray) で作っている。円弧の path を
 * 組むより計算が少なく、1 クラスしか無いとき (= 円周まるごと 1 本) も
 * 特別扱いが要らない。
 */
function renderPieChart(slices, total, label) {
  const { cx, cy, r, width } = PIE;
  const circumference = 2 * Math.PI * r;
  // 隣り合う色は 2px 空けて切り離す。色だけに頼らず境目が分かるようにする。
  const gap = slices.length > 1 ? PIE.gap : 0;

  let offset = 0;
  const arcs = slices.map((slice) => {
    const span = (slice.games / total) * circumference;
    const length = Math.max(span - gap, 0.5);   // 極端に細い扇でも線を残す
    const arc = svgEl("circle", {
      class: "pie-slice",
      cx, cy, r,
      fill: "none",
      style: `stroke: ${slice.color}`,
      "stroke-width": width,
      "stroke-dasharray": `${length} ${circumference - length}`,
      "stroke-dashoffset": -(offset + gap / 2),
    }, [svgEl("title", { text: sliceTitle(slice, total) })]);
    offset += span;
    return arc;
  });

  return svgEl("svg", {
    class: "pie", viewBox: "0 0 200 200", role: "img",
    "aria-label": `${label}別の試合数の割合`,
  }, [
    // circle は 3 時から時計回りに描かれる。12 時始まりにするため全体を回す。
    svgEl("g", { transform: `rotate(-90 ${cx} ${cy})` }, arcs),
    svgEl("text", { class: "pie-total", x: cx, y: cy + 4, text: String(total) }),
    svgEl("text", { class: "pie-total-unit", x: cx, y: cy + 20, text: "戦" }),
  ]);
}

/** 円グラフの凡例。色と名前の対応に加えて、読み取れない数字をここで出す。 */
function renderPieLegend(slices, total, label) {
  const table = $("pie-legend");
  table.replaceChildren();
  table.appendChild(el("thead", {}, [
    el("tr", {}, [label, "試合", "割合", "勝率"].map((text) => el("th", { text }))),
  ]));

  const body = el("tbody");
  for (const slice of slices) {
    body.appendChild(el("tr", {}, [
      el("td", {}, [
        el("span", { class: "swatch", style: `background: ${slice.color}` }),
        document.createTextNode(slice.key),
      ]),
      el("td", { text: String(slice.games) }),
      el("td", { text: pct(slice.games / total) }),
      el("td", { text: pct(slice.winrate) }),
    ]));
  }
  table.appendChild(body);
}

function renderPie(stats) {
  const opponent = state.pieScope === "opp";
  const label = opponent ? "相手クラス" : "自分クラス";
  const slices = pieSlices(opponent ? stats.by_opp_class : stats.by_my_class, stats.classes);
  const total = slices.reduce((sum, slice) => sum + slice.games, 0);

  if (!total) {
    $("pie-chart").replaceChildren();
    $("pie-legend").replaceChildren();
    return;
  }
  $("pie-chart").replaceChildren(renderPieChart(slices, total, label));
  renderPieLegend(slices, total, label);
}

/**
 * グレードは Grand Master 帯でしか付かない。ランクが config の grade_rank と
 * 一致しないときは選べなくして値も落とす。無効化された select は FormData に
 * 載らないので、送信される JSON からも自動的に消える。
 */
function syncGradeField() {
  const select = $("field-grade");
  const { grades, grade_rank: gradeRank } = state.config;
  const atGradeRank = !gradeRank || $("field-rank").value === gradeRank;
  const active = grades.length > 0 && atGradeRank;
  select.disabled = !active;
  if (!active) select.value = "";
  $("grade-hint").textContent = grades.length === 0 ? "未設定"
    : active ? "任意" : `${gradeRank} のみ`;

  // CR もグラマス帯のみ。グレードと違い config の一覧に依存しないので、
  // ランクの条件だけで判定する。
  const cr = $("field-cr");
  cr.disabled = !atGradeRank;
  if (!atGradeRank) cr.value = "";
  $("cr-hint").textContent = atGradeRank ? "任意" : `${gradeRank} のみ`;
}

/** config の閾値 (そのグレードに必要な最低 CR) から、この CR のグレードを引く。 */
function gradeForCr(cr) {
  let derived = null;
  let highest = -Infinity;
  for (const [grade, minCr] of Object.entries(state.config.grade_thresholds || {})) {
    if (cr >= minCr && minCr > highest) {
      derived = grade;
      highest = minCr;
    }
  }
  return derived;
}

/**
 * CR を入れたらグレードを自動で合わせる。
 *
 * 閾値を持たないグレード (BEYOND は LEGEND のうちランキング上位のみで、CR だけ
 * では決まらない) が選ばれているときは触らない。自動設定が毎回 LEGEND へ
 * 引き戻してしまうため。CR を消しただけのときもグレードは残す。
 */
function autoSetGradeFromCr() {
  const select = $("field-grade");
  const thresholds = state.config.grade_thresholds || {};
  if (select.disabled || !Object.keys(thresholds).length) return;
  if (select.value && !(select.value in thresholds)) return;

  const raw = $("field-cr").value.trim();
  if (raw === "") return;
  const cr = Number(raw);
  if (!Number.isInteger(cr) || cr < 0) return;

  const derived = gradeForCr(cr);
  if (!derived) return;
  select.value = derived;
  $("grade-hint").textContent = "CR から自動";
}

function renderStats(stats) {
  const hasData = stats.overall.games > 0;
  $("stats-empty").hidden = hasData;
  $("stats-body").hidden = !hasData;

  const overall = stats.overall;
  $("topbar-summary").replaceChildren(
    el("strong", { text: overall.games ? pct(overall.winrate) : "—" }),
    document.createTextNode(` / ${overall.games} 戦`),
  );
  if (!hasData) return;

  renderHeadline(stats);
  renderPie(stats);
  renderMatrix(stats);
  renderBreakdown("by-deck", stats.by_my_deck, "デッキ");
  renderBreakdown("by-opp", stats.by_opp_class, "相手クラス");

  // グレード別はグラマス帯の戦績が 1 件でもあるときだけ出す。
  const grades = stats.by_grade || [];
  $("grade-section").hidden = grades.length === 0;
  if (grades.length) renderBreakdown("by-grade", grades, "グレード");

  renderCr(stats.cr);
}

/** CR の推移要約。CR を記録した戦績が無ければ行ごと隠す。 */
function renderCr(cr) {
  $("cr-row").hidden = !cr;
  if (!cr) return;
  const sign = cr.delta > 0 ? "+" : "";
  $("cr-row").replaceChildren(
    el("div", { class: "stat" }, [
      el("div", { class: "label", text: "現在 CR" }),
      el("div", { class: "value", text: String(cr.latest) }),
      el("div", { class: "detail" }, [
        el("span", {
          class: cr.delta > 0 ? "delta-up" : cr.delta < 0 ? "delta-down" : "",
          text: `${sign}${cr.delta}`,
        }),
        document.createTextNode(` / ${cr.games} 戦`),
      ]),
    ]),
    el("div", { class: "stat" }, [
      el("div", { class: "label", text: "最高 CR" }),
      el("div", { class: "value", text: String(cr.max) }),
      el("div", { class: "detail", text: `最低 ${cr.min}` }),
    ]),
    el("div", { class: "stat" }, [
      el("div", { class: "label", text: "期間の始点" }),
      el("div", { class: "value", text: String(cr.first) }),
      el("div", { class: "detail", text: "絞り込み範囲の最初の記録" }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 履歴の描画
// ---------------------------------------------------------------------------

function renderLog(records) {
  const table = $("log");
  table.replaceChildren();
  $("log-count").textContent = records.length ? `(${records.length} 件)` : "";

  table.appendChild(el("thead", {}, [
    el("tr", {}, ["日付", "自分", "相手", "先後", "結果", "ランク", "グレード", "CR", "メモ", ""].map(
      (label) => el("th", { text: label }))),
  ]));

  if (!records.length) {
    table.appendChild(el("tbody", {}, [
      el("tr", {}, [el("td", { colspan: "10", class: "empty-cell", text: "まだ戦績がありません。" })]),
    ]));
    return;
  }

  // 新しい試合ほど上に出す。全部並べると数百行になるので既定は直近だけ。
  const newestFirst = [...records].reverse();
  const shown = state.logExpanded ? newestFirst : newestFirst.slice(0, LOG_PAGE_SIZE);

  const body = el("tbody");
  for (const record of shown) {
    const side = (cls, deck) => (deck ? `${cls} / ${deck}` : cls);
    body.appendChild(el("tr", { class: record.id === state.editingId ? "editing" : "" }, [
      el("td", { text: record.played_at }),
      el("td", { text: side(record.my_class, record.my_deck) }),
      el("td", { text: side(record.opp_class, record.opp_deck) }),
      el("td", { text: TURN_LABEL[record.turn] || "" }),
      el("td", { class: record.result, text: RESULT_LABEL[record.result] || "" }),
      el("td", { text: record.rank || "" }),
      el("td", { text: record.grade || "" }),
      el("td", { text: record.cr === null || record.cr === undefined ? "" : String(record.cr) }),
      el("td", { class: "note", title: record.note || "", text: record.note || "" }),
      el("td", {}, [
        el("button", { class: "link", type: "button", text: "編集", onclick: () => startEdit(record) }),
        el("button", { class: "link", type: "button", text: "削除", onclick: () => removeRecord(record) }),
      ]),
    ]));
  }
  table.appendChild(body);

  const hidden = newestFirst.length - shown.length;
  $("log-more").hidden = hidden === 0;
  $("log-more").textContent = `残り ${hidden} 件を表示`;
}

// ---------------------------------------------------------------------------
// フォーム
// ---------------------------------------------------------------------------

function formValues() {
  const form = $("entry-form");
  const data = Object.fromEntries(new FormData(form).entries());
  delete data.id;
  return data;
}

function showFormError(message, fields = {}) {
  const box = $("form-error");
  box.hidden = !message;
  box.textContent = message || "";
  for (const name of ["played_at", "my_class", "my_deck", "opp_class", "opp_deck", "rank", "grade", "cr", "note"]) {
    $(`field-${name}`).classList.toggle("invalid", Boolean(fields[name]));
  }
  if (Object.keys(fields).length) {
    box.textContent = Object.values(fields).join(" / ");
    box.hidden = false;
  }
}

function startEdit(record) {
  state.editingId = record.id;
  $("field-id").value = record.id;
  $("field-played_at").value = record.played_at || "";
  $("field-rank").value = record.rank || "";
  syncGradeField();                       // ランクを入れてからでないと有効化されない
  $("field-grade").value = record.grade || "";
  $("field-cr").value = record.cr === null || record.cr === undefined ? "" : record.cr;
  $("field-my_class").value = record.my_class || "";
  $("field-my_deck").value = record.my_deck || "";
  $("field-opp_class").value = record.opp_class || "";
  $("field-opp_deck").value = record.opp_deck || "";
  $("field-note").value = record.note || "";
  for (const input of document.querySelectorAll('input[name="turn"]')) {
    input.checked = input.value === record.turn;
  }
  for (const input of document.querySelectorAll('input[name="result"]')) {
    input.checked = input.value === record.result;
  }
  $("submit-button").textContent = "更新する";
  $("cancel-edit").hidden = false;
  showFormError("");
  renderLog(state.records);
  $("entry-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelEdit() {
  state.editingId = null;
  $("field-id").value = "";
  $("submit-button").textContent = "記録する";
  $("cancel-edit").hidden = true;
  showFormError("");
  renderLog(state.records);
}

/** 記録後のリセット。次の試合ですぐ使う項目だけ残す。 */
function resetForNextGame(submitted) {
  const carried = Object.fromEntries(CARRY_FIELDS.map((f) => [f, submitted[f] || ""]));
  const playedAt = submitted.played_at;
  $("entry-form").reset();
  $("field-played_at").value = playedAt;
  // ランクを戻してからグレードの有効/無効を判定し、そのあとグレードを復元する。
  for (const [name, value] of Object.entries(carried)) {
    if (name === "grade") continue;
    $(`field-${name}`).value = value;
  }
  syncGradeField();
  $("field-grade").value = carried.grade;
  $("field-opp_class").focus();
}

async function submitForm(event) {
  event.preventDefault();
  const payload = formValues();
  const editingId = $("field-id").value;
  try {
    if (editingId) {
      await api(`/api/records/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      cancelEdit();
    } else {
      await api("/api/records", { method: "POST", body: JSON.stringify(payload) });
      resetForNextGame(payload);
    }
    showFormError("");
    await refresh();
  } catch (error) {
    showFormError(error.message, error.fields);
  }
}

async function removeRecord(record) {
  const label = `${record.played_at} ${record.my_class} vs ${record.opp_class}`;
  if (!window.confirm(`削除しますか？\n${label}`)) return;
  try {
    await api(`/api/records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
    if (state.editingId === record.id) cancelEdit();
    await refresh();
  } catch (error) {
    showFormError(error.message);
  }
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/** 入力済みのデッキ名を候補として集める (絞り込みでは自分デッキのみ)。 */
function collectDecks(records) {
  const all = new Set();
  const mine = new Set();
  for (const record of records) {
    if (record.my_deck) { all.add(record.my_deck); mine.add(record.my_deck); }
    if (record.opp_deck) all.add(record.opp_deck);
  }
  return { all: [...all].sort(), mine: [...mine].sort() };
}

function describeFilters() {
  const parts = [];
  if ($("filter-since").value) parts.push(`${$("filter-since").value} 以降`);
  if ($("filter-until").value) parts.push(`${$("filter-until").value} 以前`);
  if ($("filter-my_class").value) parts.push($("filter-my_class").value);
  if ($("filter-my_deck").value) parts.push($("filter-my_deck").value);
  if ($("filter-grade").value) parts.push($("filter-grade").value);
  $("filter-summary").textContent = parts.length ? `適用中: ${parts.join(" / ")}` : "全期間・全クラス";
}

async function refresh() {
  const query = filterQuery();
  // 絞り込み後の履歴と集計は同じ条件で取る。デッキ候補だけは全件から作る。
  const [{ records }, stats, all] = await Promise.all([
    api(`/api/records${query}`),
    api(`/api/stats${query}`),
    api("/api/records"),
  ]);
  state.records = records;
  state.stats = stats;

  const decks = collectDecks(all.records);
  $("deck-list").replaceChildren(...decks.all.map((deck) => el("option", { value: deck })));
  replaceOptions($("filter-my_deck"), decks.mine, { placeholder: "すべて" });

  describeFilters();
  renderStats(stats);
  renderLog(records);
}

async function init() {
  state.config = await api("/api/config");

  replaceOptions($("field-my_class"), state.config.classes, { placeholder: "選択" });
  replaceOptions($("field-opp_class"), state.config.classes, { placeholder: "選択" });
  replaceOptions($("field-rank"), state.config.ranks, { placeholder: "未設定" });
  replaceOptions($("field-grade"), state.config.grades, { placeholder: "未設定" });
  replaceOptions($("filter-my_class"), state.config.classes, { placeholder: "すべて" });
  replaceOptions($("filter-grade"), state.config.grades, { placeholder: "すべて" });
  // グレードが未定義の config なら絞り込み欄ごと出さない。
  $("filter-grade-field").hidden = state.config.grades.length === 0;
  syncGradeField();

  $("field-played_at").value = new Date().toLocaleDateString("sv-SE"); // ローカル時刻の YYYY-MM-DD
  $("entry-form").addEventListener("submit", submitForm);
  $("field-rank").addEventListener("change", syncGradeField);
  $("field-cr").addEventListener("input", autoSetGradeFromCr);
  // 手で選び直したら「CR から自動」の表示は消す。
  $("field-grade").addEventListener("change", syncGradeField);
  $("cancel-edit").addEventListener("click", cancelEdit);
  $("log-more").addEventListener("click", () => {
    state.logExpanded = true;
    renderLog(state.records);
  });

  // 円グラフの自分 / 相手切り替え。同じ集計結果の見方を変えるだけなので
  // サーバーには取りに行かない。
  for (const input of document.querySelectorAll('input[name="pie_scope"]')) {
    input.addEventListener("change", () => {
      state.pieScope = input.value;
      if (state.stats) renderPie(state.stats);
    });
  }

  for (const id of FILTER_IDS) {
    $(id).addEventListener("change", () => refresh().catch(reportFatal));
  }
  $("filter-reset").addEventListener("click", () => {
    for (const id of FILTER_IDS) $(id).value = "";
    refresh().catch(reportFatal);
  });

  await refresh();
}

function reportFatal(error) {
  showFormError(`サーバーと通信できません: ${error.message}`);
  console.error(error);
}

init().catch(reportFatal);
