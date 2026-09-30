/**
 * push.js
 * This device's push notifications: subscribe/unsubscribe through the service worker,
 * so agents (MCP notify) can reach the phone even with the app closed.
 */
const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

async function api(method, route, body) {
    const response = await fetch(`${base()}/api/push${route}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
    return data;
}

function keyBytes(base64url) {
    const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * @returns {Promise<{supported: boolean, reason?: string, permission?: string, subscribed?: boolean, devices?: number}>}
 */
export async function pushStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (isIOS() && !isStandalone()) {
            return { supported: false, reason: 'No iPhone, instale o app na tela inicial (Compartilhar → Adicionar à Tela de Início) e ative por lá.' };
        }
        return { supported: false, reason: 'Este navegador não aceita notificações push.' };
    }
    if (!window.isSecureContext) return { supported: false, reason: 'Notificações push precisam de HTTPS.' };
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    let devices;
    try {
        devices = (await api('GET', '')).devices;
    } catch { /* offline */ }
    return { supported: true, permission: Notification.permission, subscribed: !!sub, devices };
}

export async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(permission === 'denied'
            ? 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador.'
            : 'Permissão não concedida.');
    }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return api('POST', '/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    await api('POST', '/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
}

export function testPush() {
    return api('POST', '/test');
}
