'use strict';
/* YT DJ Mix — YouTube 2デッキ + Web MIDI コントローラー */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STORE_KEY = 'ytdj.v1';
const APP_VERSION = '2026-10-25h';
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
  addT(`${d}.jogFast`, `デッキ${d} ジョグ（SHIFT を押しながら回したとき）`, 'rel', 'SHIFT を押したままジョグを回してください（ふだんと同じ信号なら、この項目はスキップで構いません）');
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
  settings: { pitchRange: 0.5, pitchInvert: false, jogSens: 0.02, jogFastMul: 10, led: true, ytKey: '', bMode: 'hide', cc: { A: true, B: true }, ccSize: 3 },
  decks: {},             // A: {videoId,title,cue,hc,pos}
  hist: [],              // [{id,title}]
  xf: 0.5, vol: { A: 1, B: 1 },
  channels: [],          // お気に入りチャンネル [{id:'UC…', name, seen: 最後に見た最新動画ID}]
});
let S = defaults();
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) { const o = JSON.parse(raw); S = Object.assign(defaults(), o); S.settings = Object.assign(defaults().settings, o.settings || {}); S.settings.cc = Object.assign({ A: false, B: false }, S.settings.cc);
    if (o.settings && o.settings.bNormal) S.settings.bMode = 'normal'; delete S.settings.bNormal; }
} catch (e) { /* 保存領域が使えなくても動作は続ける */ }
// 起動時は字幕をオンにする（途中でオフにしても、次に開いたときはまたオン）
S.settings.cc = { A: true, B: true };
delete S.settings.smallVideo; // 廃止した「動画: 大／小」の設定を消す
// ユーザーに頼まれたお気に入りチャンネルを一度だけ登録しておく（消したあとに勝手に戻らないよう印を残す）
if (!S.seedCh1) {
  for (const id of ['UC8-Th83bH_thdKZDJCrn88g', 'UCa6vGFO9ty8v5KZJXQxdhaw'])
    if (!S.channels.some(c => c.id === id)) S.channels.push({ id, name: '', seen: '' });
  S.seedCh1 = 1;
}
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
const hasTouched = () => (navigator.userActivation ? navigator.userActivation.hasBeenActive : touchedOnce);
let touchedOnce = false;
function needTouchHint() {
  if (hasTouched()) return false;
  $('#tapHint').hidden = false;
  toast('先に画面のどこかを1回タップしてください（ブラウザの決まりで、最初の再生には画面へのタッチが必要です）', 4000);
  return true;
}

/* ---------- デッキ ---------- */
/* ---------- 動画ファイル用プレーヤー ----------
   YouTube プレーヤーと同じ命令（playVideo / seekTo など）で <video> を動かす。
   デッキは this.player をこれに差し替えるだけで、CUE・パッド・ループ・一時停止などがそのまま使える。
   状態の番号は YouTube と同じ（-1 未開始, 0 終了, 1 再生中, 2 停止, 3 読み込み中, 5 頭出し済み）。 */
