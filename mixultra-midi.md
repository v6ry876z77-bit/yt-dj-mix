# Hercules DJControl Mix Ultra の MIDI 信号（2026-11-08 実機で採取）

USB: VID 06F8 / PID B131。標準の USB MIDI（クラスコンプライアント）。チャンネルは 0 始まりで表記（MIDI チャンネル番号 = 表記 + 1）。

| 操作子 | 左デッキ (A) | 右デッキ (B) |
|---|---|---|
| PLAY | Note ch1 #7 | Note ch2 #7 |
| CUE | Note ch1 #6 | Note ch2 #6 |
| SYNC | Note ch1 #5（トグル気味の挙動） | （未採取） |
| SHIFT | Note ch1 #4 | Note ch2 #4 |
| LOAD | Note ch1 #13 | Note ch2 #13 |
| パッドモード HOT CUE / LOOP / FX / NEURAL MIX | Note ch1 #15 / #16 / #17 / #18 | （同様と推定） |
| パッド1〜8（HOT CUE モード） | Note ch6 #0〜7 | Note ch7 #0〜7 |
| SHIFT＋パッド1〜8（HOT CUE モード） | Note ch6 #8〜15 | Note ch7 #8〜15 |
| パッド1〜8（LOOP モード） | Note ch6 #16〜23 | （同様と推定） |
| 音量フェーダー | CC ch1 #0（14bit: LSB #32） | CC ch2 #0（LSB #32） |
| テンポフェーダー | CC ch1 #8（LSB #40）、奥（上）＝127 | CC ch2 #8（LSB #40） |
| ジョグ天面 タッチ | Note ch1 #8 | Note ch2 #8 |
| ジョグ天面 回転 | CC ch1 #10（右=1, 左=127） | CC ch2 #10 |
| ジョグ側面 回転 | CC ch1 #9 | （未採取） |
| SHIFT＋ジョグ天面 | タッチ Note ch4 #8、回転 CC ch4 #10 | タッチ Note ch5 #8、回転 CC ch5 #10 |

| 中央 | 信号 |
|---|---|
| クロスフェーダー | CC ch0 #0（LSB #32） |
| ブラウズつまみ 回転 | CC ch0 #1（右=1, 左=127） |
| ブラウズつまみ 押し込み | Note ch0 #0 |

未採取: EQ（HIGH/MID/LOW）、FILTER、MASTER VOL、ヘッドホン CUE、FX/NEURAL MIX などのパッドモードのパッド。YouTube の音は加工できないため、アプリでは使っていない。
