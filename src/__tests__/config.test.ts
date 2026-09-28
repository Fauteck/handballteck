/**
 * Die Proxy-Liste (`TRUST_PROXY`): nur IP- und CIDR-Einträge, leer heißt
 * keinem trauen — und nie `true`, das jedem Aufrufer jede Adresse glaubte.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { trustProxy } from '../config';

afterEach(() => { delete process.env.TRUST_PROXY; });

describe('TRUST_PROXY', () => {
  it('vertraut ohne Angabe keinem Proxy', () => {
    expect(trustProxy()).toBe(false);
    process.env.TRUST_PROXY = '   ';
    expect(trustProxy()).toBe(false);
  });

  it('nimmt Adressen und Bereiche, durch Komma oder Leerzeichen getrennt', () => {
    process.env.TRUST_PROXY = '192.168.0.97, 172.16.0.0/12  ::1';
    expect(trustProxy()).toEqual(['192.168.0.97', '172.16.0.0/12', '::1']);
  });

  it('wird durch „true" oder eine Zahl nicht zu „allen vertrauen"', () => {
    process.env.TRUST_PROXY = 'true';
    expect(trustProxy()).toBe(false);
    process.env.TRUST_PROXY = 'loopback, 192.168.0.97';
    expect(trustProxy()).toEqual(['192.168.0.97']);
  });
});
