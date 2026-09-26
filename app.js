'use strict';
/* YT DJ Mix — YouTube 2デッキ + Web MIDI コントローラー */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STORE_KEY = 'ytdj.v1';
const NCUES = 8;
const DECK_NAMES = ['A', 'B'];

/* ---------- 操作対象（割り当て先）の定義 ---------- */
const TARGETS = [];
const TMAP = {};
function addT(id, label, kind, how) { const t = { id, label, kind, how }; TARGETS.push(t); TMAP[id] = t; }
const HOW = {
  button: 'ボタン（パッド）を1回押してください',
  abs: 'フェーダー／つまみを端から端まで動かしてください',
  rel: 'ゆっくり回してください',
};
addT('shift', 'SHIFT ボタン', 'button');
addT('xfader', 'クロスフェーダー', 'abs');
for (const d of DECK_NAMES) {
  addT(`${d}.play`, `デッキ${d} 再生／一時停止`, 'button');
  addT(`${d}.cue`, `デッキ${d} CUE`, 'button');
  addT(`${d}.volume`, `デッキ${d} 音量フェーダー`, 'abs');
  addT(`${d}.pitch`, `デッキ${d} ピッチ（テンポ）フェーダー`, 'abs');
  addT(`${d}.jog`, `デッキ${d} ジョグホイール`, 'rel', 'ジョグの天面をゆっくり回してください（2回目は側面。同じ信号なら自動で先へ進みます）');
  for (let i = 1; i <= NCUES; i++) addT(`${d}.hc${i}`, `デッキ${d} パッド${i}（ホットキュー）`, 'button');
  addT(`${d}.loopIn`, `デッキ${d} ループ IN`, 'button');
  addT(`${d}.loopOut`, `デッキ${d} ループ OUT／解除`, 'button');
  addT(`${d}.back`, `デッキ${d} 10秒戻る`, 'button');
  addT(`${d}.fwd`, `デッキ${d} 10秒進む`, 'button');
  addT(`${d}.load`, `デッキ${d} LOAD（履歴で選んだ曲を読み込む）`, 'button');
}
addT('browse', 'ブラウズつまみ（履歴の選択）', 'rel', 'ブラウズつまみを回してください');

// ウィザードの手順（ジョグは天面と側面で2回）
const WIZARD = [];
for (const t of TARGETS) {
  WIZARD.push(t.id);
  if (t.kind === 'rel' && t.id.endsWith('.jog')) WIZARD.push(t.id + '#2');
}

/* ---------- 保存状態 ---------- */
const defaults = () => ({
  map: {},               // "c:0:48" -> {t:"A.jog", rel:"twos"|"offset"}
  settings: { pitchRange: 0.5, pitchInvert: false, jogSens: 0.02, led: true, ytKey: '', smallVideo: false, bMode: 'hide', cc: { A: false, B: false }, ccSize: 3 },
  decks: {},             // A: {videoId,title,cue,hc,pos}
  hist: [],              // [{id,title}]
  xf: 0.5, vol: { A: 1, B: 1 },
});
let S = defaults();
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) { const o = JSON.parse(raw); S = Object.assign(defaults(), o); S.settings = Object.assign(defaults().settings, o.settings || {}); S.settings.cc = Object.assign({ A: false, B: false }, S.settings.cc);
    if (o.settings && o.settings.bNormal) S.settings.bMode = 'normal'; delete S.settings.bNormal; }
} catch (e) { /* 保存領域が使えなくても動作は続ける */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const d of decks) S.decks[d.name] = d.serialize();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { }
  }, 300);
}