class FilePlayer {
  constructor(deck, video) {
    this.deck = deck; this.v = video; this.state = -1; this.name = ''; this.url = null;
    const emit = s => { if (this.state === s) return; this.state = s; if (deck.player === this) deck.onState(s); };
    video.addEventListener('loadedmetadata', () => emit(5));
    video.addEventListener('playing', () => emit(1));
    video.addEventListener('waiting', () => emit(3));
    video.addEventListener('pause', () => emit(2));
    video.addEventListener('ended', () => emit(0));
    video.addEventListener('ratechange', () => { if (deck.player === this) deck.rateActual = video.playbackRate; });
    video.addEventListener('error', () => {
      if (deck.player === this && this.url) toast(`デッキ${deck.name}: この動画ファイルは再生できません（形式に対応していない可能性があります）`, 4000);
    });
  }
  open(file) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file); this.name = file.name; this.state = -1;
    this.v.src = this.url; this.v.load();
  }
  stop() {
    this.v.pause();
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.v.removeAttribute('src'); this.v.load(); this.state = -1;
  }
  playVideo() { const p = this.v.play(); if (p) p.catch(() => { }); }
  pauseVideo() { this.v.pause(); }
  seekTo(t) { if (isFinite(t)) this.v.currentTime = Math.max(0, t); }
  getCurrentTime() { return this.v.currentTime || 0; }
  getDuration() { return isFinite(this.v.duration) ? this.v.duration : 0; }
  getPlayerState() { return this.state; }
  setVolume(v) { this.v.volume = Math.max(0, Math.min(1, v / 100)); }
  getVolume() { return Math.round(this.v.volume * 100); }
  mute() { this.v.muted = true; }
  unMute() { this.v.muted = false; }
  isMuted() { return this.v.muted; }
  setPlaybackRate(r) { this.v.playbackRate = r; } // 動画ファイルはテンポを細かく変えられる
  getPlaybackRate() { return this.v.playbackRate; }
  getVideoData() { return { title: this.name }; }
  // 字幕などは動画ファイルには無いので何もしない
  loadModule() { } unloadModule() { } getOption() { return null; } setOption() { }
  cueVideoById() { } loadVideoById() { }
}

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
    this.priming = false; this.primeAt = 0; this.primeTimer = null;
    this.cuePreview = false; this.playLatch = false;
    this.lastVolSent = -1; this.lastMuteCheck = 0;
    // 一時停止は「その位置で映像を止める」方式（本当の一時停止だとロゴや「その他の動画」が出て字幕が隠れるため）
    this.softPaused = false; this.softT = 0;
    this.lastChromeAt = 0; // lastChromeAt: YouTube のバーが最後に出た時刻（再生開始・シーク）
    const saved = S.decks[name];
    if (saved) {
      this.videoId = saved.videoId || ''; this.title = saved.title || '';
      this.cue = saved.cue || 0; this.hc = (saved.hc || []).concat(Array(NCUES).fill(null)).slice(0, NCUES);
      this.restorePos = saved.pos || 0;
    }
    this.buildUI();
    this.fp = new FilePlayer(this, this.ui.fvid); this.isFile = false;
  }
  serialize() {
    if (this.isFile) return { videoId: '', title: '', cue: 0, hc: [], pos: 0 }; // 動画ファイルは次回開いたときには使えないので保存しない
    return { videoId: this.videoId, title: this.title, cue: this.cue, hc: this.hc, pos: this.videoId ? this.now() : 0 };
  }
  buildUI() {
    const n = this.name;
    this.el.innerHTML = `
      <div class="vidrow">
        <div class="pitch"><span>テンポ</span><input type="range" class="pit" min="-1000" max="1000" value="0"><span class="pv">0.0%</span></div>
        <div class="vid"><div id="player${n}"></div><video class="fvid" playsinline preload="auto"></video><div class="shield"></div></div>
      </div>
      <div class="bar"><div class="loopz"></div><div class="fill"></div><div class="marks"></div><div class="ph"></div></div>
      <div class="time"><span><span class="cur">0:00</span> / <span class="dur">0:00</span></span><span class="remain"></span><span class="snd"></span></div>
      <div class="row transport">
        <button data-a="cue">CUE</button><button data-a="play">▶ / ❚❚</button>
        <button data-a="back">−10秒</button><button data-a="fwd">+10秒</button>
      </div>
      <div class="pads">${Array.from({ length: NCUES }, (_, i) => `<button data-hc="${i}">${i + 1}</button>`).join('')}</div>
      <div class="lc"><div class="row loops"><button data-a="loopIn">ループ IN</button><button data-a="loopOut">ループ OUT／解除</button></div>
      <div class="row cc"><button data-a="cc">字幕</button><button data-a="ccMinus">字幕 小さく</button><button data-a="ccPlus">字幕 大きく</button></div></div>
      <div class="hint">パッド: 空なら登録／登録済みなら飛ぶ。長押し（またはSHIFT+パッド）で消去。</div>`;
    this.ui = {
      bar: $('.bar', this.el), fill: $('.fill', this.el), ph: $('.ph', this.el),
      marks: $('.marks', this.el), loopz: $('.loopz', this.el), cur: $('.cur', this.el), dur: $('.dur', this.el),
      remain: $('.remain', this.el), snd: $('.snd', this.el), pit: $('.pit', this.el), pv: $('.pv', this.el),
      play: $('[data-a=play]', this.el), cue: $('[data-a=cue]', this.el), loopOut: $('[data-a=loopOut]', this.el),
      pads: $$('[data-hc]', this.el), vid: $('.vid', this.el), ccBtn: $('[data-a=cc]', this.el), fvid: $('.fvid', this.el),
    };
    // ボタン（CUE は押している間だけプレビューするので pointerdown/up を使う）
    for (const b of $$('[data-a]', this.el)) {
      const a = b.dataset.a;
      if (a === 'cue') {
        b.addEventListener('pointerdown', e => { e.preventDefault(); this.cueDown(); });
        b.addEventListener('pointerup', () => this.cueUp());
        b.addEventListener('pointercancel', () => this.cueUp());
      } else if (a === 'cc' || a === 'ccMinus' || a === 'ccPlus') {
        b.addEventListener('click', () => this.view(a));
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
    // 再生位置バー: 触れた位置へ移動し、指を滑らせると追いかける（移動命令は 0.12 秒おきにまとめる）
    let barDrag = false, barLast = 0, barTimer = null;
    const seekFromBar = e => {
      const dur = this.dur || (this.ready && this.player.getDuration && this.player.getDuration()) || 0;
      if (!dur) { toast('曲の長さがまだ分からないので移動できません（少し待ってください）', 1500); return; }
      if (!this.dur) this.dur = dur;
      const r = this.ui.bar.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur;
      clearTimeout(barTimer);
      const now = performance.now();
      if (now - barLast > 120) { barLast = now; this.seek(t); }
      else barTimer = setTimeout(() => { barLast = performance.now(); this.seek(t); }, 120);
    };
    this.ui.bar.addEventListener('pointerdown', e => { barDrag = true; try { this.ui.bar.setPointerCapture(e.pointerId); } catch (err) { } barLast = 0; seekFromBar(e); });
    this.ui.bar.addEventListener('pointermove', e => { if (barDrag) seekFromBar(e); });
    const endDrag = () => { barDrag = false; };
    this.ui.bar.addEventListener('pointerup', endDrag);
    this.ui.bar.addEventListener('pointercancel', endDrag);
    this.renderStatic();
  }
  /* --- YouTube --- */
  createPlayer() {
    const pv = { playsinline: 1, controls: 0, disablekb: 1, rel: 0, iv_load_policy: 3, fs: 0 };
    // 字幕は英語を使う。言語はプレーヤー作成時にしか決められず、指定しないと端末の言語（日本語）になる
    pv.hl = 'en'; pv.cc_lang_pref = 'en';
    if (location.origin && location.origin !== 'null') pv.origin = location.origin;
    this.player = this.yt = new YT.Player(`player${this.name}`, {
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
  /* 動画ファイルを読み込む（YouTube から動画ファイル用プレーヤーへ切り替える） */
  loadFile(file) {
    if (!window.YT || !this.ready) { toast('準備中です。少し待ってからもう一度選んでください'); return; }
    try { this.yt.pauseVideo(); this.yt.mute(); } catch (e) { }
    clearTimeout(this.primeTimer); this.primeTimer = null; this.priming = false;
    this.isFile = true; this.player = this.fp; this.ui.vid.classList.add('file');
    this.cue = 0; this.hc = Array(NCUES).fill(null); this.loop = { in: null, out: null, on: false };
    this.videoId = 'file:' + file.name; this.title = file.name;
    this.dur = 0; this.appliedRate = null; this.softPaused = false; this.state = -1;
    this.base = 0; this.stamp = performance.now(); this.lastRaw = -1; this.ccFor = this.videoId;
    this.fp.open(file); this.applyVolume(true);
    this.renderStatic(); refreshLeds(); save();
    toast(`デッキ${this.name}: ${file.name} を読み込みました`, 2000);
  }
  /* YouTube に戻す */
  useYouTube() {
    if (!this.isFile) return;
    this.fp.stop(); this.isFile = false; this.player = this.yt; this.ui.vid.classList.remove('file');
  }
  load(id, start = 0, keepCues = false) {
    this.useYouTube();
    if (!keepCues || id !== this.videoId) {
      this.cue = start; this.hc = Array(NCUES).fill(null); this.loop = { in: null, out: null, on: false };
      const h = S.hist.find(x => x.id === id); this.title = h ? h.title : '';
    }
    if (!this.ready) { this.videoId = id; this.restorePos = start; return; }
    this.videoId = id; this.dur = 0; this.appliedRate = null; this.softPaused = false;
    this.base = start; this.stamp = performance.now(); this.lastRaw = -1;
    // 先頭を読み込ませてから止めておく（すぐに再生できるように）。この間は消音。
    clearTimeout(this.primeTimer); this.primeTimer = null;
    this.priming = true; this.primeAt = start; this.primeStarted = performance.now();
    this.player.mute();
    this.player.loadVideoById({ videoId: id, startSeconds: start });
    addHistory(id, this.title);
    this.renderStatic(); refreshLeds(); save();
  }
  onState(s) {
    this.state = s;
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) this.lastChromeAt = performance.now();
    if (this.priming && s === YT.PlayerState.PLAYING) {
      // 再生が始まった直後は YouTube のバーが出ているので、消えるのを待ってから止める
      if (!this.primeTimer) this.primeTimer = setTimeout(() => this.primeCheck(), 4000);
      return;
    }
    if (this.priming && s === YT.PlayerState.CUED) { // 自動再生できず頭出しだけされた場合
      clearTimeout(this.primeTimer); this.primeTimer = null;
      this.priming = false; this.player.unMute(); this.applyVolume(true);
    }
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.PAUSED || s === YT.PlayerState.CUED) {
      const d = this.player.getDuration(); if (d) this.dur = d;
      const vd = this.player.getVideoData && this.player.getVideoData();
      if (vd && vd.title && vd.title !== this.title) { this.title = vd.title; addHistory(this.videoId, this.title); this.renderStatic(); save(); }
    }
    if (s === YT.PlayerState.PLAYING) this.appliedRate = null; // 再生開始時にテンポを確実に反映
    if (s === YT.PlayerState.PLAYING && this.ccFor !== this.videoId) {
      if (S.settings.cc[this.name]) this.applyCaptions();
      else { this.ccFor = this.videoId; try { this.player.unloadModule('captions'); } catch (e) { } }
    }
    refreshLeds();
  }
  onError(code) {
    this.priming = false; try { this.player.unMute(); } catch (e) { }
    const msg = {
      2: 'URL が正しくありません', 5: 'この端末で再生できない動画です', 100: '動画が見つかりません（削除・非公開）',
      101: 'この動画は埋め込み再生が禁止されているか、日本では見られない動画です', 150: 'この動画は埋め込み再生が禁止されているか、日本では見られない動画です',
      153: 'YouTube が再生を拒否しました（ファイルを直接開いている場合は https で開いてください）',
    }[code] || `再生エラー (${code})`;
    toast(`デッキ${this.name}: ${msg}`, 4000);
  }
  /* --- 時刻（YouTube の報告は間引かれるので補間する） --- */
  now() {
    if (!this.ready || !this.videoId) return 0;
    if (this.priming) return this.primeAt;
    if (this.softPaused) return this.softT;
    const raw = this.player.getCurrentTime() || 0;
    const t = performance.now();
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.base = raw; this.stamp = t; }
    if (this.state === YT.PlayerState.PLAYING) {
      return this.base + Math.min(1.5, (t - this.stamp) / 1000) * (this.rateActual || 1);
    }
    return this.base;
  }
  primeCheck() {
    this.primeTimer = null;
    if (!this.priming) return;
    const wait = this.lastChromeAt + 4000 - performance.now();
    if (wait > 50) { this.primeTimer = setTimeout(() => this.primeCheck(), wait); return; }
    this.finishPrime();
  }
  /* 準備完了: 頭（primeAt）に戻してその場で止める。再開は resume()（止めた位置から再生） */
  finishPrime() {
    clearTimeout(this.primeTimer); this.primeTimer = null;
    if (!this.priming) return;
    this.priming = false;
    this.softPaused = true; this.softT = this.primeAt; this.base = this.primeAt;
    this.freezeAt(this.primeAt);
    this.player.unMute(); this.applyVolume(true);
  }
  get playing() { return !!window.YT && !this.priming && !this.softPaused && (this.state === YT.PlayerState.PLAYING || this.state === YT.PlayerState.BUFFERING); } // YouTube の読み込み前は false
  /* 止める: seekTo(t, false) はシークバーを掴んだ状態になり、映像がその位置で止まる。このときロゴ等の表示が出ない */
  pauseSoft(t = this.now()) {
    this.softPaused = true; this.softT = t; this.base = t;
    this.applyVolume(true); // 音はすぐ消す
    this.freezeAt(t);
  }
  /* その位置で映像を止める。seekTo(t, false) だけだとタブレットでは映像が流れ続けることがあるので、
     続けて pauseVideo() で確実に止める（この順なら一時停止のバーは出ない。
     ただし再生開始・シーク直後でバーが出ている最中に止めた場合は、バーが残る） */
  freezeAt(t) {
    this.player.seekTo(t, false);
    this.player.pauseVideo();
  }
  /* 再開: 止めた位置へ通常のシークをしてから再生（playVideo だけだと止まったまま） */
  resume() {
    if (needTouchHint()) return;
    if (this.priming) {
      clearTimeout(this.primeTimer); this.primeTimer = null;
      this.priming = false; this.softPaused = true; this.softT = this.primeAt;
    }
    this.player.unMute();
    if (this.softPaused) {
      this.softPaused = false; this.applyVolume(true);
      this.player.seekTo(this.softT, true);
      this.base = this.softT; this.stamp = performance.now(); this.lastRaw = -1;
    } else this.applyVolume(true);
    this.player.playVideo();
  }
  seek(t) {
    if (!this.ready || !this.videoId) return;
    t = Math.max(0, this.dur ? Math.min(t, this.dur - 0.05) : t);
    if (this.priming) { this.primeAt = t; this.base = t; return; }
    if (this.softPaused) { // 止めたまま位置だけ動かす
      this.softT = t; this.base = t;
      this.freezeAt(t);
      return;
    }
    if (!this.isFile && (this.state === YT.PlayerState.CUED || this.state === YT.PlayerState.UNSTARTED)) {
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
        if (this.playing) this.pauseSoft();
        else this.resume();
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
    if (this.playing && !this.cuePreview) { this.pauseSoft(this.cue); return; }
    const t = this.now();
    if (Math.abs(t - this.cue) < 0.2) {
      if (needTouchHint()) return;
      this.cuePreview = true; this.playLatch = false;
      if (this.softPaused) this.softT = this.cue;
      this.resume();
    }
    else { this.cue = t; this.renderStatic(); save(); }
  }
  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false;
    if (!this.playLatch) this.pauseSoft(this.cue);
    this.playLatch = false;
  }
  hotcue(i) {
    if (!this.videoId) { toast(`デッキ${this.name} に曲がありません`); return; }
    if (shiftHeld) { this.deleteHotcue(i); return; }
    if (this.hc[i] == null) { this.hc[i] = this.now(); toast(`パッド${i + 1} に登録 (${fmt(this.hc[i])})`, 1200); }
    else { this.seek(this.hc[i]); if (!this.playing) this.resume(); }
    this.renderStatic(); refreshLeds(); save();
  }
  deleteHotcue(i) {
    if (this.hc[i] == null) return;
    this.hc[i] = null; toast(`パッド${i + 1} を消去`, 1200); this.renderStatic(); refreshLeds(); save();
  }
  /* --- 字幕（YouTube プレーヤーの字幕を大きく表示） --- */
  view(a) {
    const cc = S.settings.cc;
    if (a === 'cc') {
      cc[this.name] = !cc[this.name];
      if (cc[this.name]) this.applyCaptions(); else { this.ccFor = null; try { this.player.unloadModule('captions'); } catch (e) { } }
    } else {
      S.settings.ccSize = Math.max(-1, Math.min(4, S.settings.ccSize + (a === 'ccPlus' ? 1 : -1)));
      if (!cc[this.name]) { cc[this.name] = true; this.applyCaptions(); }
      for (const d of decks) d.setCaptionSize();
      toast(`字幕の大きさ: ${S.settings.ccSize + 2} / 6`, 1200);
    }
    this.renderCc(); save();
  }
  applyCaptions() {
    if (!this.ready || !this.videoId || this.isFile) return;
    this.ccFor = this.videoId;
    try { this.player.loadModule('captions'); } catch (e) { }
    // 言語はプレーヤー作成時の hl / cc_lang_pref（英語）で決まる。字幕の読み込みを待ってから大きさを反映
    // 自動生成字幕は tracklist に入らないので、実際に選ばれている字幕（track）も見て判定する
    const hasCc = () => {
      try {
        return (this.player.getOption('captions', 'tracklist') || []).length > 0 || !!this.player.getOption('captions', 'track')?.languageCode;
      } catch (e) { return true; }
    };
    setTimeout(() => {
      this.setCaptionSize();
      if (hasCc()) return;
      setTimeout(() => { // 読み込みが遅い場合に備えてもう一度だけ確認
        this.setCaptionSize();
        if (this.ccFor !== this.videoId || !S.settings.cc[this.name] || hasCc()) return;
        toast(`デッキ${this.name}: この動画には英語の字幕がありません`, 2000);
      }, 3000);
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
    const v = this.softPaused ? 0 : Math.round(100 * this.vol * g);
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
    if (this.priming && t - this.primeStarted > 15000) this.finishPrime();
    if (!this.priming && t - this.lastMuteCheck > 500) {
      this.lastMuteCheck = t;
      try { if (this.player.isMuted()) { this.player.unMute(); this.applyVolume(true); } } catch (e) { }
    }
    const cur = this.now();
    if (this.loop.on && this.loop.out != null && this.playing && cur >= this.loop.out) this.seek(this.loop.in);
    // ジョグ（まとめて適用）
    const iv = this.playing ? 150 : 70;
    if (this.jogAcc && t - this.lastJog > iv) {
      const d = this.jogAcc * S.settings.jogSens;
      this.jogAcc = 0; this.lastJog = t; this.seek(cur + d);
    }
    // テンポ
    if (this.appliedRate !== this.wantRate && t - this.lastRateSet > 120 && !this.priming) {
      this.player.setPlaybackRate(this.wantRate); this.appliedRate = this.wantRate; this.lastRateSet = t;
      setTimeout(() => { try { this.rateActual = this.player.getPlaybackRate() || 1; } catch (e) { } }, 150);
    }
  }
  renderStatic() {
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

window.onYouTubeIframeAPIReady = () => { for (const d of decks) d.createPlayer(); setTimeout(refreshChannels, 3000); };

/* ---------- 履歴・検索結果（ブラウズつまみ／LOAD は表示中の一覧に対して動く） ---------- */
let histSel = 0;
let listMode = 'hist'; // 'hist' | 'srch' | 'chan'
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
  $('#srch').hidden = m !== 'srch'; $('#hist').hidden = m !== 'hist'; $('#chanPane').hidden = m !== 'chan'; $('#filePane').hidden = m !== 'file';
  $('#segH').classList.toggle('on', m === 'hist'); $('#segC').classList.toggle('on', m === 'chan'); $('#segF').classList.toggle('on', m === 'file');
  // デッキA の下は、ファイルタブのときはファイル一覧、それ以外はチャンネルの動画一覧
  try { renderGrid(); renderFiles(); } catch (e) { } // 起動処理の途中（一覧の準備前）に呼ばれた場合は何もしない
}
// 「検索」タブは廃止。API キー登録時だけ、🔍 を押すと結果一覧（#srch）が表示される
$('#segH').addEventListener('click', () => setListMode('hist'));

/* ---------- お気に入りチャンネル（API キー不要） ----------
   チャンネルの「アップロード動画」再生リスト（UC… → UU…）を、画面外の YouTube プレーヤーに
   読み込ませて動画 ID の一覧（新しい順・最大 200 本）を取り出す。タイトルは oEmbed で取得。
   このプレーヤーは一覧を取るだけで再生はしない。 */
const chan = { sel: null, items: [], shown: 25, itemSel: 0, listSel: 0, vids: {}, busy: false };
const titleCache = {};
let helperQ = Promise.resolve();
// 1チャンネルごとに使い捨てのプレーヤーを作って一覧を取り出す（使い回すと前の一覧が混ざるため）
// 先頭の動画が日本で見られない等で再生エラーになると一覧も取れないので、開始位置をずらして取り直す
function uploadsAttempt(chId, index) {
  return new Promise(res => {
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-400px;top:0;width:200px;height:200px;pointer-events:none';
    const inner = document.createElement('div'); div.appendChild(inner); document.body.appendChild(div);
    let p = null, done = false, poll = null;
    const finish = v => {
      if (done) return; done = true; clearInterval(poll); clearTimeout(tm);
      try { p && p.destroy(); } catch (e) { } div.remove(); res(v);
    };
    const tm = setTimeout(() => finish(null), 8000);
    p = new YT.Player(inner, {
      width: '200', height: '200',
      playerVars: { listType: 'playlist', list: 'UU' + chId.slice(2), index, controls: 0, hl: 'en' },
      events: {
        onReady: () => { poll = setInterval(() => { const l = p.getPlaylist(); if (l && l.length) finish(l.slice()); }, 300); },
        onError: () => setTimeout(() => finish((p.getPlaylist() || []).slice() || null), 300),
      },
    });
  });
}
function fetchUploads(chId) {
  const job = helperQ.then(async () => {
    if (!window.YT || !YT.Player) return null;
    for (const index of [0, 5, 12, 25, 50]) {
      const l = await uploadsAttempt(chId, index);
      if (l && l.length) return l;
    }
    return null;
  });
  helperQ = job.catch(() => null);
  return job;
}
async function getTitle(id) {
  if (titleCache[id]) return titleCache[id];
  const h = S.hist.find(x => x.id === id);
  if (h && h.title) return titleCache[id] = { title: h.title, author: '' };
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (r.ok) { const j = await r.json(); return titleCache[id] = { title: j.title || id, author: j.author_name || '' }; }
  } catch (e) { }
  return { title: id, author: '' };
}
function newCount(c) {
  const v = chan.vids[c.id]; if (!v || !c.seen) return 0;
  const i = v.indexOf(c.seen);
  return i < 0 ? Math.min(v.length, 20) : i;
}
function updateChanBadge() {
  const n = S.channels.reduce((s, c) => s + newCount(c), 0);
  // 新着の数は小さな丸で表示（文字で書くとボタンからはみ出すため）
  $('#segC').innerHTML = n ? `チャンネル<span class="badge" title="新着">${n}</span>` : 'チャンネル';
}
/* 右の列: チャンネル名の一覧（選んだチャンネルは強調）。動画はデッキA の下に大きく並べる */
function renderChan() {
  const ul = $('#chan');
  if (!S.channels.length) {
    ul.innerHTML = '<li class="hint">お気に入りチャンネルはまだありません。上の欄にチャンネル ID（UC で始まる英数字）を貼り付けて「追加」を押してください。<br>チャンネル ID は YouTube アプリのチャンネル画面 → 説明文の「…さらに表示」→「チャンネルを共有」→「チャンネル ID をコピー」で取れます。</li>';
  } else {
    ul.innerHTML = S.channels.map((c, i) => `<li data-ci="${i}" class="${c.id === chan.sel ? 'sel' : ''}">
      <span class="t"><span class="tt"></span><span class="sub"></span></span><button data-del>×</button></li>`).join('');
    $$('li[data-ci]', ul).forEach((li, i) => {
      const c = S.channels[i], n = newCount(c);
      $('.tt', li).textContent = c.name || c.id;
      $('.sub', li).textContent = n ? `新着 ${n}` : (chan.vids[c.id] ? (c.id === chan.sel ? '↓ 下に動画一覧' : '') : '確認中…');
      if (n) $('.sub', li).style.color = 'var(--ok)';
    });
  }
  renderGrid();
}
function renderGrid() {
  const sec = $('#chanGrid'), grid = $('#cgrid');
  const c = S.channels.find(x => x.id === chan.sel);
  if (!c || listMode === 'file') { sec.hidden = true; return; }
  sec.hidden = false;
  $('#cgName').textContent = c.name || c.id;
  const vids = chan.vids[chan.sel];
  $('#cgMore').hidden = !vids || vids.length <= chan.shown;
  if (!vids) { grid.innerHTML = '<div class="hint">読み込み中…</div>'; return; }
  if (!vids.length) { grid.innerHTML = '<div class="hint">動画が見つかりませんでした</div>'; return; }
  chan.itemSel = Math.max(0, Math.min(chan.itemSel, Math.min(vids.length, chan.shown) - 1));
  grid.innerHTML = vids.slice(0, chan.shown).map((id, i) => `<div class="vcard${i === chan.itemSel ? ' sel' : ''}" data-vi="${i}">
    <img loading="lazy" alt="" src="https://i.ytimg.com/vi/${id}/mqdefault.jpg"><div class="new"></div><div class="ct"></div>
    <div class="cb"><button data-to="A">A へ</button><button data-to="B">B へ</button></div></div>`).join('');
  const nNew = chan.newShown || 0;
  $$('.vcard', grid).forEach(card => {
    const i = +card.dataset.vi, id = vids[i];
    if (i < nNew) $('.new', card).textContent = 'NEW';
    const fill = t => { $('.ct', card).textContent = t.title; };
    if (titleCache[id]) fill(titleCache[id]); else { $('.ct', card).textContent = '…'; getTitle(id).then(fill); }
  });
}
async function openChannel(c) {
  chan.sel = c.id; chan.itemSel = 0; chan.shown = 25; S.lastChan = c.id;
  chan.newShown = newCount(c);
  renderChan();
  if (!chan.vids[c.id]) { chan.vids[c.id] = await fetchUploads(c.id) || []; chan.newShown = newCount(c); }
  const v = chan.vids[c.id];
  if (v.length) { c.seen = v[0]; save(); } // 開いたら既読にする
  updateChanBadge(); if (chan.sel === c.id) renderChan();
}
async function refreshChannels() {
  for (const c of S.channels) {
    const v = await fetchUploads(c.id);
    if (v) chan.vids[c.id] = v;
    if (!c.seen && v && v.length) { c.seen = v[0]; save(); } // 初回は全部既読扱い
    if (!c.name && v && v.length) { const t = await getTitle(v[0]); if (t.author) { c.name = t.author; save(); } }
    if (listMode === 'chan') renderChan();
    updateChanBadge();
  }
  // 前回開いていたチャンネルの動画を、デッキA の下に並べておく（新着の印はそのまま残す）
  const last = S.channels.find(c => c.id === S.lastChan);
  if (!chan.sel && last) { chan.sel = last.id; chan.newShown = newCount(last); renderChan(); }
}
async function addChannel() {
  const raw = $('#chIn').value.trim(); if (!raw) return;
  const m = raw.match(/UC[\w-]{22}/);
  if (!m) {
    toast(/@|youtube\.com/.test(raw)
      ? 'チャンネルの URL ではなく「チャンネル ID」（UC で始まる英数字）が必要です。チャンネル画面 →「チャンネルを共有」→「チャンネル ID をコピー」で取れます'
      : 'チャンネル ID（UC で始まる24文字）を貼り付けてください', 6000);
    return;
  }
  const id = m[0];
  if (S.channels.some(c => c.id === id)) { toast('そのチャンネルは登録済みです'); return; }
  toast('チャンネルを確認しています…', 3000);
  const v = await fetchUploads(id);
  if (!v || !v.length) { toast('このチャンネルの動画が見つかりませんでした（ID を確認してください）', 4000); return; }
  const t = await getTitle(v[0]);
  const c = { id, name: t.author || id, seen: v[0] };
  S.channels.push(c); chan.vids[id] = v; save();
  $('#chIn').value = ''; chan.listSel = S.channels.length - 1;
  toast(`「${c.name}」を登録しました`, 2500);
  renderChan(); updateChanBadge();
}
$('#chAdd').addEventListener('click', addChannel);
$('#chIn').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });
$('#chan').addEventListener('click', e => {
  const t = e.target;
  const ci = t.closest('li[data-ci]'); if (!ci) return;
  const i = +ci.dataset.ci, c = S.channels[i];
  if (t.hasAttribute('data-del')) {
    if (confirm(`「${c.name || c.id}」を登録から外しますか？`)) {
      S.channels.splice(i, 1); if (chan.sel === c.id) chan.sel = null;
      save(); renderChan(); updateChanBadge();
    }
    return;
  }
  chan.listSel = i; openChannel(c);
  $('#chanGrid').scrollIntoView({ behavior: 'smooth', block: 'start' }); // 画面をタップして開いたときは一覧までスクロール
});
// デッキA の下の動画一覧: カードを押すとデッキA へ（「B へ」ボタンはデッキB へ）
$('#cgrid').addEventListener('click', e => {
  const card = e.target.closest('.vcard'); if (!card) return;
  const i = +card.dataset.vi, id = chan.vids[chan.sel][i];
  chan.itemSel = i;
  loadInto(deckOf(e.target.dataset.to || 'A'), { id, title: titleCache[id] ? titleCache[id].title : '' });
  renderGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' }); // 読み込んだらデッキの位置へ戻る
});
$('#cgMore').addEventListener('click', () => { chan.shown += 25; renderGrid(); });
$('#cgReload').addEventListener('click', () => { const c = S.channels.find(x => x.id === chan.sel); delete chan.vids[chan.sel]; if (c) openChannel(c); });
$('#segC').addEventListener('click', () => { setListMode('chan'); renderChan(); });

/* ---------- 動画ファイル（ファイルエクスプローラーとお気に入りフォルダ） ----------
   フォルダを覚えられるブラウザ（showDirectoryPicker がある）では、選んだフォルダを IndexedDB に保存して
   お気に入りにできる。無いブラウザでは、毎回フォルダ／ファイルを選んでもらう。 */
const canKeepFolders = 'showDirectoryPicker' in window;
const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|3gp|avi|wmv|mpe?g|ts|ogv)$/i;
const fx = { mode: null, rootName: '', root: null, stack: [], files: null, entries: [], sel: 0 };
const sortName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
const fmtSize = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';

