import { describe, it, expect } from 'vitest';
import { rateLimitSchluessel } from '../lib/rateLimitKey';

/** SEC-3-005: Das Rate-Limit zählt IPv6 je /64, IPv4 (auch in IPv6 verpackt) je Adresse. */
describe('Schlüssel des Rate-Limits', () => {
  it('fasst ein IPv6-/64 zusammen, gleich wie die Adresse geschrieben ist', () => {
    expect(rateLimitSchluessel('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSchluessel('2001:0DB8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSchluessel('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitSchluessel('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateLimitSchluessel('::1')).toBe('0:0:0:0::/64');
  });

  it('trennt verschiedene /64', () => {
    expect(rateLimitSchluessel('2001:db8:1:2::1')).not.toBe(rateLimitSchluessel('2001:db8:1:3::1'));
  });

  it('zählt IPv4 je Adresse, auch in IPv6 verpackt', () => {
    expect(rateLimitSchluessel('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitSchluessel('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
});