/* ---------- 共通 ---------- */
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.style.display = 'none', ms);
}
function fmt(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function parseYouTubeId(s) {
  if (!s) return null;
  s = String(s).trim();
  const pats = [
    /youtu\.be\/([\w-]{11})/, /[?&]v=([\w-]{11})/, /\/shorts\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/, /\/live\/([\w-]{11})/, /\/v\/([\w-]{11})/,
  ];
  for (const p of pats) { const m = s.match(p); if (m) return m[1]; }
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}
let shiftHeld = false;

/* ---------- デッキ ---------- */
class Deck {
  constructor(name) {
    this.name = name;
    this.el = $(`.deck[data-deck=${name}]`);
    this.player = null; this.ready = false;
    this.videoId = ''; this.title = '';
    this.cue = 0; this.hc = Array(NCUES).fill(null);
    this.loop = { in: null, out: null, on: false };
    this.vol = S.vol[name] ?? 1;
    this.pitch = 0; this.wantRate = 1; this.appliedRate = null; this.rateActual = 1; this.lastRateSet = 0;
    this.state = -1; this.dur = 0;
    this.lastRaw = -1; this.base = 0; this.stamp = 0;
    this.jogAcc = 0; this.lastJog = 0;
    this.priming = false; this.primeAt = 0;
    this.cuePreview = false; this.playLatch = false;
    this.lastVolSent = -1; this.lastMuteCheck = 0;
    const saved = S.decks[name];
    if (saved) {
      this.videoId = saved.videoId || ''; this.title = saved.title || '';
      this.cue = saved.cue || 0; this.hc = (saved.hc || []).concat(Array(NCUES).fill(null)).slice(0, NCUES);
      this.restorePos = saved.pos || 0;
    }
    this.buildUI();
  }
  serialize() {
    return { videoId: this.videoId, title: this.title, cue: this.cue, hc: this.hc, pos: this.videoId ? this.now() : 0 };
  }
  buildUI() {
    const n = this.name;
    this.el.innerHTML = `
      <div class="vid"><div id="player${n}"></div><div class="shield"></div><button class="unbig" data-a="big">✕ 元に戻す</button></div>
      <div class="dtitle"><span class="tag">${n}</span><span class="tt">未ロード</span></div>
      <div class="bar"><div class="loopz"></div><div class="fill"></div><div class="marks"></div><div class="ph"></div></div>
      <div class="time"><span><span class="cur">0:00</span> / <span class="dur">0:00</span></span><span class="remain"></span><span class="snd"></span><span class="rate">×1.00</span></div>
      <div class="row transport">
        <button data-a="cue">CUE</button><button data-a="play">▶ / ❚❚</button>
        <button data-a="back">−10秒</button><button data-a="fwd">+10秒</button>
      </div>
      <div class="pads">${Array.from({ length: NCUES }, (_, i) => `<button data-hc="${i}">${i + 1}</button>`).join('')}</div>
      <div class="lc"><div class="row loops"><button data-a="loopIn">ループ IN</button><button data-a="loopOut">ループ OUT／解除</button></div>
      <div class="row cc"><button data-a="cc">字幕</button><button data-a="ccMinus">字幕 小さく</button><button data-a="ccPlus">字幕 大きく</button><button data-a="big">⛶ 大画面</button></div></div>
      <div class="pitch"><span style="text-align:left;min-width:auto">テンポ</span><input type="range" class="pit" min="-1000" max="1000" value="0"><span class="pv">0.0%</span><button data-a="pitchReset" style="padding:4px 8px">0</button></div>
      <div class="hint">パッド: 空なら登録／登録済みなら飛ぶ。長押し（またはSHIFT+パッド）で消去。</div>`;
    this.ui = {
      tt: $('.tt', this.el), bar: $('.bar', this.el), fill: $('.fill', this.el), ph: $('.ph', this.el),
      marks: $('.marks', this.el), loopz: $('.loopz', this.el), cur: $('.cur', this.el), dur: $('.dur', this.el),
      remain: $('.remain', this.el), snd: $('.snd', this.el), rate: $('.rate', this.el), pit: $('.pit', this.el), pv: $('.pv', this.el),
      play: $('[data-a=play]', this.el), cue: $('[data-a=cue]', this.el), loopOut: $('[data-a=loopOut]', this.el),
      pads: $$('[data-hc]', this.el), vid: $('.vid', this.el), ccBtn: $('[data-a=cc]', this.el),
    };
    // ボタン（CUE は押している間だけプレビューするので pointerdown/up を使う）
    for (const b of $$('[data-a]', this.el)) {
      const a = b.dataset.a;
      if (a === 'cue') {
        b.addEventListener('pointerdown', e => { e.preventDefault(); this.cueDown(); });
        b.addEventListener('pointerup', () => this.cueUp());
        b.addEventListener('pointercancel', () => this.cueUp());
      } else if (a === 'cc' || a === 'ccMinus' || a === 'ccPlus' || a === 'big') {
        b.addEventListener('click', () => this.view(a));
      } else if (a === 'pitchReset') {
        b.addEventListener('click', () => this.setPitch(0));
      } else {
        b.addEventListener('click', () => this.button(a, true));
      }
    }
    for (const b of this.ui.pads) {
      const i = +b.dataset.hc; let tm = null, long = false;
      b.addEventListener('pointerdown', () => { long = false; tm = setTimeout(() => { long = true; this.deleteHotcue(i); }, 600); });
      b.addEventListener('pointerup', () => { clearTimeout(tm); if (!long) this.hotcue(i); });
      b.addEventListener('pointerleave', () => clearTimeout(tm));
      b.addEventListener('contextmenu', e => e.preventDefault());
    }
    this.ui.pit.addEventListener('input', () => this.setPitch(this.ui.pit.value / 1000, true));
    const seekFromBar = e => {
      if (!this.dur) return;
      const r = this.ui.bar.getBoundingClientRect();
      this.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.dur);
    };
    this.ui.bar.addEventListener('pointerdown', seekFromBar);
    this.renderStatic();
  }
  /* --- YouTube --- */
  createPlayer() {
    const pv = { playsinline: 1, controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, fs: 0, hl: 'ja', cc_lang_pref: 'ja' };
    if (location.origin && location.origin !== 'null') pv.origin = location.origin;
    this.player = new YT.Player(`player${this.name}`, {
      width: '100%', height: '100%', playerVars: pv,
      events: {
        onReady: () => {
          this.ready = true; this.applyVolume(true);
          if (this.videoId) this.load(this.videoId, this.restorePos || 0, true);
        },
        onStateChange: e => this.onState(e.data),
        onPlaybackRateChange: e => { this.rateActual = e.data; },
        onError: e => this.onError(e.data),
      },
    });
  }
  load(id, start = 0, keepCues = false) {
    if (!this.ready) { this.videoId = id; this.restorePos = start; return; }
    if (!keepCues || id !== this.videoId) {
      this.cue = start; this.hc = Array(NCUES).fill(null); this.loop = { in: null, out: null, on: false };
      const h = S.hist.find(x => x.id === id); this.title = h ? h.title : '';
    }
    this.videoId = id; this.dur = 0; this.appliedRate = null;
    this.base = start; this.stamp = performance.now(); this.lastRaw = -1;
    // 先頭を読み込ませてから一時停止しておく（すぐに再生できるように）。この間は消音。
    this.priming = true; this.primeAt = start; this.primeStarted = performance.now();
    this.player.mute();
    this.player.loadVideoById({ videoId: id, startSeconds: start });
    addHistory(id, this.title);
    this.renderStatic(); refreshLeds(); save();
  }
  onState(s) {
    this.state = s;
    if (this.priming && s === YT.PlayerState.PLAYING) {
      this.player.pauseVideo(); this.player.seekTo(this.primeAt, true);
      return;
    }
    if (this.priming && (s === YT.PlayerState.PAUSED || s === YT.PlayerState.CUED)) {
      this.priming = false; this.player.unMute(); this.applyVolume(true);
    }
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED || s === YT.PlayerState.CUED) {
      const d = this.player.getDuration(); if (d) this.dur = d;
      const vd = this.player.getVideoData && this.player.getVideoData();
      if (vd && vd.title && vd.title !== this.title) { this.title = vd.title; addHistory(this.videoId, this.title); this.renderStatic(); save(); }
    }
    if (s === YT.PlayerState.PLAYING) this.appliedRate = null; // 再生開始時にテンポを確実に反映
    if (s === YT.PlayerState.PLAYING && S.settings.cc[this.name] && this.ccFor !== this.videoId) this.applyCaptions();
    refreshLeds();
  }
  onError(code) {
    this.priming = false; try { this.player.unMute(); } catch (e) { }
    const msg = {
      2: 'URL が正しくありません', 5: 'この端末で再生できない動画です', 100: '動画が見つかりません（削除・非公開）',
      101: 'この動画は埋め込み再生が禁止されています', 150: 'この動画は埋め込み再生が禁止されています',
      153: 'YouTube が再生を拒否しました（ファイルを直接開いている場合は https で開いてください）',
    }[code] || `再生エラー (${code})`;
    toast(`デッキ${this.name}: ${msg}`, 4000);
  }
  /* --- 時刻（YouTube の報告は間引かれるので補間する） --- */
  now() {
    if (!this.ready || !this.videoId) return 0;
    if (this.priming) return this.primeAt;
    const raw = this.player.getCurrentTime() || 0;
    const t = performance.now();
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.base = raw; this.stamp = t; }
    if (this.state === YT.PlayerState.PLAYING) {
      return this.base + Math.min(1.5, (t - this.stamp) / 1000) * (this.rateActual || 1);
    }
    return this.base;
  }
  get playing() { return this.state === YT.PlayerState.PLAYING || this.state === YT.PlayerState.BUFFERING; }
  seek(t) {
    if (!this.ready || !this.videoId) return;
    t = Math.max(0, this.dur ? Math.min(t, this.dur - 0.05) : t);
    if (this.priming) { this.primeAt = t; this.base = t; return; }
    if (this.state === YT.PlayerState.CUED || this.state === YT.PlayerState.UNSTARTED) {
      this.load(this.videoId, t, true); return;
    }
    this.player.seekTo(t, true);
    this.base = t; this.stamp = performance.now(); this.lastRaw = this.player.getCurrentTime();
  }
  /* --- 操作 --- */
  button(a, pressed) {
    if (a === 'cue') { pressed ? this.cueDown() : this.cueUp(); return; }
    if (!pressed) return;
    if (!this.videoId && a !== 'load') { toast(`デッキ${this.name} に曲がありません`); return; }
    switch (a) {
      case 'play':
        if (this.cuePreview) { this.playLatch = true; break; }
        if (this.playing) this.player.pauseVideo(); else { this.player.unMute(); this.applyVolume(true); this.player.playVideo(); }
        break;
      case 'back': this.seek(this.now() - (shiftHeld ? 30 : 10)); break;
      case 'fwd': this.seek(this.now() + (shiftHeld ? 30 : 10)); break;
      case 'loopIn':
        this.loop = { in: this.now(), out: null, on: false }; this.renderStatic(); break;
      case 'loopOut':
        if (this.loop.on) this.loop.on = false;
        else if (this.loop.in != null && this.loop.out != null) { this.loop.on = true; this.seek(this.loop.in); }
        else if (this.loop.in != null) {
          const t = this.now();
          if (t > this.loop.in + 0.1) { this.loop.out = t; this.loop.on = true; this.seek(this.loop.in); }
        } else toast('先にループ IN を押してください');
        this.renderStatic(); refreshLeds(); break;
      case 'load': loadSelected(this); break;
    }
  }
  cueDown() {
    if (!this.videoId || this.priming) return;
    if (this.playing && !this.cuePreview) { this.player.pauseVideo(); this.seek(this.cue); return; }
    const t = this.now();
    if (Math.abs(t - this.cue) < 0.2) { this.cuePreview = true; this.playLatch = false; this.player.playVideo(); }
    else { this.cue = t; this.renderStatic(); save(); }
  }
  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false;
    if (!this.playLatch) { this.player.pauseVideo(); this.seek(this.cue); }
    this.playLatch = false;
  }
  hotcue(i) {
    if (!this.videoId) { toast(`デッキ${this.name} に曲がありません`); return; }
    if (shiftHeld) { this.deleteHotcue(i); return; }
    if (this.hc[i] == null) { this.hc[i] = this.now(); toast(`パッド${i + 1} に登録 (${fmt(this.hc[i])})`, 1200); }
    else { this.seek(this.hc[i]); if (!this.playing) this.player.playVideo(); }
    this.renderStatic(); refreshLeds(); save();
  }
  deleteHotcue(i) {
    if (this.hc[i] == null) return;
    this.hc[i] = null; toast(`パッド${i + 1} を消去`, 1200); this.renderStatic(); refreshLeds(); save();
  }
  /* --- 字幕（YouTube プレーヤーの字幕を大きく表示） --- */
  view(a) {
    const cc = S.settings.cc;
    if (a === 'big') {
      const on = !this.ui.vid.classList.contains('big');
      for (const d of decks) d.ui.vid.classList.remove('big');
      this.ui.vid.classList.toggle('big', on);
    } else if (a === 'cc') {
      cc[this.name] = !cc[this.name];
      if (cc[this.name]) this.applyCaptions(); else { this.ccFor = null; try { this.player.unloadModule('captions'); } catch (e) { } }
    } else {
      S.settings.ccSize = Math.max(-1, Math.min(4, S.settings.ccSize + (a === 'ccPlus' ? 1 : -1)));
      for (const d of decks) if (cc[d.name]) d.setCaptionSize();
      toast(`字幕の大きさ: ${S.settings.ccSize + 2} / 6`, 1200);
    }
    this.renderCc(); save();
  }
  applyCaptions() {
    if (!this.ready || !this.videoId) return;
    this.ccFor = this.videoId;
    try { this.player.loadModule('captions'); } catch (e) { }
    // 言語はプレーヤー作成時の cc_lang_pref（日本語優先）で決まる。字幕の読み込みを待ってから大きさを反映
    setTimeout(() => {
      try {
        if (!(this.player.getOption('captions', 'tracklist') || []).length) toast(`デッキ${this.name}: この動画には字幕がありません`, 2000);
      } catch (e) { }
      this.setCaptionSize();
    }, 1500);
  }
  setCaptionSize() { try { this.player.setOption('captions', 'fontSize', S.settings.ccSize); } catch (e) { } }
  renderCc() { this.ui.ccBtn.classList.toggle('on', !!S.settings.cc[this.name]); }
  setPitch(p, fromUi = false) {
    if (Math.abs(p) < 0.02) p = 0; // 中央付近は 0 に吸着
    this.pitch = p;
    this.wantRate = 1 + p * S.settings.pitchRange;
    if (!fromUi) this.ui.pit.value = Math.round(p * 1000);
    this.ui.pv.textContent = `${p >= 0 ? '+' : ''}${(p * S.settings.pitchRange * 100).toFixed(1)}%`;
  }
  setVolume(v) { this.vol = v; S.vol[this.name] = v; $(`#vol${this.name}`).value = Math.round(v * 1000); applyVolumes(); save(); }
  jog(delta) { this.jogAcc += delta; }
  applyVolume(force) {
    if (!this.ready) return;
    const xf = S.xf;
    const g = this.name === 'A' ? (xf <= 0.5 ? 1 : (1 - xf) * 2) : (xf >= 0.5 ? 1 : xf * 2);
    const v = Math.round(100 * this.vol * g);
    if (force || v !== this.lastVolSent) { this.player.setVolume(v); this.lastVolSent = v; }
  }
  /* --- 定期処理 --- */
  tick(t) {
    if (!this.ready || !this.videoId) return;
    // 取りこぼし対策: 準備中のまま止まったら解除
    // 自動再生が許可されず準備が進まない場合は、通常の読み込み（サムネイル表示）に切り替える
    if (this.priming && t - this.primeStarted > 6000 && this.player.getPlayerState() === YT.PlayerState.UNSTARTED) {
      this.priming = false; this.player.unMute(); this.applyVolume(true);
      this.player.cueVideoById({ videoId: this.videoId, startSeconds: this.primeAt });
      this.base = this.primeAt; return;
    }
    if (this.priming && t - this.primeStarted > 15000) { this.priming = false; this.player.unMute(); this.applyVolume(true); }
    if (!this.priming && t - this.lastMuteCheck > 500) {
      this.lastMuteCheck = t;
      try { if (this.player.isMuted()) { this.player.unMute(); this.applyVolume(true); } } catch (e) { }
    }
    const cur = this.now();
    if (this.loop.on && this.loop.out != null && this.playing && cur >= this.loop.out) this.seek(this.loop.in);
    // ジョグ（まとめて適用）
    const iv = this.playing ? 150 : 70;
    if (this.jogAcc && t - this.lastJog > iv) {
      const d = this.jogAcc * S.settings.jogSens * (shiftHeld ? 10 : 1);
      this.jogAcc = 0; this.lastJog = t; this.seek(cur + d);
    }
    // テンポ
    if (this.appliedRate !== this.wantRate && t - this.lastRateSet > 120 && !this.priming) {
      this.player.setPlaybackRate(this.wantRate); this.appliedRate = this.wantRate; this.lastRateSet = t;
      setTimeout(() => { try { this.rateActual = this.player.getPlaybackRate() || 1; } catch (e) { } }, 150);
    }
  }
  renderStatic() {
    this.ui.tt.textContent = this.videoId ? (this.title || this.videoId) : '未ロード';
    this.ui.pads.forEach((b, i) => b.classList.toggle('set', this.hc[i] != null));
    let h = '';
    if (this.dur) {
      h += `<div class="mk" style="left:${this.cue / this.dur * 100}%"></div>`;
      this.hc.forEach(c => { if (c != null) h += `<div class="mk hc" style="left:${c / this.dur * 100}%"></div>`; });
    }
    this.ui.marks.innerHTML = h;
    const lz = this.ui.loopz;
    if (this.dur && this.loop.in != null) {
      const end = this.loop.out ?? this.loop.in + 0.5;
      lz.style.display = 'block'; lz.style.left = `${this.loop.in / this.dur * 100}%`;
      lz.style.width = `${Math.max(0.3, (end - this.loop.in) / this.dur * 100)}%`;
      lz.style.opacity = this.loop.on ? '1' : '.4';
    } else lz.style.display = 'none';
    this.ui.loopOut.classList.toggle('on', this.loop.on);
    this.lastDurRendered = this.dur;
  }
  renderLive() {
    const cur = this.now();
    if (this.dur !== this.lastDurRendered) this.renderStatic();
    const pct = this.dur ? Math.min(100, cur / this.dur * 100) : 0;
    this.ui.fill.style.width = pct + '%'; this.ui.ph.style.left = pct + '%';
    this.ui.cur.textContent = fmt(cur); this.ui.dur.textContent = fmt(this.dur);
    this.ui.remain.textContent = this.dur ? `残り ${fmt(this.dur - cur)}` : '';
    const want = this.wantRate, act = this.rateActual || 1;
    this.ui.rate.textContent = Math.abs(want - act) > 0.004 ? `×${act.toFixed(2)}（指定 ${want.toFixed(3)}）` : `×${act.toFixed(3)}`;
    let snd = '';
    if (this.videoId && this.ready && !this.priming) {
      let muted = false; try { muted = this.player.isMuted(); } catch (e) { }
      if (muted) snd = '🔇 消音中';
      else if (this.lastVolSent === 0) snd = this.vol === 0 ? '🔈 音量フェーダー 0' : '🔈 クロスフェーダーで無音';
      else snd = `🔊 ${this.lastVolSent}`;
    }
    if (this.ui.snd.textContent !== snd) this.ui.snd.textContent = snd;
    this.ui.play.classList.toggle('on', this.playing);
    this.ui.cue.classList.toggle('on', this.cuePreview);
  }
}

