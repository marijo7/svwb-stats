"use strict";

/**
 * svwb-stats のランクマッチ画面。
 *
 * サーバー (svwb.py serve) の JSON API だけを相手にする薄い画面で、
 * 勝率などの計算は一切ここではやらず /api/stats の結果を描画する。
 * 集計ロジックを Python 側に一本化しておくと、CLI (`svwb.py stats`) と
 * ブラウザで数字がずれない。
 *
 * $ / el / api などの土台は common.js、集計の描画は stats.js にある
 * (どちらも先に読み込まれ、大会の画面 tournament.js と共用している)。
 *
 * この画面が扱うのはランクマッチの戦績だけ。大会の戦績は大会のタブが持つので、
 * 一覧も集計も mode=ladder に固定して取りに行く。
 */

/**
 * 直近の入力。連戦を記録するとき毎回選び直さずに済むよう引き継ぐ。
 * 相手グレードと相手 CR は入れない。対戦相手ごとに違う値なので、残っていると
 * 別人の数字をそのまま記録してしまう。相手ランクは Master / Grand Master の
 * 2 段しかなく、同じ帯とばかり当たるので引き継ぐ (違う帯に当たったら選び直す)。
 */
const CARRY_FIELDS = ["my_class", "my_deck", "opp_rank"];

/** 今チェックされている相手ランクの値。無ければ空文字。 */
function checkedOppRank() {
  const checked = document.querySelector('input[name="opp_rank"]:checked');
  return checked ? checked.value : "";
}

/**
 * 相手ランクのトグルを作る。config.ranks の数だけボタンが並ぶ (既定は
 * Master / Grand Master の 2 つ)。select ではなくトグルにしたのは、必須項目を
 * 「未選択のまま素通りできる空欄」に見せたくないため。
 */
function renderRankToggle() {
  const box = $("field-opp_rank");
  box.replaceChildren(...state.config.ranks.map((rank) =>
    el("label", {}, [
      el("input", { type: "radio", name: "opp_rank", value: rank, required: "" }),
      el("span", { text: rank }),
    ])));
  for (const input of box.querySelectorAll("input")) {
    input.addEventListener("change", syncGradeField);
  }
}

/** 絞り込みの入力欄 id と、それが対応する API のクエリ名。 */
const FILTERS = {
  "filter-since": "since",
  "filter-until": "until",
  "filter-my_class": "my_class",
  "filter-my_deck": "my_deck",
  "filter-turn": "turn",
};
const FILTER_IDS = Object.keys(FILTERS);

/**
 * 履歴の既定表示件数。履歴の枠は縦スクロールの固定高さ (style.css の
 * .log-scroll) なので、ここを増やしても画面の高さは変わらない。枠の中で
 * 「残りを表示」を押すまでにスクロールする量を抑えるための値。
 */
const LOG_PAGE_SIZE = 15;

const state = {
  config: { classes: [], ranks: [], grades: [], grade_rank: "", grade_thresholds: {} },
  records: [],
  stats: null,
  editingId: null,
  beforeEdit: null,    // 編集に入る前のフォーム。抜けたときに戻すため
  logExpanded: false,
  pieScope: "my",      // クラス別円グラフの対象 ("my" = 自分クラス / "opp" = 相手クラス)
};

// ---------------------------------------------------------------------------
// 描画ヘルパー
// ---------------------------------------------------------------------------

/** 絞り込み欄の値を API のクエリ名で拾う。この画面はランクマッチ固定。 */
function filterValues() {
  return {
    ...Object.fromEntries(Object.entries(FILTERS).map(([id, name]) => [name, $(id).value])),
    mode: "ladder",
  };
}

