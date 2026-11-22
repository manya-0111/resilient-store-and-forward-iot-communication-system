import crypto from 'node:crypto';

export interface SensorPlaintext {
  rain: 'DRY' | 'NORMAL' | 'HEAVY';
  rain_raw: number;
  temperature: number;
  humidity: number;
}

export interface EncryptedEnvelope {
  version: number;
  source: number;
  destination: number;
  packet_id: number;
  priority: number;
  key_version: string;
  nonce: string; // 12-byte (96-bit) hex
  ciphertext: string; // hex
  tag: string; // 16-byte GCM authentication tag hex
  aad: string; // UTF-8 authenticated metadata string
}

export interface DecryptionResult {
  authenticated: boolean;
  plaintext: SensorPlaintext | null;
  error: string | null;
}

class SecurityManager {
  private readonly key: Buffer;
  private readonly keyVersion: string;
  private readonly keySource: 'ENV_PROVISIONED' | 'EPHEMERAL_SESSION_KEY';
  private readonly usedNonces: Set<string> = new Set();

  constructor() {
    this.keyVersion = process.env.IOT_AES_KEY_VERSION || 'v1';
    const envHex = process.env.IOT_AES_KEY_HEX?.trim();
    if (envHex && /^[0-9a-fA-F]{32}$/.test(envHex)) {
      this.key = Buffer.from(envHex, 'hex');
      this.keySource = 'ENV_PROVISIONED';
    } else {
      // Ephemeral 128-bit in-memory key for demonstration when env secret is not provisioned.
      // Never written to disk, logs, database, or API responses.
      this.key = crypto.randomBytes(16);
      this.keySource = 'EPHEMERAL_SESSION_KEY';
    }
  }

  public getPublicKeyMetadata(): {
    algorithm: string;
    nonce_bits: number;
    tag_bits: number;
    key_version: string;
    key_source: string;
    encryption_endpoint: string;
    gateway_behavior: string;
    decryption_endpoint: string;
    unique_nonces_tracked: number;
  } {
    return {
      algorithm: 'AES-128-GCM',
      nonce_bits: 96,
      tag_bits: 128,
      key_version: this.keyVersion,
      key_source: this.keySource,
      encryption_endpoint: 'Node 1 (ESP32 Sensor Transmitter)',
      gateway_behavior: 'Node 2 stores & forwards opaque ciphertext; never decrypts',
      decryption_endpoint: 'Node 3 (ESP32 Destination Receiver)',
      unique_nonces_tracked: this.usedNonces.size,
    };
  }

  /**
   * Re-hydrates all persisted 96-bit nonces from SQLite on server startup so
   * nonce uniqueness holds across restarts.
   */
  public hydrateUsedNonces(nonces: string[]): void {
    for (const n of nonces) {
      if (typeof n === 'string' && /^[0-9a-fA-F]{24}$/.test(n)) {
        this.usedNonces.add(n.toLowerCase());
      }
    }
  }

  public isNonceTracked(nonceHex: string): boolean {
    return this.usedNonces.has(nonceHex.toLowerCase());
  }

  public recordExternalNonce(nonceHex: string): void {
    if (/^[0-9a-fA-F]{24}$/.test(nonceHex)) {
      this.usedNonces.add(nonceHex.toLowerCase());
    }
  }

  public buildAad(version: number, source: number, destination: number, packetId: number, priority: number): string {
    return `v${version}|src:${source}|dst:${destination}|pkt:${packetId}|pri:${priority}`;
  }

  /**
   * Validates strict AES-128-GCM wire envelope formatting:
   * - 96-bit (12-byte = 24 hex chars) nonce
   * - 128-bit (16-byte = 32 hex chars) authentication tag
   * - Non-empty even-length hex ciphertext
   * - Canonical AAD bound to envelope header fields when provided
   */
  public validateEnvelopeFormat(envelope: {
    nonce: string;
    ciphertext: string;
    tag: string;
    aad?: string;
    version?: number;
    source?: number;
    destination?: number;
    packet_id?: number;
    priority?: number;
  }): { valid: boolean; error: string | null } {
    if (!envelope.nonce || !/^[0-9a-fA-F]{24}$/.test(envelope.nonce)) {
      return { valid: false, error: 'INVALID_NONCE_FORMAT_96BIT_HEX_REQUIRED' };
    }
    if (!envelope.tag || !/^[0-9a-fA-F]{32}$/.test(envelope.tag)) {
      return { valid: false, error: 'INVALID_TAG_FORMAT_128BIT_HEX_REQUIRED' };
    }
    if (!envelope.ciphertext || envelope.ciphertext.length % 2 !== 0 || !/^[0-9a-fA-F]{2,}$/.test(envelope.ciphertext)) {
      return { valid: false, error: 'INVALID_CIPHERTEXT_HEX_FORMAT' };
    }
    if (
      envelope.aad !== undefined &&
      envelope.version !== undefined &&
      envelope.source !== undefined &&
      envelope.destination !== undefined &&
      envelope.packet_id !== undefined &&
      envelope.priority !== undefined
    ) {
      const expectedAad = this.buildAad(
        envelope.version,
        envelope.source,
        envelope.destination,
        envelope.packet_id,
        envelope.priority
      );
      if (envelope.aad !== expectedAad) {
        return { valid: false, error: 'AAD_HEADER_MISMATCH' };
      }
    }
    return { valid: true, error: null };
  }