const decks = DECK_NAMES.map(n => new Deck(n));
const deckOf = n => decks.find(d => d.name === n);

function applyVolumes() { for (const d of decks) d.applyVolume(); }

window.onYouTubeIframeAPIReady = () => { for (const d of decks) d.createPlayer(); };

/* ---------- 履歴・検索結果（ブラウズつまみ／LOAD は表示中の一覧に対して動く） ---------- */
let histSel = 0;
let listMode = 'hist'; // 'hist' | 'srch'
const srch = { q: '', items: [], next: null, sel: 0, busy: false };
const titleReq = new Set();
async function fetchTitle(id) {
  if (titleReq.has(id)) return; titleReq.add(id);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (!r.ok) return;
    const j = await r.json();
    if (j.title) {
      addHistory(id, j.title);
      for (const d of decks) if (d.videoId === id && !d.title) { d.title = j.title; d.renderStatic(); }
      if (clipOffer && clipOffer.id === id) $('#clipBar .ct').textContent = j.title;
    }
  } catch (e) { }
}
function addHistory(id, title) {
  const i = S.hist.findIndex(h => h.id === id);
  if (i >= 0) { if (title) S.hist[i].title = title; }
  else S.hist.unshift({ id, title: title || '' });
  if (!title && !(i >= 0 && S.hist[i].title)) fetchTitle(id);
  if (S.hist.length > 200) S.hist.length = 200;
  renderHist(); save();
}
function renderHist() {
  const ul = $('#hist');
  if (!S.hist.length) { ul.innerHTML = '<li class="hint">履歴はまだありません。検索するか、URL を貼り付けるか、YouTube アプリの「共有」から送ってください。</li>'; return; }
  histSel = Math.max(0, Math.min(histSel, S.hist.length - 1));
  ul.innerHTML = S.hist.map((h, i) => `<li data-i="${i}" class="${i === histSel ? 'sel' : ''}">
    <span class="t"></span><button data-to="A">A</button><button data-to="B">B</button><button data-del>×</button></li>`).join('');
  $$('li', ul).forEach((li, i) => { $('.t', li).textContent = S.hist[i].title || S.hist[i].id; });
}
$('#hist').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const i = +li.dataset.i;
  if (e.target.dataset.to) loadInto(deckOf(e.target.dataset.to), S.hist[i]);
  else if (e.target.hasAttribute('data-del')) { S.hist.splice(i, 1); save(); }
  else histSel = i;
  renderHist();
});
function renderSrch() {
  const ul = $('#srch');
  if (srch.busy && !srch.items.length) { ul.innerHTML = '<li class="hint">検索中…</li>'; return; }
  if (!srch.items.length) { ul.innerHTML = `<li class="hint">${srch.q ? '見つかりませんでした' : '上の欄にキーワードを入れて検索してください'}</li>`; return; }
  srch.sel = Math.max(0, Math.min(srch.sel, srch.items.length - 1));
  ul.innerHTML = srch.items.map((v, i) => `<li data-i="${i}" class="${i === srch.sel ? 'sel' : ''}">
    <img loading="lazy" alt=""><span class="t"><span class="tt"></span><span class="sub"></span></span><button data-to="A">A</button><button data-to="B">B</button></li>`).join('')
    + (srch.next ? `<li class="more"><button data-more>${srch.busy ? '読み込み中…' : 'もっと見る'}</button></li>` : '');
  $$('li[data-i]', ul).forEach((li, i) => {
    const v = srch.items[i];
    $('img', li).src = v.thumb; $('.tt', li).textContent = v.title;
    $('.sub', li).textContent = [v.dur, v.ch].filter(Boolean).join(' ・ ');
  });
}
$('#srch').addEventListener('click', e => {
  if (e.target.hasAttribute('data-more')) { runSearch(true); return; }
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const i = +li.dataset.i;
  if (e.target.dataset.to) loadInto(deckOf(e.target.dataset.to), srch.items[i]);
  srch.sel = i; renderSrch();
});
function setListMode(m) {
  listMode = m;
  $('#srch').hidden = m !== 'srch'; $('#hist').hidden = m !== 'hist';
  $('#segS').classList.toggle('on', m === 'srch'); $('#segH').classList.toggle('on', m === 'hist');
}
$('#segS').addEventListener('click', () => { setListMode('srch'); renderSrch(); });
$('#segH').addEventListener('click', () => setListMode('hist'));

