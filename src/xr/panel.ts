import * as THREE from 'three';

/**
 * A small HUD-styled text card for the headset (where the DOM HUD can't be seen).
 * Line prefixes pick the style: `~` header, `#` name, `@` address, `!` hint; anything else is body text.
 */
export class TextPanel {
  mesh: THREE.Mesh;
  /** height / width */
  readonly aspect: number;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;

  constructor(
    private w: number,
    private h: number,
    metres: number,
  ) {
    this.aspect = h / w;
    this.canvas.width = w;
    this.canvas.height = h;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(metres, metres * this.aspect), mat);
    this.mesh.renderOrder = 1600;
    this.mesh.frustumCulled = false;
  }

  draw(lines: string[]) {
    const { g, w, h } = this;
    const pad = Math.round(w * 0.045);
    g.clearRect(0, 0, w, h);
    // glass + frame + corner brackets, like the DOM panels
    g.fillStyle = 'rgba(10, 4, 26, 0.82)';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0, 240, 255, 0.45)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
    g.strokeStyle = '#ff2bd6';
    g.lineWidth = 4;
    const c = Math.round(w * 0.05);
    for (const [x, y, dx, dy] of [
      [2, 2, 1, 1],
      [w - 2, 2, -1, 1],
      [2, h - 2, 1, -1],
      [w - 2, h - 2, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x, y + dy * c);
      g.lineTo(x, y);
      g.lineTo(x + dx * c, y);
      g.stroke();
    }
    const base = w / 26;
    const styles: Record<string, { font: string; color: string; glow: string; size: number }> = {
      '~': { font: '700 {s}px Orbitron, sans-serif', color: '#00f0ff', glow: 'rgba(0,240,255,0.8)', size: base * 0.85 },
      '#': { font: '600 {s}px "JetBrains Mono", monospace', color: '#ffffff', glow: 'rgba(255,43,214,0.9)', size: base * 1.05 },
      '@': { font: '500 {s}px "JetBrains Mono", monospace', color: '#fff200', glow: 'rgba(255,242,0,0.6)', size: base * 0.95 },
      '!': { font: '500 {s}px "JetBrains Mono", monospace', color: '#8f7fc4', glow: 'transparent', size: base * 0.78 },
      '': { font: '500 {s}px "JetBrains Mono", monospace', color: '#dff8ff', glow: 'rgba(0,240,255,0.35)', size: base * 0.85 },
    };
    g.textBaseline = 'top';
    let y = pad;
    for (const raw of lines) {
      const st = styles[raw[0]] ?? styles[''];
      const text = styles[raw[0]] ? raw.slice(1) : raw;
      g.font = st.font.replace('{s}', String(Math.round(st.size)));
      g.fillStyle = st.color;
      g.shadowColor = st.glow;
      g.shadowBlur = 8;
      if (text) g.fillText(text, pad, y, w - pad * 2);
      y += st.size * 1.45;
      if (y > h - pad) break;
    }
    g.shadowBlur = 0;
    this.tex.needsUpdate = true;
  }
}
