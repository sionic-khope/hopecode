import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAppUrl } from '../../src/main/appUrl';
import { isSafeExternalUrl } from '../../src/main/externalUrl';
import { LOGIN_URL_HOSTS } from '../../src/shared/constants';

const index = '/Applications/Hopecode.app/Contents/Resources/app.asar/out/renderer/index.html';

describe('isAppUrl (H1 / M1)', () => {
  it('accepts only the built renderer index.html when there is no dev URL', () => {
    const cfg = { devUrl: null, rendererIndexPath: index };
    expect(isAppUrl(pathToFileURL(index).href, cfg)).toBe(true);
    expect(isAppUrl(`${pathToFileURL(index).href}#/thread/1`, cfg)).toBe(true);
    expect(isAppUrl(pathToFileURL('/etc/passwd').href, cfg)).toBe(false);
    expect(isAppUrl('file://evil-host/Applications/Hopecode.app/Contents/Resources/app.asar/out/renderer/index.html', cfg)).toBe(false);
    expect(isAppUrl('https://example.com/', cfg)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', cfg)).toBe(false);
    expect(isAppUrl(undefined, cfg)).toBe(false);
    expect(isAppUrl('not a url', cfg)).toBe(false);
  });

  it('accepts the dev server origin when configured', () => {
    const cfg = { devUrl: 'http://localhost:5173/', rendererIndexPath: index };
    expect(isAppUrl('http://localhost:5173/src/index.html', cfg)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', cfg)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', cfg)).toBe(false);
  });
});

describe('isSafeExternalUrl (L1)', () => {
  it('allows https links only', () => {
    expect(isSafeExternalUrl('https://github.com/x')).toBe(true);
    expect(isSafeExternalUrl('http://github.com/x')).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('https://user:pw@github.com/')).toBe(false);
    expect(isSafeExternalUrl('garbage')).toBe(false);
  });

  it('restricts automatic login opens to the host allowlist', () => {
    expect(isSafeExternalUrl('https://claude.ai/oauth/authorize?x=1', LOGIN_URL_HOSTS)).toBe(true);
    expect(isSafeExternalUrl('https://claude.com/login', LOGIN_URL_HOSTS)).toBe(true);
    expect(isSafeExternalUrl('https://console.anthropic.com/', LOGIN_URL_HOSTS)).toBe(true);
    expect(isSafeExternalUrl('https://evil.com/claude.ai', LOGIN_URL_HOSTS)).toBe(false);
    expect(isSafeExternalUrl('https://claude.ai.evil.com/', LOGIN_URL_HOSTS)).toBe(false);
    expect(isSafeExternalUrl('https://notanthropic.com/', LOGIN_URL_HOSTS)).toBe(false);
  });
});
