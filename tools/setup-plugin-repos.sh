#!/bin/bash
set -euo pipefail

# Setup script for Dec 18 Studios plugin repos
# Creates local folders, git init, manager-release-config.json, and pushes to GitHub

ORG="Dec18studios"
DCTL_ROOT="/Volumes/Server Sync Files/Private-DCTLS/Plugin Repos"
OFX_ROOT="/Volumes/Server Sync Files/Private-OFX-Builds/Plugin Repos"

# DCTL default install paths per platform
DCTL_MAC_PATH="/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL"
DCTL_WIN_PATH="C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL"
DCTL_LIN_PATH="/opt/resolve/LUT/DCTL"

# OFX install paths per platform
OFX_MAC_PATH="/Library/OFX/Plugins"
OFX_WIN_PATH="C:\\Program Files\\Common Files\\OFX\\Plugins"
OFX_LIN_PATH="/usr/OFX/Plugins"

HOST_RESOLVE='["Resolve", "DaVinci Resolve"]'
HOST_OFX='["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"]'

create_repo() {
  local dir="$1"
  local repo_name="$2"
  local display_name="$3"
  local plugin_id="$4"
  local config_json="$5"
  local description="$6"

  echo ""
  echo "=== Setting up $repo_name ==="

  mkdir -p "$dir"
  cd "$dir"

  # Write the release config
  echo "$config_json" > manager-release-config.json

  # Write a basic README
  cat > README.md << READMEEOF
# $display_name

$description

Part of the [Dec 18 Studios](https://dec18studios.com/color-grading-tools/) plugin collection.

## Installation

Install via the **Dec 18 Studios Plugin Manager** — download from [dec18studios.com](https://dec18studios.com).

## License

Proprietary — Dec 18 Studios. All rights reserved.
READMEEOF

  # Init git if not already
  if [ ! -d .git ]; then
    git init
    git branch -M main
  fi

  git add -A
  git commit -m "chore: initial repo setup with manager-release-config" --allow-empty 2>/dev/null || true

  # Create GitHub repo if it doesn't exist
  if ! gh repo view "$ORG/$repo_name" --json name >/dev/null 2>&1; then
    gh repo create "$ORG/$repo_name" --private --description "$description" --source . --push
    echo "  ✓ Created and pushed $ORG/$repo_name (private)"
  else
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/$ORG/$repo_name.git"
    git push -u origin main 2>/dev/null || git push -u origin main --force
    echo "  ✓ Pushed to existing $ORG/$repo_name"
  fi
}

# ============================================================
# DCTLs
# ============================================================
echo ""
echo "╔══════════════════════════════════════╗"
echo "║        DCTL Plugin Repos             ║"
echo "╚══════════════════════════════════════╝"

create_repo "$DCTL_ROOT/Hue-Contrast-Compressor-DCTL" \
  "Hue-Contrast-Compressor-DCTL" \
  "Hue Contrast Compressor" \
  "hue-contrast-compressor-dctl" \
  '{
  "pluginId": "hue-contrast-compressor-dctl",
  "displayName": "Hue Contrast Compressor",
  "releaseRepo": "dec18studios/Hue-Contrast-Compressor-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Color Grading",
  "description": "Compresses hue shifts caused by contrast adjustments, keeping colors clean through the tonal range.",
  "tags": ["hue", "contrast", "color grading", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Hue.Contrast.Compressor.*\\.zip$",
      "packageType": "zip",
      "bundleName": "GE Contrast Hue Compressor.dctl",
      "bundleIdentifier": "com.dec18studios.hue-contrast-compressor-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Hue.Contrast.Compressor.*\\.zip$",
      "packageType": "zip",
      "bundleName": "GE Contrast Hue Compressor.dctl",
      "bundleIdentifier": "com.dec18studios.hue-contrast-compressor-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Hue.Contrast.Compressor.*\\.zip$",
      "packageType": "zip",
      "bundleName": "GE Contrast Hue Compressor.dctl",
      "bundleIdentifier": "com.dec18studios.hue-contrast-compressor-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Compresses hue shifts caused by contrast adjustments"

create_repo "$DCTL_ROOT/Perfect-Exposure-DCTL" \
  "Perfect-Exposure-DCTL" \
  "Perfect Exposure" \
  "perfect-exposure-dctl" \
  '{
  "pluginId": "perfect-exposure-dctl",
  "displayName": "Perfect Exposure",
  "releaseRepo": "dec18studios/Perfect-Exposure-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Workflow",
  "description": "Workflow and diagnostic DCTL for evaluating and correcting exposure in DaVinci Resolve.",
  "tags": ["exposure", "workflow", "diagnostic", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Perfect.Exposure.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Perfect Exposure.dctl",
      "bundleIdentifier": "com.dec18studios.perfect-exposure-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Perfect.Exposure.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Perfect Exposure.dctl",
      "bundleIdentifier": "com.dec18studios.perfect-exposure-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Perfect.Exposure.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Perfect Exposure.dctl",
      "bundleIdentifier": "com.dec18studios.perfect-exposure-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Workflow and diagnostic tool for exposure evaluation"

create_repo "$DCTL_ROOT/Volume-Curve-DCTL" \
  "Volume-Curve-DCTL" \
  "Volume Curve" \
  "volume-curve-dctl" \
  '{
  "pluginId": "volume-curve-dctl",
  "displayName": "Volume Curve",
  "releaseRepo": "dec18studios/Volume-Curve-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Color Grading",
  "description": "Color volume curve control for advanced color grading in DaVinci Resolve.",
  "tags": ["volume", "curve", "color grading", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Volume.Curve.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Volume Curve.dctl",
      "bundleIdentifier": "com.dec18studios.volume-curve-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Volume.Curve.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Volume Curve.dctl",
      "bundleIdentifier": "com.dec18studios.volume-curve-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Volume.Curve.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Volume Curve.dctl",
      "bundleIdentifier": "com.dec18studios.volume-curve-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Color volume curve control for advanced grading"

create_repo "$DCTL_ROOT/Grain-By-Greg-DCTL" \
  "Grain-By-Greg-DCTL" \
  "Grain By Greg" \
  "grain-by-greg-dctl" \
  '{
  "pluginId": "grain-by-greg-dctl",
  "displayName": "Grain By Greg",
  "releaseRepo": "dec18studios/Grain-By-Greg-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Film Emulation",
  "description": "Realistic film grain emulation DCTL with per-channel control and density response curves.",
  "tags": ["grain", "film", "emulation", "color grading", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Grain.By.Greg.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Grain By Greg.dctl",
      "bundleIdentifier": "com.dec18studios.grain-by-greg-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Grain.By.Greg.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Grain By Greg.dctl",
      "bundleIdentifier": "com.dec18studios.grain-by-greg-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Grain.By.Greg.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Grain By Greg.dctl",
      "bundleIdentifier": "com.dec18studios.grain-by-greg-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Realistic film grain emulation with per-channel control"

create_repo "$DCTL_ROOT/Film-Negative-Spac-CST-DCTL" \
  "Film-Negative-Spac-CST-DCTL" \
  "Film Negative Spac CST" \
  "film-negative-spac-cst-dctl" \
  '{
  "pluginId": "film-negative-spac-cst-dctl",
  "displayName": "Film Negative Spac CST",
  "releaseRepo": "dec18studios/Film-Negative-Spac-CST-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Film Emulation",
  "description": "Film negative color space transform DCTL for authentic film emulation workflows.",
  "tags": ["film", "negative", "CST", "color space", "emulation", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Film.Negative.Spac.CST.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Film Negative Spac CST.dctl",
      "bundleIdentifier": "com.dec18studios.film-negative-spac-cst-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Film.Negative.Spac.CST.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Film Negative Spac CST.dctl",
      "bundleIdentifier": "com.dec18studios.film-negative-spac-cst-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Film.Negative.Spac.CST.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Film Negative Spac CST.dctl",
      "bundleIdentifier": "com.dec18studios.film-negative-spac-cst-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Film negative color space transform for film emulation"

create_repo "$DCTL_ROOT/Saturation-Separator-DCTL" \
  "Saturation-Separator-DCTL" \
  "Saturation Separator" \
  "saturation-separator-dctl" \
  '{
  "pluginId": "saturation-separator-dctl",
  "displayName": "Saturation Separator",
  "releaseRepo": "dec18studios/Saturation-Separator-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Color Grading",
  "description": "Isolates and controls saturation bands independently for precise color grading.",
  "tags": ["saturation", "separator", "color grading", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Saturation.Separator.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Saturation Separator.dctl",
      "bundleIdentifier": "com.dec18studios.saturation-separator-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Saturation.Separator.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Saturation Separator.dctl",
      "bundleIdentifier": "com.dec18studios.saturation-separator-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Saturation.Separator.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Saturation Separator.dctl",
      "bundleIdentifier": "com.dec18studios.saturation-separator-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Isolates and controls saturation bands for precise grading"

create_repo "$DCTL_ROOT/Linear-Ramp-Diagnostic-DCTL" \
  "Linear-Ramp-Diagnostic-DCTL" \
  "Linear Ramp Diagnostic" \
  "linear-ramp-diagnostic-dctl" \
  '{
  "pluginId": "linear-ramp-diagnostic-dctl",
  "displayName": "Linear Ramp Diagnostic",
  "releaseRepo": "dec18studios/Linear-Ramp-Diagnostic-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Diagnostics",
  "description": "Diagnostic DCTL that generates a linear ramp for testing and calibrating color pipelines.",
  "tags": ["diagnostic", "ramp", "linear", "calibration", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Linear.Ramp.Diagnostic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Linear Ramp Diagnostic.dctl",
      "bundleIdentifier": "com.dec18studios.linear-ramp-diagnostic-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Linear.Ramp.Diagnostic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Linear Ramp Diagnostic.dctl",
      "bundleIdentifier": "com.dec18studios.linear-ramp-diagnostic-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Linear.Ramp.Diagnostic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Linear Ramp Diagnostic.dctl",
      "bundleIdentifier": "com.dec18studios.linear-ramp-diagnostic-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Linear ramp generator for testing color pipelines"

create_repo "$DCTL_ROOT/Color-Slice-Omatic-DCTL" \
  "Color-Slice-Omatic-DCTL" \
  "Color Slice O'matic" \
  "color-slice-omatic-dctl" \
  '{
  "pluginId": "color-slice-omatic-dctl",
  "displayName": "Color Slice O'\''matic",
  "releaseRepo": "dec18studios/Color-Slice-Omatic-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Color Grading",
  "description": "Hue-based color slicing tool for targeted color manipulation in DaVinci Resolve.",
  "tags": ["color", "slice", "hue", "color grading", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Color.Slice.Omatic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Color Slice Omatic.dctl",
      "bundleIdentifier": "com.dec18studios.color-slice-omatic-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Color.Slice.Omatic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Color Slice Omatic.dctl",
      "bundleIdentifier": "com.dec18studios.color-slice-omatic-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Color.Slice.Omatic.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Color Slice Omatic.dctl",
      "bundleIdentifier": "com.dec18studios.color-slice-omatic-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Hue-based color slicing for targeted color manipulation"

create_repo "$DCTL_ROOT/Dolby-Vision-Spoofer-DCTL" \
  "Dolby-Vision-Spoofer-DCTL" \
  "Dolby Vision Spoofer" \
  "dolby-vision-spoofer-dctl" \
  '{
  "pluginId": "dolby-vision-spoofer-dctl",
  "displayName": "Dolby Vision Spoofer",
  "releaseRepo": "dec18studios/Dolby-Vision-Spoofer-DCTL",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve"],
  "requiredFamilies": ["universal"],
  "category": "Workflow",
  "description": "Workflow DCTL that spoofs Dolby Vision metadata for testing and development purposes.",
  "tags": ["dolby", "vision", "workflow", "HDR", "DCTL"],
  "assetRules": [
    {
      "family": "universal",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Dolby.Vision.Spoofer.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Dolby Vision Spoofer.dctl",
      "bundleIdentifier": "com.dec18studios.dolby-vision-spoofer-dctl",
      "installPath": "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Dolby.Vision.Spoofer.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Dolby Vision Spoofer.dctl",
      "bundleIdentifier": "com.dec18studios.dolby-vision-spoofer-dctl",
      "installPath": "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL",
      "installMode": "file-browse"
    },
    {
      "family": "universal",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Dolby.Vision.Spoofer.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Dolby Vision Spoofer.dctl",
      "bundleIdentifier": "com.dec18studios.dolby-vision-spoofer-dctl",
      "installPath": "/opt/resolve/LUT/DCTL",
      "installMode": "file-browse"
    }
  ]
}' \
  "DCTL: Spoofs Dolby Vision metadata for testing"

# ============================================================
# OFX Plugins
# ============================================================
echo ""
echo "╔══════════════════════════════════════╗"
echo "║        OFX Plugin Repos              ║"
echo "╚══════════════════════════════════════╝"

create_repo "$OFX_ROOT/Hue-Contrast-Compressor-OFX" \
  "Hue-Contrast-Compressor-OFX" \
  "Hue Contrast Compressor OFX" \
  "hue-contrast-compressor-ofx" \
  '{
  "pluginId": "hue-contrast-compressor-ofx",
  "displayName": "Hue Contrast Compressor OFX",
  "releaseRepo": "dec18studios/Hue-Contrast-Compressor-OFX",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "Color Grading",
  "description": "OFX plugin that compresses hue shifts caused by contrast adjustments with full GPU acceleration.",
  "tags": ["hue", "contrast", "OFX", "color grading", "GPU"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "HueContrastCompressor.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "HueContrastCompressor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.HueContrastCompressor",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "HueContrastCompressor.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "HueContrastCompressor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.HueContrastCompressor",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "HueContrastCompressor.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "HueContrastCompressor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.HueContrastCompressor",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: GPU-accelerated hue shift compression for contrast adjustments"

create_repo "$OFX_ROOT/Technically-Technicolor-DRT" \
  "Technically-Technicolor-DRT" \
  "Technically Technicolor DRT" \
  "technicolor-drt" \
  '{
  "pluginId": "technicolor-drt",
  "displayName": "Technically Technicolor DRT",
  "releaseRepo": "dec18studios/Technically-Technicolor-DRT",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "Film Emulation",
  "description": "Display Render Transform inspired by the Technicolor dye-transfer process with GPU acceleration.",
  "tags": ["technicolor", "DRT", "film", "emulation", "OFX"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "Technicolor.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Technicolor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.Technicolor",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "Technicolor.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "Technicolor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.Technicolor",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "Technicolor.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "Technicolor.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.Technicolor",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: Technicolor dye-transfer inspired Display Render Transform"

# PhotoChemist-OFX already has a config in docs/plugins/photochemist — create the repo
create_repo "$OFX_ROOT/PhotoChemist-OFX" \
  "PhotoChemist-OFX" \
  "PhotoChemist DRT" \
  "photochemist" \
  '{
  "pluginId": "photochemist",
  "displayName": "PhotoChemist DRT",
  "releaseRepo": "dec18studios/PhotoChemist-OFX",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "Film Emulation",
  "description": "43-band spectral film emulation engine with multiple film stock presets and full GPU acceleration.",
  "tags": ["film", "spectral", "DRT", "emulation", "OFX"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "PhotoChemist.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "PhotoChemist.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.PhotoChemist",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "PhotoChemist.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "PhotoChemist.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.PhotoChemist",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "PhotoChemist.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "PhotoChemist.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.PhotoChemist",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: 43-band spectral film emulation engine"

create_repo "$OFX_ROOT/OpenDRT-OFX" \
  "OpenDRT-OFX" \
  "OpenDRT" \
  "opendrt-ofx" \
  '{
  "pluginId": "opendrt-ofx",
  "displayName": "OpenDRT",
  "releaseRepo": "dec18studios/OpenDRT-OFX",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "DRT",
  "description": "Open-source Display Render Transform OFX plugin with GPU acceleration.",
  "tags": ["DRT", "open source", "display", "render", "OFX"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "OpenDRT.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "OpenDRT.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.OpenDRT",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "OpenDRT.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "OpenDRT.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.OpenDRT",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "OpenDRT.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "OpenDRT.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.OpenDRT",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: Open-source Display Render Transform"

create_repo "$OFX_ROOT/IBKeymaster-OFX" \
  "IBKeymaster-OFX" \
  "IBKeymaster" \
  "ibkeymaster-ofx" \
  '{
  "pluginId": "ibkeymaster-ofx",
  "displayName": "IBKeymaster",
  "releaseRepo": "dec18studios/IBKeymaster-OFX",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "Workflow",
  "description": "OFX keying and image-based workflow plugin with GPU acceleration.",
  "tags": ["keying", "workflow", "compositing", "OFX"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "IBKeymaster.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "IBKeymaster.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.IBKeymaster",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "IBKeymaster.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "IBKeymaster.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.IBKeymaster",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "IBKeymaster.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "IBKeymaster.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.IBKeymaster",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: Image-based keying and workflow plugin"

create_repo "$OFX_ROOT/X-Grade-OFX" \
  "X-Grade-OFX" \
  "X-Grade" \
  "x-grade-ofx" \
  '{
  "pluginId": "x-grade-ofx",
  "displayName": "X-Grade",
  "releaseRepo": "dec18studios/X-Grade-OFX",
  "minManagerVersion": "0.1.0",
  "hostProcesses": ["Resolve", "DaVinci Resolve", "Fusion", "Fusion Studio", "Nuke", "NukeX", "NukeStudio", "Hiero"],
  "requiredFamilies": ["macos"],
  "category": "Workflow",
  "description": "Advanced grading workflow OFX plugin for DaVinci Resolve and other OFX hosts.",
  "tags": ["grading", "workflow", "OFX"],
  "assetRules": [
    {
      "family": "macos",
      "platform": "macos",
      "arch": "universal",
      "assetPattern": "X-Grade.*macOS.*universal.*\\.zip$",
      "packageType": "zip",
      "bundleName": "X-Grade.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.XGrade",
      "installPath": "/Library/OFX/Plugins"
    },
    {
      "family": "windows",
      "platform": "windows",
      "arch": "x86_64",
      "assetPattern": "X-Grade.*[Ww]indows.*x86_64.*\\.zip$",
      "packageType": "zip",
      "bundleName": "X-Grade.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.XGrade",
      "installPath": "C:\\Program Files\\Common Files\\OFX\\Plugins"
    },
    {
      "family": "linux",
      "platform": "linux",
      "arch": "x86_64",
      "assetPattern": "X-Grade.*linux.*x86_64.*\\.tar\\.gz$",
      "packageType": "tar.gz",
      "bundleName": "X-Grade.ofx.bundle",
      "bundleIdentifier": "com.dec18studios.XGrade",
      "installPath": "/usr/OFX/Plugins"
    }
  ]
}' \
  "OFX: Advanced grading workflow plugin"

# ============================================================
# External Workflow Apps (repo structure only, no file moves)
# ============================================================
echo ""
echo "╔══════════════════════════════════════╗"
echo "║        Workflow App Repos            ║"
echo "╚══════════════════════════════════════╝"

# Apps get repos but no local folder creation — keep developing where they are
for APP_INFO in \
  "Resolve-Node-Toggler|Resolve Node Toggler|resolve-node-toggler|Workflow|Standalone app that enables keyboard-driven node toggling in DaVinci Resolve." \
  "DCTL-Manager|DCTL Manager|dctl-manager|Workflow|Desktop application for managing and organizing DCTLs in DaVinci Resolve."
do
  IFS='|' read -r REPO_NAME DISPLAY_NAME PLUGIN_ID CATEGORY DESC <<< "$APP_INFO"

  echo ""
  echo "=== Setting up $REPO_NAME (app — remote repo only) ==="

  # Create GitHub repo if it doesn't exist
  if ! gh repo view "$ORG/$REPO_NAME" --json name >/dev/null 2>&1; then
    gh repo create "$ORG/$REPO_NAME" --private --description "$DESC"
    echo "  ✓ Created $ORG/$REPO_NAME (private, empty — push when ready)"
  else
    echo "  ✓ $ORG/$REPO_NAME already exists"
  fi
done

echo ""
echo "╔══════════════════════════════════════╗"
echo "║          All repos created!          ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Summary:"
echo "  DCTL repos:  $DCTL_ROOT/"
echo "  OFX repos:   $OFX_ROOT/"
echo "  App repos:   Remote only (push when ready)"
echo ""
echo "Next steps:"
echo "  1. Move your DCTL source files into the Plugin Repos subfolders"
echo "  2. Move your OFX source files into the Plugin Repos subfolders"
echo "  3. When ready, create a GitHub Release on each repo with a zip asset"
echo "  4. The Pages workflow will auto-generate the catalog"
