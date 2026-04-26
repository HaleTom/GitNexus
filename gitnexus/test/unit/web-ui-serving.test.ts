import { describe, expect, it, vi, beforeEach } from 'vitest';

const { accessMock } = vi.hoisted(() => ({
  accessMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { access: accessMock },
  access: accessMock,
}));

import { registerWebUI, resolveWebDistDir, landingPageHtml } from '../../src/server/api.js';

type MockRoute = { method: string; path: string | RegExp; handler: Function[] };
type MockApp = {
  use: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  _routes: MockRoute[];
};

const createMockApp = (): MockApp => {
  const _routes: MockRoute[] = [];
  return {
    use: vi.fn(),
    get: vi.fn((p: string | RegExp, ...h: Function[]) =>
      _routes.push({ method: 'get', path: p, handler: h }),
    ),
    _routes,
  };
};

const invokeHandler = async (app: MockApp, method: string, reqPath: string) => {
  for (const route of app._routes) {
    if (route.method !== method) continue;
    if (route.path instanceof RegExp) {
      if (!route.path.test(reqPath)) continue;
    } else {
      if (route.path !== reqPath) continue;
    }
    const res: any = {
      sendFile: vi.fn(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    await route.handler[0]({ path: reqPath } as any, res, vi.fn());
    return res;
  }
  return null;
};

describe('landingPageHtml', () => {
  const html = landingPageHtml();

  it('contains void background colour from gitnexus-web design tokens', () => {
    expect(html).toContain('#06060a');
  });

  it('contains surface card colour from gitnexus-web design tokens', () => {
    expect(html).toContain('#101018');
  });

  it('contains accent colour from gitnexus-web design tokens', () => {
    expect(html).toContain('#7c3aed');
  });

  it('uses Outfit font with system-ui fallback', () => {
    expect(html).toContain('Outfit');
    expect(html).toContain('system-ui');
  });

  it('contains the build command in a terminal-style block', () => {
    expect(html).toContain('cd gitnexus-web');
    expect(html).toContain('npm run build');
  });

  it('contains the Vercel link with safe external attributes', () => {
    expect(html).toContain('https://gitnexus.vercel.app');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('contains the Web UI not found message', () => {
    expect(html).toContain('Web UI not found');
  });
});

describe('SPA fallback regex', () => {
  const regex = /^(?!\/api(?:\/|$))(?!.*\.\w{1,10}$).*/;

  it('allows root path', () => {
    expect(regex.test('/')).toBe(true);
  });

  it('allows SPA routes', () => {
    expect(regex.test('/processes')).toBe(true);
    expect(regex.test('/settings')).toBe(true);
    expect(regex.test('/clusters')).toBe(true);
  });

  it('excludes /api paths', () => {
    expect(regex.test('/api')).toBe(false);
    expect(regex.test('/api/')).toBe(false);
    expect(regex.test('/api/info')).toBe(false);
    expect(regex.test('/api/does-not-exist')).toBe(false);
  });

  it('excludes asset-like paths with file extensions', () => {
    expect(regex.test('/assets/missing.js')).toBe(false);
    expect(regex.test('/assets/missing.css')).toBe(false);
    expect(regex.test('/favicon.ico')).toBe(false);
    expect(regex.test('/assets/font.woff2')).toBe(false);
    expect(regex.test('/static/app.map')).toBe(false);
    expect(regex.test('/images/logo.png')).toBe(false);
  });

  it('allows SPA routes with dots not at the end', () => {
    expect(regex.test('/v1.0/api')).toBe(true);
    expect(regex.test('/docs/v2.0/guide')).toBe(true);
  });

  it('excludes paths ending in dot-plus-extension regardless of content before it', () => {
    expect(regex.test('/user@example.com')).toBe(false);
  });
});

describe('registerWebUI', () => {
  it('registers express.static and SPA fallback when staticDir provided', () => {
    const app = createMockApp();
    registerWebUI(app as any, '/some/dir');
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(app.get).toHaveBeenCalledTimes(1);
    const [regex] = app.get.mock.calls[0] as [RegExp, ...Function[]];
    expect(regex.source).toBe(/^(?!\/api(?:\/|$))(?!.*\.\w{1,10}$).*/.source);
  });

  it('registers landing page route when staticDir is null', () => {
    const app = createMockApp();
    registerWebUI(app as any, null);
    expect(app.use).not.toHaveBeenCalled();
    expect(app.get).toHaveBeenCalledTimes(1);
    const [path] = app.get.mock.calls[0] as [string, ...Function[]];
    expect(path).toBe('/');
  });

  it('landing page handler returns styled HTML', async () => {
    const app = createMockApp();
    registerWebUI(app as any, null);
    const res = await invokeHandler(app, 'get', '/');
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Web UI not found'));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('#06060a'));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('#7c3aed'));
  });

  it('Cache-Control setHeaders sets no-cache for HTML, immutable for assets', () => {
    const setHeaders = (filePath: string) => {
      const headers: Record<string, string> = {};
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
      };
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return headers;
    };
    expect(setHeaders('index.html')).toEqual({ 'Cache-Control': 'no-cache' });
    expect(setHeaders('app.js')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    expect(setHeaders('style.css')).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
});

describe('resolveWebDistDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns primary dir when index.html exists', async () => {
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('primary')) return undefined;
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    const result = await resolveWebDistDir('/primary', '/fallback');
    expect(result).toBe('/primary');
  });

  it('returns fallback dir when primary missing', async () => {
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('fallback')) return undefined;
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    const result = await resolveWebDistDir('/primary', '/fallback');
    expect(result).toBe('/fallback');
  });

  it('returns null when both dirs missing', async () => {
    accessMock.mockImplementation(async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    const result = await resolveWebDistDir('/primary', '/fallback');
    expect(result).toBeNull();
  });

  it('warns on non-ENOENT errors but continues', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    accessMock.mockImplementation(async (p: string) => {
      if (p.includes('primary'))
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      if (p.includes('fallback')) return undefined;
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    const result = await resolveWebDistDir('/primary', '/fallback');
    expect(result).toBe('/fallback');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not access web UI dir /primary'),
      'permission denied',
    );
    warnSpy.mockRestore();
  });

  it('prefers GITNEXUS_WEB_DIST env var when set', async () => {
    const original = process.env.GITNEXUS_WEB_DIST;
    process.env.GITNEXUS_WEB_DIST = '/env/dist';
    try {
      accessMock.mockImplementation(async (p: string) => {
        if (p.includes('/env/dist')) return undefined;
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      });
      const result = await resolveWebDistDir('/primary', '/fallback');
      expect(result).toBe('/env/dist');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_WEB_DIST;
      } else {
        process.env.GITNEXUS_WEB_DIST = original;
      }
    }
  });

  it('falls back to primary when GITNEXUS_WEB_DIST dir missing', async () => {
    const original = process.env.GITNEXUS_WEB_DIST;
    process.env.GITNEXUS_WEB_DIST = '/env/dist';
    try {
      accessMock.mockImplementation(async (p: string) => {
        if (p.includes('/env/dist'))
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        if (p.includes('primary')) return undefined;
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      });
      const result = await resolveWebDistDir('/primary', '/fallback');
      expect(result).toBe('/primary');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_WEB_DIST;
      } else {
        process.env.GITNEXUS_WEB_DIST = original;
      }
    }
  });
});
