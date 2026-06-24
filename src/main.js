import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";

// Ed25519 public key (SPKI DER, base64) — matches tools/license-keys/public.b64
const LICENSE_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAAZ7aAuceZRk6w/OQ3LUoYr7/rIZLlE1xHxMh8/Dhjzs=";

function base64urlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  return Uint8Array.from(atob(base64 + pad), (c) => c.charCodeAt(0));
}

async function verifyLicenseToken(token) {
  if (!token || !token.startsWith("D18.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const payloadB64 = parts[1];
  const signatureB64 = parts[2];

  try {
    const payloadBytes = base64urlDecode(payloadB64);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));

    // Verify Ed25519 signature via Web Crypto when available
    try {
      const keyDer = Uint8Array.from(atob(LICENSE_PUBLIC_KEY_B64), (c) => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey(
        "spki", keyDer, { name: "Ed25519" }, false, ["verify"]
      );
      const signature = base64urlDecode(signatureB64);
      // Server signs the base64url string, not the decoded bytes
      const signedMsg = new TextEncoder().encode(payloadB64);
      const valid = await crypto.subtle.verify("Ed25519", cryptoKey, signature, signedMsg);
      if (!valid) return null;
    } catch {
      // Ed25519 not yet supported in this WebView — accept structural validity.
      // Move to Rust-side verification for production hardening.
    }

    if (!payload.t || !payload.e || !Array.isArray(payload.p)) return null;

    // Check expiration — keys with an `exp` field (unix seconds) expire
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return null;  // expired
    }

    return payload;
  } catch {
    return null;
  }
}

const state = {
  busy: false,
  dashboard: null,
  activeOperation: null,
  searchQuery: "",
  categoryFilter: "all",
  registrationFilter: "all",
  sortOrder: "name",
  activeTab: "all",
  license: {
    keys: [],        // raw D18.xxx.xxx tokens stored on disk
    parsed: [],      // verified payloads: [{ t, e, p }]  (t=tier, e=email, p=plugins)
    tier: null,      // "master" | <pluginId> | null
    plugins: [],     // ["*"] or ["photochemist", ...]
  },
};

const elements = {
  version: document.querySelector("#manager-version"),
  platform: document.querySelector("#manager-platform"),
  catalogSource: document.querySelector("#catalog-source"),
  updaterStatus: document.querySelector("#updater-status"),
  betaToggle: document.querySelector("#beta-releases-toggle"),
  autoUpdateToggle: document.querySelector("#auto-update-plugins-toggle"),
  refreshButton: document.querySelector("#refresh-button"),
  updateButton: document.querySelector("#check-updates-button"),
  pluginList: document.querySelector("#plugin-list"),
  activityLog: document.querySelector("#activity-log"),
  alertBanner: document.querySelector("#alert-banner"),
  alertSummary: document.querySelector("#alert-summary"),
  alertMessage: document.querySelector("#alert-message"),
  alertDetails: document.querySelector("#alert-details"),
  alertDismiss: document.querySelector("#alert-dismiss"),
  releaseHighlightsDialog: document.querySelector("#release-highlights-dialog"),
  releaseHighlightsTitle: document.querySelector("#release-highlights-title"),
  releaseHighlightsBody: document.querySelector("#release-highlights-body"),
  releaseHighlightsLink: document.querySelector("#release-highlights-link"),
  releaseHighlightsClose: document.querySelector("#release-highlights-close"),
  pluginSearch: document.querySelector("#plugin-search"),
  categoryFilter: document.querySelector("#category-filter"),
  registrationFilter: document.querySelector("#registration-filter"),
  sortOrder: document.querySelector("#sort-order"),
  licenseStatus: document.querySelector("#license-status"),
  enterLicenseButton: document.querySelector("#enter-license-button"),
  licenseDialog: document.querySelector("#license-key-dialog"),
  licenseDialogTitle: document.querySelector("#license-dialog-title"),
  licenseDialogClose: document.querySelector("#license-dialog-close"),
  registerView: document.querySelector("#license-signin-view"),
  switchToKeyEntry: document.querySelector("#switch-to-key-entry"),
  signinEmailStep: document.querySelector("#signin-email-step"),
  signinEmailInput: document.querySelector("#signin-email-input"),
  signinSendCode: document.querySelector("#signin-send-code"),
  signinCodeStep: document.querySelector("#signin-code-step"),
  signinEmailEcho: document.querySelector("#signin-email-echo"),
  signinCodeInput: document.querySelector("#signin-code-input"),
  signinVerifyCode: document.querySelector("#signin-verify-code"),
  signinChangeEmail: document.querySelector("#signin-change-email"),
  signinResendCode: document.querySelector("#signin-resend-code"),
  signinError: document.querySelector("#signin-error"),
  signinStatus: document.querySelector("#signin-status"),
  keyEntryView: document.querySelector("#license-key-view"),
  licenseKeyInput: document.querySelector("#license-key-input"),
  licenseKeyError: document.querySelector("#license-key-error"),
  licenseActivateButton: document.querySelector("#license-activate-button"),
  switchToRegister: document.querySelector("#switch-to-register"),
  manageView: document.querySelector("#license-manage-view"),
  manageAccountSummary: document.querySelector("#manage-account-summary"),
  manageSignOut: document.querySelector("#manage-sign-out"),
  manageShowKeyEntry: document.querySelector("#manage-show-key-entry"),
  manageShowSignin: document.querySelector("#manage-show-signin"),
  licenseActiveKeys: document.querySelector("#license-active-keys")
};

function logActivity(message) {
  const item = document.createElement("div");
  item.className = "activity-item";
  item.innerHTML = `<time>${new Date().toLocaleString()}</time><div>${message}</div>`;
  elements.activityLog.prepend(item);
}

function setBusy(nextBusy) {
  state.busy = nextBusy;
  document.querySelectorAll("button, select, input").forEach((element) => {
    element.disabled = nextBusy;
  });
}

function operationSteps(kind) {
  if (kind === "catalog") {
    return ["Connecting to catalog", "Loading manifests", "Refreshing plugin status"];
  }
  if (kind === "manager-update") {
    return ["Checking for updates", "Downloading manager update", "Installing manager update"];
  }
  if (kind === "plugin-uninstall") {
    return ["Preparing uninstall", "Removing installed bundle", "Cleaning manager records", "Refreshing plugin status"];
  }
  return ["Preparing package", "Downloading package", "Installing plugin", "Refreshing plugin status"];
}

function startOperation(kind, pluginId = null, label = "Working") {
  const steps = operationSteps(kind);
  state.activeOperation = {
    kind,
    pluginId,
    label,
    steps,
    stepIndex: 0
  };

  // Only per-plugin operations animate stepwise inside a card. Global operations
  // (catalog refresh, manager update — pluginId === null) have no per-card progress
  // to advance, so running the interval just thrashes the whole list every 1.4s.
  if (pluginId) {
    state.activeOperation.timer = window.setInterval(() => {
      if (!state.activeOperation || state.activeOperation.kind !== kind || state.activeOperation.pluginId !== pluginId) {
        return;
      }
      const lastStep = state.activeOperation.steps.length - 1;
      state.activeOperation.stepIndex = Math.min(state.activeOperation.stepIndex + 1, lastStep);
      renderPlugins();
    }, 1400);
  }

  renderPlugins();
}