// IndexedDB（お気に入りフォルダの保存先）
function favDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ytdj-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('favs', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function favTx(mode, fn) {
  const db = await favDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('favs', mode), st = tx.objectStore('favs');
    const r = fn(st); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error);
  });
}
const favList = () => favTx('readonly', st => st.getAll()).catch(() => []);
let favCache = [];
async function renderFavs() {
  const ul = $('#favs');
  if (!canKeepFolders) {
    ul.innerHTML = '<li class="hint">このブラウザはフォルダを覚えられないため、お気に入りとして残せません。上のボタンでフォルダを選ぶと、アプリを閉じるまでの間だけ下に中身が表示されます。</li>';
    return;
  }
  favCache = await favList();
  if (!favCache.length) { ul.innerHTML = '<li class="hint">お気に入りフォルダはまだありません。上の「＋ お気に入りフォルダを追加」で、動画の入ったフォルダを選んでください。</li>'; return; }
  ul.innerHTML = favCache.map((f, i) => `<li data-fi="${i}" class="${fx.mode === 'handle' && f.id === S.lastFav ? 'sel' : ''}"><span class="t"></span><button data-del>×</button></li>`).join('');
  $$('li[data-fi]', ul).forEach((li, i) => { $('.t', li).textContent = '📁 ' + favCache[i].name; });
}
$('#favs').addEventListener('click', async e => {
  const li = e.target.closest('li[data-fi]'); if (!li) return;
  const f = favCache[+li.dataset.fi];
  if (e.target.hasAttribute('data-del')) {
    if (confirm(`お気に入りから「${f.name}」を外しますか？`)) { await favTx('readwrite', st => st.delete(f.id)); renderFavs(); }
    return;
  }
  openFav(f, true);
});
// 登録フォルダを開く（前回の許可が切れていたら、もう一度許可をもらう。画面のタップが必要）
async function openFav(f, scroll) {
  try {
    let p = await f.handle.queryPermission({ mode: 'read' });
    if (p !== 'granted') p = await f.handle.requestPermission({ mode: 'read' });
    if (p !== 'granted') { toast('フォルダを読む許可がもらえませんでした'); return; }
  } catch (err) { toast('このフォルダを開けませんでした（移動・削除された可能性があります）', 4000); return; }
  S.lastFav = f.id; save();
  openFolderHandle(f.handle, scroll);
}