const decodeHtml = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
function isoDur(s) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || ''); if (!m) return '';
  const h = +(m[1] || 0), mi = +(m[2] || 0), se = +(m[3] || 0);
  return h ? `${h}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}` : `${mi}:${String(se).padStart(2, '0')}`;
}
async function ytApi(path, params) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [k, v] of Object.entries({ ...params, key: S.settings.ytKey })) u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u); } catch (e) { throw new Error('通信できませんでした（ネット接続を確認してください）'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j.error?.errors?.[0]?.reason || j.error?.status || String(r.status);
    const msg = {
      quotaExceeded: '今日の検索回数の上限に達しました（日本時間の午後4〜5時ごろにリセット）',
      keyInvalid: 'API キーが正しくありません（設定を確認してください）',
      badRequest: 'API キーが正しくありません（設定を確認してください）',
      INVALID_ARGUMENT: 'API キーが正しくありません（設定を確認してください）',
      accessNotConfigured: 'YouTube Data API v3 が有効になっていません',
      SERVICE_DISABLED: 'YouTube Data API v3 が有効になっていません',
      forbidden: 'このサイトからのキーの使用が許可されていません（キーの制限を確認してください）',
      PERMISSION_DENIED: 'このサイトからのキーの使用が許可されていません（キーの制限を確認してください）',
    }[reason] || `検索エラー（${reason}）`;
    throw new Error(msg);
  }
  return j;
}
async function runSearch(more = false) {
  if (srch.busy) return;
  if (!more) {
    const q = $('#qIn').value.trim(); if (!q) return;
    // URL が入力されたら検索せずに履歴へ入れる
    const id = parseYouTubeId(q);
    if (id && /youtu|^[\w-]{11}$/.test(q)) { addHistory(id, ''); histSel = 0; setListMode('hist'); renderHist(); toast('履歴に追加しました'); $('#qIn').value = ''; return; }
    if (!S.settings.ytKey) { openYouTubeSearch(q); return; }
    Object.assign(srch, { q, items: [], next: null, sel: 0 });
  }
  srch.busy = true; setListMode('srch'); renderSrch();
  try {
    const p = { part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '25', q: srch.q, regionCode: 'JP', relevanceLanguage: 'ja' };
    if (more && srch.next) p.pageToken = srch.next;
    const r = await ytApi('search', p);
    const items = (r.items || []).filter(x => x.id?.videoId).map(x => ({
      id: x.id.videoId, title: decodeHtml(x.snippet.title), ch: decodeHtml(x.snippet.channelTitle || ''),
      thumb: x.snippet.thumbnails?.medium?.url || x.snippet.thumbnails?.default?.url || '', dur: '',
    }));
    if (items.length) { // 長さは別 API で取得（消費はごくわずか）
      try {
        const d = await ytApi('videos', { part: 'contentDetails', id: items.map(v => v.id).join(',') });
        const m = Object.fromEntries((d.items || []).map(v => [v.id, isoDur(v.contentDetails?.duration)]));
        items.forEach(v => v.dur = m[v.id] || '');
      } catch (e) { }
    }
    srch.items.push(...items); srch.next = r.nextPageToken || null;
  } catch (e) { toast(e.message, 5000); }
  srch.busy = false; renderSrch();
}
function openYouTubeSearch(q) {
  const path = `www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const a = document.createElement('a');
  if (/Android/i.test(navigator.userAgent)) {
    // YouTube アプリで開く（入っていなければブラウザで開く）
    a.href = `intent://${path}#Intent;scheme=https;package=com.google.android.youtube;S.browser_fallback_url=${encodeURIComponent('https://' + path)};end`;
  } else { a.href = `https://${path}`; a.target = '_blank'; a.rel = 'noopener'; }
  a.click();
  toast('気に入った動画は「共有」→「YT DJ」か、「共有」→「コピー」してから戻ってきてください', 5000);
}
function updateSearchPlaceholder() {
  $('#qIn').placeholder = S.settings.ytKey ? '検索 または URL' : 'YouTube アプリで検索 または URL';
}
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); $('#qIn').blur(); runSearch(); });

