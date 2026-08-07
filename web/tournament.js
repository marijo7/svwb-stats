"use strict";

/**
 * 大会 (2 デッキ BO1) の入力画面。
 *
 * 持ち込んだ 2 デッキを先に登録しておき、各ラウンドは「どちらを使ったか」を
 * 1 タップ選んで勝敗を入れる。BO1 なので 1 ラウンド = 1 試合で、保存されるのは
 * ランクマッチとまったく同じ形の戦績 (mode="tournament" と大会名が付くだけ)。
 *
 * そのため集計はランクマッチの画面のものをそのまま使える。この画面で出す成績も
 * /api/stats?mode=tournament&event=… を描いているだけで、独自の計算はしない。
 *
 * $ / el / api などの土台は common.js にある (先に読み込まれる)。
 */

/** 大会設定の保存先。サーバーには置かない (端末ごとに違う大会を開けるように)。 */
const SETUP_KEY = "svwb-stats:tournament-setup";

/** デッキ枠の呼び名。2 デッキ BO1 なので枠は 2 つ。 */
const DECK_MARKS = ["①", "②"];

/** 絞り込みの入力欄 id と、それが対応する API のクエリ名。 */
const FILTERS = {
  "filter-event": "event",
  "filter-since": "since",
  "filter-until": "until",
  "filter-my_class": "my_class",
  "filter-my_deck": "my_deck",
  "filter-turn": "turn",
};
const FILTER_IDS = Object.keys(FILTERS);

const state = {
  config: { classes: [] },
  setup: { event: "", played_at: today(), decks: [] },
  records: [],        // 絞り込み後の戦績 (ラウンド一覧に出るもの)
  allRecords: [],     // 大会の全戦績。候補作りと「次のラウンド」の判定に使う
  stats: null,
  editing: null,      // 編集中の戦績 (そのまま持って played_at / event を引き継ぐ)
  pieScope: "my",     // クラス別円グラフの対象 ("my" = 自分クラス / "opp" = 相手クラス)
};

// ---------------------------------------------------------------------------
// 大会設定
// ---------------------------------------------------------------------------

const emptyDeck = () => ({ my_class: "", my_deck: "" });

/** デッキが 1 つでも登録された、記録を始められる設定か。 */
const isSetUp = (setup) => Boolean(setup.event) && setup.decks.some((deck) => deck.my_class);

/** 入力欄から今の設定を読む。open は畳んだかどうかで、記録の内容とは関係ない。 */
function readSetup() {
  return {
    event: $("setup-event").value.trim(),
    played_at: $("setup-played_at").value || today(),
    decks: DECK_MARKS.map((_, i) => ({
      my_class: $(`setup-deck${i + 1}_class`).value,
      my_deck: $(`setup-deck${i + 1}_deck`).value.trim(),
    })),
    open: $("setup-panel").open,
  };
}

function writeSetup(setup) {
  $("setup-event").value = setup.event || "";
  $("setup-played_at").value = setup.played_at || today();
  DECK_MARKS.forEach((_, i) => {
    const deck = setup.decks[i] || emptyDeck();
    $(`setup-deck${i + 1}_class`).value = deck.my_class || "";
    $(`setup-deck${i + 1}_deck`).value = deck.my_deck || "";
  });
  $("setup-panel").open = setup.open;
}

/** 保存した設定を読む。壊れていたら黙って初期値に戻す (入力し直せば済む)。 */
function loadSetup() {
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(SETUP_KEY) || "null");
  } catch (error) {
    saved = null;
  }
  // 大会は日をまたがない。過ぎた日の設定が残っていると、その大会名・その日付の
  // まま記録し続けてしまうので、空から始める。先の日付 (前の晩に用意した場合)
  // はそのまま残す。
  if (saved && typeof saved.played_at === "string" && saved.played_at < today()) {
    return { event: "", played_at: today(), decks: DECK_MARKS.map(emptyDeck),
             open: true, cleared: true };
  }

  const decks = Array.isArray(saved && saved.decks) ? saved.decks : [];
  const setup = {
    event: (saved && typeof saved.event === "string") ? saved.event : "",
    played_at: (saved && typeof saved.played_at === "string") ? saved.played_at : today(),
    decks: DECK_MARKS.map((_, i) => ({
      my_class: (decks[i] && decks[i].my_class) || "",
      my_deck: (decks[i] && decks[i].my_deck) || "",
    })),
  };
  // 畳んだかどうかは覚えておく。まだ覚えていないときは、記録を始められる設定が
  // 残っていれば畳んでおく (大会の途中で開き直したときにラウンド入力から始まる)。
  setup.open = (saved && typeof saved.open === "boolean") ? saved.open : !isSetUp(setup);
  return setup;
}

