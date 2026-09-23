import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "./secret-box.js";

test("AES-GCM secret box round-trips without exposing plaintext", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptSecret("ghu_private_token", key);
  assert.equal(encrypted.includes("ghu_private_token"), false);
  assert.equal(decryptSecret(encrypted, key), "ghu_private_token");
});

test("AES-GCM rejects a modified ciphertext", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptSecret("secret", key);
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptSecret(tampered, key));
});

test("secret box rejects weak keys", () => {
  assert.throws(() => encryptSecret("secret", "short"), /32/);
});
