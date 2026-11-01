/**
 * haptics.js
 * Feedback tátil ao tocar. Android: navigator.vibrate. iPhone (iOS 18+): o Safari não tem
 * vibrate, mas vibra de leve quando um <input type="checkbox" switch> muda; um interruptor
 * escondido é acionado por um <label> a cada toque. Desligável em Configurações → Interface
 * (configuração "haptics"). Só funciona dentro de um toque do usuário (regra dos navegadores).
 */
const PATTERNS = { light: 8, medium: 15, heavy: 25, success: [10, 40, 10], warning: [20, 60, 20], select: 6 };

let enabled = true;
let iosLabel = null;

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function iosSwitch() {
    if (iosLabel) return iosLabel;
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9px;top:-9px';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosLabel = label;
    return label;
}

/** Liga/desliga (configuração "haptics"). */
export function setHaptics(on) {
    enabled = on !== false;
}

/** Vibra de leve. @param {'light'|'medium'|'heavy'|'success'|'warning'|'select'} [kind] */
export function haptic(kind = 'light') {
    if (!enabled) return;
    try {
        if (typeof navigator.vibrate === 'function' && !isIOS()) {
            navigator.vibrate(PATTERNS[kind] ?? PATTERNS.light);
        } else if (isIOS()) {
            iosSwitch().click();
        }
    } catch { /* sem suporte: nada */ }
}

/** O aparelho tem algum feedback tátil? (para a tela de permissões) */
export function hapticsSupported() {
    return typeof navigator.vibrate === 'function' || isIOS();
}
