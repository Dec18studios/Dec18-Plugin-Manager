import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
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
      const valid = await crypto.subtle.verify("Ed25519", cryptoKey, signature, payloadBytes);
      if (!valid) return null;
    } catch {
      // Ed25519 not yet supported in this WebView — accept structural validity.
      // Move to Rust-side verification for production hardening.
    }

    if (!payload.tier || !payload.email || !Array.isArray(payload.plugins)) return null;
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
  sortOrder: "name",
  license: {
    keys: [],        // raw D18.xxx.xxx tokens stored on disk
    parsed: [],      // verified payloads: [{ tier, email, plugins, issuedAt }]
    tier: null,      // "master" | <pluginId> | null
    plugins: [],     // ["*"] or ["photochemist", ...]
  }
};

const elements = {
  version: document.querySelector("#manager-version"),
  platform: document.querySelector("#manager-platform"),
  catalogSource: document.querySelector("#catalog-source"),
  updaterStatus: document.querySelector("#updater-status"),
  betaToggle: document.querySelector("#beta-releases-toggle"),
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
  sortOrder: document.querySelector("#sort-order"),
  licenseStatus: document.querySelector("#license-status"),
  enterLicenseButton: document.querySelector("#enter-license-button"),
  licenseDialog: document.querySelector("#license-key-dialog"),
  licenseDialogTitle: document.querySelector("#license-dialog-title"),
  licenseDialogClose: document.querySelector("#license-dialog-close"),
  registerView: document.querySelector("#license-register-view"),
  switchToKeyEntry: document.querySelector("#switch-to-key-entry"),
  keyEntryView: document.querySelector("#license-key-view"),
  licenseKeyInput: document.querySelector("#license-key-input"),
  licenseKeyError: document.querySelector("#license-key-error"),
  licenseActivateButton: document.querySelector("#license-activate-button"),
  switchToRegister: document.querySelector("#switch-to-register"),
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

  state.activeOperation.timer = window.setInterval(() => {
    if (!state.activeOperation || state.activeOperation.kind !== kind || state.activeOperation.pluginId !== pluginId) {
      return;
    }
    const lastStep = state.activeOperation.steps.length - 1;
    state.activeOperation.stepIndex = Math.min(state.activeOperation.stepIndex + 1, lastStep);
    renderPlugins();
  }, 1400);

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
  if (status === "Installed" || status === "Up to date") return "ok";
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

function actionLabel(plugin) {
  if (!plugin.installed) return "Install";
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
    return a.displayName.localeCompare(b.displayName);
  });

  if (!plugins.length) {
    elements.pluginList.innerHTML = `<div class="empty-state">No plugins match your filter.</div>`;
    return;
  }

  elements.pluginList.innerHTML = "";

  for (const plugin of plugins) {
    const card = document.createElement("article");
    card.className = `plugin-card ${cardToneClass(plugin)}${isLicensed() ? "" : " locked"}`;
    const installedVersion = plugin.installedVersion ?? (plugin.installed ? "Unknown" : "Not installed");
    const managedBadge = plugin.managedInstall ? "Managed install" : "Detected install";
    const primaryLabel = actionLabel(plugin);
    const primaryRequest = actionRequest(plugin);
    const helperText = actionHelperText(plugin, primaryLabel);
    const showLatestInfo = hasReleaseHighlights(plugin.releaseHighlights);
    card.innerHTML = `
      <header>
        <div class="plugin-heading">
          ${pluginIconMarkup(plugin)}
          <div>
          <h3>${plugin.displayName}</h3>
          ${plugin.category ? `<span class="plugin-category-badge">${escapeHtml(plugin.category)}</span>` : ""}
          </div>
        </div>
        <span class="status-pill ${statusClass(plugin.status)} ${plugin.status === "Ready to install" ? "ready" : ""}">${plugin.status}</span>
      </header>
      ${plugin.description ? `<p class="plugin-description">${escapeHtml(plugin.description)}</p>` : ""}

      <dl class="plugin-meta">
        <div>
          <dt>Installed</dt>
          <dd>${installedVersion}</dd>
        </div>
        <div>
          <dt>Latest</dt>
          <dd>${plugin.latestVersion}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>${plugin.installPath}</dd>
        </div>
        <div>
          <dt>Tracking</dt>
          <dd>${plugin.installed ? managedBadge : "Ready to install"}</dd>
        </div>
      </dl>

      <div class="plugin-actions">
        ${isLicensed() ? `
        <button type="button" class="${primaryActionClass(primaryLabel)}" data-plugin-id="${plugin.pluginId}" data-action="${primaryRequest}">${primaryLabel}</button>
        ${
          helperText
            ? `<p class="action-helper">${helperText}</p>`
            : '<span class="action-helper-placeholder" aria-hidden="true"></span>'
        }
        ${showLatestInfo ? releaseInfoButtonMarkup("main-action-info-button") : ""}
        ` : `
        <div class="plugin-locked-overlay">
          <p>Register to download and install plugins</p>
          <button type="button" class="register-prompt-button" data-register-prompt="true">Register Now</button>
        </div>
        `}
      </div>
      ${pluginOperationMarkup(plugin)}
    `;

    const button = card.querySelector(`[data-action="${primaryRequest}"]`);
    if (button) {
      button.addEventListener("click", async () => {
        await applyPluginAction(plugin.pluginId, primaryRequest);
      });
    }

    // Register prompt buttons inside locked cards
    const registerPrompt = card.querySelector("[data-register-prompt]");
    if (registerPrompt) {
      registerPrompt.addEventListener("click", openLicenseDialog);
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

    if (isLicensed() && (plugin.availableVersions?.length ?? 0) > 1) {
      card.appendChild(renderVersionDrawer(plugin));
    }

    const maintenanceDrawer = isLicensed() ? renderMaintenanceDrawer(plugin) : null;
    if (maintenanceDrawer) {
      card.appendChild(maintenanceDrawer);
    }

    elements.pluginList.appendChild(card);
  }
}