function loadInto(deck, item) {
  if (!item) return;
  addHistory(item.id, item.title || '');
  deck.load(item.id);
}
function browse(delta) {
  const dir = delta > 0 ? 1 : -1;
  if (listMode === 'srch') {
    if (!srch.items.length) return;
    srch.sel = Math.max(0, Math.min(srch.items.length - 1, srch.sel + dir)); renderSrch();
    const li = $(`#srch li[data-i="${srch.sel}"]`); if (li) li.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (!S.hist.length) return;
  histSel = Math.max(0, Math.min(S.hist.length - 1, histSel + dir));
  renderHist();
  const li = $(`#hist li[data-i="${histSel}"]`); if (li) li.scrollIntoView({ block: 'nearest' });
}
function loadSelected(deck) {
  const item = listMode === 'srch' ? srch.items[srch.sel] : S.hist[histSel];
  if (!item) { toast(listMode === 'srch' ? '検索結果がありません' : '履歴が空です'); return; }
  if (deck.playing) { toast(`デッキ${deck.name} は再生中なので読み込みません（止めてから LOAD）`, 3000); return; }
  loadInto(deck, item);
}

/* ---------- URL 貼り付け・共有 ---------- */
function takeUrlInput() {
  const id = parseYouTubeId($('#urlIn').value);
  if (!id) { toast('YouTube の URL を認識できませんでした'); return null; }
  $('#urlIn').value = ''; return id;
}
$$('[data-load]').forEach(b => b.addEventListener('click', () => { const id = takeUrlInput(); if (id) deckOf(b.dataset.load).load(id); }));
$('#btnAddHist').addEventListener('click', () => { const id = takeUrlInput(); if (id) { addHistory(id, ''); histSel = 0; renderHist(); toast('履歴に追加しました'); } });
let clipOffer = null;
function offerClip(id) {
  clipOffer = { id };
  const h = S.hist.find(x => x.id === id);
  $('#clipBar .ct').textContent = (h && h.title) || id;
  $('#clipBar').style.display = 'block';
  if (!(h && h.title)) fetchTitle(id);
}
function closeClip() { clipOffer = null; $('#clipBar').style.display = 'none'; }
$('#clipBar').addEventListener('click', e => {
  const k = e.target.dataset.clip; if (!k || !clipOffer) return;
  const id = clipOffer.id; closeClip();
  if (k === 'A' || k === 'B') {
    const d = deckOf(k);
    if (d.playing && !confirm(`デッキ${k} は再生中です。入れ替えますか？`)) { addHistory(id, ''); return; }
    loadInto(d, { id, title: '' });
  } else if (k === 'hist') { addHistory(id, ''); histSel = 0; setListMode('hist'); renderHist(); toast('履歴に追加しました'); }
});
// 画面に戻ってきた時にクリップボードを確認（新しい YouTube リンクがあれば提案）
async function checkClipboard(manual = false) {
  if (!navigator.clipboard?.readText) { if (manual) toast('この端末ではクリップボードを読めません。入力欄を長押しして貼り付けてください'); return; }
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { if (manual) toast('クリップボードを読めませんでした。入力欄を長押しして貼り付けてください'); return; }
  const id = parseYouTubeId(text);
  if (!id || !/youtu/.test(text)) { if (manual) { if (text) { $('#urlIn').value = text; $('#qIn').value = text; } else toast('クリップボードは空です'); } return; }
  if (!manual && id === S.lastClip) return; // 同じリンクは何度も聞かない
  S.lastClip = id; save();
  offerClip(id);
}
$('#btnClip').addEventListener('click', () => checkClipboard(true));
let clipCheckAt = 0;
function autoClip() {
  if (!started || document.visibilityState !== 'visible') return;
  const t = Date.now(); if (t - clipCheckAt < 800) return; clipCheckAt = t;
  setTimeout(() => checkClipboard(false), 300);
}
document.addEventListener('visibilitychange', autoClip);
window.addEventListener('focus', autoClip);
function handleShared(params) {
  const text = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
  const id = parseYouTubeId(text); if (!id) return false;
  let title = params.get('title') || '';
  if (/youtu/.test(title)) title = '';
  addHistory(id, title); histSel = 0; renderHist();
  toast('共有された動画を履歴の先頭に追加しました。A / B を押して読み込めます', 4000);
  return true;
}
if (handleShared(new URLSearchParams(location.search))) history.replaceState(null, '', location.pathname);
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(p => { if (p.targetURL) handleShared(new URL(p.targetURL).searchParams); });
}

