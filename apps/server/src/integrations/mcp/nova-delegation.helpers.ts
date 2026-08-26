import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export type NovaDelegationRequest = {
  email: string;
  workosUserId: string;
  issuedAt: number;
  nonce: string;
};

export function novaDelegationPayload(input: NovaDelegationRequest): string {
  return [
    'v1',
    String(input.issuedAt),
    input.nonce,
    input.workosUserId,
    input.email.trim().toLowerCase(),
  ].join('\n');
}

export function verifyNovaDelegationRequest(input: {
  body: NovaDelegationRequest;
  signature?: string;
  secret: string;
  now?: number;
}): NovaDelegationRequest {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const body = input.body ?? ({} as NovaDelegationRequest);
  const email = String(body.email ?? '').trim().toLowerCase();
  const workosUserId = String(body.workosUserId ?? '').trim();
  const nonce = String(body.nonce ?? '').trim();
  const issuedAt = Number(body.issuedAt);
  if (
    !/^[^\s@]+@sup3rnova\.com$/i.test(email) ||
    !/^user_[A-Za-z0-9]+$/.test(workosUserId) ||
    !/^[a-f0-9]{32,128}$/.test(nonce) ||
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(now - issuedAt) > 60 ||
    input.secret.length < 32
  ) {
    throw new UnauthorizedException('Invalid delegated identity assertion.');
  }

  const normalized = { email, workosUserId, issuedAt, nonce };
  const expected = createHmac('sha256', input.secret)
    .update(novaDelegationPayload(normalized))
    .digest('hex');
  const supplied = String(input.signature ?? '').toLowerCase();
  if (
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
  ) {
    throw new UnauthorizedException('Invalid delegated identity assertion.');
  }
  return normalized;
}
