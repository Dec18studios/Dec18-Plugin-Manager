//! Email-OTP account sync against the Dec 18 Studios auth worker.
//!
//! Three flows mirror the worker endpoints:
//!   * `start`  — POST /auth/start : email a 6-digit code (worker checks the
//!                purchase ledger first; non-customers get a "no purchase" notice).
//!   * `verify` — POST /auth/verify: exchange the code for the account's license
//!                key(s), which we install into licenses.json automatically.
//!   * `attest` — POST /auth/attest: existing key-holders prove entitlement
//!                silently on launch (logged as `silent_key`, no email).
//!
//! The license key itself stays the download credential; this module only adds
//! the account-sync layer in front of it.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::license;

const AUTH_BASE: &str = "https://dec18-auth.dec18studios.workers.dev";
const TIMEOUT_SECS: u64 = 20;

/// Stable, pseudonymous per-machine id for the analytics log. Not security
/// sensitive — it only lets the backend tell devices apart in
/// `verification_events`. Derived (not persisted) from host name + home path.
fn device_id() -> String {
    let host = sysinfo::System::host_name().unwrap_or_default();
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(host.as_bytes());
    hasher.update(b"|");
    hasher.update(home.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("Dec18-Plugin-Manager")
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| anyhow!("Failed to build HTTP client: {e}"))
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StartRequest<'a> {
    email: &'a str,
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Deserialize)]
struct StartResponse {
    #[serde(default)]
    sent: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
struct VerifyRequest<'a> {
    email: &'a str,
    code: &'a str,
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(Serialize)]
struct AttestRequest<'a> {
    key: &'a str,
    #[serde(rename = "deviceId")]
    device_id: String,
}

/// Worker entitlement payload shared by /auth/verify and /auth/attest.
#[derive(Deserialize)]
struct EntitlementResponse {
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    keys: Option<Vec<String>>,
    #[serde(default)]
    plugins: Option<Vec<String>>,
    #[serde(default, rename = "activeUntil")]
    active_until: Option<i64>,
    #[serde(default)]
    expired: bool,
    #[serde(default, rename = "attemptsLeft")]
    attempts_left: Option<u32>,
    #[serde(default)]
    error: Option<String>,
}

/// Result handed back to the UI after a verify/attest call.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthOutcome {
    pub ok: bool,
    pub email: Option<String>,
    /// Keys newly installed into licenses.json by this call.
    pub installed_keys: Vec<String>,
    pub plugins: Vec<String>,
    pub active_until: Option<i64>,
    pub expired: bool,
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/// Request an OTP for `email`. Always succeeds from the UI's perspective when the
/// request reaches the worker — a non-customer simply receives a different email.
pub async fn start(email: &str) -> Result<()> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(anyhow!("Please enter a valid email address."));
    }
    let body = StartRequest {
        email,
        device_id: device_id(),
    };
    let resp = http_client()?
        .post(format!("{AUTH_BASE}/auth/start"))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Couldn't reach the sign-in service. Check your connection.\n{e}"))?;

    let status = resp.status();
    let parsed: StartResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Unexpected response from sign-in service: {e}"))?;

    if status.is_success() && parsed.sent {
        Ok(())
    } else if let Some(err) = parsed.error {
        Err(anyhow!(err))
    } else if status.as_u16() == 429 {
        Err(anyhow!("Too many requests. Please wait a minute and try again."))
    } else {
        Err(anyhow!("Couldn't send the code. Please try again shortly."))
    }
}

/// Exchange `code` for the account's keys and install them locally.
pub async fn verify(email: &str, code: &str) -> Result<AuthOutcome> {
    let email = email.trim();
    let code = code.trim();
    if code.is_empty() {
        return Err(anyhow!("Please enter the 6-digit code from your email."));
    }
    let body = VerifyRequest {
        email,
        code,
        device_id: device_id(),
    };
    let resp = http_client()?
        .post(format!("{AUTH_BASE}/auth/verify"))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Couldn't reach the sign-in service. Check your connection.\n{e}"))?;

    let status = resp.status();
    let parsed: EntitlementResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Unexpected response from sign-in service: {e}"))?;

    if !status.is_success() || !parsed.verified {
        let mut msg = parsed
            .error
            .unwrap_or_else(|| "That code didn't work. Please try again.".to_string());
        if let Some(left) = parsed.attempts_left {
            msg = format!("{msg} ({left} attempt{} left)", if left == 1 { "" } else { "s" });
        }
        return Err(anyhow!(msg));
    }

    Ok(install_entitlement(parsed))
}

/// Silently prove entitlement for an already-installed key (existing users).
/// Returns `Ok(None)` when no local key is present (nothing to attest).
pub async fn attest_installed() -> Result<Option<AuthOutcome>> {
    let stored = license::load_licenses()?;
    let Some(key) = stored.keys.first().cloned() else {
        return Ok(None);
    };
    let body = AttestRequest {
        key: &key,
        device_id: device_id(),
    };
    let resp = http_client()?
        .post(format!("{AUTH_BASE}/auth/attest"))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Couldn't reach the sign-in service: {e}"))?;

    let status = resp.status();
    let parsed: EntitlementResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("Unexpected response from sign-in service: {e}"))?;

    if !status.is_success() || !parsed.ok {
        return Err(anyhow!(parsed
            .error
            .unwrap_or_else(|| "Could not verify the installed license.".to_string())));
    }

    Ok(Some(install_entitlement(parsed)))
}

/// Install any keys returned by the worker into licenses.json (dedup-safe) and
/// build the UI outcome.
fn install_entitlement(resp: EntitlementResponse) -> AuthOutcome {
    let mut installed = Vec::new();
    if let Some(keys) = &resp.keys {
        for key in keys {
            // add_license_key dedups; only report keys we actually stored.
            if let Ok(data) = license::add_license_key(key) {
                if data.keys.iter().any(|k| k == key) {
                    installed.push(key.clone());
                }
            }
        }
    }
    AuthOutcome {
        ok: true,
        email: resp.email,
        installed_keys: installed,
        plugins: resp.plugins.unwrap_or_default(),
        active_until: resp.active_until,
        expired: resp.expired,
    }
}