/* ---------- ミキサー（画面） ---------- */
for (const n of DECK_NAMES) {
  const el = $(`#vol${n}`); el.value = Math.round((S.vol[n] ?? 1) * 1000);
  el.addEventListener('input', () => deckOf(n).setVolume(el.value / 1000));
}
$('#xfader').value = Math.round(S.xf * 1000);
$('#xfader').addEventListener('input', () => setXf($('#xfader').value / 1000, true));
function setXf(v, fromUi) { S.xf = v; if (!fromUi) $('#xfader').value = Math.round(v * 1000); applyVolumes(); save(); }

/* ---------- MIDI ---------- */
let midi = null;
const monitorLines = [];
function keyLabel(k) {
  const [ty, ch, n] = k.split(':');
  return ty === 'n' ? `Note ch${+ch + 1} #${n}` : ty === 'c' ? `CC ch${+ch + 1} #${n}` : `PitchBend ch${+ch + 1}`;
}
async function initMidi() {
  if (!navigator.requestMIDIAccess) { setMidiStatus(false, 'このブラウザは MIDI 非対応です（Android 版 Chrome を使ってください）'); return; }
  try {
    midi = await navigator.requestMIDIAccess({ sysex: false });
    midi.onstatechange = () => bindInputs();
    bindInputs();
  } catch (e) { setMidiStatus(false, 'MIDI の使用が許可されませんでした'); }
}
function bindInputs() {
  if (!midi) return;
  const ins = [...midi.inputs.values()], outs = [...midi.outputs.values()];
  for (const i of ins) i.onmidimessage = onMidi;
  const live = ins.filter(i => i.state === 'connected');
  setMidiStatus(live.length > 0, live.length ? live.map(i => i.name).join(', ') : 'コントローラーが見つかりません');
  $('#midiList').textContent = `入力: ${live.map(i => i.name).join(', ') || 'なし'} ／ 出力: ${outs.filter(o => o.state === 'connected').map(o => o.name).join(', ') || 'なし'}`;
  refreshLeds();
}
function setMidiStatus(ok, text) { $('#midiDot').classList.toggle('ok', ok); $('#midiName').textContent = text; }