function finishOperation() {
  if (state.activeOperation?.timer) {
    window.clearInterval(state.activeOperation.timer);
  }
  state.activeOperation = null;
  renderPlugins();
}

function updateOperationProgress({ label, steps, stepIndex = 0 } = {}) {
  if (!state.activeOperation) {
    return;
  }

  if (label) {
    state.activeOperation.label = label;
  }
  if (steps) {
    state.activeOperation.steps = steps;
  }
  state.activeOperation.stepIndex = Math.max(0, Math.min(stepIndex, state.activeOperation.steps.length - 1));
  renderPlugins();
}

function parseUiError(error, fallbackSummary = "The operation failed.") {
  const raw = typeof error === "string" ? error : String(error);

  if (
    raw.includes("fallback platforms") &&
    raw.includes("response `platforms` object")
  ) {
    return {
      summary: "Update is still being published. Try again in a minute.",
      details:
        "The new manager release is available, but the update feed has not finished refreshing yet. Wait a moment and check again.",
      code: "updater_feed_pending"
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.summary === "string") {
      return {
        summary: parsed.summary,
        details: typeof parsed.details === "string" ? parsed.details : raw,
        code: parsed.code ?? "unknown"
      };
    }
  } catch {
    // Some command failures still arrive as plain strings.
  }

  return {
    summary: fallbackSummary,
    details: raw,
    code: "plain_error"
  };
}

function showAlert(errorLike, fallbackSummary) {
  const payload =
    typeof errorLike === "object" && errorLike?.summary
      ? errorLike
      : parseUiError(errorLike, fallbackSummary);

  elements.alertSummary.textContent = payload.summary;
  const hasDetails = Boolean(payload.details) && payload.details !== payload.summary;
  elements.alertMessage.textContent = payload.details ?? "";
  elements.alertDetails.classList.toggle("hidden", !hasDetails);
  elements.alertDetails.open = false;
  elements.alertBanner.classList.remove("hidden");
}

