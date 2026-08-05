"use strict";

/**
 * 大会 (2 デッキ BO1) の入力画面。
 *
 * 持ち込んだ 2 デッキを先に登録しておき、各ラウンドは「どちらを使ったか」を
 * 1 タップ選んで勝敗を入れる。BO1 なので 1 ラウンド = 1 試合で、保存されるのは
 * ランク戦とまったく同じ形の戦績 (mode="tournament" と大会名が付くだけ)。
 *
 * そのため集計はランク戦の画面のものをそのまま使える。この画面で出す成績も
 * /api/stats?mode=tournament&event=… を描いているだけで、独自の計算はしない。
 *
 * $ / el / api などの土台は common.js にある (先に読み込まれる)。
 */

/** 大会設定の保存先。サーバーには置かない (端末ごとに違う大会を開けるように)。 */
const SETUP_KEY = "svwb-stats:tournament-setup";

/** デッキ枠の呼び名。2 デッキ BO1 なので枠は 2 つ。 */
const DECK_MARKS = ["①", "②"];

const state = {
  config: { classes: [] },
  setup: { event: "", played_at: today(), decks: [] },
  records: [],        // 今開いている大会の記録
  editing: null,      // 編集中の戦績 (そのまま持って played_at / event を引き継ぐ)
};

// ---------------------------------------------------------------------------
// 大会設定
// ---------------------------------------------------------------------------

const emptyDeck = () => ({ my_class: "", my_deck: "" });

/** 入力欄から今の設定を読む。 */
function readSetup() {
  return {
    event: $("setup-event").value.trim(),
    played_at: $("setup-played_at").value || today(),
    decks: DECK_MARKS.map((_, i) => ({
      my_class: $(`setup-deck${i + 1}_class`).value,
      my_deck: $(`setup-deck${i + 1}_deck`).value.trim(),
    })),
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
}

/** 保存した設定を読む。壊れていたら黙って初期値に戻す (入力し直せば済む)。 */
function loadSetup() {
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(SETUP_KEY) || "null");
  } catch (error) {
    saved = null;
  }
  const decks = Array.isArray(saved && saved.decks) ? saved.decks : [];
  return {
    event: (saved && typeof saved.event === "string") ? saved.event : "",
    played_at: (saved && typeof saved.played_at === "string") ? saved.played_at : today(),
    decks: DECK_MARKS.map((_, i) => ({
      my_class: (decks[i] && decks[i].my_class) || "",
      my_deck: (decks[i] && decks[i].my_deck) || "",
    })),
  };
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

/** 設定を読み直して保存し、画面に反映する。 */
function syncSetup() {
  state.setup = readSetup();
  saveSetup(state.setup);
  renderDeckChoices();
  const named = Boolean(state.setup.event);
  $("submit-button").disabled = !named;
  $("round-hint").textContent = named
    ? "大会名・日付・使用デッキは次のラウンドに引き継がれます"
    : "先に大会名を入力してください";
}

// ---------------------------------------------------------------------------
// 成績 (ランク戦画面と同じ /api/stats の結果を描くだけ)
// ---------------------------------------------------------------------------

function renderSummary(stats) {
  const overall = stats ? stats.overall : { games: 0, wins: 0, losses: 0, winrate: 0 };
  const hasData = overall.games > 0;
  $("summary-empty").hidden = hasData;
  $("summary-body").hidden = !hasData;

  $("topbar-summary").replaceChildren(
    el("strong", { text: hasData ? `${overall.wins}-${overall.losses}` : "—" }),
    document.createTextNode(hasData ? ` / 勝率 ${pct(overall.winrate)}` : " / 未記録"),
  );
  if (!hasData) return;

  $("headline").replaceChildren(
    statCard("この大会", overall),
    statCard("先攻", stats.turn_order.first),
    statCard("後攻", stats.turn_order.second),
  );
  renderBreakdown("by-deck", stats.by_my_deck, "デッキ");
  renderBreakdown("by-opp", stats.by_opp_class, "相手クラス");
}