function saveSetup(setup) {
  try {
    window.localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch (error) {
    // プライベートブラウズなどで保存できないだけ。入力自体は続けられる。
  }
}

/** 選択中の使用デッキ (枠の番号)。未選択なら null。 */
function selectedDeckIndex() {
  const checked = $("field-deck").querySelector("input:checked");
  return checked ? Number(checked.value) : null;
}

/**
 * 使用デッキの選択肢を作り直す。クラスを選んだ枠だけを出す。
 * 選び直しの手間を減らすため、作り直しても選択は残す。
 */
function renderDeckChoices() {
  const box = $("field-deck");
  const previous = selectedDeckIndex();
  const usable = state.setup.decks
    .map((deck, index) => ({ ...deck, index }))
    .filter((deck) => deck.my_class);

  if (!usable.length) {
    box.replaceChildren(el("p", {
      class: "hint",
      text: "大会設定でデッキのクラスを選ぶと、ここに出ます。",
    }));
    return;
  }

  box.replaceChildren(...usable.map((deck) => {
    const input = el("input", { type: "radio", name: "deck", value: String(deck.index), required: "" });
    input.checked = deck.index === previous;
    return el("label", {}, [
      input,
      el("span", {}, [
        el("strong", { text: `${DECK_MARKS[deck.index]} ${deck.my_deck || deck.my_class}` }),
        el("em", { text: deck.my_deck ? deck.my_class : "デッキ名なし" }),
      ]),
    ]);
  }));
}

/**
 * 畳んだときに見出しの横へ出す要約。何を記録している状態なのかが
 * 開かなくても分かるようにする。日付を含めるのは、前日の設定が残ったまま
 * 記録を続けてしまうのを防ぐため。
 */
function setupDigest() {
  const { event, played_at: playedAt, decks } = state.setup;
  if (!event) return "大会名が未入力";
  const registered = decks.filter((deck) => deck.my_class)
    .map((deck) => side(deck.my_class, deck.my_deck));
  return `${event} · ${playedAt} · ${registered.length ? registered.join(" ＋ ") : "デッキ未登録"}`;
}

/** 設定を読み直して保存し、画面に反映する。 */
function syncSetup() {
  state.setup = readSetup();
  saveSetup(state.setup);
  renderDeckChoices();
  $("setup-digest").textContent = setupDigest();
  const named = Boolean(state.setup.event);
  if (named) $("setup-note").hidden = true;
  $("submit-button").disabled = !named;
  $("round-hint").textContent = named
    ? "大会名・日付・使用デッキは次のラウンドに引き継がれます"
    : "先に大会名を入力してください";
}

// ---------------------------------------------------------------------------
// ラウンド一覧
// ---------------------------------------------------------------------------

function renderRounds(records) {
  const table = $("rounds");
  table.replaceChildren();
  $("rounds-count").textContent = records.length ? `(${records.length} 戦)` : "";

  table.appendChild(el("thead", {}, [
    el("tr", {}, ["大会", "R", "対戦相手", "自分", "相手", "先後", "結果", "メモ", ""].map(
      (label) => el("th", { text: label }))),
  ]));

  if (!records.length) {
    table.appendChild(el("tbody", {}, [
      el("tr", {}, [el("td", {
        colspan: "9", class: "empty-cell", text: "この条件に合う大会の戦績がありません。",
      })]),
    ]));
    return;
  }

  const body = el("tbody");
  for (const record of records) {
    body.appendChild(el("tr", { class: record.id === (state.editing && state.editing.id) ? "editing" : "" }, [
      el("td", { class: "event", text: record.event || "(名前なし)" }),
      el("td", { text: record.round ? `R${record.round}` : "" }),
      el("td", { text: record.opponent || "" }),
      el("td", { text: side(record.my_class, record.my_deck) }),
      el("td", {}, opponentCell(record)),
      el("td", { text: TURN_LABEL[record.turn] || "" }),
      el("td", { class: record.result, text: RESULT_LABEL[record.result] || "" }),
      el("td", { class: "note", title: record.note || "", text: record.note || "" }),
      el("td", {}, [
        el("button", { class: "link", type: "button", text: "編集", onclick: () => startEdit(record) }),
        el("button", { class: "link", type: "button", text: "削除", onclick: () => removeRecord(record) }),
      ]),
    ]));
  }
  table.appendChild(body);
}

// ---------------------------------------------------------------------------
// フォーム
// ---------------------------------------------------------------------------

function showFormError(message, fields = {}) {
  const box = $("form-error");
  const messages = Object.values(fields);
  box.textContent = messages.length ? messages.join(" / ") : (message || "");
  box.hidden = !box.textContent;
  for (const name of ["round", "opponent", "opp_class", "opp_deck", "opp_class2", "opp_deck2", "note"]) {
    $(`field-${name}`).classList.toggle("invalid", Boolean(fields[name]));
  }
}

function checkedValue(name) {
  const checked = $("round-form").querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : "";
}

/**
 * 次に記録するラウンド番号。今の大会で記録済みの最大 + 1。
 * 絞り込みで別の大会を見ている間も、入力するのは今の大会なのでそちらを数える。
 */
function nextRound() {
  const rounds = state.allRecords
    .filter((record) => (record.event || "") === state.setup.event)
    .map((record) => record.round || 0);
  return Math.min(Math.max(0, ...rounds) + 1, 99);
}

function formPayload() {
  const index = selectedDeckIndex();
  const deck = index === null ? emptyDeck() : state.setup.decks[index];
  // 編集中は、その記録が属する大会と日付をそのまま保つ。設定を書き換えても
  // 過去のラウンドが別の大会へ移らないようにする。
  const base = state.editing || state.setup;
  return {
    mode: "tournament",
    event: base.event || "",
    played_at: base.played_at || today(),
    round: $("field-round").value,
    opponent: $("field-opponent").value.trim(),
    my_class: deck.my_class,
    my_deck: deck.my_deck,
    opp_class: $("field-opp_class").value,
    opp_deck: $("field-opp_deck").value.trim(),
    opp_class2: $("field-opp_class2").value,
    opp_deck2: $("field-opp_deck2").value.trim(),
    turn: checkedValue("turn"),
    result: checkedValue("result"),
    note: $("field-note").value.trim(),
  };
}

function startEdit(record) {
  state.editing = record;
  $("field-id").value = record.id;
  $("field-round").value = record.round || "";
  $("field-opponent").value = record.opponent || "";
  $("field-opp_class").value = record.opp_class || "";
  $("field-opp_deck").value = record.opp_deck || "";
  $("field-opp_class2").value = record.opp_class2 || "";
  $("field-opp_deck2").value = record.opp_deck2 || "";
  $("field-note").value = record.note || "";
  for (const input of $("round-form").querySelectorAll('input[name="turn"], input[name="result"]')) {
    input.checked = input.value === record.turn || input.value === record.result;
  }

  // 登録した 2 デッキのどちらで記録したのかを探す。設定を変えたあとだと
  // 一致しないことがあるので、そのときは選び直してもらう。
  const match = state.setup.decks.findIndex(
    (deck) => deck.my_class === record.my_class && deck.my_deck === (record.my_deck || ""));
  for (const input of $("field-deck").querySelectorAll("input")) {
    input.checked = Number(input.value) === match;
  }
  showFormError(match === -1
    ? `この記録の ${side(record.my_class, record.my_deck)} は今の登録と違います。使用デッキを選び直してください。`
    : "");

  $("submit-button").textContent = "更新する";
  $("submit-button").disabled = false;
  $("cancel-edit").hidden = false;
  renderRounds(state.records);
  $("round-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelEdit() {
  state.editing = null;
  $("field-id").value = "";
  $("submit-button").textContent = "記録する";
  $("cancel-edit").hidden = true;
  showFormError("");
  syncSetup();
  renderRounds(state.records);
}

/** 記録後のリセット。使用デッキは残し、相手の情報と勝敗だけ空にする。 */
function resetForNextRound() {
  $("field-opponent").value = "";
  $("field-opp_class").value = "";
  $("field-opp_deck").value = "";
  $("field-opp_class2").value = "";
  $("field-opp_deck2").value = "";
  $("field-note").value = "";
  for (const input of $("round-form").querySelectorAll('input[name="turn"], input[name="result"]')) {
    input.checked = false;
  }
  $("field-round").value = nextRound();
  $("field-opp_class").focus();
}

async function submitForm(event) {
  event.preventDefault();
  const payload = formPayload();
  if (!payload.event) {
    showFormError("大会名を入力してください。");
    return;
  }
  if (!payload.my_class) {
    showFormError("使用デッキを選んでください。大会設定でデッキのクラスを登録すると選べます。");
    return;
  }
  try {
    if (state.editing) {
      await api(`/api/records/${encodeURIComponent(state.editing.id)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      cancelEdit();
    } else {
      await api("/api/records", { method: "POST", body: JSON.stringify(payload) });
      showFormError("");
      // 別の大会を見ている最中なら、今記録したラウンドが見えるよう戻す。
      const shown = $("filter-event").value;
      if (shown && shown !== state.setup.event) focusCurrentEvent();
      await refresh();
      resetForNextRound();
      return;
    }
    await refresh();
  } catch (error) {
    showFormError(error.message, error.fields);
  }
}

async function removeRecord(record) {
  const label = `R${record.round || "?"} ${side(record.my_class, record.my_deck)} vs ${record.opp_class}`;
  if (!window.confirm(`削除しますか？\n${label}`)) return;
  try {
    await api(`/api/records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
    if (state.editing && state.editing.id === record.id) cancelEdit();
    await refresh();
  } catch (error) {
    showFormError(error.message);
  }
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/** 絞り込み欄の値を API のクエリ名で拾う。この画面は大会固定。 */
function filterValues() {
  return {
    ...Object.fromEntries(Object.entries(FILTERS).map(([id, name]) => [name, $(id).value])),
    mode: "tournament",
  };
}

function describeFilters() {
  const parts = [$("filter-event").value || "すべての大会"];
  if ($("filter-since").value) parts.push(`${$("filter-since").value} 以降`);
  if ($("filter-until").value) parts.push(`${$("filter-until").value} 以前`);
  if ($("filter-my_class").value) parts.push($("filter-my_class").value);
  if ($("filter-my_deck").value) parts.push($("filter-my_deck").value);
  if ($("filter-turn").value) parts.push(TURN_LABEL[$("filter-turn").value]);
  $("filter-summary").textContent = `対象: ${parts.join(" / ")}`;
}

/**
 * 大会の全戦績から選択肢を作る。今の大会は 1 戦も記録していなくても選べるよう、
 * 記録済みの大会名に足しておく (これが絞り込みの既定値になる)。
 */
function fillDynamicOptions(records) {
  const decks = new Set();
  const myDecks = new Set();
  const events = [];
  for (const record of records) {
    if (record.my_deck) { decks.add(record.my_deck); myDecks.add(record.my_deck); }
    if (record.opp_deck) decks.add(record.opp_deck);
    if (record.opp_deck2) decks.add(record.opp_deck2);
    if (record.event && !events.includes(record.event)) events.push(record.event);
  }
  events.reverse();   // 新しい大会ほど上に
  if (state.setup.event && !events.includes(state.setup.event)) events.unshift(state.setup.event);

  $("deck-list").replaceChildren(...[...decks].sort().map((deck) => el("option", { value: deck })));
  $("event-list").replaceChildren(...events.map((name) => el("option", { value: name })));
  replaceOptions($("filter-event"), events, { placeholder: "すべての大会" });
  replaceOptions($("filter-my_deck"), [...myDecks].sort(), { placeholder: "すべて" });
}

/**
 * 絞り込みを「今の大会」に戻す。大会名が空なら全大会。
 *
 * 1 戦も記録していない大会はまだ選択肢に無いので、その場で足してから選ぶ
 * (選択肢は戦績から作られるため。次の refresh で作り直しても値は残る)。
 */
function focusCurrentEvent() {
  for (const id of FILTER_IDS) $(id).value = "";
  const select = $("filter-event");
  const known = [...select.options].some((option) => option.value === state.setup.event);
  if (state.setup.event && !known) {
    select.appendChild(el("option", { value: state.setup.event, text: state.setup.event }));
  }
  select.value = state.setup.event;
}

async function refresh() {
  // 候補と「次のラウンド」は絞り込みに関係なく大会の全戦績から作る。
  const all = await api("/api/records?mode=tournament");
  state.allRecords = all.records;
  fillDynamicOptions(all.records);

  const query = toQuery(filterValues());
  const [{ records }, stats] = await Promise.all([
    api(`/api/records${query}`),
    api(`/api/stats${query}`),
  ]);
  // 新しい大会を上に、その中はラウンド順 (ラウンド未設定は末尾)。複数の大会を
  // 並べたときに、同じ大会のラウンドが飛び飛びにならないよう大会名でまとめる。
  state.records = [...records].sort((a, b) =>
    (b.played_at || "").localeCompare(a.played_at || "")
    || (a.event || "").localeCompare(b.event || "")
    || (a.round || 99) - (b.round || 99));
  state.stats = stats;

  describeFilters();
  renderStats(stats, { pieScope: state.pieScope, headline: "全体" });
  renderRounds(state.records);

  const overall = stats.overall;
  $("topbar-summary").replaceChildren(
    el("strong", { text: overall.games ? `${overall.wins}-${overall.losses}` : "—" }),
    document.createTextNode(overall.games ? ` / 勝率 ${pct(overall.winrate)}` : " / 未記録"),
  );
  if (!state.editing) $("field-round").value = nextRound();
}

async function init() {
  state.config = await api("/api/config");
  for (const id of ["setup-deck1_class", "setup-deck2_class"]) {
    replaceOptions($(id), state.config.classes, { placeholder: "未登録" });
  }
  replaceOptions($("field-opp_class"), state.config.classes, { placeholder: "選択" });
  replaceOptions($("field-opp_class2"), state.config.classes, { placeholder: "不明" });
  replaceOptions($("filter-my_class"), state.config.classes, { placeholder: "すべて" });

  const saved = loadSetup();
  writeSetup(saved);
  $("setup-note").hidden = !saved.cleared;
  syncSetup();
  // 既定では今の大会だけを見る。他の大会や全大会は絞り込みで切り替える。
  focusCurrentEvent();

  // デッキの登録はその場で使用デッキの選択肢へ反映する (通信は不要)。
  for (const id of ["setup-deck1_class", "setup-deck1_deck", "setup-deck2_class", "setup-deck2_deck"]) {
    $(id).addEventListener("input", syncSetup);
  }
  // 畳んだ / 開いたを覚える。次に開いたときも同じ状態で始まる。
  $("setup-panel").addEventListener("toggle", syncSetup);
  // 大会名と日付を変えると記録先の大会そのものが変わる。絞り込みもその大会へ
  // 合わせ直してから取り直す (入力している大会と見ている集計をずらさない)。
  for (const id of ["setup-event", "setup-played_at"]) {
    $(id).addEventListener("change", () => {
      if (state.editing) cancelEdit();
      syncSetup();
      focusCurrentEvent();
      refresh().catch(reportFatal);
    });
  }

  $("round-form").addEventListener("submit", submitForm);
  $("cancel-edit").addEventListener("click", cancelEdit);

  for (const id of FILTER_IDS) {
    $(id).addEventListener("change", () => refresh().catch(reportFatal));
  }
  $("filter-reset").addEventListener("click", () => {
    focusCurrentEvent();
    refresh().catch(reportFatal);
  });

  // 円グラフの自分 / 相手切り替え。同じ集計結果の見方を変えるだけなので
  // サーバーには取りに行かない。
  for (const input of document.querySelectorAll('input[name="pie_scope"]')) {
    input.addEventListener("change", () => {
      state.pieScope = input.value;
      if (state.stats) renderPie(state.stats, state.pieScope);
    });
  }

  await refresh();
}

function reportFatal(error) {
  showFormError(`サーバーと通信できません: ${error.message}`);
  console.error(error);
}

init().catch(reportFatal);