function onMidi(e) {
  const [st, d1, d2 = 0] = e.data;
  const type = st & 0xF0, ch = st & 0x0F;
  let key, val;
  if (type === 0x90 || type === 0x80) { key = `n:${ch}:${d1}`; val = type === 0x80 ? 0 : d2; }
  else if (type === 0xB0) { key = `c:${ch}:${d1}`; val = d2; }
  else if (type === 0xE0) { key = `p:${ch}`; val = ((d2 << 7) | d1) / 16383 * 127; }
  else return;
  const b = S.map[key];
  monitorLines.unshift(`${keyLabel(key)}  値=${Math.round(val)}${b ? '  → ' + TMAP[b.t]?.label : ''}`);
  if (monitorLines.length > 12) monitorLines.length = 12;
  if ($('#settings').open) $('#monitor').textContent = monitorLines.join('\n');
  if (learn) { learnFeed(key, val); return; }
  if (b) dispatch(b, val);
}
function dispatch(b, val) {
  const t = TMAP[b.t]; if (!t) return;
  const [dn, act] = b.t.includes('.') ? b.t.split('.') : [null, b.t];
  const deck = dn && deckOf(dn);
  if (t.kind === 'button') {
    const pressed = val > 0;
    if (act === 'shift') { shiftHeld = pressed; return; }
    if (act.startsWith('hc')) { if (pressed) deck.hotcue(+act.slice(2) - 1); return; }
    deck.button(act, pressed);
  } else if (t.kind === 'abs') {
    const v = val / 127;
    if (act === 'xfader') setXf(v);
    else if (act === 'volume') deck.setVolume(v);
    else if (act === 'pitch') deck.setPitch((S.settings.pitchInvert ? 0.5 - v : v - 0.5) * 2);
  } else {
    const d = b.rel === 'offset' ? val - 64 : (val < 64 ? val : val - 128);
    if (act === 'jog') deck.jog(d);
    else if (act === 'browse') browse(d);
  }
}

/* --- ランプ（LED）へのフィードバック --- */
function sendLed(target, on) {
  if (!midi || !S.settings.led) return;
  for (const [k, b] of Object.entries(S.map)) {
    if (b.t !== target) continue;
    const [ty, ch, n] = k.split(':');
    const msg = ty === 'n' ? [0x90 | ch, +n, on ? 127 : 0] : ty === 'c' ? [0xB0 | ch, +n, on ? 127 : 0] : null;
    if (!msg) continue;
    for (const o of midi.outputs.values()) { try { if (o.state === 'connected') o.send(msg); } catch (e) { } }
  }
}
function refreshLeds() {
  if (!midi || !S.settings.led) return;
  for (const d of decks) {
    sendLed(`${d.name}.play`, d.playing);
    sendLed(`${d.name}.cue`, !!d.videoId && !d.playing);
    sendLed(`${d.name}.loopOut`, d.loop.on);
    d.hc.forEach((c, i) => sendLed(`${d.name}.hc${i + 1}`, c != null));
  }
}
let lastPlaying = {};
setInterval(() => { // 再生状態が変わった時だけランプ更新
  for (const d of decks) if (lastPlaying[d.name] !== d.playing) {
    lastPlaying[d.name] = d.playing; refreshLeds();
    if (d.name === 'B' && S.settings.bMode === 'hide') { applyVideoSize(); if (d.playing) toast('デッキB が再生中なので表示しました', 2000); }
  }
}, 200);

/* --- 学習 --- */
let learn = null; // {target, msgs, timer, done}
function startLearn(target, done) {
  cancelLearn();
  learn = { target, msgs: [], timer: null, done };
}
function cancelLearn() { if (learn) clearTimeout(learn.timer); learn = null; }
function learnFeed(key, val) {
  const kind = TMAP[learn.target.split('#')[0]].kind;
  if (kind === 'button') { if (val > 0) finishLearn(key); return; }
  if (key[0] === 'n') return; // フェーダー/ジョグ学習中はノート（ジョグのタッチ等）を無視
  learn.msgs.push({ key, val });
  if (!learn.timer) learn.timer = setTimeout(resolveLearn, 700);
}
function resolveLearn() {
  if (!learn) return;
  const cnt = {}, vals = {};
  for (const m of learn.msgs) { cnt[m.key] = (cnt[m.key] || 0) + 1; (vals[m.key] ||= []).push(m.val); }
  let keys = Object.keys(cnt).filter(k => { // 14bit の下位バイト (CC 32-63) は上位側を採用
    const [ty, ch, n] = k.split(':');
    return !(ty === 'c' && +n >= 32 && +n < 64 && cnt[`c:${ch}:${+n - 32}`]);
  });
  keys.sort((a, b) => cnt[b] - cnt[a]);
  const key = keys[0];
  const kind = TMAP[learn.target.split('#')[0]].kind;
  const rel = kind === 'rel' ? (vals[key].some(v => v >= 56 && v <= 72) ? 'offset' : 'twos') : undefined;
  finishLearn(key, rel);
}
function finishLearn(key, rel) {
  const tid = learn.target.split('#')[0], done = learn.done;
  cancelLearn();
  const already = S.map[key] && S.map[key].t === tid;
  S.map[key] = rel ? { t: tid, rel } : { t: tid };
  save(); refreshLeds();
  done && done(key, already);
}

