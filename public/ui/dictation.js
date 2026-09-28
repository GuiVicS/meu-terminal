/**
 * dictation.js
 * Voice-to-text for the terminal using the browser's Web Speech API.
 * One utterance per tap; the final text is typed into the shell WITHOUT Enter,
 * so the user can review a command before running it.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export default class Dictation {
    static get supported() {
        return !!Recognition;
    }

    /**
     * @param {{ onInterim: (text: string) => void, onFinal: (text: string) => void,
     *   onStateChange: (listening: boolean) => void, onError: (message: string) => void }} handlers
     */
    constructor(handlers) {
        this.handlers = handlers;
        this.listening = false;
        this.recognition = null;
    }

    toggle() {
        if (this.listening) this.stop();
        else this.start();
    }

    start() {
        if (!Recognition || this.listening) return;
        const rec = new Recognition();
        rec.lang = document.documentElement.lang || navigator.language || 'pt-BR';
        rec.interimResults = true;
        // continuous mode duplicates results on Android Chrome; one phrase per tap is reliable
        rec.continuous = false;
        rec.maxAlternatives = 1;

        let finalText = '';
        rec.onresult = event => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (result.isFinal) finalText += result[0].transcript;
                else interim += result[0].transcript;
            }
            this.handlers.onInterim(finalText + interim);
        };
        rec.onerror = event => {
            const messages = {
                'not-allowed': 'Permita o acesso ao microfone para transcrever.',
                'service-not-allowed': 'Transcrição indisponível neste navegador.',
                'network': 'Transcrição precisa de conexão com a internet.',
                'audio-capture': 'Nenhum microfone encontrado.',
            };
            // "no-speech" / "aborted" are normal endings, not errors worth showing
            if (messages[event.error]) this.handlers.onError(messages[event.error]);
        };
        rec.onend = () => {
            const text = finalText.replace(/\s*\n\s*/g, ' ').trim();
            if (text) this.handlers.onFinal(text);
            this.recognition = null;
            this.setListening(false);
        };

        try {
            rec.start();
            this.recognition = rec;
            this.setListening(true);
        } catch (e) {
            console.warn('Speech recognition failed to start:', e);
            this.handlers.onError('Não foi possível iniciar a transcrição.');
        }
    }

    stop() {
        // stop() (not abort) still delivers what was already recognized
        this.recognition?.stop();
    }

    setListening(on) {
        this.listening = on;
        this.handlers.onStateChange(on);
    }
}
