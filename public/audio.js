// Window Seat sound: generative lofi music and the sounds of the ride, all synthesised with the
// Web Audio API — no recordings, so nothing to license and nothing to download.
//
//   WSAudio.music(on)        lofi: jazzy seventh chords, soft bass, swung drums, vinyl crackle
//   WSAudio.ambience(on)     the train (rumble and rail joints) plus rain, wind and thunder
//   WSAudio.update({...})    speed, rain, snow, wind, tunnel — called a few times a second
//   WSAudio.thunder(near)    a rumble, sharper when the strike is close
"use strict";
window.WSAudio = (() => {
  let ctx = null, master, musicBus, ambBus, noiseBuf, crackleBuf;
  let musicOn = false, ambOn = false, timer = null, step = 0, nextTime = 0;
  const state = { speed: 0, rain: 0, snow: 0, wind: 0, tunnel: false };
  let rumble, rumbleGain, rainGain, rainFilter, windGain, nextClack = 0;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3; comp.connect(ctx.destination);
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(comp);
    musicBus = ctx.createGain(); musicBus.gain.value = 0; const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 2600; musicBus.connect(tone); tone.connect(master);
    ambBus = ctx.createGain(); ambBus.gain.value = 0; ambBus.connect(master);
    // noise buffers
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    crackleBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate); { const d = crackleBuf.getChannelData(0); let b = 0; for (let i = 0; i < d.length; i++) { b = b * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = b * 0.5 + (Math.random() < 0.0004 ? (Math.random() * 2 - 1) * 0.9 : 0); } }
    // vinyl crackle bed for the music
    const cr = ctx.createBufferSource(); cr.buffer = crackleBuf; cr.loop = true; const crg = ctx.createGain(); crg.gain.value = 0.16; cr.connect(crg); crg.connect(musicBus); cr.start();
    // train rumble: low, filtered noise that rises with speed
    rumble = ctx.createBufferSource(); rumble.buffer = noiseBuf; rumble.loop = true; const rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.frequency.value = 140; rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0; rumble.connect(rlp); rlp.connect(rumbleGain); rumbleGain.connect(ambBus); rumble.start();
    // rain on the roof and windows
    const rn = ctx.createBufferSource(); rn.buffer = noiseBuf; rn.loop = true; rn.playbackRate.value = 0.9; rainFilter = ctx.createBiquadFilter(); rainFilter.type = "bandpass"; rainFilter.frequency.value = 2400; rainFilter.Q.value = 0.4; rainGain = ctx.createGain(); rainGain.gain.value = 0; rn.connect(rainFilter); rainFilter.connect(rainGain); rainGain.connect(ambBus); rn.start();
    // wind
    const wn = ctx.createBufferSource(); wn.buffer = noiseBuf; wn.loop = true; wn.playbackRate.value = 0.5; const wf = ctx.createBiquadFilter(); wf.type = "lowpass"; wf.frequency.value = 500; windGain = ctx.createGain(); windGain.gain.value = 0; wn.connect(wf); wf.connect(windGain); windGain.connect(ambBus); wn.start();
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13; const lg = ctx.createGain(); lg.gain.value = 260; lfo.connect(lg); lg.connect(wf.frequency); lfo.start();
    timer = setInterval(tick, 25);
  }

  /* ---------- lofi ---------- */
  const BPM = 76, SIXTEENTH = 60 / BPM / 4;
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  // ii–V–I–vi in F, voiced softly: Gm9, C13, Fmaj9, Dm9
  const CHORDS = [[55, 58, 62, 65, 69], [52, 58, 62, 64, 69], [53, 57, 60, 64, 67], [50, 53, 57, 60, 64]];
  const BASS = [43, 36, 41, 38];
  const SCALE = [65, 67, 69, 72, 74, 77, 79, 81]; // F major pentatonic-ish, upper register
  function env(g, t, a, peak, d, sustain, r, len) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d); g.gain.setValueAtTime(Math.max(0.0001, sustain), t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + r);
  }
  function keys(notes, t, len) {
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1500; lp.connect(musicBus);
    notes.forEach((n, i) => {
      for (const [type, det, vol] of [["sine", 0, 0.05], ["triangle", 7, 0.022]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = midi(n); o.detune.value = det + (Math.random() - 0.5) * 6;
        const g = ctx.createGain(); env(g, t + i * 0.012, 0.015, vol, 0.9, vol * 0.35, 0.8, len); o.connect(g); g.connect(lp); o.start(t); o.stop(t + len + 1);
        wobble(o, t, len + 1);
      }
    });
  }
  function wobble(o, t, len) { const l = ctx.createOscillator(); l.frequency.value = 0.6; const lg = ctx.createGain(); lg.gain.value = 6; l.connect(lg); lg.connect(o.detune); l.start(t); l.stop(t + len); } // tape wow
  function bass(n, t, len) { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = midi(n); const g = ctx.createGain(); env(g, t, 0.01, 0.16, 0.25, 0.07, 0.2, len); o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + len + 0.4); }
  function kick(t, v = 1) { const o = ctx.createOscillator(); o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14); const g = ctx.createGain(); g.gain.setValueAtTime(0.32 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32); o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.35); }
  function noiseHit(t, type, f, q, vol, dur) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.connect(fl); fl.connect(g); g.connect(musicBus); s.start(t, Math.random()); s.stop(t + dur + 0.02); }
  function snare(t) { noiseHit(t, "bandpass", 1900, 0.8, 0.11, 0.18); const o = ctx.createOscillator(); o.frequency.value = 185; const g = ctx.createGain(); g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09); o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.1); }
  function hat(t, v) { noiseHit(t, "highpass", 7500, 0.6, 0.028 * v, 0.045); }
  const delay = () => { const d = ctx.createDelay(); d.delayTime.value = SIXTEENTH * 3; const fb = ctx.createGain(); fb.gain.value = 0.35; const lp = ctx.createBiquadFilter(); lp.frequency.value = 1800; d.connect(fb); fb.connect(lp); lp.connect(d); d.connect(musicBus); return d; };
  let echo = null;
  function lead(n, t) { if (!echo) echo = delay(); const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = midi(n); const g = ctx.createGain(); env(g, t, 0.02, 0.035, 0.3, 0.012, 0.5, 0.35); o.connect(g); g.connect(musicBus); g.connect(echo); o.start(t); o.stop(t + 1.2); }

  function schedule(t) {
    const s16 = step % 16, bar = Math.floor(step / 16) % 8, chord = Math.floor(bar / 2) % 4;
    const swing = s16 % 2 ? SIXTEENTH * 0.18 : 0; const tt = t + swing;
    if (s16 === 0 && bar % 2 === 0) { keys(CHORDS[chord], tt, SIXTEENTH * 30); bass(BASS[chord], tt, SIXTEENTH * 6); }
    if (s16 === 10 && bar % 2 === 1) bass(BASS[chord] + 7, tt, SIXTEENTH * 4);
    if (s16 === 0 || s16 === 10 || (s16 === 7 && Math.random() < 0.3)) kick(tt, s16 === 7 ? 0.6 : 1);
    if (s16 === 4 || s16 === 12) snare(tt);
    if (s16 % 2 === 0) hat(tt, s16 % 4 === 0 ? 1 : 0.6 + Math.random() * 0.3);
    if (s16 % 4 === 2 && Math.random() < 0.22) lead(SCALE[Math.floor(Math.random() * SCALE.length)], tt);
  }

  /* ---------- the ride ---------- */
  function clack(t) { // a wheelset crossing a rail joint: two quick knocks
    for (const [dt, f] of [[0, 900], [0.11, 700]]) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = 2.5; const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t + dt); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.07); s.connect(bp); bp.connect(g); g.connect(ambBus); s.start(t + dt, Math.random()); s.stop(t + dt + 0.1); }
  }

  function tick() {
    const now = ctx.currentTime;
    if (musicOn) { if (nextTime < now) nextTime = now + 0.05; while (nextTime < now + 0.12) { schedule(nextTime); nextTime += SIXTEENTH; step++; } }
    if (ambOn) {
      const v = Math.min(1, state.speed / 80);
      rumbleGain.gain.setTargetAtTime((0.05 + 0.35 * v) * (state.tunnel ? 1.8 : 1), now, 0.4);
      rainGain.gain.setTargetAtTime(state.tunnel ? 0 : state.rain * 0.22 + state.snow * 0.03, now, 0.6);
      rainFilter.frequency.setTargetAtTime(state.snow > state.rain ? 900 : 2400, now, 1);
      windGain.gain.setTargetAtTime(state.tunnel ? 0.02 : Math.min(0.25, state.wind / 160 + v * 0.05), now, 1);
      if (state.speed > 4 && now > nextClack) { clack(now + 0.02); nextClack = now + Math.max(0.35, 18 / (state.speed / 3.6)); } // 18 m rails
    }
  }

  return {
    get musicOn() { return musicOn; }, get ambienceOn() { return ambOn; },
    music(on) { init(); ctx.resume(); musicOn = on; musicBus.gain.setTargetAtTime(on ? 0.85 : 0, ctx.currentTime, 0.5); if (on) { nextTime = ctx.currentTime + 0.1; step = 0; } },
    ambience(on) { init(); ctx.resume(); ambOn = on; ambBus.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.5); },
    update(s) { Object.assign(state, s); },
    chime() { // the door chime as the train arrives and leaves a station
      if (!ctx || !ambOn) return; const t = ctx.currentTime + 0.05;
      [[659.3, 0], [523.3, 0.42]].forEach(([f, dt]) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.16, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 1.3); o.connect(g); g.connect(ambBus); o.start(t + dt); o.stop(t + dt + 1.4); });
    },
    whoosh() { // another train flashing past the window
      if (!ctx || !ambOn) return; const t = ctx.currentTime + 0.02; const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 1.2); bp.frequency.exponentialRampToValueAtTime(250, t + 3.5);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 1.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8); s.connect(bp); bp.connect(g); g.connect(ambBus); s.start(t); s.stop(t + 4);
    },
    thunder(near) {
      if (!ctx || !ambOn) return; const t = ctx.currentTime + 0.05;
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.35; const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(near ? 1600 : 500, t); lp.frequency.exponentialRampToValueAtTime(70, t + 4);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(near ? 0.9 : 0.5, t + (near ? 0.03 : 0.5)); g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
      s.connect(lp); lp.connect(g); g.connect(ambBus); s.start(t); s.stop(t + 6);
    }
  };
})();
