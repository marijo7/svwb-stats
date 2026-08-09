"use strict";

/**
 * 集計の描画。ランクマッチ (app.js) と大会 (tournament.js) の両方が使う。
 *
 * 計算は一切しない。/api/stats が返したものをそのまま描くだけで、勝率の数字は
 * Python 側にしかない (CLI とブラウザ、ランクマッチと大会で数字がずれない)。
 *
 * どのセクションを出すかは HTML 側が決める。renderStats はページに置かれた
 * 要素だけを描き、無いものは黙って飛ばす。大会の画面には CR とグレードの
 * セクションが無いが、それはランクマッチ帯にしか無い値だから。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG は名前空間が違うので createElement では作れない (中身は common.js の el と同じ)。 */
function svgEl(tag, props = {}, children = []) {
  return build(document.createElementNS(SVG_NS, tag), props, children);
}

/** そのセクションがこのページにあるか。 */
const has = (id) => $(id) !== null;

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

function renderHeadline(stats, label) {
  $("headline").replaceChildren(
    statCard(label, stats.overall),
    statCard("先攻", stats.turn_order.first),
    statCard("後攻", stats.turn_order.second),
  );
}

function renderMatrix(stats) {
  const classes = stats.classes;
  const table = $("matrix");
  table.replaceChildren();

  // 列 (相手クラス) は全部出す。「まだ当たっていない相手」も知りたい情報なので。
  // 行 (自分クラス) は使ったクラスだけ。7 クラス全部並べると空行だらけになる。
  const played = classes.filter((mine) =>
    classes.some((opp) => stats.matchup_matrix[mine][opp].games > 0));

  // 左上の角。斜線の下 (左) が行 = 自分、上 (右) が列 = 相手、という表の慣例。
  // ASCII のバックスラッシュは日本語フォントで円記号に化けるので全角を使う。
  const head = el("tr", {}, [el("th", { text: "自分＼相手" })]);
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

/**
 * 円グラフの凡例。色と名前の対応に加えて、読み取れない数字をここで出す。
 * 自分 / 相手のどちらを見ているかは真上のトグルが示すので、列名では繰り返さない。
 */
function renderPieLegend(slices, total) {
  const table = $("pie-legend");
  table.replaceChildren();
  table.appendChild(el("thead", {}, [
    el("tr", {}, ["クラス", "試合", "割合", "勝率"].map((text) => el("th", { text }))),
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
  const slices = pieSlices(stats.by_opp_class, stats.classes);
  const total = slices.reduce((sum, slice) => sum + slice.games, 0);

  if (!total) {
    $("pie-chart").replaceChildren();
    $("pie-legend").replaceChildren();
    return;
  }
  $("pie-chart").replaceChildren(renderPieChart(slices, total, "相手クラス"));
  // 凡例だけ試合数の多い順に。扇の並びと色は config 順で固定のまま
  // (pieSlices のコメント参照)。凡例は一覧性を優先して試合数順にする。
  renderPieLegend([...slices].sort((a, b) => b.games - a.games), total);
}

/**
 * 集計をまとめて描く。ページに無いセクションは飛ばす。
 * headline は先頭のカードの見出し ("全体" / "この大会" など)。
 */
function renderStats(stats, { headline = "全体" } = {}) {
  const hasData = stats.overall.games > 0;
  $("stats-empty").hidden = hasData;
  $("stats-body").hidden = !hasData;
  if (!hasData) return;

  if (has("headline")) renderHeadline(stats, headline);
  if (has("pie-chart")) renderPie(stats);
  if (has("matrix")) renderMatrix(stats);
  if (has("by-deck")) renderBreakdown("by-deck", stats.by_my_deck, "デッキ");
  if (has("by-opp")) renderBreakdown("by-opp", stats.by_opp_class, "クラス");

  // 相手グレードはランクマッチ帯にしか無い。大会の画面にはセクションごと無い。
  if (has("grade-section")) {
    const grades = stats.by_opp_grade || [];
    $("grade-section").hidden = grades.length === 0;
    if (grades.length) renderBreakdown("by-grade", grades, "グレード");
  }
}
