import assert from 'node:assert/strict';
import test from 'node:test';
import { hasOAuthParams, isAnalyticsHost, normalizeAnalyticsPath } from './analytics.ts';

test('analytics is gated to the two production hostnames', () => {
  for (const host of ['gnarlynav.com', 'www.gnarlynav.com']) assert.equal(isAnalyticsHost(host), true);
  for (const host of ['', 'localhost', '127.0.0.1', '192.168.1.2', 'preview.amplifyapp.com', 'gnarlynav.com.example.org', 'admin.naijei.com']) {
    assert.equal(isAnalyticsHost(host), false);
  }
});

test('analytics retains only the public demo base from the pathname', () => {
  for (const path of ['/demo', '/demo/', '/demo/person%40example.com', '/demo/550e8400-e29b-41d4-a716-446655440000', '/demo/Alice/123456789012345/token']) {
    assert.equal(normalizeAnalyticsPath(path), '/demo/');
  }
  for (const path of ['/', '/demolition', '/account']) assert.equal(normalizeAnalyticsPath(path), null);
});

test('analytics waits while OAuth redirect params are in the URL', () => {
  assert.equal(hasOAuthParams('?code=abc&state=xyz'), true);
  assert.equal(hasOAuthParams('?error=access_denied'), true);
  assert.equal(hasOAuthParams(''), false);
  assert.equal(hasOAuthParams('?utm_source=x'), false);
});
