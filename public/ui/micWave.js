/**
 * micWave.js
 * As ondas sonoras enquanto o ditado escuta: barras que entram pela direita, na altura da voz.
 * O nível vem do microfone. Se o aparelho não deixar captar junto com o ditado (dropMic), as barras
 * seguem por uma animação suave, com um impulso a cada trecho reconhecido (pulse).
 */
const BAR = 3;
const GAP = 3;
const STEP_MS = 70;

export default class MicWave {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.canvas = canvas;
        this.levels = [];
        this.running = false;
        this.stream = null;
        this.audio = null;
        this.analyser = null;
        this.boost = 0;
        this.token = 0;
    }

    get usingMic() {
        return !!this.stream;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.levels = [];
        this.last = 0;
        this.resize();
        this.connect();
        this.frame = requestAnimationFrame(t => this.draw(t));
    }

    async connect() {
        const token = ++this.token;
        if (!navigator.mediaDevices?.getUserMedia) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (token !== this.token || !this.running) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }
            const Context = window.AudioContext || window.webkitAudioContext;
            const audio = new Context();
            await audio.resume().catch(() => {});
            const analyser = audio.createAnalyser();
            analyser.fftSize = 512;
            audio.createMediaStreamSource(stream).connect(analyser);
            this.stream = stream;
            this.audio = audio;
            this.analyser = analyser;
            this.samples = new Uint8Array(analyser.fftSize);
        } catch {
            this.release(); // sem captura, as barras continuam pela animação
        }
    }

    /** Solta o microfone e segue só com a animação. */
    dropMic() {
        this.token++;
        this.release();
    }

    /** O ditado reconheceu algo: dá um impulso quando não há nível real. */
    pulse() {
        this.boost = 1;
    }

    stop() {
        this.running = false;
        this.token++;
        cancelAnimationFrame(this.frame);
        this.release();
    }

    release() {
        this.stream?.getTracks().forEach(t => t.stop());
        this.audio?.close().catch(() => {});
        this.stream = null;
        this.audio = null;
        this.analyser = null;
    }

    resize() {
        const box = this.canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        this.width = box.width;
        this.height = box.height;
        this.canvas.width = Math.round(box.width * ratio);
        this.canvas.height = Math.round(box.height * ratio);
        this.canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    level(time) {
        if (this.analyser) {
            this.analyser.getByteTimeDomainData(this.samples);
            let sum = 0;
            for (const s of this.samples) sum += ((s - 128) / 128) ** 2;
            return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
        }
        this.boost *= 0.86;
        const calm = 0.1 + 0.07 * Math.abs(Math.sin(time / 310)) + 0.05 * Math.abs(Math.sin(time / 127));
        return Math.min(1, calm + this.boost * (0.35 + 0.35 * Math.abs(Math.sin(time / 53))));
    }

    draw(time) {
        if (!this.running) return;
        if (time - this.last >= STEP_MS) {
            this.last = time;
            if (!this.width) this.resize(); // a barra pode ter aparecido depois de começar
            this.levels.push(this.level(time));
            const fit = Math.ceil(this.width / (BAR + GAP));
            if (this.levels.length > fit) this.levels.splice(0, this.levels.length - fit);
            this.paint();
        }
        this.frame = requestAnimationFrame(t => this.draw(t));
    }

    paint() {
        const g = this.canvas.getContext('2d');
        g.clearRect(0, 0, this.width, this.height);
        g.fillStyle = getComputedStyle(this.canvas).color;
        const middle = this.height / 2;
        const tallest = Math.max(this.height - 8, 8);
        this.levels.forEach((level, i) => {
            const x = this.width - (this.levels.length - i) * (BAR + GAP);
            const h = Math.max(3, level * tallest);
            g.beginPath();
            g.roundRect(x, middle - h / 2, BAR, h, BAR / 2);
            g.fill();
        });
    }
}