async function openFolderHandle(h, scroll = true) {
  fx.mode = 'handle'; fx.root = h; fx.rootName = h.name; fx.stack = []; fx.files = null;
  await loadEntries(); renderFavs(); showFiles(scroll);
}
// 今いるフォルダの中身（フォルダ → 動画ファイルの順）
async function loadEntries() {
  fx.sel = 0;
  if (fx.mode === 'handle') {
    const dir = fx.stack.length ? fx.stack[fx.stack.length - 1].h : fx.root;
    const dirs = [], files = [];
    try {
      for await (const [name, e] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (e.kind === 'directory') dirs.push({ name, dir: true, h: e });
        else if (VIDEO_EXT.test(name)) files.push({ name, h: e });
      }
    } catch (err) { toast('フォルダの中身を読めませんでした', 3000); }
    fx.entries = [...dirs.sort(sortName), ...files.sort(sortName)];
  } else if (fx.mode === 'list') {
    // 選んだフォルダ内のファイル一覧（webkitRelativePath）から、今いる階層の中身を作る
    const depth = fx.stack.length, prefix = fx.stack.map(s => s.name).join('/');
    const dirs = new Map(), files = [];
    for (const f of fx.files) {
      const parts = (f.webkitRelativePath || f.name).split('/').slice(fx.hasRoot ? 1 : 0);
      if (parts.slice(0, depth).join('/') !== prefix) continue;
      const rest = parts.slice(depth);
      if (rest.length > 1) dirs.set(rest[0], { name: rest[0], dir: true });
      else if (VIDEO_EXT.test(rest[0]) || (f.type || '').startsWith('video/')) files.push({ name: rest[0], file: f });
    }
    fx.entries = [...[...dirs.values()].sort(sortName), ...files.sort(sortName)];
  }
}
function showFiles(scroll = true) { setListMode('file'); renderFiles(); if (scroll) $('#fileGrid').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function renderFiles() {
  const sec = $('#fileGrid');
  sec.hidden = listMode !== 'file' || !fx.mode;
  if (sec.hidden) return;
  // パンくず: 登録フォルダから今いるフォルダまで。途中の名前を押すとその階層へ戻る
  const crumbs = [fx.rootName, ...fx.stack.map(s => s.name)];
  // 登録フォルダより上（内部ストレージ内のどこか）はブラウザの制限で分からないので「…」で示す
  const path = $('#fgPath'); path.innerHTML = '📁 <span class="crumbLbl">内部ストレージ › … ›</span> ';
  crumbs.forEach((name, depth) => {
    if (depth) path.append(' › ');
    const s = document.createElement('span'); s.textContent = name; s.dataset.depth = depth;
    s.className = depth < crumbs.length - 1 ? 'crumb' : 'crumb cur';
    path.append(s);
  });
  const list = $('#flist');
  let h = fx.stack.length ? '<div class="frow up" data-up>⬆ ひとつ上のフォルダへ</div>' : '';
  if (!fx.entries.length) h += '<div class="hint" style="padding:10px">このフォルダには動画ファイルがありません</div>';
  h += fx.entries.map((e, i) => e.dir
    ? `<div class="frow${i === fx.sel ? ' sel' : ''}" data-ei="${i}"><span class="fn"></span><span class="fs">フォルダ</span></div>`
    : `<div class="frow${i === fx.sel ? ' sel' : ''}" data-ei="${i}"><span class="fn"></span><span class="fs"></span><button data-to="A">A へ</button><button data-to="B">B へ</button></div>`).join('');
  list.innerHTML = h;
  $$('.frow[data-ei]', list).forEach(row => {
    const e = fx.entries[+row.dataset.ei];
    $('.fn', row).textContent = (e.dir ? '📁 ' : '🎞 ') + e.name;
    if (!e.dir) {
      const setSize = f => { $('.fs', row).textContent = fmtSize(f.size); };
      if (e.file) setSize(e.file); else e.h.getFile().then(setSize).catch(() => { });
    }
  });
}
async function openEntry(i, deckName) {
  const e = fx.entries[i]; if (!e) return;
  fx.sel = i;
  if (e.dir) { fx.stack.push(e); await loadEntries(); renderFiles(); return; }
  let file = e.file;
  if (!file) { try { file = await e.h.getFile(); } catch (err) { toast('ファイルを開けませんでした', 3000); return; } }
  deckOf(deckName || 'A').loadFile(file);
  renderFiles();
  window.scrollTo({ top: 0, behavior: 'smooth' }); // 読み込んだらデッキの位置へ戻る
}
$('#flist').addEventListener('click', async e => {
  if (e.target.closest('[data-up]')) { fx.stack.pop(); await loadEntries(); renderFiles(); return; }
  const row = e.target.closest('.frow[data-ei]'); if (!row) return;
  openEntry(+row.dataset.ei, e.target.dataset.to);
});
$('#fgPath').addEventListener('click', async e => {
  const s = e.target.closest('.crumb'); if (!s || s.classList.contains('cur')) return;
  fx.stack = fx.stack.slice(0, +s.dataset.depth); await loadEntries(); renderFiles();
});
// お気に入りフォルダを追加（選んだフォルダを登録して、そのまま中身を表示する）
$('#fAdd').addEventListener('click', async () => {
  if (!canKeepFolders) { $('#fDir').click(); return; } // 覚えられないブラウザでは、今だけ表示する
  let h;
  try { h = await window.showDirectoryPicker({ id: 'ytdj-video', mode: 'read' }); }
  catch (err) { if (err.name !== 'AbortError') toast('フォルダを開けませんでした', 3000); return; }
  const favs = await favList();
  let fav = null;
  for (const f of favs) { try { if (await f.handle.isSameEntry(h)) fav = f; } catch (e) { } }
  if (fav) toast('このフォルダは登録済みです');
  else {
    const id = await favTx('readwrite', st => st.add({ name: h.name, handle: h }));
    fav = { id, name: h.name, handle: h };
    toast(`「${h.name}」をお気に入りに追加しました`, 2500);
  }
  S.lastFav = fav.id; save();
  openFolderHandle(h, true);
});
function openFileList(files, hasRoot) {
  if (!files.length) return;
  fx.mode = 'list'; fx.files = files; fx.hasRoot = hasRoot; fx.stack = []; fx.root = null;
  fx.rootName = hasRoot ? (files[0].webkitRelativePath || '').split('/')[0] || '選んだフォルダ' : '選んだファイル';
  loadEntries().then(showFiles);
}
$('#fDir').addEventListener('change', e => { openFileList([...e.target.files], true); e.target.value = ''; });
$('#segF').addEventListener('click', async () => {
  setListMode('file'); await renderFavs(); renderFiles();
  // 前回開いていた登録フォルダの中身を、デッキA の下に表示しておく
  if (!fx.mode && S.lastFav != null) { const f = favCache.find(x => x.id === S.lastFav); if (f) openFav(f, false); }
});




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
    if (id && /youtu|^[\w-]{11}$/.test(q)) {
      $('#qIn').value = '';
      const A = deckOf('A');
      if (A.playing) { addHistory(id, ''); histSel = 0; setListMode('hist'); renderHist(); toast('デッキA が再生中なので履歴に入れました（A を押すと読み込みます）', 3000); }
      else { loadInto(A, { id, title: '' }); toast('デッキA に読み込みました', 2000); }
      return;
    }
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
  $('#qIn').placeholder = '検索ワード または URL'; // 長いと欄に収まらず切れるので短くする
}
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); $('#qIn').blur(); runSearch(); });

