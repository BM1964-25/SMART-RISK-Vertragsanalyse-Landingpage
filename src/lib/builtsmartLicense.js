(function () {
'use strict';

const MEMORY_STORE = new Map();

function store(type) {
  try {
    const storage = type === 'session' ? window.sessionStorage : window.localStorage;
    if (!storage) return null;
    const key = '__builtsmart_storage_test__';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return storage;
  } catch (_) {
    return null;
  }
}

function getStore(key, type = 'local') {
  const storage = store(type);
  if (storage) return storage.getItem(key);
  return MEMORY_STORE.get(`${type}:${key}`) || null;
}

function setStore(key, value, type = 'local') {
  const storage = store(type);
  if (storage) storage.setItem(key, value);
  else MEMORY_STORE.set(`${type}:${key}`, String(value));
}

function removeStore(key, type = 'local') {
  const storage = store(type);
  if (storage) storage.removeItem(key);
  MEMORY_STORE.delete(`${type}:${key}`);
}

function normalizeConfig(config = {}) {
  return {
    appName: config.appName || 'SMART RISK Vertragsanalyse',
    appKey: config.appKey || 'smart-risk-vertragsanalyse',
    supabaseUrl: config.supabaseUrl || '',
    supabaseAnonKey: config.supabaseAnonKey || '',
    checkoutFunctionUrl: config.checkoutFunctionUrl || '',
    aiFunctionUrl: config.aiFunctionUrl || ''
  };
}

function isConfigured(config) {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey);
}

function sessionKey(config) {
  return `builtsmart:${config.appKey}:session`;
}

function ownKeyKey(provider) {
  return `builtsmart:own-api-key:${provider}`;
}

async function jsonRequest(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Anfrage hat zu lange gedauert. Bitte Verbindung prüfen und erneut versuchen.');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function createBuiltSmartLicenseClient(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);

  function authHeaders() {
    const session = getCurrentUser();
    return {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${session?.access_token || config.supabaseAnonKey}`
    };
  }

  function edgeUrl(path) {
    return `${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/${path}`;
  }

  async function loginWithMagicLink(email) {
    if (!isConfigured(config)) throw new Error('Supabase URL oder Anon Key fehlt.');
    return jsonRequest(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: config.supabaseAnonKey },
      body: JSON.stringify({
        email,
        create_user: true,
        type: 'magiclink',
        options: { email_redirect_to: window.location.href.split('#')[0] }
      })
    });
  }

  function captureMagicLinkSession() {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hash.get('access_token');
    if (!accessToken) return null;
    const session = {
      access_token: accessToken,
      refresh_token: hash.get('refresh_token') || '',
      expires_at: hash.get('expires_at') || '',
      token_type: hash.get('token_type') || 'bearer',
      email: ''
    };
    setStore(sessionKey(config), JSON.stringify(session), 'local');
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
    return session;
  }

  function logout() {
    removeStore(sessionKey(config), 'local');
  }

  function getCurrentUser() {
    const captured = captureMagicLinkSession();
    if (captured) return captured;
    const raw = getStore(sessionKey(config), 'local');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  async function checkAppAccess(appKey = config.appKey) {
    if (!isConfigured(config)) {
      return { allowed: false, state: 'not_configured', reason: 'Lizenzsystem nicht konfiguriert.' };
    }
    if (!getCurrentUser()) return { allowed: false, state: 'not_logged_in' };
    return jsonRequest(edgeUrl('check-app-access'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ app_key: appKey })
    });
  }

  async function startTrial(appKey = config.appKey) {
    if (!getCurrentUser()) throw new Error('Bitte zuerst einloggen.');
    return jsonRequest(edgeUrl('start-trial'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ app_key: appKey })
    });
  }

  async function redeemLicenseCode(appKey = config.appKey, code) {
    if (!getCurrentUser()) throw new Error('Bitte zuerst einloggen.');
    return jsonRequest(edgeUrl('redeem-license-code'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ app_key: appKey, code })
    });
  }

  async function createCheckoutSession(appKey = config.appKey, quantity = 1) {
    if (!getCurrentUser()) throw new Error('Bitte zuerst einloggen.');
    if (!config.checkoutFunctionUrl) throw new Error('Checkout Function URL fehlt.');
    return jsonRequest(config.checkoutFunctionUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ app_key: appKey, quantity })
    });
  }

  async function getAiCreditBalance() {
    if (!getCurrentUser()) return { credits: 0, state: 'not_logged_in' };
    return jsonRequest(edgeUrl('ai-credit-balance'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({})
    });
  }

  async function estimateAiUsage(action, payload = {}) {
    const chars = JSON.stringify(payload).length;
    return {
      action,
      estimatedCredits: Math.max(1, Math.ceil(chars / 12000)),
      estimatedTokens: Math.ceil(chars / 4)
    };
  }

  async function runAiAction(action, payload = {}) {
    if (!getCurrentUser()) throw new Error('Bitte zuerst einloggen.');
    if (!config.aiFunctionUrl) throw new Error('Zentrale AI Function URL fehlt.');
    return jsonRequest(config.aiFunctionUrl, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ app_key: config.appKey, action, payload })
    });
  }

  function saveOwnApiKey(provider, key) {
    setStore(ownKeyKey(provider), key, 'local');
    return { provider, active: true };
  }

  function removeOwnApiKey(provider) {
    removeStore(ownKeyKey(provider), 'local');
    return { provider, active: false };
  }

  function getOwnApiKey(provider) {
    return getStore(ownKeyKey(provider), 'local') || '';
  }

  return {
    config,
    loginWithMagicLink,
    logout,
    getCurrentUser,
    checkAppAccess,
    startTrial,
    redeemLicenseCode,
    createCheckoutSession,
    getAiCreditBalance,
    estimateAiUsage,
    runAiAction,
    saveOwnApiKey,
    removeOwnApiKey,
    getOwnApiKey,
    isConfigured: () => isConfigured(config)
  };
}

window.createBuiltSmartLicenseClient = createBuiltSmartLicenseClient;
})();
