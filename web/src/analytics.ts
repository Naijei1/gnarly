const productionHosts = new Set(['gnarlynav.com', 'www.gnarlynav.com']);

export function isAnalyticsHost(hostname: string) {
  return productionHosts.has(hostname);
}

export function normalizeAnalyticsPath(pathname: string) {
  return pathname === '/demo' || pathname.startsWith('/demo/') ? '/demo/' : null;
}

const viewSuffix = { map: '', details: 'details', indoors: 'indoors', data: 'data' } as const;
type View = keyof typeof viewSuffix;
type Pageview = { path: string; title: string; event: false };
type GoatCounter = { no_onload: boolean; allow_local: boolean; count?: (view: Pageview) => void };

let lastPath: string | undefined;
let pending: Pageview[] = [];

// count.js always sends location.search; wait until the Cognito redirect params are cleaned up.
export function hasOAuthParams(search: string) {
  const params = new URLSearchParams(search);
  return ['code', 'state', 'error', 'error_description'].some(key => params.has(key));
}

export function trackView(view: View, attempt = 0) {
  if (!isAnalyticsHost(window.location.hostname)) return;
  if (hasOAuthParams(window.location.search)) {
    if (attempt < 20) window.setTimeout(() => trackView(view, attempt + 1), 500);
    return;
  }
  const base = normalizeAnalyticsPath(window.location.pathname);
  if (!base) return;

  const path = base + viewSuffix[view];
  if (path === lastPath) return;
  lastPath = path;

  const browser = window as Window & { goatcounter?: GoatCounter };
  const pageview: Pageview = { path, title: 'Gnarly', event: false };
  if (browser.goatcounter?.count) {
    browser.goatcounter.count(pageview);
    return;
  }

  pending.push(pageview);
  if (browser.goatcounter) return;

  browser.goatcounter = { no_onload: true, allow_local: false };
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = 'https://gnarlynav.goatcounter.com/count';
  script.onload = () => {
    for (const queued of pending) browser.goatcounter?.count?.(queued);
    pending = [];
  };
  script.onerror = () => {
    pending = [];
    lastPath = undefined;
    delete browser.goatcounter;
    script.remove();
  };
  document.head.append(script);
}