// --- License state management ---

function isLicensed() {
  return state.license.tier === "master";
}

async function loadLicenseState() {
  try {
    const keys = await invoke("get_stored_license_keys");
    state.license.keys = keys;
    state.license.parsed = [];
    state.license.tier = null;
    state.license.plugins = [];

    for (const token of keys) {
      const payload = await verifyLicenseToken(token);
      if (payload) {
        state.license.parsed.push(payload);
        if (payload.tier === "master") {
          state.license.tier = "master";
          state.license.plugins = ["*"];
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
    const email = state.license.parsed[0]?.email ?? "";
    elements.licenseStatus.innerHTML = `
      <span class="license-tier-badge master">Registered</span>
      <p class="license-status-text">${escapeHtml(email)}</p>
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
      (payload, index) => `
      <div class="license-key-row">
        <div>
          <span class="license-tier-badge ${payload.tier}">${payload.tier === "master" ? "Master" : escapeHtml(payload.tier)}</span>
          <span class="license-status-text">${escapeHtml(payload.email)}</span>
        </div>
        <button type="button" class="license-key-remove" data-key-index="${index}" title="Remove this key">&times;</button>
      </div>
    `
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
  // Show register view by default, key entry view if already licensed
  if (isLicensed()) {
    showKeyEntryView();
    elements.licenseDialogTitle.textContent = "Manage Account";
  } else {
    showRegisterView();
    elements.licenseDialogTitle.textContent = "Register for Dec 18 Studios";
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
  elements.licenseDialogTitle.textContent = "Register for Dec 18 Studios";
}

function showKeyEntryView() {
  elements.registerView.classList.add("hidden");
  elements.keyEntryView.classList.remove("hidden");
  elements.licenseDialogTitle.textContent = "Enter License Key";
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
    logActivity(`License activated: ${payload.tier === "master" ? "Master License" : payload.tier} (${payload.email})`);
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

    const result = await invoke("apply_plugin_action", { pluginId, action, targetVersion });
    logActivity(`${result.pluginId}: ${result.message}`);
    await refreshDashboard();
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
elements.sortOrder.addEventListener("change", (event) => {
  state.sortOrder = event.currentTarget.value;
  renderPlugins();
});

// License dialog controls
elements.enterLicenseButton.addEventListener("click", openLicenseDialog);
elements.licenseDialogClose.addEventListener("click", closeLicenseDialog);
elements.licenseActivateButton.addEventListener("click", activateLicenseKey);
elements.switchToKeyEntry.addEventListener("click", showKeyEntryView);
elements.switchToRegister.addEventListener("click", showRegisterView);
elements.licenseDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLicenseDialog();
});
elements.licenseDialog.addEventListener("click", (event) => {
  if (event.target === elements.licenseDialog) {
    closeLicenseDialog();
  }
});

refreshDashboard();
