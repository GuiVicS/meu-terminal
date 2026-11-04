/**
 * dictation.js
 * Voice-to-text for the terminal using the browser's Web Speech API.
 * One utterance per tap; the final text is typed into the shell WITHOUT Enter,
 * so the user can review a command before running it.
 * With keepListening it hears until the next tap, however long the silence: the browser ends the
 * recognition by itself after a pause, so it is started again, and the text comes once at the end.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const STOP_GRACE_MS = 2500; // sem o "fim" do navegador, entrega o que já ouviu
const QUICK_END_MS = 1500;
const MAX_QUICK_ENDS = 4;
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network']);

export default class Dictation {
    static get supported() {
        return !!Recognition;
    }

    /**
     * @param {{ onInterim: (text: string) => void, onFinal: (text: string) => void,
     *   onStateChange: (listening: boolean) => void, onError: (message: string) => void,
     *   onConflict?: () => boolean }} handlers - onConflict: o reconhecimento não conseguiu ouvir; true se soltou o que disputava o microfone
     * @param {{ keepListening?: boolean }} [options]
     */
    constructor(handlers, { keepListening = false } = {}) {
        this.handlers = handlers;
        this.keepListening = keepListening;
        this.listening = false;
        this.recognition = null;
    }

    toggle() {
        if (this.listening) this.stop();
        else this.start();
    }

    start() {
        if (!Recognition || this.listening) return;
        this.wanted = true;
        this.collected = '';
        this.quickEnds = 0;
        if (this.begin()) this.setListening(true);
        else this.wanted = false;
    }

    begin() {
        const rec = new Recognition();
        rec.lang = document.documentElement.lang || navigator.language || 'pt-BR';
        rec.interimResults = true;
        // continuous mode duplicates results on Android Chrome; there, each phrase is a new start
        rec.continuous = this.keepListening && !/Android/i.test(navigator.userAgent);
        rec.maxAlternatives = 1;

        const startedAt = Date.now();
        let finalText = '';
        let lastInterim = '';
        let fatal = false;
        rec.onresult = event => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) finalText += result[0].transcript;
                else interim += result[0].transcript;
            }
            lastInterim = interim;
            this.heardSoFar = finalText + interim;
            this.handlers.onInterim(this.joined(finalText + interim));
        };
        rec.onerror = event => {
            const messages = {
                'not-allowed': 'Permita o acesso ao microfone para transcrever.',
                'service-not-allowed': 'Transcrição indisponível neste navegador.',
                'network': 'Transcrição precisa de conexão com a internet.',
                'audio-capture': 'Nenhum microfone encontrado.',
            };
            if (this.keepListening && event.error === 'audio-capture' && this.handlers.onConflict?.()) return;
            // "no-speech" / "aborted" are normal endings, not errors worth showing
            if (messages[event.error]) this.handlers.onError(messages[event.error]);
            if (FATAL.has(event.error)) fatal = true;
        };
        rec.onend = () => {
            if (rec !== this.recognition) return; // já entregue pela espera do stop()
            // O Safari às vezes encerra sem marcar o último trecho como final: ele não se perde
            const heard = finalText + (this.keepListening ? lastInterim : '');
            this.collected = this.joined(heard);
            this.heardSoFar = '';
            this.recognition = null;
            if (this.keepListening && this.wanted && !fatal && this.restart(Date.now() - startedAt, !!heard)) return;
            this.finish();
        };

        try {
            rec.start();
            this.recognition = rec;
            return true;
        } catch (e) {
            console.warn('Speech recognition failed to start:', e);
            this.handlers.onError('Não foi possível iniciar a transcrição.');
            return false;
        }
    }

    joined(text) {
        return [this.collected, text.trim()].filter(Boolean).join(' ');
    }

    /** O navegador parou sozinho: volta a ouvir. Só desiste se ele não conseguir ouvir nada. */
    restart(duration, heard) {
        if (heard || duration >= QUICK_END_MS) this.quickEnds = 0;
        else {
            this.quickEnds++;
            this.handlers.onConflict?.();
            if (this.quickEnds > MAX_QUICK_ENDS) {
                this.handlers.onError('Não foi possível continuar ouvindo.');
                return false;
            }
        }
        return this.begin();
    }

    stop() {
        this.wanted = false;
        if (!this.recognition) return;
        // stop() (not abort) still delivers what was already recognized
        this.recognition.stop();
        if (!this.keepListening) return;
        clearTimeout(this.stopTimer);
        const rec = this.recognition;
        this.stopTimer = setTimeout(() => {
            if (rec !== this.recognition) return;
            this.recognition = null;
            this.collected = this.joined(this.heardSoFar || ''); // o que já tinha ouvido não se perde
            this.heardSoFar = '';
            this.finish();
        }, STOP_GRACE_MS);
    }

    finish() {
        clearTimeout(this.stopTimer);
        this.wanted = false;
        const text = this.collected.replace(/\s*\n\s*/g, ' ').trim();
        this.collected = '';
        if (text) this.handlers.onFinal(text);
        this.setListening(false);
    }

    setListening(on) {
        this.listening = on;
        this.handlers.onStateChange(on);
    }
}