function renderRounds(records) {
  const table = $("rounds");
  table.replaceChildren();
  $("rounds-count").textContent = records.length ? `(${records.length} 戦)` : "";

  table.appendChild(el("thead", {}, [
    el("tr", {}, ["R", "対戦相手", "自分", "相手", "先後", "結果", "メモ", ""].map(
      (label) => el("th", { text: label }))),
  ]));

  if (!records.length) {
    table.appendChild(el("tbody", {}, [
      el("tr", {}, [el("td", {
        colspan: "8", class: "empty-cell",
        text: state.setup.event ? "この大会の記録はまだありません。" : "大会名を入力すると、その大会の記録が出ます。",
      })]),
    ]));
    return;
  }

  const body = el("tbody");
  for (const record of records) {
    body.appendChild(el("tr", { class: record.id === (state.editing && state.editing.id) ? "editing" : "" }, [
      el("td", { text: record.round ? `R${record.round}` : "" }),
      el("td", { text: record.opponent || "" }),
      el("td", { text: side(record.my_class, record.my_deck) }),
      el("td", { text: side(record.opp_class, record.opp_deck) }),
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
  for (const name of ["round", "opponent", "opp_class", "opp_deck", "note"]) {
    $(`field-${name}`).classList.toggle("invalid", Boolean(fields[name]));
  }
}

function checkedValue(name) {
  const checked = $("round-form").querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : "";
}

/** 次に記録するラウンド番号。記録済みの最大 + 1。 */
function nextRound() {
  const rounds = state.records.map((record) => record.round || 0);
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

/** 入力済みのデッキ名 / 大会名を候補にする。全戦績から作る。 */
function fillDatalists(records) {
  const decks = new Set();
  const events = [];
  for (const record of records) {
    if (record.my_deck) decks.add(record.my_deck);
    if (record.opp_deck) decks.add(record.opp_deck);
    if (record.event && !events.includes(record.event)) events.push(record.event);
  }
  $("deck-list").replaceChildren(...[...decks].sort().map((deck) => el("option", { value: deck })));
  $("event-list").replaceChildren(...events.reverse().map((name) => el("option", { value: name })));
}

async function refresh() {
  const event = state.setup.event;
  const all = await api("/api/records");
  fillDatalists(all.records);

  const link = $("full-stats-link");
  link.href = `/${toQuery({ mode: "tournament", event })}`;
  link.hidden = !event;

  if (!event) {
    state.records = [];
    renderSummary(null);
    renderRounds([]);
    return;
  }

  const query = toQuery({ mode: "tournament", event });
  const [{ records }, stats] = await Promise.all([
    api(`/api/records${query}`),
    api(`/api/stats${query}`),
  ]);
  // 記録した順ではなくラウンド順に並べる。ラウンド未設定は末尾。
  state.records = [...records].sort((a, b) => (a.round || 99) - (b.round || 99));
  renderSummary(stats);
  renderRounds(state.records);
  if (!state.editing) $("field-round").value = nextRound();
}

async function init() {
  state.config = await api("/api/config");
  for (const id of ["setup-deck1_class", "setup-deck2_class"]) {
    replaceOptions($(id), state.config.classes, { placeholder: "未登録" });
  }
  replaceOptions($("field-opp_class"), state.config.classes, { placeholder: "選択" });

  writeSetup(loadSetup());
  syncSetup();

  // デッキの登録はその場で使用デッキの選択肢へ反映する (通信は不要)。
  for (const id of ["setup-deck1_class", "setup-deck1_deck", "setup-deck2_class", "setup-deck2_deck"]) {
    $(id).addEventListener("input", syncSetup);
  }
  // 大会名と日付を変えると見ている大会そのものが変わるので、取り直す。
  for (const id of ["setup-event", "setup-played_at"]) {
    $(id).addEventListener("change", () => {
      if (state.editing) cancelEdit();
      syncSetup();
      refresh().catch(reportFatal);
    });
  }

  $("round-form").addEventListener("submit", submitForm);
  $("cancel-edit").addEventListener("click", cancelEdit);

  await refresh();
}

function reportFatal(error) {
  showFormError(`サーバーと通信できません: ${error.message}`);
  console.error(error);
}

init().catch(reportFatal);