function loadInto(deck, item) {
  if (!item) return;
  addHistory(item.id, item.title || '');
  deck.load(item.id);
}
function browse(delta) {
  const dir = delta > 0 ? 1 : -1;
  if (listMode === 'file') {
    if (!fx.entries.length) return;
    fx.sel = Math.max(0, Math.min(fx.entries.length - 1, fx.sel + dir)); renderFiles();
    const e = fx.entries[fx.sel]; toast((e.dir ? '📁 ' : '🎞 ') + e.name, 1500);
    return;
  }
  if (listMode === 'chan') {
    if (!chan.sel) { if (!S.channels.length) return; chan.listSel = Math.max(0, Math.min(S.channels.length - 1, chan.listSel + dir)); const c = S.channels[chan.listSel]; toast(`チャンネル: ${c.name || c.id}（LOAD で開く）`, 1500); return; }
    const v = chan.vids[chan.sel] || []; if (!v.length) return;
    chan.itemSel = Math.max(0, Math.min(Math.min(v.length, chan.shown) - 1, chan.itemSel + dir));
    renderGrid();
    const id = v[chan.itemSel]; toast(`${chan.itemSel + 1}. ${titleCache[id] ? titleCache[id].title : id}`, 1500);
    return;
  }
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
  if (listMode === 'file') { // フォルダなら中へ、ファイルなら読み込む
    const e = fx.entries[fx.sel]; if (!e) return;
    if (!e.dir && deck.playing) { toast(`デッキ${deck.name} は再生中なので読み込みません（止めてから LOAD）`, 3000); return; }
    openEntry(fx.sel, deck.name); return;
  }
  if (listMode === 'chan') { // 一覧ではチャンネルを開き、動画一覧では読み込む
    if (!chan.sel) { const c = S.channels[chan.listSel]; if (c) openChannel(c); return; }
    const id = (chan.vids[chan.sel] || [])[chan.itemSel]; if (!id) return;
    if (deck.playing) { toast(`デッキ${deck.name} は再生中なので読み込みません（止めてから LOAD）`, 3000); return; }
    loadInto(deck, { id, title: titleCache[id] ? titleCache[id].title : '' }); return;
  }
  const item = listMode === 'srch' ? srch.items[srch.sel] : S.hist[histSel];
  if (!item) { toast(listMode === 'srch' ? '検索結果がありません' : '履歴が空です'); return; }
  if (deck.playing) { toast(`デッキ${deck.name} は再生中なので読み込みません（止めてから LOAD）`, 3000); return; }
  loadInto(deck, item);
}

