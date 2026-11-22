"""AES-128-GCM End-to-End Security Manager for Python backend (PDF Section 7)."""
import json
import os
import re
import secrets
from typing import Callable
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_HEX_32 = re.compile(r"^[0-9a-fA-F]{32}$")
_HEX_24 = re.compile(r"^[0-9a-fA-F]{24}$")
_HEX_EVEN = re.compile(r"^[0-9a-fA-F]{2,}$")


class SecurityManager:
    def __init__(self) -> None:
        self.key_version = os.environ.get("IOT_AES_KEY_VERSION", "v1")
        key_hex = os.environ.get("IOT_AES_KEY_HEX", "").strip()
        if _HEX_32.match(key_hex):
            self._key = bytes.fromhex(key_hex)
            self.key_source = "ENV_PROVISIONED"
        else:
            # Ephemeral 16-byte in-memory key; never persisted or logged.
            self._key = secrets.token_bytes(16)
            self.key_source = "EPHEMERAL_SESSION_KEY"
        self._aesgcm = AESGCM(self._key)
        self._used_nonces: set[str] = set()

    def hydrate_used_nonces(self, nonces: list[str]) -> None:
        for n in nonces:
            if isinstance(n, str) and _HEX_24.match(n):
                self._used_nonces.add(n.lower())

    def record_external_nonce(self, nonce_hex: str) -> None:
        if _HEX_24.match(nonce_hex):
            self._used_nonces.add(nonce_hex.lower())

    @staticmethod
    def build_aad(version: int, source: int, destination: int, packet_id: int, priority: int) -> bytes:
        return f"v{version}|src:{source}|dst:{destination}|pkt:{packet_id}|pri:{priority}".encode("utf-8")

    @classmethod
    def validate_envelope_format(
        cls,
        nonce_hex: str,
        ciphertext_hex: str,
        tag_hex: str,
        aad_str: str | None = None,
        version: int | None = None,
        source: int | None = None,
        destination: int | None = None,
        packet_id: int | None = None,
        priority: int | None = None,
    ) -> tuple[bool, str | None]:
        if not nonce_hex or not _HEX_24.match(nonce_hex):
            return False, "INVALID_NONCE_FORMAT_96BIT_HEX_REQUIRED"
        if not tag_hex or not _HEX_32.match(tag_hex):
            return False, "INVALID_TAG_FORMAT_128BIT_HEX_REQUIRED"
        if not ciphertext_hex or len(ciphertext_hex) % 2 != 0 or not _HEX_EVEN.match(ciphertext_hex):
            return False, "INVALID_CIPHERTEXT_HEX_FORMAT"
        if aad_str is not None and None not in (version, source, destination, packet_id, priority):
            expected = cls.build_aad(version, source, destination, packet_id, priority).decode("utf-8")
            if aad_str != expected:
                return False, "AAD_HEADER_MISMATCH"
        return True, None

    def encrypt_node1(
        self,
        packet_id: int,
        priority: int,
        payload: dict,
        external_nonce_exists: Callable[[str], bool] | None = None,
    ) -> dict:
        nonce = secrets.token_bytes(12)
        for _ in range(16):
            hx = nonce.hex()
            if hx not in self._used_nonces and (external_nonce_exists is None or not external_nonce_exists(hx)):
                self._used_nonces.add(hx)
                break
            nonce = secrets.token_bytes(12)
        else:
            raise RuntimeError("Failed to generate unique 96-bit AES-GCM nonce")

        aad = self.build_aad(1, 1, 3, packet_id, priority)
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        ct_and_tag = self._aesgcm.encrypt(nonce, raw, aad)
        ciphertext, tag = ct_and_tag[:-16], ct_and_tag[-16:]

        return {
            "version": 1,
            "source": 1,
            "destination": 3,
            "packet_id": packet_id,
            "priority": priority,
            "key_version": self.key_version,
            "nonce": nonce.hex(),
            "ciphertext": ciphertext.hex(),
            "tag": tag.hex(),
            "aad": aad.decode("utf-8"),
        }

    def verify_and_decrypt_node3(
        self,
        nonce_hex: str,
        ciphertext_hex: str,
        tag_hex: str,
        aad_str: str,
        version: int | None = None,
        source: int | None = None,
        destination: int | None = None,
        packet_id: int | None = None,
        priority: int | None = None,
    ) -> tuple[bool, dict | None, str | None]:
        valid, err = self.validate_envelope_format(
            nonce_hex, ciphertext_hex, tag_hex, aad_str, version, source, destination, packet_id, priority
        )
        if not valid:
            return False, None, err
        try:
            canonical_aad = (
                self.build_aad(version, source, destination, packet_id, priority)
                if None not in (version, source, destination, packet_id, priority)
                else aad_str.encode("utf-8")
            )
            nonce = bytes.fromhex(nonce_hex)
            ct = bytes.fromhex(ciphertext_hex) + bytes.fromhex(tag_hex)
            plaintext = self._aesgcm.decrypt(nonce, ct, canonical_aad)
            parsed = json.loads(plaintext.decode("utf-8"))
            if (
                not isinstance(parsed, dict)
                or not isinstance(parsed.get("temperature"), (int, float))
                or not isinstance(parsed.get("humidity"), (int, float))
                or not isinstance(parsed.get("rain_raw"), (int, float))
                or parsed.get("rain") not in ("DRY", "NORMAL", "HEAVY")
            ):
                return False, None, "INVALID_DECRYPTED_PAYLOAD_SCHEMA"
            return True, parsed, None
        except Exception:
            return False, None, "AES_GCM_AUTH_TAG_VERIFICATION_FAILED"
