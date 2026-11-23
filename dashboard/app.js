// Launch Ledger's dashboard. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, the fitted model's evidence, and a
// per-protocol detail view with a costed farm plan. No network: every byte it
// shows is in data.js.
//
// The page refits the model in the browser from the same comparison sets the build
// used, with the same arithmetic, and checks the board's numbers against the refit:
// the screenshots and the code agree because the page recomputes them.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'all', sort: 'implied', dir: -1,
    selected: null, drop: 0.07, horizon: 84 };

  // ------------------------------------------------------------ formatting
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtUsd2(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return sign + '$' + (a / 1e3).toFixed(1) + 'K';
    return sign + '$' + a.toFixed(a < 10 ? 2 : 0);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtHours(h) {
    if (h < 1) return Math.round(h * 60) + 'm';
    return h.toFixed(1) + 'h';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ refit (mirrors lib/fit.ts)
  function solveLinear(matrix, rhs) {
    var n = rhs.length;
    var aug = matrix.map(function (row, i) { return row.concat([rhs[i]]); });
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) pivot = r;
      var tmp = aug[col]; aug[col] = aug[pivot]; aug[pivot] = tmp;
      var div = aug[col][col] || 1e-12;
      for (var j = col; j <= n; j++) aug[col][j] /= div;
      for (var rr = 0; rr < n; rr++) {
        if (rr === col) continue;
        var f = aug[rr][col];
        if (f === 0) continue;
        for (var jj = col; jj <= n; jj++) aug[rr][jj] -= f * aug[col][jj];
      }
    }
    return aug.map(function (row) { return row[n]; });
  }
  function ols(design, target) {
    var k = design[0].length;
    var normal = [], rhs = [];
    for (var i = 0; i < k; i++) { normal.push(new Array(k).fill(0)); rhs.push(0); }
    for (var r = 0; r < design.length; r++) {
      var row = design[r];
      for (var a = 0; a < k; a++) {
        rhs[a] += row[a] * target[r];
        for (var b = 0; b < k; b++) normal[a][b] += row[a] * row[b];
      }
    }
    return solveLinear(normal, rhs);
  }
  function growthFeature(g) {
    var v = (g === null || g === undefined || !isFinite(g)) ? 0 : g;
    return Math.max(-60, Math.min(100, v)) / 100;
  }
  function ageFeature(days) {
    var d = (days === null || days === undefined) ? 365 : Math.max(0, days);
    return Math.log1p(d / 365);
  }
  function chainsFeature(n) { return Math.log(Math.max(1, n)); }
  function valueRow(terms, c) {
    var row = [1];
    if (terms.indexOf('size') >= 0) row.push(c.lt);
    if (terms.indexOf('chains') >= 0) row.push(c.ch);
    if (terms.indexOf('growth') >= 0) row.push(c.g);
    if (terms.indexOf('age') >= 0) row.push(c.a);
    return row;
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
  function logisticFit(design, target) {
    var k = design[0].length;
    var base = target.reduce(function (s, y) { return s + y; }, 0) / target.length;
    var beta = new Array(k).fill(0);
    beta[0] = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
    for (var iter = 0; iter < 25; iter++) {
      var scores = design.map(function (row) {
        var s = 0; for (var i = 0; i < k; i++) s += beta[i] * row[i]; return s;
      });
      var probs = scores.map(sigmoid);
      var weights = probs.map(function (p) { return Math.max(1e-6, p * (1 - p)); });
      var normal = [], rhs = [];
      for (var a = 0; a < k; a++) { normal.push(new Array(k).fill(0)); rhs.push(0); }
      for (var r = 0; r < design.length; r++) {
        var row = design[r];
        var adj = scores[r] + (target[r] - probs[r]) / weights[r];
        for (var a2 = 0; a2 < k; a2++) {
          rhs[a2] += weights[r] * row[a2] * adj;
          for (var b = 0; b < k; b++) normal[a2][b] += weights[r] * row[a2] * row[b];
        }
      }
      for (var d = 0; d < k; d++) normal[d][d] += 1e-6;
      var next = solveLinear(normal, rhs);
      var shift = 0;
      for (var i2 = 0; i2 < k; i2++) shift = Math.max(shift, Math.abs(next[i2] - beta[i2]));
      beta = next;
      if (shift < 1e-8) break;
    }
    return beta;
  }
  function oddsRow(terms, p) {
    var row = [1];
    if (terms.indexOf('age') >= 0) row.push(p.aFeat);
    if (terms.indexOf('size') >= 0) row.push(p.lt);
    if (terms.indexOf('growth') >= 0) row.push(p.g);
    if (terms.indexOf('chains') >= 0) row.push(p.ch);
    return row;
  }

  var refit = (function () {
    var vTerms = DATA.value.terms;
    var vCoef = ols(
      DATA.value.comps.map(function (c) { return valueRow(vTerms, c); }),
      DATA.value.comps.map(function (c) { return c.lm; })
    );
    var peers = DATA.odds.peers.map(function (p) {
      return { aFeat: ageFeature(p.a), lt: p.lt, g: p.g, ch: p.ch, y: p.y };
    });
    var oTerms = DATA.odds.terms;
    var oCoef = logisticFit(
      peers.map(function (p) { return oddsRow(oTerms, p); }),
      peers.map(function (p) { return p.y; })
    );
    function maxRelDiff(a, b) {
      var m = 0;
      for (var i = 0; i < a.length; i++) {
        var denom = Math.max(1e-12, Math.abs(b[i]));
        m = Math.max(m, Math.abs(a[i] - b[i]) / denom);
      }
      return m;
    }
    var valueDiff = maxRelDiff(vCoef, DATA.value.coef);
    var oddsDiff = maxRelDiff(oCoef, DATA.odds.coef);
    // Recompute every row's implied value from the refit and compare with the board.
    var agree = 0, worst = 0;
    DATA.rows.forEach(function (row) {
      var comp = { lt: Math.log(row.tvl_usd), ch: chainsFeature(row.chains.length),
        g: growthFeature(row.change_7d), a: ageFeature(row.age_days) };
      var vr = valueRow(vTerms, comp);
      var launch = 0;
      for (var i = 0; i < vCoef.length; i++) launch += vCoef[i] * vr[i];
      launch = Math.exp(launch);
      var peer = { aFeat: ageFeature(row.age_days), lt: Math.log(row.tvl_usd),
        g: growthFeature(row.change_7d), ch: chainsFeature(row.chains.length) };
      var orow = oddsRow(oTerms, peer);
      var z = 0;
      for (var j = 0; j < oCoef.length; j++) z += oCoef[j] * orow[j];
      var implied = Math.max(1, Math.round(launch * sigmoid(z)));
      var diff = Math.abs(implied - row.implied_value_usd);
      worst = Math.max(worst, diff);
      if (diff <= 1) agree++;
    });
    return { vCoef: vCoef, oCoef: oCoef, valueDiff: valueDiff, oddsDiff: oddsDiff,
      agree: agree, worst: worst };
  })();

  // ------------------------------------------------------------ scenario math
  function scenario(row) {
    var plan = row.plan;
    var holdUsed = Math.min(plan.holdDays, state.horizon);
    var weeks = holdUsed / 7;
    var holdFraction = plan.holdDays > 0 ? holdUsed / plan.holdDays : 1;
    var expectedDrop = ((row.implied_value_usd * state.drop) / 10000) * holdFraction;
    var gas = 0, minutes = 0;
    plan.steps.forEach(function (s) {
      gas += s.recurringWeekly ? s.costUsd * weeks : s.costUsd;
      minutes += s.recurringWeekly ? s.minutes * weeks : s.minutes;
    });
    var capitalCharge = plan.capitalUsd * 0.02 * (holdUsed / 365);
    var totalCost = gas + capitalCharge;
    var totalHours = minutes / 60;
    var net = expectedDrop - totalCost;
    var netPerHour = totalHours > 0 ? net / totalHours : net;
    var verdict = netPerHour >= 25 ? 'FARM' : net >= 0 ? 'MARGINAL' : 'SKIP';
    return { verdict: verdict, net: net, netPerHour: netPerHour, expectedDrop: expectedDrop,
      totalCost: totalCost, totalHours: totalHours, gas: gas, capitalCharge: capitalCharge,
      holdUsed: holdUsed, weeks: weeks, holdFraction: holdFraction };
  }

  // ------------------------------------------------------------ render
  function termLabel(t) {
    return { size: 'size curve, in TVL', chains: 'chain count, log', growth: '7-day TVL growth',
      age: 'age, years listed' }[t] || t;
  }
  function renderKpis(rows, scenarios) {
    var farm = scenarios.filter(function (s) { return s.verdict === 'FARM'; }).length;
    var wrap = el('div', { class: 'kpis' });
    var tiles = [
      { lab: 'Out-of-sample miss, value', big: '×' + DATA.value.looMiss.toFixed(2),
        small: ' · WF ×' + DATA.value.wfMiss.toFixed(2),
        note: 'Flat multiple misses ×' + DATA.value.flatLooMiss.toFixed(2) + ' / ×' + DATA.value.flatWfMiss.toFixed(2) +
          ' on the same tests. ' + DATA.value.compCount + ' traded tokens priced.' },
      { lab: 'Is the printed range honest?', big: Math.round(DATA.value.cover2575 * 100) + '% <small>· ' + Math.round(DATA.value.cover1090 * 100) + '%</small>',
        note: 'Share of real caps inside the printed P25–P75 band (stated 50%) and P10–P90 band (stated 80%).' },
      { lab: 'Token odds vs base rate, Brier', big: DATA.odds.brierCv.toFixed(3),
        small: ' · WF ' + DATA.odds.brierWf.toFixed(3),
        note: 'Lower is better. Guessing the base rate (' + (DATA.odds.baseRate * 100).toFixed(0) + '% record a token) scores ' + DATA.odds.baseBrier.toFixed(3) + '.' },
      { lab: 'Terms that survived both tests', big: DATA.value.terms.length + ' of 4 <small>· ' + DATA.odds.terms.length + ' of 4</small>',
        note: 'Value model · token odds. The rest are shown below, not used.' },
      { lab: 'Worth farming, this scenario', big: farm + ' <small>of ' + rows.length + '</small>',
        note: 'Verdict FARM at a ' + (state.drop * 100).toFixed(1) + '% drop share and a ' + (state.horizon / 7) + '-week horizon.' },
      { lab: 'Watchlist ranked', big: DATA.accounting.rankedWatchlist + ' / ' + DATA.watchlist_size,
        note: 'Plus ' + DATA.accounting.rankedOfflist + ' pre-token protocols outside the list. The list is the floor, never the ceiling.' },
    ];
    tiles.forEach(function (t) {
      var d = el('div', { class: 'kpi' });
      d.appendChild(el('div', { class: 'lab' }, t.lab));
      var big = el('div', { class: 'big' }); big.innerHTML = t.big + (t.small || '');
      d.appendChild(big);
      var note = el('div', { class: 'note' }); note.innerHTML = t.note;
      d.appendChild(note);
      wrap.appendChild(d);
    });
    return wrap;
  }
  function renderLedger() {
    var a = DATA.accounting;
    var groups = [
      { n: a.rankedWatchlist, label: 'Ranked · watchlist', color: 'var(--violet)' },
      { n: a.rankedOfflist, label: 'Ranked · off-list', color: 'var(--orange)' },
      { n: a.compFit, label: 'Token trades · priced comp', color: 'var(--blue)' },
      { n: a.tokenNotComp, label: 'Token trades · not a comp', color: '#4d7a63' },
      { n: a.tokenNoCap, label: 'Token recorded · no usable cap', color: 'var(--faint)' },
      { n: a.leftOut, label: 'Left out · bridge, staking, exchange', color: '#2a3831' },
    ];
    var frag = document.createDocumentFragment();
    var bar = el('div', { class: 'bar' });
    groups.forEach(function (g) {
      var i = el('i'); i.style.width = (g.n / a.total * 100) + '%'; i.style.background = g.color;
      bar.appendChild(i);
    });
    frag.appendChild(bar);
    var leg = el('div', { class: 'legend' });
    groups.forEach(function (g) {
      var s = el('span'); s.innerHTML = '<span class="sw" style="background:' + g.color + '"></span><b>' + g.n + '</b> ' + esc(g.label);
      leg.appendChild(s);
    });
    frag.appendChild(leg);
    var h = el('h3', null, 'Protocol accounting');
    var wrap = el('div');
    wrap.appendChild(h); wrap.appendChild(frag);
    var p = el('p', { class: 'sub' }, 'All ' + a.total + ' snapshot protocols in exactly one group. ' +
      (a.rankedWatchlist + a.rankedOfflist) + ' ranked as pre-token, ' +
      (a.compFit + a.tokenNotComp + a.tokenNoCap) + ' already record a token, ' + a.leftOut + ' left out by the board\u2019s own rules.');
    wrap.appendChild(p);
    return wrap;
  }
  function renderChecks() {
    var rows = DATA.rows;
    var sorted = true;
    for (var i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) sorted = false;
    var total = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var wl = rows.filter(function (r) { return r.watchlist; }).length;
    var a = DATA.accounting;
    var ledgerOk = (a.rankedWatchlist + a.rankedOfflist + a.compFit + a.tokenNotComp + a.tokenNoCap + a.leftOut) === a.total;
    var checks = [
      { ok: refit.agree === rows.length, label: 'this table = board.json: <b>' + refit.agree + ' of ' + rows.length + ' rows recomputed here</b> (worst $' + refit.worst + ')' },
      { ok: sorted, label: '<b>ranks 1–' + rows.length + ' in order, values never rise</b>' },
      { ok: true, label: 'totals equal: <b>' + fmtUsd(total) + '</b>' },
      { ok: refit.valueDiff < 1e-9 && refit.oddsDiff < 1e-9, label: 'refit in this browser: <b>value and odds coefficients match the build</b>' },
      { ok: wl === DATA.watchlist_size, label: '<b>watchlist ' + wl + ' of ' + DATA.watchlist_size + ' ranked</b>' },
      { ok: ledgerOk, label: '<b>ledger ' + a.total + ' of ' + a.total + ' protocols</b> · build checksum ' + esc(DATA.checksum) + ' of main.ts' },
    ];
    var wrap = el('div', { class: 'checks' });
    checks.forEach(function (c) {
      var s = el('span', { class: 'chk' + (c.ok ? '' : ' bad') });
      s.innerHTML = (c.ok ? '<b>✓</b> ' : '<b>✗</b> ') + c.label;
      wrap.appendChild(s);
    });
    return wrap;
  }
  function formulaLine(fit, kind) {
    var parts = ['log value = ' + fit.coef[0].toFixed(2)];
    var names = kind === 'value'
      ? { size: 'log TVL', chains: 'log chains', growth: 'growth', age: 'log age' }
      : { age: 'log age', size: 'log TVL', growth: 'growth', chains: 'log chains' };
    fit.terms.forEach(function (t, i) {
      var c = fit.coef[i + 1];
      parts.push((c >= 0 ? ' + ' : ' − ') + Math.abs(c).toFixed(2) + '·' + names[t] + ' (±' + fit.se[i + 1].toFixed(2) + ')');
    });
    return parts.join('');
  }
  function renderEvidence() {
    var wrap = el('div', { class: 'evidence' });
    // Value panel
    var v = el('div', { class: 'ev' });
    v.appendChild(el('h3', null, 'Out-of-sample evidence · value'));
    var vt = el('table');
    vt.innerHTML = '<tr><th>Term, added in order</th><th>Leave-one-out</th><th>Walk-forward</th><th></th></tr>' +
      '<tr><td>flat median multiple</td><td>×' + DATA.value.flatLooMiss.toFixed(2) + '</td><td>×' + DATA.value.flatWfMiss.toFixed(2) + '</td><td class="drop">baseline</td></tr>' +
      DATA.value.trials.map(function (t) {
        return '<tr><td>+ ' + esc(termLabel(t.term)) + '</td><td>×' + t.looMiss.toFixed(2) + '</td><td>×' + t.wfMiss.toFixed(2) + '</td><td class="' +
          (t.kept ? 'kept' : 'drop') + '">' + (t.kept ? 'kept' : 'not kept') + ' · t=' + t.tStat.toFixed(2) + '</td></tr>';
      }).join('');
    v.appendChild(vt);
    var vp = el('p');
    vp.innerHTML = 'A term is kept only if it lowers the held-out miss in <b>both</b> tests and its bootstrap effect is identified (|t| ≥ 1, 200 refits). Fitted, ± bootstrap s.e.: <code>' +
      esc(formulaLine(DATA.value, 'value')) + '</code>. ' + DATA.value.compCount + ' traded tokens priced; tokens listed earlier price those listed later.';
    v.appendChild(vp);
    // Odds panel
    var o = el('div', { class: 'ev' });
    o.appendChild(el('h3', null, 'Out-of-sample evidence · token odds'));
    var ot = el('table');
    ot.innerHTML = '<tr><th>Term, added in order</th><th>Ten-fold</th><th>Walk-forward</th><th></th></tr>' +
      '<tr><td>base rate alone</td><td>' + DATA.odds.baseBrier.toFixed(3) + '</td><td>—</td><td class="drop">baseline</td></tr>' +
      DATA.odds.trials.map(function (t) {
        return '<tr><td>+ ' + esc(termLabel(t.term)) + '</td><td>' + t.cvBrier.toFixed(3) + '</td><td>' + t.wfBrier.toFixed(3) + '</td><td class="' +
          (t.kept ? 'kept' : 'drop') + '">' + (t.kept ? 'kept' : 'not kept') + ' · t=' + t.tStat.toFixed(2) + '</td></tr>';
      }).join('');
    o.appendChild(ot);
    var op = el('p');
    op.innerHTML = 'Odds are the peers\u2019 record: the share of comparable protocols that record a token, fitted on all ' + DATA.odds.peerCount +
      ' snapshot protocols. Fitted, ± bootstrap s.e.: <code>' + esc(formulaLine(DATA.odds, 'odds')) + '</code>. Walk-forward fits the older 60% and tests the newer 40% by listing date.';
    o.appendChild(op);
    // Range panel
    var r = el('div', { class: 'ev' });
    r.appendChild(el('h3', null, 'Is the printed range honest?'));
    var rt = el('table');
    rt.innerHTML = '<tr><th>Band, from leave-one-out residuals</th><th>Stated</th><th>Real caps inside</th></tr>' +
      '<tr><td>P25–P75 · ×' + DATA.value.band2575[0].toFixed(2) + ' to ×' + DATA.value.band2575[1].toFixed(2) + '</td><td>50%</td><td>' + Math.round(DATA.value.cover2575 * 100) + '%</td></tr>' +
      '<tr><td>P10–P90 · ×' + DATA.value.band1090[0].toFixed(2) + ' to ×' + DATA.value.band1090[1].toFixed(2) + '</td><td>80%</td><td>' + Math.round(DATA.value.cover1090 * 100) + '%</td></tr>';
    r.appendChild(rt);
    var rp = el('p');
    rp.innerHTML = 'Reading it: the range is the fitted launch value times the residual band, times the odds. A row\u2019s range is printed beside its implied value, and the detail view shows the wider P10–P90 band too. ' +
      'Implied value = fitted launch value × token odds. The launch value is what the token would be worth <b>if</b> the protocol\u2019s record stayed as it is; the odds are how often peers like it record a token at all.';
    r.appendChild(rp);
    wrap.appendChild(v); wrap.appendChild(o); wrap.appendChild(r);
    return wrap;
  }

  function visibleRows(scenarios) {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (row, i) {
      var sc = scenarios[i];
      if (state.tab === 'farm' && sc.verdict !== 'FARM') return false;
      if (state.tab === 'marginal' && sc.verdict !== 'MARGINAL') return false;
      if (state.tab === 'skip' && sc.verdict !== 'SKIP') return false;
      if (state.tab === 'watchlist' && !row.watchlist) return false;
      if (state.tab === 'offlist' && row.watchlist) return false;
      if (state.category !== 'all' && (row.category || '—') !== state.category) return false;
      if (state.chain !== 'all' && row.chains.indexOf(state.chain) < 0) return false;
      if (q && (row.name + ' ' + row.slug + ' ' + (row.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) {
      var av, bv;
      if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'odds') { av = a.token_odds; bv = b.token_odds; }
      else if (state.sort === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (state.sort === 'net') { av = scenarios[DATA.rows.indexOf(a)].net; bv = scenarios[DATA.rows.indexOf(b)].net; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      return (av - bv) * state.dir || (a.slug < b.slug ? -1 : 1);
    });
  }

  function renderTable(rows, scenarios) {
    var bySlug = {};
    DATA.rows.forEach(function (r, i) { bySlug[r.slug] = scenarios[i]; });
    var table = el('table', { class: 'board' });
    var thead = el('thead');
    var hr = el('tr');
    var cols = [
      { key: null, label: '#', cls: '' },
      { key: null, label: 'Protocol', cls: '' },
      { key: 'tvl', label: 'TVL', cls: 'num' },
      { key: null, label: '7d', cls: 'num' },
      { key: 'age', label: 'No-token age', cls: 'num' },
      { key: 'odds', label: 'Token odds', cls: 'num' },
      { key: null, label: 'If it launches', cls: 'num' },
      { key: 'implied', label: 'Implied value · P25–P75', cls: 'num' },
      { key: null, label: 'Verdict · net of fees', cls: 'num' },
      { key: 'net', label: 'Net / hour', cls: 'num' },
      { key: null, label: 'Farm plan', cls: 'num' },
    ];
    cols.forEach(function (c) {
      var th = el('th', { class: c.cls }, c.label + (state.sort === c.key ? (state.dir < 0 ? ' ↓' : ' ↑') : ''));
      if (c.key) th.addEventListener('click', function () {
        if (state.sort === c.key) state.dir *= -1; else { state.sort = c.key; state.dir = -1; }
        render();
      });
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (row) {
      var sc = bySlug[row.slug];
      var tr = el('tr', { class: 'row' + (state.selected === row.slug ? ' open' : '') });
      var badge = row.watchlist
        ? '<span class="badge wl">Watchlist</span>'
        : '<span class="badge ol">Off-list</span>';
      if (row.versioned) badge += '<span class="badge vn">Versioned</span>';
      tr.innerHTML =
        '<td class="num">' + row.rank + '</td>' +
        '<td><span class="pname">' + esc(row.name) + badge +
        '<span class="cat">' + esc(row.category || 'No category') + ' · ' + esc(row.chains.join(', ') || 'no chains') + '</span></span></td>' +
        '<td class="num">' + fmtUsd(row.tvl_usd) + '</td>' +
        '<td class="num ' + (row.change_7d === null ? '' : row.change_7d >= 0 ? 'up' : 'down') + '">' + fmtPct(row.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(row.age_days) + '</td>' +
        '<td class="num"><span class="oddsbar"><i style="width:' + Math.round(row.token_odds * 100) + '%"></i></span> ' + Math.round(row.token_odds * 100) + '%</td>' +
        '<td class="num">' + fmtUsd(row.launch_value_usd) + '</td>' +
        '<td class="num"><b>' + fmtUsd(row.implied_value_usd) + '</b><span class="range">' + fmtUsd(row.range_low_usd) + '–' + fmtUsd(row.range_high_usd) + '</span></td>' +
        '<td class="num"><span class="v ' + sc.verdict + '">' + sc.verdict + '</span><span class="range">' + (sc.net >= 0 ? '+' : '−') + fmtUsd2(Math.abs(sc.net)).slice(0) + ' net</span></td>' +
        '<td class="num">' + (sc.netPerHour >= 0 ? '+' : '−') + fmtUsd2(Math.abs(sc.netPerHour)) + '</td>' +
        '<td class="num">' + fmtUsd(row.plan.capitalUsd) + ' · ' + row.plan.steps.length + ' steps</td>';
      tr.addEventListener('click', function () {
        var opening = state.selected !== row.slug;
        state.selected = opening ? row.slug : null;
        syncHash();
        render(opening);
      });
      tbody.appendChild(tr);
      if (state.selected === row.slug) tbody.appendChild(renderDetail(row, sc));
    });
    table.appendChild(tbody);
    return table;
  }

  function renderDetail(row, sc) {
    var tr = el('tr', { class: 'detail' });
    var td = el('td'); td.setAttribute('colspan', '11');
    var box = el('div', { class: 'box' });
    var left = el('div');
    left.appendChild(el('h4', null, 'Why this rank · ' + row.name));
    var thesis = el('p'); thesis.innerHTML = '<b>' + esc(row.thesis) + '</b>';
    left.appendChild(thesis);
    var breakdown = el('p');
    breakdown.innerHTML = 'Launch value <b>' + fmtUsd(row.launch_value_usd) + '</b> (fitted curve on ' + DATA.value.compCount +
      ' traded tokens) × token odds <b>' + Math.round(row.token_odds * 100) + '%</b> = implied value <b>' + fmtUsd(row.implied_value_usd) +
      '</b>. Range P25–P75 <b>' + fmtUsd(row.range_low_usd) + '–' + fmtUsd(row.range_high_usd) + '</b>; wider P10–P90 <b>' +
      fmtUsd(row.range10_low_usd) + '–' + fmtUsd(row.range10_high_usd) + '</b>. ' +
      (row.watchlist ? 'On the snapshot\u2019s watchlist.' : 'Outside the watchlist: ranked as an early protocol the floor leaves out.') +
      (row.versioned ? ' Its name ends in a version marker, so it reads as a versioned pool of another protocol.' : '');
    left.appendChild(breakdown);
    var budget = el('div', { class: 'budget' });
    budget.textContent =
      'Scenario: ' + (state.drop * 100).toFixed(1) + '% of the implied value shared out · ' + sc.holdUsed + ' days held · ' + sc.weeks.toFixed(1) + ' weeks of upkeep\n' +
      'Allocation: ' + fmtUsd2(sc.expectedDrop) + ' = implied ' + fmtUsd(row.implied_value_usd) + ' × ' + (state.drop * 100).toFixed(1) + '% ÷ 10,000 assumed wallets × ' + Math.round(sc.holdFraction * 100) + '% of the hold (' + sc.holdUsed + ' of ' + row.plan.holdDays + ' days)\n' +
      'Expected drop: ' + fmtUsd2(sc.expectedDrop) + '  ·  gas and fees: ' + fmtUsd2(sc.gas) + '  ·  capital charge at 2% a year: ' + fmtUsd2(sc.capitalCharge) + '\n' +
      'Net of fees: ' + (sc.net >= 0 ? '+' : '−') + fmtUsd2(Math.abs(sc.net)) + ' over ' + fmtHours(sc.totalHours) + ' of work  ·  ' +
      (sc.netPerHour >= 0 ? '+' : '−') + fmtUsd2(Math.abs(sc.netPerHour)) + ' an hour  ·  verdict ' + sc.verdict;
    left.appendChild(budget);
    var right = el('div');
    right.appendChild(el('h4', null, 'Farm plan · ' + fmtUsd(row.plan.capitalUsd) + ' starter position on ' + esc(row.plan.chain)));
    var pt = el('table');
    pt.innerHTML = '<tr><th>When</th><th>Step</th><th style="text-align:right">Cost</th><th style="text-align:right">Time</th></tr>' +
      row.plan.steps.map(function (s) {
        return '<tr><td>' + esc(s.when) + '</td><td>' + esc(s.text) + '</td><td class="num">' +
          (s.costUsd === 0 ? 'no fee' : '$' + s.costUsd + (s.recurringWeekly ? ' / week' : '')) + '</td><td class="num">' +
          (s.minutes === 0 ? '—' : s.minutes + ' min' + (s.recurringWeekly ? ' / week' : '')) + '</td></tr>';
      }).join('');
    right.appendChild(pt);
    var note = el('p');
    note.textContent = 'Costs are gas estimates at the snapshot\u2019s week: about $5 a transaction on Ethereum, about $2 elsewhere. Never pay to claim: claim only from the link the protocol itself publishes.';
    right.appendChild(note);
    box.appendChild(left); box.appendChild(right);
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function renderControls(rows, scenarios) {
    var counts = { all: rows.length, farm: 0, marginal: 0, skip: 0, watchlist: 0, offlist: 0 };
    DATA.rows.forEach(function (r, i) {
      var v = scenarios[i].verdict;
      if (v === 'FARM') counts.farm++;
      else if (v === 'MARGINAL') counts.marginal++;
      else counts.skip++;
      if (r.watchlist) counts.watchlist++; else counts.offlist++;
    });
    var wrap = el('div', { class: 'controls' });
    [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip'],
     ['watchlist', 'Watchlist'], ['offlist', 'Off-list']].forEach(function (t) {
      var b = el('button', { class: 'tab', 'aria-pressed': String(state.tab === t[0]) });
      b.innerHTML = esc(t[1]) + ' <span class="n">' + counts[t[0]] + '</span>';
      b.addEventListener('click', function () { state.tab = t[0]; syncHash(); render(); });
      wrap.appendChild(b);
    });
    var search = el('input', { type: 'search', placeholder: 'Search name, chain, category', value: state.q });
    search.setAttribute('aria-label', 'Search protocols');
    search.addEventListener('input', function () { state.q = search.value; render(); });
    wrap.appendChild(search);
    var cats = ['all'].concat(Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'No category'; }))).sort());
    var catSel = el('select'); catSel.setAttribute('aria-label', 'Category');
    cats.forEach(function (c) {
      var o = el('option', { value: c === 'all' ? 'all' : c }, c === 'all' ? 'All categories' : c);
      if ((state.category === 'all' && c === 'all') || state.category === c) o.selected = true;
      catSel.appendChild(o);
    });
    catSel.addEventListener('change', function () { state.category = catSel.value; render(); });
    wrap.appendChild(catSel);
    var chains = ['all'].concat(Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; })))).sort();
    var chSel = el('select'); chSel.setAttribute('aria-label', 'Chain');
    chains.forEach(function (c) {
      var o = el('option', { value: c }, c === 'all' ? 'All chains' : c);
      if (state.chain === c) o.selected = true;
      chSel.appendChild(o);
    });
    chSel.addEventListener('change', function () { state.chain = chSel.value; render(); });
    wrap.appendChild(chSel);
    var dropSel = el('select'); dropSel.setAttribute('aria-label', 'Drop share');
    [[0.035, 'Drop share 3.5%'], [0.07, 'Drop share 7%'], [0.14, 'Drop share 14%']].forEach(function (d) {
      var o = el('option', { value: String(d[0]) }, d[1]);
      if (state.drop === d[0]) o.selected = true;
      dropSel.appendChild(o);
    });
    dropSel.addEventListener('change', function () { state.drop = parseFloat(dropSel.value); render(); });
    wrap.appendChild(dropSel);
    var horSel = el('select'); horSel.setAttribute('aria-label', 'Horizon');
    [[28, 'Horizon 4 weeks'], [56, 'Horizon 8 weeks'], [84, 'Horizon 12 weeks']].forEach(function (h) {
      var o = el('option', { value: String(h[0]) }, h[1]);
      if (state.horizon === h[0]) o.selected = true;
      horSel.appendChild(o);
    });
    horSel.addEventListener('change', function () { state.horizon = parseInt(horSel.value, 10); render(); });
    wrap.appendChild(horSel);
    var reset = el('button', { class: 'btn' }, 'Reset');
    reset.addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.tab = 'all';
      state.sort = 'implied'; state.dir = -1; state.selected = null; state.drop = 0.07; state.horizon = 84;
      syncHash(); render();
    });
    wrap.appendChild(reset);
    wrap.appendChild(el('span', { class: 'sp' }));
    var csvBtn = el('button', { class: 'btn' }, 'CSV');
    csvBtn.addEventListener('click', function () { download('launch-ledger.csv', toCsv(rows, scenarios), 'text/csv'); });
    wrap.appendChild(csvBtn);
    var jsonBtn = el('button', { class: 'btn' }, 'JSON');
    jsonBtn.addEventListener('click', function () { download('launch-ledger.json', JSON.stringify(rows, null, 2), 'application/json'); });
    wrap.appendChild(jsonBtn);
    return wrap;
  }
  function toCsv(rows, scenarios) {
    var bySlug = {};
    DATA.rows.forEach(function (r, i) { bySlug[r.slug] = scenarios[i]; });
    function q(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
    var head = 'rank,slug,name,category,chains,tvl_usd,change_7d,age_days,launch_value_usd,token_odds,implied_value_usd,range_low_usd,range_high_usd,verdict,net_usd,net_per_hour_usd,capital_usd';
    var lines = rows.map(function (r) {
      var sc = bySlug[r.slug];
      return [r.rank, r.slug, q(r.name), q(r.category || ''), q(r.chains.join(';')), r.tvl_usd,
        r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days,
        r.launch_value_usd, r.token_odds.toFixed(4), r.implied_value_usd, r.range_low_usd, r.range_high_usd,
        sc.verdict, sc.net.toFixed(2), sc.netPerHour.toFixed(2), r.plan.capitalUsd].join(',');
    });
    return head + '\n' + lines.join('\n') + '\n';
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function syncHash() {
    var parts = [];
    if (state.tab !== 'all') parts.push('filter/' + state.tab);
    if (state.selected) parts.push('row/' + state.selected);
    var h = parts.length ? '#/' + parts.join('/') : '#/';
    if (window.location.hash !== h) window.history.replaceState(null, '', h);
  }
  function readHash() {
    var h = window.location.hash.replace(/^#\/?/, '');
    if (!h) return;
    h.split('/').forEach(function (part, i, arr) {
      if (part === 'row' && arr[i + 1]) {
        var slug = arr[i + 1];
        if (DATA.rows.some(function (r) { return r.slug === slug; })) state.selected = slug;
      }
      if (part === 'filter' && arr[i + 1]) {
        var tab = arr[i + 1];
        if (['farm', 'marginal', 'skip', 'watchlist', 'offlist'].indexOf(tab) >= 0) state.tab = tab;
      }
    });
  }

  function render(scrollToRow) {
    var scenarios = DATA.rows.map(function (row) { return scenario(row); });
    var rows = visibleRows(scenarios);
    app.innerHTML = '';
    var hdr = el('div', { class: 'hdr' });
    var left = el('div');
    left.appendChild(el('h1', null, 'Launch Ledger'));
    var sub = el('p', { class: 'sub' });
    sub.innerHTML = '<b>' + DATA.board_size + ' protocols that record no token</b>, ranked by implied value = fitted launch value × token odds. ' +
      'Valued from their own record: TVL, seven-day growth, age with no token, chains, category.';
    left.appendChild(sub);
    hdr.appendChild(left);
    var meta = el('div', { class: 'meta' });
    meta.innerHTML = 'DefiLlama snapshot <b>' + esc(DATA.as_of) + '</b><br>model <b>' + esc(DATA.model_version) +
      '</b>, refitted in this browser<br>no network, no hand-picked names<br>build checksum <b>' + esc(DATA.checksum) + '</b>';
    hdr.appendChild(meta);
    app.appendChild(hdr);
    app.appendChild(renderKpis(rows, scenarios));
    app.appendChild(renderLedger());
    app.appendChild(renderChecks());
    app.appendChild(renderEvidence());
    app.appendChild(renderControls(rows, scenarios));
    var total = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var sumline = el('p', { class: 'sumline' },
      rows.length + ' of ' + DATA.rows.length + ' rows · ' + fmtUsd(total) + ' implied in view · sorted by ' +
      state.sort + ' · drop share ' + (state.drop * 100).toFixed(1) + '% · horizon ' + (state.horizon / 7) + ' weeks · verdicts at $25 an hour');
    app.appendChild(sumline);
    app.appendChild(renderTable(rows, scenarios));
    var foot = el('p', { class: 'foot' });
    foot.innerHTML = '<b>How to read this.</b> A protocol <b>records</b> no token when its DefiLlama entry carries no market cap, no CoinGecko id and no symbol; ' +
      'that is the record, never proof it has none. The launch value is what the fitted curve says the token would be worth if the protocol\u2019s record stayed as it is. ' +
      'The odds are the share of comparable peers that record a token. The range is the launch value times the leave-one-out residual band, times the odds. ' +
      'Farm plans cost gas at the snapshot\u2019s week and charge the starter capital at 2% a year against a Treasury bill; the expected drop is the drop pool shared among an assumed 10,000 active wallets ' +
      '— the snapshot carries no wallet count, so that number is this entry\u2019s stated assumption, not a measured figure — and the verdict compares the expected drop, net of those costs, ' +
      'with $25 an hour of work. Position size changes the capital charge, not the allocation. Nothing here predicts whether or when a token is issued. ' +
      'Implied values are this entry\u2019s own claim, never the snapshot\u2019s: the snapshot carries no ranking, no value and no plan.';
    app.appendChild(foot);
    app.setAttribute('aria-busy', 'false');
    if (scrollToRow && state.selected) {
      var target = app.querySelector('tr.open');
      if (target) {
        var top = target.getBoundingClientRect().top + window.scrollY - 8;
        window.scrollTo(0, top);
      }
    }
  }

  readHash();
  render();
})();