/* ---------- URL 貼り付け・共有 ---------- */
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
async function checkClipboard() {
  if (!navigator.clipboard?.readText) return;
  let text;
  try { text = await navigator.clipboard.readText(); } catch (e) { return; }
  const id = parseYouTubeId(text);
  if (!id || !/youtu/.test(text)) return;
  if (id === S.lastClip) return; // 同じリンクは何度も聞かない
  S.lastClip = id; save();
  offerClip(id);
}
let clipCheckAt = 0;
function autoClip() {
  if (document.visibilityState !== 'visible') return;
  const t = Date.now(); if (t - clipCheckAt < 800) return; clipCheckAt = t;
  setTimeout(() => checkClipboard(), 300);
}
document.addEventListener('visibilitychange', autoClip);
window.addEventListener('focus', autoClip);
function handleShared(params) {
  const text = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
  const id = parseYouTubeId(text); if (!id) return false;
  let title = params.get('title') || '';
  if (/youtu/.test(title)) title = '';
  // デッキA に読み込む（再生中に曲が替わると困るので、そのときは履歴に入れるだけ）
  const A = deckOf('A');
  if (A.playing) {
    const old = S.hist.findIndex(h => h.id === id);
    if (old >= 0) { title = title || S.hist[old].title; S.hist.splice(old, 1); } // 既にあれば先頭へ移す
    addHistory(id, title); histSel = 0; setListMode('hist'); renderHist();
    toast('デッキA が再生中なので、共有された動画は履歴の先頭に入れました（A を押すと読み込みます）', 4000);
  } else {
    loadInto(A, { id, title });
    toast('共有された動画をデッキA に読み込みました', 2500);
  }
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
    if (act === 'jog') deck.jog(d * (shiftHeld ? S.settings.jogFastMul : 1));
    else if (act === 'jogFast') deck.jog(d * S.settings.jogFastMul);
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
  $('#appVer').textContent = `バージョン ${APP_VERSION}`;
  $('#optRange').value = String(S.settings.pitchRange);
  $('#optInvert').checked = S.settings.pitchInvert;
  $('#optJog').value = S.settings.jogSens;
  $('#optJogFast').value = String(S.settings.jogFastMul);
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
$('#optJogFast').addEventListener('change', e => { S.settings.jogFastMul = +e.target.value; save(); });
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
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
}
document.addEventListener('visibilitychange', keepAwake);
// 開始画面は使わず、起動と同時に MIDI 接続・画面スリープ防止を行う
initMidi(); keepAwake();
if (!Object.keys(S.map).length) setTimeout(() => toast('まず「⚙ 設定・割り当て」→「かんたん割り当て」でコントローラーを登録してください', 5000), 800);
// 自動再生が許可されず準備できなかった曲は、最初に画面を触った時に準備し直す
if (!hasTouched()) $('#tapHint').hidden = false;
document.addEventListener('pointerdown', e => {
  touchedOnce = true; $('#tapHint').hidden = true;
  keepAwake();
  if (!window.YT || e.target.closest('button')) return; // ボタンを押した場合はその操作を優先する
  for (const d of decks) {
    if (d.ready && d.videoId && !d.isFile && (d.priming || d.state === YT.PlayerState.UNSTARTED || d.state === YT.PlayerState.CUED)) d.load(d.videoId, d.priming ? d.primeAt : d.now(), true);
  }
}, { once: true, capture: true });
const BMODE_LABEL = { hide: 'B: 隠す', mini: 'B: 小', normal: 'B: 通常' };
function applyVideoSize() {
  // 隠すモードでも B が再生中なら小さく表示する（見えないまま鳴らさない）
  const m = S.settings.bMode === 'hide' && window.YT && deckOf('B').playing ? 'mini' : S.settings.bMode;
  document.body.classList.toggle('bhide', m === 'hide');
  document.body.classList.toggle('bmini', m === 'mini');
  $('#btnBMode').textContent = BMODE_LABEL[S.settings.bMode] || BMODE_LABEL.hide;
}
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

renderHist(); renderSrch(); updateSearchPlaceholder();
setListMode('chan'); renderChan();
decks.forEach(d => d.renderCc());
decks.forEach(d => d.setPitch(0));
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