function syncGradeField() {
  const select = $("field-opp_grade");
  const { grades, grade_rank: gradeRank } = state.config;
  const atGradeRank = !gradeRank || checkedOppRank() === gradeRank;
  const active = grades.length > 0 && atGradeRank;
  select.disabled = !active;
  if (!active) select.value = "";
  $("grade-hint").textContent = grades.length === 0 ? "未設定"
    : active ? "任意" : `${gradeRank} のみ`;

  // 相手 CR もグラマス帯のみ (CR 自体がその帯にしか無い)。グレードと違い
  // config の一覧に依存しないので、ランクの条件だけで判定する。
  const cr = $("field-opp_cr");
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
 * 相手 CR を入れたら相手グレードを自動で合わせる。どちらも同じ相手の値なので、
 * CR が決まればグレードも決まる。
 *
 * 閾値を持たないグレード (BEYOND は LEGEND のうちランキング上位のみで、CR だけ
 * では決まらない) が選ばれているときは触らない。自動設定が毎回 LEGEND へ
 * 引き戻してしまうため。CR を消しただけのときもグレードは残す。
 */
function autoSetGradeFromCr() {
  const select = $("field-opp_grade");
  const thresholds = state.config.grade_thresholds || {};
  if (select.disabled || !Object.keys(thresholds).length) return;
  if (select.value && !(select.value in thresholds)) return;

  const raw = $("field-opp_cr").value.trim();
  if (raw === "") return;
  const cr = Number(raw);
  if (!Number.isInteger(cr) || cr < 0) return;

  const derived = gradeForCr(cr);
  if (!derived) return;
  select.value = derived;
  $("grade-hint").textContent = "CR から自動";
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
    body.appendChild(el("tr", { class: record.id === state.editingId ? "editing" : "" }, [
      el("td", { text: record.played_at }),
      el("td", { text: side(record.my_class, record.my_deck) }),
      el("td", {}, opponentCell(record)),
      el("td", { text: TURN_LABEL[record.turn] || "" }),
      el("td", { class: record.result, text: RESULT_LABEL[record.result] || "" }),
      el("td", { text: record.opp_rank || "" }),
      el("td", { text: record.opp_grade || "" }),
      el("td", { text: record.opp_cr === null || record.opp_cr === undefined ? "" : String(record.opp_cr) }),
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
  for (const name of ["played_at", "my_class", "my_deck", "opp_class", "opp_deck", "opp_rank", "opp_grade", "opp_cr", "note"]) {
    $(`field-${name}`).classList.toggle("invalid", Boolean(fields[name]));
  }
  if (Object.keys(fields).length) {
    box.textContent = Object.values(fields).join(" / ");
    box.hidden = false;
  }
}

function startEdit(record) {
  // 編集に入る前の入力を覚えておく。編集を抜けたときに日付と自分の情報を
  // ここへ戻す (履歴の古い記録を直したあと、その記録の日付やクラスが
  // 次の入力に残らないようにする)。編集中にさらに別の行を編集しても上書きしない。
  if (!state.editingId) state.beforeEdit = formValues();
  state.editingId = record.id;
  $("field-id").value = record.id;
  $("field-played_at").value = record.played_at || "";
  $("entry-form").elements["opp_rank"].value = record.opp_rank || "";
  syncGradeField();                       // ランクを入れてからでないと有効化されない
  $("field-opp_grade").value = record.opp_grade || "";
  $("field-opp_cr").value = record.opp_cr === null || record.opp_cr === undefined ? "" : record.opp_cr;
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
  resetAfterEdit();
  $("submit-button").textContent = "記録する";
  $("cancel-edit").hidden = true;
  showFormError("");
  renderLog(state.records);
}

/**
 * 編集を抜けたときの後始末。編集に入る前のフォームをそのまま戻す。
 *
 * 直した記録の内容が残っていると、次の試合をその内容で記録してしまう。かと
 * いって全部空にすると、記録の途中で履歴を直しただけなのに打ち直しになる。
 * 「編集ボタンを押す前」に戻すのが、どちらの困りごとも起きない。
 */
function resetAfterEdit() {
  const before = state.beforeEdit || {};
  state.beforeEdit = null;

  const form = $("entry-form");
  form.reset();
  // ランクを先に戻す。グレードと CR が触れるかどうかがこれで決まる。
  form.elements["opp_rank"].value = before.opp_rank || "";
  syncGradeField();
  for (const [name, value] of Object.entries(before)) {
    const field = form.elements[name];
    if (field) field.value = value;   // radio の組は value を入れると選択が移る
  }
  $("field-played_at").value = before.played_at || today();
}

/** 記録後のリセット。次の試合ですぐ使う項目だけ残す。 */
function resetForNextGame(submitted) {
  const carried = Object.fromEntries(CARRY_FIELDS.map((f) => [f, submitted[f] || ""]));
  const playedAt = submitted.played_at;
  const form = $("entry-form");
  form.reset();
  $("field-played_at").value = playedAt;
  // form.elements 経由にする。opp_rank はトグル (input の組) で field-opp_rank
  // 自体は div なので .value を持たない (radio の組は value を入れると選択が移る)。
  for (const [name, value] of Object.entries(carried)) {
    const field = form.elements[name];
    if (field) field.value = value;
  }
  syncGradeField();   // ランクを戻したあとで相手グレード / 相手 CR の有効・無効を決める
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
    if (record.opp_deck2) all.add(record.opp_deck2);
  }
  return { all: [...all].sort(), mine: [...mine].sort() };
}

function describeFilters() {
  const parts = [];
  if ($("filter-since").value) parts.push(`${$("filter-since").value} 以降`);
  if ($("filter-until").value) parts.push(`${$("filter-until").value} 以前`);
  if ($("filter-my_class").value) parts.push($("filter-my_class").value);
  if ($("filter-my_deck").value) parts.push($("filter-my_deck").value);
  if ($("filter-turn").value) parts.push(TURN_LABEL[$("filter-turn").value]);
  $("filter-summary").textContent = parts.length ? `適用中: ${parts.join(" / ")}` : "全期間・全クラス";
}

/** ランクマッチの全戦績から作るデッキ名の候補。絞り込み結果ではなく常に全件から作る。 */
function fillDynamicOptions(records) {
  const decks = collectDecks(records);
  $("deck-list").replaceChildren(...decks.all.map((deck) => el("option", { value: deck })));
  replaceOptions($("filter-my_deck"), decks.mine, { placeholder: "すべて" });
}

async function refresh() {
  const query = toQuery(filterValues());
  // 絞り込み後の履歴と集計は同じ条件で取る。デッキの候補だけは
  // (絞り込みで消えないよう) ランクマッチの全件から作る。
  const [{ records }, stats, all] = await Promise.all([
    api(`/api/records${query}`),
    api(`/api/stats${query}`),
    api("/api/records?mode=ladder"),
  ]);
  state.records = records;
  state.stats = stats;

  fillDynamicOptions(all.records);
  describeFilters();
  renderStats(stats, { pieScope: state.pieScope });
  renderLog(records);

  const overall = stats.overall;
  $("topbar-summary").replaceChildren(
    el("strong", { text: overall.games ? pct(overall.winrate) : "—" }),
    document.createTextNode(` / ${overall.games} 戦`),
  );
}

async function init() {
  state.config = await api("/api/config");

  replaceOptions($("field-my_class"), state.config.classes, { placeholder: "選択" });
  replaceOptions($("field-opp_class"), state.config.classes, { placeholder: "選択" });
  renderRankToggle();
  replaceOptions($("field-opp_grade"), state.config.grades, { placeholder: "未設定" });
  replaceOptions($("filter-my_class"), state.config.classes, { placeholder: "すべて" });
  syncGradeField();

  $("field-played_at").value = today();
  $("entry-form").addEventListener("submit", submitForm);
  $("field-opp_cr").addEventListener("input", autoSetGradeFromCr);
  // 手で選び直したら「CR から自動」の表示は消す。
  $("field-opp_grade").addEventListener("change", syncGradeField);
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
      if (state.stats) renderPie(state.stats, state.pieScope);
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