/* ---------- 設定画面 ---------- */
function renderMapTable() {
  const rows = TARGETS.map(t => {
    const keys = Object.entries(S.map).filter(([, b]) => b.t === t.id).map(([k]) => keyLabel(k));
    const learning = learn && !wiz && learn.target === t.id;
    return `<tr data-t="${t.id}" class="${learning ? 'learning' : ''}"><td>${t.label}</td><td>${learning ? '…操作してください' : (keys.join(' / ') || '未割り当て')}</td>
      <td style="white-space:nowrap"><button data-learn>学習</button> <button data-clr>消去</button></td></tr>`;
  });
  $('#mapTbl').innerHTML = rows.join('');
}
$('#mapTbl').addEventListener('click', e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const tid = tr.dataset.t;
  if (e.target.hasAttribute('data-learn')) {
    if (learn && learn.target === tid) { cancelLearn(); renderMapTable(); return; }
    startLearn(tid, key => { toast(`${TMAP[tid].label} ← ${keyLabel(key)}`); renderMapTable(); });
    renderMapTable();
  } else if (e.target.hasAttribute('data-clr')) {
    for (const [k, b] of Object.entries(S.map)) if (b.t === tid) delete S.map[k];
    save(); renderMapTable();
  }
});
function openSettings() {
  $('#optRange').value = String(S.settings.pitchRange);
  $('#optInvert').checked = S.settings.pitchInvert;
  $('#optJog').value = S.settings.jogSens;
  $('#optLed').checked = S.settings.led;
  $('#optKey').value = S.settings.ytKey || '';
  $('#optBMode').value = S.settings.bMode;
  $('#monitor').textContent = monitorLines.join('\n') || '（コントローラーを操作するとここに表示されます）';
  renderMapTable(); $('#settings').showModal();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#btnCloseSettings').addEventListener('click', () => { cancelLearn(); $('#settings').close(); });
$('#settings').addEventListener('close', cancelLearn);
$('#optRange').addEventListener('change', e => { S.settings.pitchRange = +e.target.value; decks.forEach(d => d.setPitch(d.pitch)); save(); });
$('#optInvert').addEventListener('change', e => { S.settings.pitchInvert = e.target.checked; save(); });
$('#optJog').addEventListener('change', e => { const v = +e.target.value; if (v > 0) { S.settings.jogSens = v; save(); } });
$('#optLed').addEventListener('change', e => { S.settings.led = e.target.checked; save(); refreshLeds(); });
$('#optBMode').addEventListener('change', e => { S.settings.bMode = e.target.value; applyVideoSize(); save(); });
$('#optKey').addEventListener('change', e => { S.settings.ytKey = e.target.value.trim(); save(); if (S.settings.ytKey) toast('API キーを保存しました'); updateSearchPlaceholder(); });
$('#btnReconnect').addEventListener('click', initMidi);
$('#btnClearMap').addEventListener('click', () => { if (confirm('割り当てをすべて消去しますか？')) { S.map = {}; save(); renderMapTable(); } });
$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ map: S.map, settings: { ...S.settings, ytKey: undefined } }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ytdj-mapping.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#btnImport').addEventListener('click', () => $('#fileImport').click());
$('#fileImport').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const o = JSON.parse(await f.text());
    if (o.map) S.map = o.map; if (o.settings) { delete o.settings.ytKey; Object.assign(S.settings, o.settings); }
    save(); openSettings(); toast('読み込みました');
  } catch (err) { toast('ファイルを読めませんでした'); }
  e.target.value = '';
});

/* ---------- かんたん割り当て（ウィザード） ---------- */
let wiz = null; // {i}
function wizShow() {
  const step = WIZARD[wiz.i];
  if (!step) { wizEnd(true); return; }
  const tid = step.split('#')[0], t = TMAP[tid], second = step.includes('#2');
  $('#wizCount').textContent = `${wiz.i + 1} / ${WIZARD.length}`;
  $('#wizStep').textContent = t.label + (second ? '（2回目：ジョグの側面）' : '');
  $('#wizHow').textContent = second ? 'ジョグの外側（側面）を回してください。天面と同じ信号なら自動で次へ進みます。無ければスキップ。' : (t.how || HOW[t.kind]);
  $('#wizInfo').textContent = '';
  startLearn(step, (key, already) => {
    $('#wizInfo').textContent = already && second ? '天面と同じ信号でした → 次へ' : `✓ ${keyLabel(key)} を登録しました`;
    setTimeout(() => { if (wiz) { wiz.i++; wizShow(); } }, 650);
  });
}
function wizEnd(finished) {
  cancelLearn(); wiz = null; $('#wizard').close();
  if (finished) toast('割り当てが完了しました！', 3000);
  if ($('#settings').open) renderMapTable();
}
$('#btnWizard').addEventListener('click', () => {
  if (!midi || ![...midi.inputs.values()].some(i => i.state === 'connected')) { toast('先にコントローラーを接続してください'); return; }
  if (Object.keys(S.map).length && !confirm('今の割り当てを消去して最初から設定し直します。よろしいですか？')) return;
  S.map = {}; save();
  wiz = { i: 0 }; $('#wizard').showModal(); wizShow();
});
$('#wizSkip').addEventListener('click', () => { wiz.i++; wizShow(); });
$('#wizBack').addEventListener('click', () => { wiz.i = Math.max(0, wiz.i - 1); wizShow(); });
$('#wizStop').addEventListener('click', () => wizEnd(false));
$('#wizard').addEventListener('cancel', () => wizEnd(false));

/* ---------- 開始・画面 ---------- */
let wakeLock = null;
let started = false;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
}
document.addEventListener('visibilitychange', keepAwake);
$('#startBtn').addEventListener('click', () => {
  $('#start').style.display = 'none';
  started = true;
  initMidi(); keepAwake();
  // 開始タップ前に読み込んだ曲は、タップ後に改めて準備し直す
  for (const d of decks) {
    if (d.ready && d.videoId && (d.priming || d.state === YT.PlayerState.UNSTARTED || d.state === YT.PlayerState.CUED)) d.load(d.videoId, d.priming ? d.primeAt : d.now(), true);
  }
  if (!Object.keys(S.map).length) setTimeout(() => toast('まず「⚙ 設定・割り当て」→「かんたん割り当て」でコントローラーを登録してください', 5000), 800);
});
const BMODE_LABEL = { hide: 'B: 隠す', mini: 'B: 小', normal: 'B: 通常' };
function applyVideoSize() {
  document.body.classList.toggle('smallvid', !!S.settings.smallVideo);
  // 隠すモードでも B が再生中なら小さく表示する（見えないまま鳴らさない）
  const m = S.settings.bMode === 'hide' && window.YT && deckOf('B').playing ? 'mini' : S.settings.bMode;
  document.body.classList.toggle('bhide', m === 'hide');
  document.body.classList.toggle('bmini', m === 'mini');
  $('#btnBMode').textContent = BMODE_LABEL[S.settings.bMode] || BMODE_LABEL.hide;
  $('#btnVid').textContent = S.settings.smallVideo ? '🎬 動画: 小' : '🎬 動画: 大';
}
$('#btnVid').addEventListener('click', () => { S.settings.smallVideo = !S.settings.smallVideo; applyVideoSize(); save(); });
$('#btnBMode').addEventListener('click', () => {
  const order = ['hide', 'mini', 'normal'];
  S.settings.bMode = order[(order.indexOf(S.settings.bMode) + 1) % order.length]; applyVideoSize(); save();
});
applyVideoSize();
$('#btnFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => { });
});

// 定期処理
setInterval(() => { const t = performance.now(); for (const d of decks) d.tick(t); }, 25);
setInterval(() => { for (const d of decks) d.renderLive(); }, 100);
setInterval(save, 3000);

document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const d of decks) d.ui.vid.classList.remove('big'); });
renderHist(); renderSrch(); updateSearchPlaceholder();
decks.forEach(d => d.renderCc());
decks.forEach(d => d.setPitch(0));
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
