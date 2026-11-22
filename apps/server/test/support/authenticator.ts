/**
 * A minimal software passkey authenticator (ES256, "none" attestation) for
 * integration tests. It produces the same JSON the browser library sends.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

interface StoredCredential {
  id: Buffer;
  privateKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface AuthenticatorOptions {
  origin: string;
  /** Simulate a cloned/legacy authenticator by fixing the counter. */
  counterStep?: number;
  userVerified?: boolean;
}

export class SoftAuthenticator {
  readonly credentials: StoredCredential[] = [];
  private readonly origin: string;
  private readonly counterStep: number;
  userVerified: boolean;

  constructor(options: AuthenticatorOptions) {
    this.origin = options.origin;
    this.counterStep = options.counterStep ?? 1;
    this.userVerified = options.userVerified ?? true;
  }

  private flags(attested: boolean): number {
    // UP=0x01, UV=0x04, BE=0x08, BS=0x10, AT=0x40
    return 0x01 | (this.userVerified ? 0x04 : 0) | 0x08 | 0x10 | (attested ? 0x40 : 0);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin?: string,
  ): RegistrationResponseJSON {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const id = randomBytes(16);
    const counter = Buffer.alloc(4);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(true)]),
      counter,
      Buffer.alloc(16), // AAGUID
      idLen,
      id,
      Buffer.from(isoCBOR.encode(cose)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    this.credentials.push({ id, privateKey, rpId, userHandle: options.user.id, counter: 0 });
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    pick?: { credentialIndex?: number; origin?: string },
  ): AuthenticationResponseJSON {
    const allowed = options.allowCredentials?.map((c) => c.id);
    const candidates = this.credentials.filter(
      (c) => !allowed?.length || allowed.includes(b64url(c.id)),
    );
    const cred = candidates[pick?.credentialIndex ?? 0];
    if (!cred) throw new Error('no matching credential');
    cred.counter += this.counterStep;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(cred.rpId), Buffer.from([this.flags(false)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, pick?.origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      cred.privateKey,
    );
    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: cred.userHandle,
      },
    };
  }

  /** Roll a credential's counter back, as a cloned authenticator would. */
  rewindCounter(index = 0): void {
    const cred = this.credentials[index];
    if (cred) cred.counter = Math.max(0, cred.counter - 2);
  }
}
