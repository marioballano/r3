// Procedural cyberpunk ambience: everything synthesised with Web Audio, no samples.
// The score is seeded from the binary's hash so every binary sounds different.
import { mulberry32, seedFrom } from '../shaders/common';

const SCALES: Record<string, number[]> = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
};
const PROGRESSIONS = [
  [0, 5, 2, 6],
  [0, 3, 5, 4],
  [0, 6, 5, 6],
  [0, 5, 3, 4],
  [0, 2, 5, 1],
];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export type Mood = 'idle' | 'loading' | 'city' | 'function';

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private delaySend!: GainNode;
  private padFilter!: BiquadFilterNode;
  private padBus!: GainNode;
  private bassGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private rainFilter!: BiquadFilterNode;
  private rainGain!: GainNode;
  private timer: number | null = null;
  private nextStep = 0;
  private step = 0;
  private rnd = mulberry32(1);
  private root = 45;
  private scale = SCALES.aeolian;
  private prog = PROGRESSIONS[0];
  private bpm = 88;
  private padVoices: { stop: (t: number) => void }[] = [];
  mood: Mood = 'idle';
  private energy = 0.3; // 0..1 drives rhythm density
  private brightness = 0.5; // filter
  muted = false;
  volume = 0.8;
  analyser: AnalyserNode | null = null;

  /** Must be called from a user gesture. */
  async start() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 3);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.master.connect(comp).connect(this.analyser).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.75;
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.55;
    this.sfxBus.connect(this.master);

    // reverb: generated stereo impulse response (long, dark, shimmering)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(5.5, 2.6);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    this.reverb.connect(revOut).connect(this.master);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.reverb);

    // ping-pong delay
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    const fb = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    fb.gain.value = 0.42;
    const merger = ctx.createChannelMerger(2);
    this.delaySend = ctx.createGain();
    this.delaySend.connect(dl);
    dl.connect(lp).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    merger.connect(this.master);
    merger.connect(this.reverbSend);
    const beat = 60 / this.bpm;
    dl.delayTime.value = beat * 0.75;
    dr.delayTime.value = beat * 0.75;
    (this as any)._delays = [dl, dr];

    // noise buffer
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // pad bus
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 6;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoGain.gain.value = 500;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.16;
    this.padBus.connect(this.padFilter);
    this.padFilter.connect(this.musicBus);
    this.padFilter.connect(this.reverbSend);

    // bass bus (side-chain pumped)
    this.bassGain = ctx.createGain();
    this.bassGain.gain.value = 0.0;
    const bassLp = ctx.createBiquadFilter();
    bassLp.type = 'lowpass';
    bassLp.frequency.value = 220;
    this.bassGain.connect(bassLp).connect(this.musicBus);

    // city rain: filtered noise bed
    const rain = ctx.createBufferSource();
    rain.buffer = this.noiseBuf;
    rain.loop = true;
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 2600;
    this.rainFilter.Q.value = 0.6;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.035;
    rain.connect(this.rainFilter).connect(this.rainGain).connect(this.musicBus);
    this.rainGain.connect(this.reverbSend);
    rain.start();
    const rlfo = ctx.createOscillator();
    const rlfoG = ctx.createGain();
    rlfo.frequency.value = 0.03;
    rlfoG.gain.value = 1400;
    rlfo.connect(rlfoG).connect(this.rainFilter.frequency);
    rlfo.start();

    this.seed('r3::idle');
    this.nextStep = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        lp = lp + (n - lp) * (0.25 + 0.6 * (1 - t)); // darker tail
        d[i] = lp * Math.pow(1 - t, decay) * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }

  /** Re-seed the generative score (e.g. from the binary's sha256). */
  seed(s: string) {
    this.rnd = mulberry32(seedFrom(s));
    const keys = Object.keys(SCALES);
    this.scale = SCALES[keys[Math.floor(this.rnd() * keys.length)]];
    this.prog = PROGRESSIONS[Math.floor(this.rnd() * PROGRESSIONS.length)];
    this.root = 40 + Math.floor(this.rnd() * 9); // E2..C3
    this.bpm = 82 + Math.floor(this.rnd() * 18);
    const ds = (this as any)._delays as DelayNode[] | undefined;
    if (ds && this.ctx) for (const d of ds) d.delayTime.setTargetAtTime((60 / this.bpm) * 0.75, this.ctx.currentTime, 0.5);
    this.step = 0;
  }

  setMood(m: Mood) {
    this.mood = m;
    const e = { idle: 0.15, loading: 0.45, city: 0.6, function: 0.85 }[m];
    this.energy = e;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.bassGain.gain.setTargetAtTime(m === 'idle' ? 0 : 0.22, t, 1.5);
    this.rainGain.gain.setTargetAtTime(m === 'function' ? 0.012 : 0.035, t, 2);
  }

  /** 0..1, e.g. entropy around current seek. */
  setBrightness(b: number) {
    this.brightness = b;
    if (!this.ctx) return;
    this.padFilter.frequency.setTargetAtTime(400 + b * 1800 * (this.mood === 'function' ? 0.6 : 1), this.ctx.currentTime, 1.2);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.3);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.2);
  }

  // ------------------------------------------------------------------ score
  private degree(d: number, octave = 0): number {
    const n = this.scale.length;
    const o = Math.floor(d / n);
    const i = ((d % n) + n) % n;
    return this.root + this.scale[i] + 12 * (o + octave);
  }

  private schedule() {
    const ctx = this.ctx!;
    const stepDur = 60 / this.bpm / 4; // 16ths
    while (this.nextStep < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextStep, stepDur);
      this.step++;
      this.nextStep += stepDur * (this.step % 2 === 1 ? 1.04 : 0.96); // slight swing
    }
  }

  private playStep(step: number, t: number, sd: number) {
    const bar = Math.floor(step / 16);
    const s16 = step % 16;
    const chordIdx = this.prog[Math.floor(bar / 2) % this.prog.length];
    const e = this.energy;
    // chord change every 2 bars
    if (s16 === 0 && bar % 2 === 0) this.padChord(chordIdx, t, sd * 32);
    // bass
    if (this.mood !== 'idle') {
      if (s16 % 4 === 0 || (e > 0.7 && s16 % 4 === 3 && this.rnd() < 0.4)) {
        this.bass(this.degree(chordIdx, -1), t, sd * (s16 % 4 === 0 ? 3 : 1));
      }
      // kick + pump
      if (s16 % 8 === 0 && e > 0.45) this.kick(t, 0.55 * e);
      if (e > 0.8 && s16 === 10 && this.rnd() < 0.5) this.kick(t, 0.3);
      // hats
      if (s16 % 4 === 2 && this.rnd() < e) this.hat(t, 0.05 + e * 0.05, 0.05);
      if (e > 0.75 && s16 % 2 === 1 && this.rnd() < 0.35) this.hat(t, 0.025, 0.025);
      // snare-ish clap on 2 and 4 in function mode
      if (e > 0.8 && s16 % 16 === 12) this.clap(t);
    }
    // arpeggio
    const density = 0.12 + e * 0.5;
    if (s16 % 2 === 0 && this.rnd() < density) {
      const chord = [0, 2, 4, 6].map((k) => chordIdx + k);
      const n = chord[Math.floor(this.rnd() * chord.length)] + (this.rnd() < 0.3 ? 7 : 0);
      this.pluck(this.degree(n, 1 + (this.rnd() < 0.25 ? 1 : 0)), t, 0.06 + this.rnd() * 0.05);
    }
    // sparse data chirps
    if (this.rnd() < 0.006 + e * 0.01) this.chirp(t);
  }

  private padChord(deg: number, t: number, dur: number) {
    const ctx = this.ctx!;
    for (const v of this.padVoices) v.stop(t + 1.5);
    this.padVoices = [];
    const notes = [this.degree(deg, 0), this.degree(deg + 2, 0), this.degree(deg + 4, 0), this.degree(deg + 6, 1)];
    if (this.rnd() < 0.5) notes.push(this.degree(deg + 1, 1)); // add9 colour
    for (const m of notes) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 2.5);
      g.connect(this.padBus);
      const oscs: OscillatorNode[] = [];
      for (const det of [-9, 0, 8]) {
        const o = ctx.createOscillator();
        o.type = det === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det + (this.rnd() - 0.5) * 4;
        const og = ctx.createGain();
        og.gain.value = det === 0 ? 0.7 : 0.35;
        o.connect(og).connect(g);
        o.start(t);
        o.stop(t + dur + 5);
        oscs.push(o);
      }
      this.padVoices.push({
        stop: (at: number) => {
          g.gain.cancelScheduledValues(at - 1.5);
          g.gain.setTargetAtTime(0, at - 1.5, 1.0);
          for (const o of oscs) {
            try {
              o.stop(at + 4);
            } catch {
              /* already scheduled */
            }
          }
        },
      });
    }
  }

  private bass(m: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = mtof(m);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = mtof(m);
    const g2 = ctx.createGain();
    g2.gain.value = 0.15;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.02);
    g.gain.setTargetAtTime(0, t + dur * 0.8, 0.08);
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(this.bassGain);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.6);
    o2.stop(t + dur + 0.6);
  }

  private kick(t: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + 0.55);
    // side-chain pump on pads
    this.padBus.gain.setValueAtTime(0.06, t);
    this.padBus.gain.setTargetAtTime(0.16, t + 0.02, 0.12);
  }

  private hat(t: number, v: number, len: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000 + this.rnd() * 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (this.rnd() - 0.5) * 0.8;
    s.connect(f).connect(g).connect(pan).connect(this.musicBus);
    s.start(t, this.rnd() * 1.5, len + 0.02);
  }

  private clap(t: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1500;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    s.connect(f).connect(g);
    g.connect(this.musicBus);
    g.connect(this.reverbSend);
    s.start(t, this.rnd(), 0.3);
  }

  private pluck(m: number, t: number, v: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = this.rnd() < 0.5 ? 'square' : 'sawtooth';
    o.frequency.value = mtof(m);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 8;
    f.frequency.setValueAtTime(600 + this.brightness * 4000, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (this.rnd() - 0.5) * 1.2;
    o.connect(f).connect(g).connect(pan);
    pan.connect(this.musicBus);
    pan.connect(this.delaySend);
    pan.connect(this.reverbSend);
    o.start(t);
    o.stop(t + 0.6);
  }

  private chirp(t: number) {
    const ctx = this.ctx!;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    const base = 1200 + this.rnd() * 2400;
    car.frequency.value = base;
    mod.frequency.value = base * (1.5 + Math.floor(this.rnd() * 3));
    mg.gain.value = base * 0.8;
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    const n = 2 + Math.floor(this.rnd() * 5);
    for (let i = 0; i < n; i++) {
      g.gain.setValueAtTime(0.018, t + i * 0.045);
      g.gain.setValueAtTime(0, t + i * 0.045 + 0.025);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rnd() * 2 - 1;
    car.connect(g).connect(pan);
    pan.connect(this.reverbSend);
    pan.connect(this.delaySend);
    car.start(t);
    mod.start(t);
    car.stop(t + n * 0.05 + 0.1);
    mod.stop(t + n * 0.05 + 0.1);
  }

  // ------------------------------------------------------------------ sfx
  private now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  key() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 3000 + Math.random() * 2500;
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t, Math.random(), 0.04);
  }

  blip(freq = 880, len = 0.08, type: OscillatorType = 'square', v = 0.06) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    o.connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbSend);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  confirm() {
    this.blip(660, 0.06, 'square', 0.05);
    setTimeout(() => this.blip(990, 0.09, 'triangle', 0.06), 60);
  }

  error() {
    this.glitchBurst(0.25);
    this.blip(140, 0.25, 'sawtooth', 0.08);
  }

  hover() {
    this.blip(1800 + Math.random() * 400, 0.03, 'sine', 0.025);
  }

  whoosh(dur = 1.4, up = true) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(up ? 200 : 5000, t);
    f.frequency.exponentialRampToValueAtTime(up ? 6000 : 150, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbSend);
    s.start(t);
    s.stop(t + dur + 0.1);
    // riser
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(up ? 80 : 900, t);
    o.frequency.exponentialRampToValueAtTime(up ? 900 : 60, t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.05, t + dur * 0.8);
    og.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(og).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  impact() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    o.connect(g);
    g.connect(this.sfxBus);
    g.connect(this.reverbSend);
    o.start(t);
    o.stop(t + 2);
    this.glitchBurst(0.15);
  }

  glitchBurst(len = 0.2) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    const n = 6 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 80 + Math.random() * 3000;
      const g = ctx.createGain();
      const st = t + (i / n) * len;
      g.gain.setValueAtTime(0.03, st);
      g.gain.setValueAtTime(0, st + len / n);
      o.connect(g).connect(this.sfxBus);
      o.start(st);
      o.stop(st + len / n + 0.01);
    }
  }

  /** Boot swell: a big chord bloom. */
  boot() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    for (const m of [33, 40, 45, 52, 57, 64, 67]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = (Math.random() - 0.5) * 14;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(200, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + 2.5);
      f.frequency.exponentialRampToValueAtTime(400, t + 6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 2.2);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 7);
      o.connect(f).connect(g);
      g.connect(this.sfxBus);
      g.connect(this.reverbSend);
      o.start(t);
      o.stop(t + 7.2);
    }
    this.whoosh(2.2, true);
    setTimeout(() => this.impact(), 2100);
  }

  /** 0..1 loudness for visuals. */
  level(): number {
    if (!this.analyser) return 0;
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    let s = 0;
    for (let i = 0; i < 24; i++) s += d[i];
    return s / (24 * 255);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.ctx?.close();
    this.ctx = null;
  }
}

export const audio = new Audio();