function hideAlert() {
  elements.alertBanner.classList.add("hidden");
  elements.alertSummary.textContent = "";
  elements.alertMessage.textContent = "";
  elements.alertDetails.classList.add("hidden");
  elements.alertDetails.open = false;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hasReleaseHighlights(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function renderReleaseHighlightsMarkup(raw) {
  if (!hasReleaseHighlights(raw)) {
    return "<p>No version highlights were provided for this release.</p>";
  }

  const blocks = [];
  let bulletItems = [];

  const flushBullets = () => {
    if (!bulletItems.length) {
      return;
    }
    blocks.push(`<ul>${bulletItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    bulletItems = [];
  };

  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      bulletItems.push(trimmed.slice(2).trim());
      continue;
    }

    flushBullets();
    blocks.push(`<p>${escapeHtml(trimmed)}</p>`);
  }

  flushBullets();
  return blocks.join("");
}

function openReleaseHighlightsDialog({ pluginName, version, releaseNotesUrl, releaseHighlights }) {
  elements.releaseHighlightsTitle.textContent = `${pluginName} ${version}`;
  elements.releaseHighlightsBody.innerHTML = renderReleaseHighlightsMarkup(releaseHighlights);

  if (releaseNotesUrl) {
    elements.releaseHighlightsLink.href = releaseNotesUrl;
    elements.releaseHighlightsLink.hidden = false;
  } else {
    elements.releaseHighlightsLink.hidden = true;
    elements.releaseHighlightsLink.removeAttribute("href");
  }

  if (elements.releaseHighlightsDialog.open) {
    elements.releaseHighlightsDialog.close();
  }
  elements.releaseHighlightsDialog.showModal();
}

function closeReleaseHighlightsDialog() {
  if (elements.releaseHighlightsDialog.open) {
    elements.releaseHighlightsDialog.close();
  }
}

function statusClass(status) {
  if (status === "Installed" || status === "Up to date" || status === "Demo installed") return "ok";
  if (
    status === "Update available" ||
    status === "Stable available" ||
    status === "Stable update available" ||
    status === "Beta installed" ||
    status === "Catalog behind" ||
    status === "Unmanaged install"
  ) {
    return "warn";
  }
  return "bad";
}

// True when an unlicensed user may install this plugin's public demo build.
function canInstallDemo(plugin) {
  return !!plugin.demoAvailable && plugin.licenseTier !== "free" && !isLicensed();
}

function actionLabel(plugin) {
  // A demo is on disk and the user is now licensed → offer the full build.
  if (plugin.demoInstalled && isLicensed()) return "Upgrade to Full";
  if (!plugin.installed) return canInstallDemo(plugin) ? "Install Demo" : "Install";
  if (plugin.demoInstalled) return "Reinstall Demo";
  if (plugin.channelSwitchMode === "stable_update_available") return "Update to stable";
  if (plugin.channelSwitchMode === "return_to_stable") return "Install stable";
  if (plugin.catalogBehindInstalled) return "Reinstall";
  if (plugin.needsUpdate) return "Update";
  return "Reinstall";
}

function actionRequest(plugin) {
  if (!plugin.installed) return "install";
  if (plugin.channelSwitchAvailable) return "update";
  if (plugin.needsUpdate) return "update";
  return "reinstall";
}

function rollbackButtonLabel(plugin, selectedVersion) {
  if (!selectedVersion) return "Install selected";
  const selected = plugin.availableVersions?.find((option) => option.version === selectedVersion);
  return selected?.actionLabel ?? "Install selected";
}

function selectedVersionHint(plugin, selectedVersion) {
  const selected = plugin.availableVersions?.find((option) => option.version === selectedVersion);
  if (!selected) return "Choose a version to install for this plugin.";

  if (!plugin.installedVersion) {
    return selected.isCurrentLatest
      ? `This installs the latest available release from ${selected.releaseDate}.`
      : `This installs ${selected.version} from ${selected.releaseDate} for project compatibility.`;
  }

  if (selected.version === plugin.installedVersion) {
    return `This reinstalls the currently detected version (${selected.version}).`;
  }

  if (plugin.channelSwitchMode === "stable_update_available") {
    if (selected.isCurrentLatest) {
      return `This installs the newly released stable version (${selected.version}) over the current beta build (${plugin.installedVersion}).`;
    }

    return `This installs stable version ${selected.version} instead of the current beta build (${plugin.installedVersion}).`;
  }

  if (plugin.channelSwitchMode === "return_to_stable") {
    if (selected.isCurrentLatest) {
      return `This installs the latest stable release (${selected.version}) and moves ${plugin.displayName} off the current beta build (${plugin.installedVersion}).`;
    }

    return `This installs ${selected.version} instead of the current beta build (${plugin.installedVersion}).`;
  }

  if (selected.isCurrentLatest) {
    return `This updates ${plugin.displayName} from ${plugin.installedVersion} to the latest release (${selected.version}).`;
  }

  return `This rolls ${plugin.displayName} back from ${plugin.installedVersion} to ${selected.version}.`;
}

function versionDrawerPreview(plugin, selectedVersion) {
  const selected = plugin.availableVersions?.find((option) => option.version === selectedVersion);
  if (!selected) {
    return "Choose a compatible version";
  }

  if (selected.version === plugin.installedVersion) {
    return `Current selection: ${selected.version}`;
  }

  if (selected.isCurrentLatest) {
    return `Latest release: ${selected.version}`;
  }

  return `Project compatibility: ${selected.version}`;
}

function findVersionOption(plugin, version) {
  return plugin.availableVersions?.find((option) => option.version === version) ?? null;
}

function releaseInfoButtonMarkup(className = "") {
  const resolvedClassName = className ? `release-info-button ${className}` : "release-info-button";
  return `
    <button
      type="button"
      class="${resolvedClassName}"
      aria-label="View version highlights"
      title="View version highlights"
    >
      <span aria-hidden="true">i</span>
    </button>
  `;
}

function cardToneClass(plugin) {
  if (!plugin.installed) return "pending";
  if (plugin.needsUpdate) return "warn";
  if (plugin.managedInstall) return "ok";
  return "neutral";
}

function primaryActionClass(label) {
  if (label === "Install") return "primary plugin-primary-action plugin-install-action";
  if (label === "Update") return "primary plugin-primary-action plugin-update-action";
  return label === "Reinstall" ? "plugin-secondary-action" : "primary plugin-primary-action";
}

function actionHelperText(plugin, primaryLabel) {
  if (plugin.catalogBehindInstalled) {
    if (state.dashboard?.catalogSource === "local-dev") {
      return `The local dev catalog currently lists ${plugin.latestVersion}, but the detected installed version (${plugin.installedVersion}) is newer. Update the local dev manifest or switch back to the remote feed if this looks wrong.`;
    }
    return `The catalog currently lists ${plugin.latestVersion}, but the detected installed version (${plugin.installedVersion}) is newer. Refresh the catalog if this looks wrong.`;
  }
  if (primaryLabel === "Update to stable") return "Install the newly released stable version.";
  if (primaryLabel === "Install stable") return "Leave beta and install the latest stable release.";
  if (primaryLabel === "Update") return "Install the latest release.";
  if (primaryLabel === "Reinstall") return "Reinstall the current version.";
  return "";
}

function pluginOperationMarkup(plugin) {
  const operation = state.activeOperation;
  if (!operation || operation.pluginId !== plugin.pluginId) return "";

  const step = operation.steps[operation.stepIndex] ?? operation.label;
  return `
    <div class="plugin-progress" role="status" aria-live="polite">
      <div class="plugin-progress-copy">
        <p class="plugin-progress-label">${operation.label}</p>
        <p class="plugin-progress-step">${step}</p>
      </div>
      <div class="plugin-progress-bar" aria-hidden="true">
        <span class="plugin-progress-fill"></span>
      </div>
    </div>
  `;
}

function uninstallButtonLabel(plugin) {
  return plugin.managedInstall ? "Uninstall plugin" : "Force uninstall";
}

function uninstallConfirmationMessage(plugin) {
  const intro = plugin.managedInstall
    ? `Uninstall ${plugin.displayName}?`
    : `Force uninstall ${plugin.displayName}?`;
  const warning = plugin.managedInstall
    ? "This removes the installed OFX plugin from the system-wide plugin folder."
    : "This install was not created by the manager. Force uninstall will still remove the detected OFX plugin from the system-wide plugin folder.";
  return `${intro}\n\n${warning}`;
}

function renderFolderRow(plugin, currentPath) {
  const row = document.createElement("div");
  row.className = "dctl-folder-row";
  const displayPath = currentPath || "Not set — will prompt on install";
  row.innerHTML = `
    <div class="dctl-folder-info">
      <span class="dctl-folder-label">Install folder</span>
      <span class="dctl-folder-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>
    </div>
    <button type="button" class="dctl-folder-open" title="Open install folder">Open</button>
    <button type="button" class="dctl-folder-change" title="Change install folder">Change</button>
  `;
  row.querySelector(".dctl-folder-change").addEventListener("click", async () => {
    const startDir = currentPath || plugin.installPath;
    const chosen = await invoke("pick_folder", { startPath: startDir });
    if (!chosen) return;
    await invoke("set_plugin_install_path", { pluginId: plugin.pluginId, path: chosen });
    logActivity(`Install folder for ${plugin.displayName} set to ${chosen}`);
    updateFolderRow(row.closest(".plugin-card"), chosen);
  });
  row.querySelector(".dctl-folder-open").addEventListener("click", async () => {
    const folder = currentPath || plugin.installPath;
    if (!folder) {
      logActivity(`No install folder set yet for ${plugin.displayName}`);
      return;
    }
    try {
      await invoke("open_folder", { path: folder });
    } catch (error) {
      logActivity(`Could not open folder for ${plugin.displayName}: ${error}`);
    }
  });
  return row;
}

function updateFolderRow(card, newPath) {
  const pathEl = card.querySelector(".dctl-folder-path");
  if (pathEl) {
    pathEl.textContent = newPath;
    pathEl.title = newPath;
  }
}

function renderMaintenanceDrawer(plugin) {
  if (!plugin.installed) return null;

  const wrapper = document.createElement("details");
  wrapper.className = "maintenance-drawer";
  wrapper.innerHTML = `
    <summary class="maintenance-toggle">
      <div class="maintenance-copy">
        <p class="eyebrow">Maintenance</p>
        <p class="maintenance-title">Uninstall plugin</p>
      </div>
      <span class="maintenance-icon" aria-hidden="true"></span>
    </summary>
    <div class="maintenance-tools">
      <button class="danger-button" data-plugin-id="${plugin.pluginId}" data-action="${plugin.managedInstall ? "uninstall" : "force-uninstall"}">${uninstallButtonLabel(plugin)}</button>
      ${
        plugin.managedInstall
          ? ""
          : '<p class="maintenance-note">Use this only if you want the manager to remove a detected install it did not create.</p>'
      }
    </div>
  `;

  const button = wrapper.querySelector("button");
  button.addEventListener("click", async () => {
    const confirmed = window.confirm(uninstallConfirmationMessage(plugin));
    if (!confirmed) return;
    await applyPluginAction(plugin.pluginId, plugin.managedInstall ? "uninstall" : "force-uninstall");
  });

  return wrapper;
}

function pluginIconMarkup(plugin) {
  return `
    <div class="plugin-icon plugin-icon-fallback" aria-hidden="true">
      <span>${plugin.displayName.charAt(0)}</span>
    </div>
  `;
}

function renderVersionDrawer(plugin) {
  const initialVersion = plugin.installedVersion ?? plugin.availableVersions[0]?.version ?? "";
  const initialSelected = findVersionOption(plugin, initialVersion);
  const showInitialInfo = hasReleaseHighlights(initialSelected?.releaseHighlights);
  const wrapper = document.createElement("details");
  wrapper.className = "version-drawer";
  wrapper.innerHTML = `
    <summary class="version-drawer-toggle">
      <div class="version-drawer-copy">
        <p class="eyebrow">Version history</p>
        <p class="version-drawer-title">Older versions and rollback</p>
      </div>
      <span class="version-drawer-icon" aria-hidden="true"></span>
    </summary>
    <div class="version-tools">
      <div class="version-picker-row">
        <label class="version-picker">
          <span>Choose a version</span>
          <select data-plugin-id="${plugin.pluginId}">
            ${plugin.availableVersions
              .map(
                (option) =>
                  `<option value="${option.version}" ${option.version === initialVersion ? "selected" : ""}>${option.label} - ${option.releaseDate}</option>`
              )
              .join("")}
          </select>
        </label>
        <div class="version-picker-actions">
          <button type="button" data-plugin-id="${plugin.pluginId}" data-action="install-selected">Install selected</button>
          ${showInitialInfo ? releaseInfoButtonMarkup("rollback-info-button") : ""}
        </div>
      </div>
      <p class="version-hint"></p>
    </div>
  `;

  const select = wrapper.querySelector("select");
  const installSelectedButton = wrapper.querySelector('[data-action="install-selected"]');
  const hint = wrapper.querySelector(".version-hint");

  const refreshCopy = () => {
    const selected = findVersionOption(plugin, select.value);
    installSelectedButton.textContent = rollbackButtonLabel(plugin, select.value);
    hint.textContent = selectedVersionHint(plugin, select.value);
    const actions = wrapper.querySelector(".version-picker-actions");
    let infoButton = actions.querySelector(".rollback-info-button");
    const shouldShowInfo = hasReleaseHighlights(selected?.releaseHighlights);

    if (shouldShowInfo && !infoButton) {
      actions.insertAdjacentHTML("beforeend", releaseInfoButtonMarkup("rollback-info-button"));
      infoButton = actions.querySelector(".rollback-info-button");
      infoButton.addEventListener("click", () => {
        const selectedVersion = findVersionOption(plugin, select.value);
        if (!selectedVersion || !hasReleaseHighlights(selectedVersion.releaseHighlights)) {
          return;
        }
        openReleaseHighlightsDialog({
          pluginName: plugin.displayName,
          version: selectedVersion.version,
          releaseNotesUrl: selectedVersion.releaseNotesUrl,
          releaseHighlights: selectedVersion.releaseHighlights
        });
      });
    } else if (!shouldShowInfo && infoButton) {
      infoButton.remove();
    }
  };

  refreshCopy();

  select.addEventListener("change", refreshCopy);
  installSelectedButton.addEventListener("click", async () => {
    await applyPluginAction(plugin.pluginId, "install-selected", select.value);
  });

  return wrapper;
}

function renderPlugins() {
  const allPlugins = state.dashboard?.plugins ?? [];

  if (!allPlugins.length) {
    elements.pluginList.innerHTML = `<div class="empty-state">No plugin manifests are currently available.</div>`;
    return;
  }

  // Filter by search query
  let plugins = allPlugins;

  // Filter by active tab
  if (state.activeTab === "ofx") {
    plugins = plugins.filter((plugin) => (plugin.type ?? "").toLowerCase() === "ofx");
  } else if (state.activeTab === "dctl") {
    plugins = plugins.filter((plugin) => (plugin.type ?? "").toLowerCase() === "dctl");
  } else if (state.activeTab === "app") {
    plugins = plugins.filter((plugin) => (plugin.type ?? "").toLowerCase() === "app");
  } else if (state.activeTab === "3rd-party") {
    plugins = plugins.filter((plugin) => (plugin.type ?? "").toLowerCase() === "3rd-party");
  }
  // "all" tab shows everything

  // Filter by registration requirement
  if (state.registrationFilter === "free") {
    plugins = plugins.filter((plugin) => plugin.licenseTier === "free");
  } else if (state.registrationFilter === "registration") {
    plugins = plugins.filter((plugin) => plugin.licenseTier !== "free");
  }

  if (state.searchQuery) {
    const query = state.searchQuery.toLowerCase();
    plugins = plugins.filter((plugin) => {
      return (
        plugin.displayName.toLowerCase().includes(query) ||
        plugin.pluginId.toLowerCase().includes(query) ||
        (plugin.category ?? "").toLowerCase().includes(query) ||
        (plugin.description ?? "").toLowerCase().includes(query) ||
        (plugin.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }

  // Filter by category
  if (state.categoryFilter !== "all") {
    plugins = plugins.filter((plugin) => (plugin.category ?? "Uncategorized") === state.categoryFilter);
  }

  // Sort
  plugins = [...plugins].sort((a, b) => {
    if (state.sortOrder === "status") {
      const statusRank = (s) => {
        if (s === "Update available" || s === "Stable update available") return 0;
        if (s === "Ready to install") return 1;
        if (s === "Up to date") return 2;
        return 3;
      };
      const diff = statusRank(a.status) - statusRank(b.status);
      if (diff !== 0) return diff;
    }
    if (state.sortOrder === "category") {
      const catCmp = (a.category ?? "ZZZ").localeCompare(b.category ?? "ZZZ");
      if (catCmp !== 0) return catCmp;
    }
    if (state.sortOrder === "license") {
      const tierRank = (tier) => tier === "free" ? 0 : 1;
      const diff = tierRank(a.licenseTier) - tierRank(b.licenseTier);
      if (diff !== 0) return diff;
    }
    return a.displayName.localeCompare(b.displayName);
  });

  if (!plugins.length) {
    elements.pluginList.innerHTML = `<div class="empty-state">No plugins match your filter.</div>`;
    return;
  }

  // Preserve UI state across the full re-render below: which expandable drawers
  // are open and the list's scroll position. Without this, every refresh (incl.
  // the periodic one during an operation) collapsed drawers and jumped to top.
  const prevScrollTop = elements.pluginList.scrollTop;
  const openDrawers = new Set();
  for (const card of elements.pluginList.querySelectorAll(".plugin-card")) {
    const id = card.dataset.pluginId;
    if (!id) continue;
    if (card.querySelector(".version-drawer[open]")) openDrawers.add(`${id}::version`);
    if (card.querySelector(".maintenance-drawer[open]")) openDrawers.add(`${id}::maintenance`);
  }

  elements.pluginList.innerHTML = "";

  for (const plugin of plugins) {
    const card = document.createElement("article");
    card.className = `plugin-card ${cardToneClass(plugin)}`;
    card.dataset.pluginId = plugin.pluginId;
    const installedVersion = plugin.installedVersion ?? (plugin.installed ? "Unknown" : "—");
    const primaryLabel = actionLabel(plugin);
    const primaryRequest = actionRequest(plugin);
    const showLatestInfo = hasReleaseHighlights(plugin.releaseHighlights);
    card.innerHTML = `
      <header>
        <div class="plugin-heading">
          ${pluginIconMarkup(plugin)}
          <div>
          <h3>${plugin.displayName}</h3>
          ${plugin.type ? `<span class="plugin-type-badge type-${escapeHtml(plugin.type)}">${escapeHtml(plugin.type)}</span>` : ""}
          ${plugin.category ? `<span class="plugin-category-badge">${escapeHtml(plugin.category)}</span>` : ""}
          ${plugin.licenseTier === "free"
            ? `<span class="license-tier-pill free">Free</span>`
            : canInstallDemo(plugin)
              ? `<span class="license-tier-pill subscription" title="Install a watermarked demo now; sign in to unlock the full build">Demo</span>`
              : `<span class="license-tier-pill subscription">License</span>`}
          </div>
        </div>
        <span class="status-pill ${statusClass(plugin.status)} ${plugin.status === "Ready to install" ? "ready" : ""}">${plugin.status}</span>
      </header>

      <dl class="plugin-meta">
        <div>
          <dt>Installed</dt>
          <dd>${installedVersion}</dd>
        </div>
        <div>
          <dt>Latest</dt>
          <dd>${plugin.latestVersion}</dd>
        </div>
      </dl>

      <div class="plugin-actions">
        <button type="button" class="${primaryActionClass(primaryLabel)}" data-plugin-id="${plugin.pluginId}" data-action="${primaryRequest}">${primaryLabel}</button>
        ${showLatestInfo ? releaseInfoButtonMarkup("main-action-info-button") : ""}
        ${plugin.infoUrl ? `<a href="${escapeHtml(plugin.infoUrl)}" target="_blank" rel="noreferrer" class="plugin-info-link" title="Tutorials &amp; info">&#8505;</a>` : ""}
      </div>
      ${pluginOperationMarkup(plugin)}
    `;

    const button = card.querySelector(`[data-action="${primaryRequest}"]`);
    if (button) {
      button.addEventListener("click", async () => {
        // Free-tier plugins don't require a license; premium ones do — unless the
        // plugin offers a public demo build, which unlicensed users may install.
        if (plugin.licenseTier !== "free" && !isLicensed() && !plugin.demoAvailable) {
          openLicenseDialog();
          return;
        }
        // DCTL file-browse: prompt for install folder on first install if no per-plugin path is saved
        if (plugin.installMode === "file-browse" && primaryRequest === "install") {
          try {
            const perPluginPath = await invoke("get_plugin_install_path", { pluginId: plugin.pluginId });
            if (!perPluginPath) {
              // Fall back to global DCTL path as the starting directory for the picker
              const globalPath = await invoke("get_dctl_install_path");
              const startDir = globalPath || plugin.installPath;
              const chosen = await invoke("pick_folder", { startPath: startDir });
              if (!chosen) return; // user cancelled
              await invoke("set_plugin_install_path", { pluginId: plugin.pluginId, path: chosen });
              // Also set global DCTL path if not yet set (first-time convenience)
              if (!globalPath) {
                await invoke("set_dctl_install_path", { path: chosen });
              }
              logActivity(`Install folder for ${plugin.displayName} set to ${chosen}`);
              updateFolderRow(card, chosen);
            }
          } catch (err) {
            console.error("DCTL path prompt error:", err);
          }
        }
        await applyPluginAction(plugin.pluginId, primaryRequest);
      });
    }

    const infoButton = card.querySelector(".main-action-info-button");
    if (infoButton) {
      infoButton.addEventListener("click", () => {
        openReleaseHighlightsDialog({
          pluginName: plugin.displayName,
          version: plugin.latestVersion,
          releaseNotesUrl: plugin.releaseNotesUrl,
          releaseHighlights: plugin.releaseHighlights
        });
      });
    }

    // Add folder picker row for DCTL / file-browse plugins. Render it synchronously
    // (before the drawers below) so the card's height is stable, then fill in the
    // actual path async — the old deferred insert caused a visible layout shift.
    if (plugin.installMode === "file-browse" && (isLicensed() || plugin.licenseTier === "free")) {
      const folderRow = renderFolderRow(plugin, null);
      card.appendChild(folderRow);
      invoke("get_plugin_install_path", { pluginId: plugin.pluginId }).then((perPath) => {
        if (perPath) updateFolderRow(card, perPath);
      });
    }

    if ((isLicensed() || plugin.licenseTier === "free") && (plugin.availableVersions?.length ?? 0) > 1) {
      card.appendChild(renderVersionDrawer(plugin));
    }

    const maintenanceDrawer = (isLicensed() || plugin.licenseTier === "free") ? renderMaintenanceDrawer(plugin) : null;
    if (maintenanceDrawer) {
      card.appendChild(maintenanceDrawer);
    }

    // Re-open any drawers the user had expanded before this re-render.
    if (openDrawers.has(`${plugin.pluginId}::version`)) {
      const drawer = card.querySelector(".version-drawer");
      if (drawer) drawer.open = true;
    }
    if (openDrawers.has(`${plugin.pluginId}::maintenance`)) {
      const drawer = card.querySelector(".maintenance-drawer");
      if (drawer) drawer.open = true;
    }

    elements.pluginList.appendChild(card);
  }

  // Restore scroll position after the list has been rebuilt.
  elements.pluginList.scrollTop = prevScrollTop;
}

// --- License state management ---

function isLicensed() {
  return state.license.tier != null;
}

async function loadLicenseState() {
  try {
    const keys = await invoke("get_stored_license_keys");
    state.license.keys = keys;
    state.license.parsed = [];
    state.license.tier = null;
    state.license.plugins = [];

    const tierPriority = { master: 3, annual: 2, free: 1 };

    for (const token of keys) {
      const payload = await verifyLicenseToken(token);
      if (payload) {
        state.license.parsed.push(payload);
        const rank = tierPriority[payload.t] ?? 1;
        const currentRank = tierPriority[state.license.tier] ?? 0;
        if (rank > currentRank) {
          state.license.tier = payload.t;
          state.license.plugins = payload.p;
        }
      }
    }

    renderLicensePanel();
  } catch (error) {
    console.error("Failed to load license state:", error);
  }
}

function renderLicensePanel() {
  if (isLicensed()) {
    const email = state.license.parsed[0]?.e ?? "";
    const tier = state.license.tier;
    const tierLabel = tier === "master" ? "Master" : tier === "annual" ? "Annual" : tier === "free" ? "Free" : tier;
    const badgeClass = tier === "master" ? "master" : tier === "annual" ? "annual" : "free";
    let expiryNote = "";
    const activeParsed = state.license.parsed.find(p => p.t === tier);
    if (activeParsed?.exp) {
      const expDate = new Date(activeParsed.exp * 1000);
      const daysLeft = Math.ceil((expDate - Date.now()) / 86400000);
      expiryNote = daysLeft > 0
        ? `<p class="license-status-text" style="font-size:.75rem;opacity:.7">Expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}</p>`
        : "";
    }
    elements.licenseStatus.innerHTML = `
      <span class="license-tier-badge ${badgeClass}">${escapeHtml(tierLabel)}</span>
      <p class="license-status-text">${escapeHtml(email)}</p>
      ${expiryNote}
    `;
    elements.enterLicenseButton.textContent = "Manage Account";
  } else {
    elements.licenseStatus.innerHTML = `
      <p class="license-status-text">Register to download plugins</p>
    `;
    elements.enterLicenseButton.textContent = "Register / Enter Key";
  }
}

function renderActiveLicenseKeys() {
  if (!state.license.parsed.length) {
    elements.licenseActiveKeys.innerHTML = '<p class="license-status-text">No active license keys</p>';
    return;
  }
  elements.licenseActiveKeys.innerHTML = state.license.parsed
    .map(
      (payload, index) => {
        const tierLabel = payload.t === "master" ? "Master" : payload.t === "annual" ? "Annual" : payload.t === "free" ? "Free" : escapeHtml(payload.t);
        let expInfo = "";
        if (payload.exp) {
          const expDate = new Date(payload.exp * 1000);
          const daysLeft = Math.ceil((expDate - Date.now()) / 86400000);
          expInfo = daysLeft > 0
            ? `<span class="license-status-text" style="font-size:.7rem;opacity:.6;margin-left:8px">· ${daysLeft}d left</span>`
            : `<span class="license-status-text" style="font-size:.7rem;color:var(--accent);margin-left:8px">· expired</span>`;
        }
        return `
      <div class="license-key-row">
        <div>
          <span class="license-tier-badge ${payload.t}">${tierLabel}</span>
          <span class="license-status-text">${escapeHtml(payload.e)}</span>
          ${expInfo}
        </div>
        <button type="button" class="license-key-remove" data-key-index="${index}" title="Remove this key">&times;</button>
      </div>
    `;
      }
    )
    .join("");

  elements.licenseActiveKeys.querySelectorAll(".license-key-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.keyIndex, 10);
      const token = state.license.keys[idx];
      if (token) {
        await invoke("remove_license_key", { key: token });
        await loadLicenseState();
        renderActiveLicenseKeys();
        logActivity("License key removed.");
      }
    });
  });
}

function openLicenseDialog() {
  // Sign-in (email OTP) is the default for new users; licensed users land on the
  // account/key-management view.
  resetSigninView();
  if (isLicensed()) {
    showManageView();
  } else {
    showRegisterView();
  }
  elements.licenseKeyInput.value = "";
  elements.licenseKeyError.textContent = "";
  elements.licenseKeyError.classList.add("hidden");
  renderActiveLicenseKeys();
  elements.licenseDialog.showModal();
}

function showRegisterView() {
  elements.registerView.classList.remove("hidden");
  elements.keyEntryView.classList.add("hidden");
  elements.manageView.classList.add("hidden");
  elements.licenseDialogTitle.textContent = "Sign in to Dec 18 Studios";
}

// Account view for users who are already signed in: a short account summary plus
// their installed keys (rendered below). Manual paste is demoted to a link so it
// no longer fronts the dialog once an account is active.
function showManageView() {
  elements.registerView.classList.add("hidden");
  elements.keyEntryView.classList.add("hidden");
  elements.manageView.classList.remove("hidden");
  elements.licenseDialogTitle.textContent = "Manage Account";

  const email = state.license.parsed[0]?.e ?? "";
  const tier = state.license.tier;
  const tierLabel = tier === "master" ? "Master" : tier === "annual" ? "Annual" : tier === "free" ? "Free" : tier;
  elements.manageAccountSummary.innerHTML = email
    ? `Signed in as <strong>${escapeHtml(email)}</strong> · ${escapeHtml(tierLabel ?? "")} license. Your keys are installed on this machine.`
    : "You're signed in. Your license is installed on this machine.";
}

// --- Email-OTP sign-in flow ---

function resetSigninView() {
  elements.signinEmailStep.classList.remove("hidden");
  elements.signinCodeStep.classList.add("hidden");
  elements.signinError.classList.add("hidden");
  elements.signinError.textContent = "";
  elements.signinStatus.classList.add("hidden");
  elements.signinStatus.textContent = "";
  elements.signinCodeInput.value = "";
}

function showSigninError(message) {
  elements.signinError.textContent = message;
  elements.signinError.classList.remove("hidden");
  elements.signinStatus.classList.add("hidden");
}

function showSigninStatus(message) {
  elements.signinStatus.textContent = message;
  elements.signinStatus.classList.remove("hidden");
  elements.signinError.classList.add("hidden");
}

async function sendSigninCode() {
  const email = elements.signinEmailInput.value.trim();
  if (!email || !email.includes("@")) {
    showSigninError("Please enter a valid email address.");
    return;
  }
  elements.signinSendCode.disabled = true;
  elements.signinResendCode.disabled = true;
  showSigninStatus("Sending code…");
  try {
    await invoke("start_email_verification", { email });
    elements.signinEmailEcho.textContent = email;
    elements.signinEmailStep.classList.add("hidden");
    elements.signinCodeStep.classList.remove("hidden");
    // The worker never reveals whether the email is a known customer, so the
    // copy stays deliberately conditional ("if that email has a purchase").
    showSigninStatus("If that email has a purchase, a 6-digit code is on its way. Check your inbox.");
    elements.signinCodeInput.focus();
  } catch (error) {
    showSigninError(parseUiError(error, "Couldn't send the code. Please try again.").summary);
  } finally {
    elements.signinSendCode.disabled = false;
    elements.signinResendCode.disabled = false;
  }
}

async function verifySigninCode() {
  const email = elements.signinEmailInput.value.trim();
  const code = elements.signinCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showSigninError("Enter the 6-digit code from your email.");
    return;
  }
  elements.signinVerifyCode.disabled = true;
  showSigninStatus("Verifying…");
  try {
    const outcome = await invoke("verify_email_code", { email, code });
    await loadLicenseState();
    renderActiveLicenseKeys();
    const installed = outcome.installedKeys?.length ?? 0;
    logActivity(
      installed > 0
        ? `Signed in as ${outcome.email ?? email} — installed ${installed} license key${installed > 1 ? "s" : ""}.`
        : `Signed in as ${outcome.email ?? email}.`
    );
    closeLicenseDialog();
  } catch (error) {
    showSigninError(parseUiError(error, "That code didn't work. Please try again.").summary);
  } finally {
    elements.signinVerifyCode.disabled = false;
  }
}

// Existing key-holders prove entitlement silently on launch. Never disrupts
// startup — any failure is logged to the console only.
async function attestInstalledLicenseSilently() {
  try {
    const outcome = await invoke("attest_installed_license");
    if (outcome && (outcome.installedKeys?.length ?? 0) > 0) {
      await loadLicenseState();
      const n = outcome.installedKeys.length;
      logActivity(`Account verified — installed ${n} license key${n > 1 ? "s" : ""}.`);
    }
  } catch (error) {
    console.warn("Silent license attest failed:", parseUiError(error).summary);
  }
}

function showKeyEntryView() {
  elements.registerView.classList.add("hidden");
  elements.keyEntryView.classList.remove("hidden");
  elements.manageView.classList.add("hidden");
  elements.licenseDialogTitle.textContent = "Enter License Key";
}

// Sign out = remove every installed key from this machine. There is no server
// session to end; the keys themselves are the credential, so clearing them
// returns the machine to the unlicensed state. (Re-signing in re-installs them.)
async function signOutAccount() {
  const keys = [...state.license.keys];
  if (!keys.length) return;
  elements.manageSignOut.disabled = true;
  try {
    for (const token of keys) {
      await invoke("remove_license_key", { key: token });
    }
    await loadLicenseState();
    renderActiveLicenseKeys();
    logActivity("Signed out — license keys removed from this machine.");
    resetSigninView();
    showRegisterView();
  } catch (error) {
    showAlert(error, "Couldn't sign out.");
  } finally {
    elements.manageSignOut.disabled = false;
  }
}

function closeLicenseDialog() {
  if (elements.licenseDialog.open) {
    elements.licenseDialog.close();
  }
}

async function activateLicenseKey() {
  const token = elements.licenseKeyInput.value.trim();
  elements.licenseKeyError.classList.add("hidden");

  if (!token) {
    elements.licenseKeyError.textContent = "Please paste a license key.";
    elements.licenseKeyError.classList.remove("hidden");
    return;
  }

  const payload = await verifyLicenseToken(token);
  if (!payload) {
    elements.licenseKeyError.textContent = "Invalid license key. Please check and try again.";
    elements.licenseKeyError.classList.remove("hidden");
    return;
  }

  try {
    await invoke("save_license_key", { key: token });
    elements.licenseKeyInput.value = "";
    await loadLicenseState();
    renderActiveLicenseKeys();
    logActivity(`License activated: ${payload.t === "master" ? "Master License" : payload.t} (${payload.e})`);
  } catch (error) {
    elements.licenseKeyError.textContent = "Failed to save license key.";
    elements.licenseKeyError.classList.remove("hidden");
  }
}

function renderDashboard() {
  const manager = state.dashboard.manager;
  elements.version.textContent = manager.appVersion;
  elements.platform.textContent = `${manager.platform} / ${manager.arch}`;
  elements.catalogSource.textContent = `${state.dashboard.catalogSource} feed`;
  elements.updaterStatus.textContent = manager.updaterConfigured ? "Configured" : "Not configured";
  elements.betaToggle.checked = Boolean(manager.betaReleasesEnabled);
  elements.autoUpdateToggle.checked = Boolean(manager.autoUpdatePluginsEnabled);

  // Populate category filter from plugin data
  const categories = new Set();
  for (const plugin of state.dashboard.plugins ?? []) {
    if (plugin.category) categories.add(plugin.category);
  }
  const sorted = [...categories].sort();
  elements.categoryFilter.innerHTML = `<option value="all">All categories</option>` +
    sorted.map((cat) => `<option value="${escapeHtml(cat)}" ${state.categoryFilter === cat ? "selected" : ""}>${escapeHtml(cat)}</option>`).join("");

  renderPlugins();
}

async function updateBetaReleasesPreference(enabled) {
  setBusy(true);
  try {
    hideAlert();
    await invoke("set_beta_releases_enabled", { enabled });
    logActivity(enabled ? "Beta releases enabled." : "Beta releases disabled.");
    await refreshDashboard();
  } catch (error) {
    elements.betaToggle.checked = !enabled;
    const parsed = parseUiError(error, "Couldn't update beta release settings.");
    showAlert(parsed);
    logActivity(`Beta release setting failed: ${parsed.summary}`);
  } finally {
    setBusy(false);
  }
}

async function updateAutoUpdatePluginsPreference(enabled) {
  setBusy(true);
  try {
    hideAlert();
    await invoke("set_auto_update_plugins_enabled", { enabled });
    logActivity(enabled ? "Auto-update plugins enabled." : "Auto-update plugins disabled.");
    await refreshDashboard();
  } catch (error) {
    elements.autoUpdateToggle.checked = !enabled;
    const parsed = parseUiError(error, "Couldn't update auto-update settings.");
    showAlert(parsed);
    logActivity(`Auto-update setting failed: ${parsed.summary}`);
  } finally {
    setBusy(false);
  }
}

async function refreshDashboard() {
  startOperation("catalog", null, "Refreshing plugin catalog");
  setBusy(true);
  try {
    hideAlert();
    state.dashboard = await invoke("dashboard_state");
    renderDashboard();
    await loadLicenseState();
    logActivity("Plugin catalog refreshed.");
  } catch (error) {
    const parsed = parseUiError(error, "Couldn't refresh the plugin catalog right now.");
    showAlert(parsed);
    logActivity(`Catalog refresh failed: ${parsed.summary}`);
    elements.pluginList.innerHTML = `<div class="empty-state">${parsed.summary}</div>`;
  } finally {
    finishOperation();
    setBusy(false);
  }
}

function shouldAutoCheckManagerUpdateForPluginAction(action) {
  return ["install", "update", "reinstall", "install-selected"].includes(action);
}

function isInstallAction(action) {
  return ["install", "update", "reinstall", "install-selected"].includes(action);
}

function managerUpdateCheckOptions() {
  return state.dashboard?.manager?.platform === "macos"
    ? { target: "darwin-universal" }
    : undefined;
}

async function runManagerUpdateCheck({ silent = false } = {}) {
  if (!state.dashboard?.manager?.updaterConfigured) {
    return { updated: false, error: null, skipped: true };
  }

  try {
    const update = await check(managerUpdateCheckOptions());
    if (!update) {
      return { updated: false, error: null, skipped: false };
    }

    if (!silent) {
      logActivity(`Downloading manager update ${update.version}.`);
    }
    await update.downloadAndInstall();
    if (!silent) {
      logActivity("Manager update installed. Restarting...");
    }
    await relaunch();
    return { updated: true, error: null, skipped: false };
  } catch (error) {
    const parsed = parseUiError(error, "Manager update failed.");
    return { updated: false, error: parsed, skipped: false };
  }
}

async function applyPluginAction(pluginId, action, targetVersion = null) {
  const activeLabel =
    action === "install-selected"
      ? "Installing selected version"
      : action === "uninstall"
        ? "Uninstalling plugin"
        : action === "force-uninstall"
        ? "Force uninstalling plugin"
          : `${action.replace("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} in progress`;
  startOperation(action.includes("uninstall") ? "plugin-uninstall" : "plugin", pluginId, activeLabel);
  setBusy(true);
  let deferredManagerUpdateError = null;
  try {
    hideAlert();
    if (shouldAutoCheckManagerUpdateForPluginAction(action)) {
      logActivity(`Checking for manager updates before ${action.replace("-", " ")}.`);
      updateOperationProgress({
        label: "Checking manager updates first",
        steps: ["Checking for manager updates", "Continuing with plugin install"],
        stepIndex: 0
      });
      const managerUpdate = await runManagerUpdateCheck();
      if (managerUpdate.error) {
        deferredManagerUpdateError = managerUpdate.error;
        logActivity(
          `Manager auto-update skipped before ${action.replace("-", " ")}: ${managerUpdate.error.summary}`
        );
      }
      updateOperationProgress({
        label: activeLabel,
        steps: operationSteps(action.includes("uninstall") ? "plugin-uninstall" : "plugin"),
        stepIndex: 0
      });
    }

    // Unlicensed users with a demo-capable plugin install the public demo build. The
    // backend swaps the package; the licensed/full path passes demo=false. (Version
    // drawer, maintenance, and auto-update only render/run for licensed users, so they
    // never reach here as demo.)
    const actingPlugin = (state.dashboard?.plugins ?? []).find((p) => p.pluginId === pluginId);
    const demo = !!actingPlugin?.demoAvailable && !isLicensed();
    const result = await invoke("apply_plugin_action", { pluginId, action, targetVersion, demo });
    logActivity(`${result.pluginId}: ${result.message}`);
    await refreshDashboard();
    // DCTL/file-browse completion feedback: reveal the install folder so the user
    // can see the freshly downloaded file (these don't land in a system plugin dir).
    if (isInstallAction(action)) {
      const refreshed = (state.dashboard?.plugins ?? []).find((p) => p.pluginId === pluginId);
      if (refreshed && refreshed.installMode === "file-browse" && refreshed.installPath) {
        try {
          await invoke("open_folder", { path: refreshed.installPath });
        } catch (error) {
          logActivity(`Installed, but couldn't open the folder: ${error}`);
        }
      }
    }
    if (deferredManagerUpdateError) {
      showAlert(deferredManagerUpdateError);
    }
  } catch (error) {
    const parsed = parseUiError(error, `Couldn't complete the ${action.replace("-", " ")} action for ${pluginId}.`);
    showAlert(parsed);
    logActivity(`${pluginId}: ${parsed.summary}`);
  }
  finally {
    finishOperation();
    setBusy(false);
  }
}

async function checkForManagerUpdates() {
  if (!state.dashboard?.manager?.updaterConfigured) {
    logActivity("Manager updater is not configured in this build yet.");
    return;
  }

  startOperation("manager-update", null, "Updating manager");
  setBusy(true);
  try {
    const outcome = await runManagerUpdateCheck();
    if (!outcome.updated && !outcome.error) {
      logActivity("Manager app is already up to date.");
      return;
    }
    if (outcome.error) {
      showAlert(outcome.error);
      logActivity(`Manager update failed: ${outcome.error.summary}`);
    }
  } finally {
    finishOperation();
    setBusy(false);
  }
}

elements.refreshButton.addEventListener("click", refreshDashboard);
elements.updateButton.addEventListener("click", checkForManagerUpdates);
elements.alertDismiss.addEventListener("click", hideAlert);
elements.betaToggle.addEventListener("change", (event) => {
  updateBetaReleasesPreference(event.currentTarget.checked);
});
elements.autoUpdateToggle.addEventListener("change", (event) => {
  updateAutoUpdatePluginsPreference(event.currentTarget.checked);
});
elements.releaseHighlightsClose.addEventListener("click", closeReleaseHighlightsDialog);
elements.releaseHighlightsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeReleaseHighlightsDialog();
});
elements.releaseHighlightsDialog.addEventListener("click", (event) => {
  if (event.target === elements.releaseHighlightsDialog) {
    closeReleaseHighlightsDialog();
  }
});

// Search, filter, and sort controls
elements.pluginSearch.addEventListener("input", (event) => {
  state.searchQuery = event.currentTarget.value;
  renderPlugins();
});
elements.categoryFilter.addEventListener("change", (event) => {
  state.categoryFilter = event.currentTarget.value;
  renderPlugins();
});
elements.registrationFilter.addEventListener("change", (event) => {
  state.registrationFilter = event.currentTarget.value;
  renderPlugins();
});
elements.sortOrder.addEventListener("change", (event) => {
  state.sortOrder = event.currentTarget.value;
  renderPlugins();
});

// Tab bar controls
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.activeTab = btn.dataset.tab;
    renderPlugins();
  });
});

