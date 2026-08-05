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

/** 絞り込みの入力欄 id と、それが対応する API のクエリ名。 */
const FILTERS = {
  "filter-since": "since",
  "filter-until": "until",
  "filter-my_class": "my_class",
  "filter-my_deck": "my_deck",
  "filter-grade": "opp_grade",
};
const FILTER_IDS = Object.keys(FILTERS);

/** 履歴の既定表示件数。 */
const LOG_PAGE_SIZE = 30;

const state = {
  config: { classes: [], ranks: [], grades: [], grade_rank: "" },
  records: [],
  stats: null,
  editingId: null,
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
  const atGradeRank = !gradeRank || $("field-opp_rank").value === gradeRank;
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
  state.editingId = record.id;
  $("field-id").value = record.id;
  $("field-played_at").value = record.played_at || "";
  $("field-opp_rank").value = record.opp_rank || "";
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
  for (const [name, value] of Object.entries(carried)) {
    $(`field-${name}`).value = value;
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
  if ($("filter-grade").value) parts.push($("filter-grade").value);
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
  replaceOptions($("field-opp_rank"), state.config.ranks, { placeholder: "未設定" });
  replaceOptions($("field-opp_grade"), state.config.grades, { placeholder: "未設定" });
  replaceOptions($("filter-my_class"), state.config.classes, { placeholder: "すべて" });
  replaceOptions($("filter-grade"), state.config.grades, { placeholder: "すべて" });
  // グレードが未定義の config なら絞り込み欄ごと出さない。
  $("filter-grade-field").hidden = state.config.grades.length === 0;
  syncGradeField();

  $("field-played_at").value = today();
  $("entry-form").addEventListener("submit", submitForm);
  $("field-opp_rank").addEventListener("change", syncGradeField);
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
