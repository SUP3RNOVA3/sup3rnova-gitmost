import { createHmac } from 'node:crypto';
import {
  novaDelegationPayload,
  verifyNovaDelegationRequest,
} from './nova-delegation.helpers';

describe('NOVA delegated MCP assertions', () => {
  const secret = 's'.repeat(64);
  const body = {
    email: 'User@SUP3RNOVA.com',
    workosUserId: 'user_abc123',
    issuedAt: 1_800_000_000,
    nonce: 'a'.repeat(32),
  };

  it('accepts one correctly signed, fresh corporate identity', () => {
    const signature = createHmac('sha256', secret)
      .update(novaDelegationPayload(body))
      .digest('hex');
    expect(
      verifyNovaDelegationRequest({
        body,
        signature,
        secret,
        now: body.issuedAt + 10,
      }),
    ).toEqual({ ...body, email: 'user@sup3rnova.com' });
  });

  it('rejects bad signatures, stale requests, and non-corporate email', () => {
    expect(() =>
      verifyNovaDelegationRequest({
        body,
        signature: '0'.repeat(64),
        secret,
        now: body.issuedAt,
      }),
    ).toThrow();
    const signature = createHmac('sha256', secret)
      .update(novaDelegationPayload(body))
      .digest('hex');
    expect(() =>
      verifyNovaDelegationRequest({
        body,
        signature,
        secret,
        now: body.issuedAt + 61,
      }),
    ).toThrow();
    expect(() =>
      verifyNovaDelegationRequest({
        body: { ...body, email: 'user@example.com' },
        signature,
        secret,
        now: body.issuedAt,
      }),
    ).toThrow();
  });
});