  private generateUniqueNonce(externalExists?: (nonceHex: string) => boolean): Buffer {
    for (let i = 0; i < 16; i++) {
      const nonce = crypto.randomBytes(12); // 96-bit unique nonce
      const hex = nonce.toString('hex');
      if (!this.usedNonces.has(hex) && (!externalExists || !externalExists(hex))) {
        this.usedNonces.add(hex);
        return nonce;
      }
    }
    throw new Error('Failed to generate unique 96-bit AES-GCM nonce');
  }

  /**
   * Node 1 encrypts the serialized sensor payload ONCE with a unique 96-bit nonce.
   * Retries must reuse these exact bytes rather than re-encrypting.
   */
  public encryptAtNode1(
    packetId: number,
    priority: number,
    payload: SensorPlaintext,
    version = 1,
    source = 1,
    destination = 3,
    externalNonceExists?: (nonceHex: string) => boolean
  ): EncryptedEnvelope {
    const nonce = this.generateUniqueNonce(externalNonceExists);
    const aad = this.buildAad(version, source, destination, packetId, priority);
    const plaintextJson = JSON.stringify(payload);

    const cipher = crypto.createCipheriv('aes-128-gcm', this.key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));

    const encrypted = Buffer.concat([
      cipher.update(plaintextJson, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      version,
      source,
      destination,
      packet_id: packetId,
      priority,
      key_version: this.keyVersion,
      nonce: nonce.toString('hex'),
      ciphertext: encrypted.toString('hex'),
      tag: tag.toString('hex'),
      aad,
    };
  }

  /**
   * Node 3 verifies envelope structure, header-recomputed AAD, and the 128-bit GCM
   * authentication tag BEFORE accepting or displaying plaintext.
   */
  public verifyAndDecryptAtNode3(envelope: {
    nonce: string;
    ciphertext: string;
    tag: string;
    aad: string;
    version?: number;
    source?: number;
    destination?: number;
    packet_id?: number;
    priority?: number;
  }): DecryptionResult {
    try {
      const formatCheck = this.validateEnvelopeFormat(envelope);
      if (!formatCheck.valid) {
        return { authenticated: false, plaintext: null, error: formatCheck.error };
      }

      const canonicalAad =
        envelope.version !== undefined &&
        envelope.source !== undefined &&
        envelope.destination !== undefined &&
        envelope.packet_id !== undefined &&
        envelope.priority !== undefined
          ? this.buildAad(
              envelope.version,
              envelope.source,
              envelope.destination,
              envelope.packet_id,
              envelope.priority
            )
          : envelope.aad;

      const nonceBuf = Buffer.from(envelope.nonce, 'hex');
      const ciphertextBuf = Buffer.from(envelope.ciphertext, 'hex');
      const tagBuf = Buffer.from(envelope.tag, 'hex');

      const decipher = crypto.createDecipheriv('aes-128-gcm', this.key, nonceBuf, {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(canonicalAad, 'utf8'));
      decipher.setAuthTag(tagBuf);

      const decrypted = Buffer.concat([
        decipher.update(ciphertextBuf),
        decipher.final(),
      ]);

      const parsed = JSON.parse(decrypted.toString('utf8')) as Partial<SensorPlaintext>;
      if (
        typeof parsed.temperature !== 'number' ||
        !Number.isFinite(parsed.temperature) ||
        typeof parsed.humidity !== 'number' ||
        !Number.isFinite(parsed.humidity) ||
        typeof parsed.rain_raw !== 'number' ||
        !Number.isFinite(parsed.rain_raw) ||
        (parsed.rain !== 'DRY' && parsed.rain !== 'NORMAL' && parsed.rain !== 'HEAVY')
      ) {
        return { authenticated: false, plaintext: null, error: 'INVALID_DECRYPTED_PAYLOAD_SCHEMA' };
      }

      return {
        authenticated: true,
        plaintext: parsed as SensorPlaintext,
        error: null,
      };
    } catch {
      return {
        authenticated: false,
        plaintext: null,
        error: 'AES_GCM_AUTH_TAG_VERIFICATION_FAILED',
      };
    }
  }

  /**
   * Flips bits in the ciphertext or authentication tag for Test 7 / Tamper Simulation.
   */
  public tamperEnvelope(
    ciphertextHex: string,
    tagHex: string,
    target: 'ciphertext' | 'tag' = 'ciphertext'
  ): { ciphertext: string; tag: string; tamperedField: string } {
    const flipFirstByte = (hex: string): string => {
      const buf = Buffer.from(hex, 'hex');
      if (buf.length > 0) {
        buf[0] = buf[0] ^ 0xff;
      }
      return buf.toString('hex');
    };

    if (target === 'tag') {
      return {
        ciphertext: ciphertextHex,
        tag: flipFirstByte(tagHex),
        tamperedField: 'authentication_tag',
      };
    }
    return {
      ciphertext: flipFirstByte(ciphertextHex),
      tag: tagHex,
      tamperedField: 'ciphertext',
    };
  }
}

export const securityManager = new SecurityManager();