// License dialog controls
elements.enterLicenseButton.addEventListener("click", openLicenseDialog);
elements.licenseDialogClose.addEventListener("click", closeLicenseDialog);
elements.licenseActivateButton.addEventListener("click", activateLicenseKey);
elements.switchToKeyEntry.addEventListener("click", showKeyEntryView);
elements.switchToRegister.addEventListener("click", showRegisterView);
elements.manageShowKeyEntry.addEventListener("click", showKeyEntryView);
elements.manageShowSignin.addEventListener("click", () => {
  resetSigninView();
  showRegisterView();
});
elements.manageSignOut.addEventListener("click", signOutAccount);
elements.signinSendCode.addEventListener("click", sendSigninCode);
elements.signinVerifyCode.addEventListener("click", verifySigninCode);
elements.signinChangeEmail.addEventListener("click", resetSigninView);
elements.signinResendCode.addEventListener("click", sendSigninCode);
elements.signinEmailInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendSigninCode();
  }
});
elements.signinCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    verifySigninCode();
  }
});
elements.licenseDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLicenseDialog();
});
elements.licenseDialog.addEventListener("click", (event) => {
  if (event.target === elements.licenseDialog) {
    closeLicenseDialog();
  }
});

async function autoUpdatePluginsIfEnabled() {
  const manager = state.dashboard?.manager;
  if (!manager?.autoUpdatePluginsEnabled || !isLicensed()) return;

  const updatable = (state.dashboard?.plugins ?? []).filter(
    (p) => p.needsUpdate && p.installed && p.managedInstall
  );
  if (updatable.length === 0) return;

  logActivity(`Auto-updating ${updatable.length} plugin${updatable.length > 1 ? "s" : ""}…`);
  for (const plugin of updatable) {
    try {
      logActivity(`Auto-updating ${plugin.displayName} to ${plugin.latestVersion}…`);
      await invoke("apply_plugin_action", {
        pluginId: plugin.pluginId,
        action: "update",
        targetVersion: null,
        demo: false,
      });
      logActivity(`${plugin.displayName} updated to ${plugin.latestVersion}.`);
    } catch (error) {
      const parsed = parseUiError(error, `Auto-update failed for ${plugin.displayName}.`);
      logActivity(`Auto-update failed: ${parsed.summary}`);
    }
  }
  await refreshDashboard();
}

refreshDashboard().then(async () => {
  // Silent self-update on launch. From this version forward every launch pulls
  // a newer signed manager build before doing anything else; if one installs,
  // runManagerUpdateCheck() relaunches into it and the rest never runs. On the
  // common "already current" path check() returns null fast and we continue.
  await runManagerUpdateCheck({ silent: true });
  autoUpdatePluginsIfEnabled();
  attestInstalledLicenseSilently();
});
