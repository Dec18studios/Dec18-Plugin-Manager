/**
 * Dec 18 Studios — License key cryptography (Ed25519).
 *
 * Key format:  D18.<base64url payload>.<base64url signature>
 *
 * Payload JSON:
 *   { tier, email, plugins, issuedAt }
 *
 * tier = "master" → plugins = ["*"]   (unlocks everything)
 * tier = <pluginId>                   (unlocks that plugin only)
 */

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Base64url helpers ──────────────────────────────────────────────

export function base64urlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// ── Key loading ────────────────────────────────────────────────────

export function loadPrivateKey(pemPath) {
  return createPrivateKey(readFileSync(pemPath, "utf8"));
}

export function loadPublicKey(pemPath) {
  return createPublicKey(readFileSync(pemPath, "utf8"));
}

// ── Sign / verify ──────────────────────────────────────────────────

export function generateLicenseKey(privateKey, payload) {
  const json = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(json, "utf8"));
  const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey);
  return `D18.${payloadB64}.${base64urlEncode(signature)}`;
}

export function verifyLicenseKey(publicKey, token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "D18") return null;

  const [, payloadB64, sigB64] = parts;
  const sigBytes = base64urlDecode(sigB64);
  const valid = verify(null, Buffer.from(payloadB64, "utf8"), publicKey, sigBytes);
  if (!valid) return null;

  return JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
}
