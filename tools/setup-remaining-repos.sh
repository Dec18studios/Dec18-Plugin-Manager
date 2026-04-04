#!/bin/bash
set -euo pipefail

ORG="Dec18studios"
DCTL_ROOT="/Volumes/Server Sync Files/Private-DCTLS/Plugin Repos"
OFX_ROOT="/Volumes/Server Sync Files/Private-OFX-Builds/Plugin Repos"

init_and_push() {
  local dir="$1"
  local repo_name="$2"
  local config_json="$3"
  local display_name="$4"
  local desc="$5"

  echo ""
  echo "=== $repo_name ==="
  mkdir -p "$dir"
  cd "$dir"

  echo "$config_json" > manager-release-config.json

  cat > README.md << READMEEOF
# $display_name

$desc

Part of the [Dec 18 Studios](https://dec18studios.com/color-grading-tools/) plugin collection.

## Installation

Install via the **Dec 18 Studios Plugin Manager** — download from [dec18studios.com](https://dec18studios.com).

## License

Proprietary — Dec 18 Studios. All rights reserved.
READMEEOF

  if [ ! -d .git ]; then
    git init && git branch -M main
  fi
  git add -A
  git commit -m "chore: initial repo setup with manager-release-config" --allow-empty 2>/dev/null || true

  # Create repo if it doesn't exist
  if ! gh repo view "$ORG/$repo_name" --json name >/dev/null 2>&1; then
    gh repo create "$ORG/$repo_name" --private --description "$desc"
    sleep 2  # Wait for GitHub to propagate
  fi

  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$ORG/$repo_name.git"
  git push -u origin main 2>&1
  echo "  ✓ $repo_name done"
}

# Remaining DCTLs
init_and_push "$DCTL_ROOT/Film-Negative-Spac-CST-DCTL" "Film-Negative-Spac-CST-DCTL" \
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
}' "Film Negative Spac CST" "DCTL: Film negative color space transform for film emulation"

init_and_push "$DCTL_ROOT/Saturation-Separator-DCTL" "Saturation-Separator-DCTL" \
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
}' "Saturation Separator" "DCTL: Isolates and controls saturation bands for precise grading"

init_and_push "$DCTL_ROOT/Linear-Ramp-Diagnostic-DCTL" "Linear-Ramp-Diagnostic-DCTL" \
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
}' "Linear Ramp Diagnostic" "DCTL: Linear ramp generator for testing color pipelines"

init_and_push "$DCTL_ROOT/Color-Slice-Omatic-DCTL" "Color-Slice-Omatic-DCTL" \
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
}' "Color Slice O'matic" "DCTL: Hue-based color slicing for targeted color manipulation"

init_and_push "$DCTL_ROOT/Dolby-Vision-Spoofer-DCTL" "Dolby-Vision-Spoofer-DCTL" \
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
}' "Dolby Vision Spoofer" "DCTL: Spoofs Dolby Vision metadata for testing"

# OFX Plugins
echo ""
echo "=== OFX Plugins ==="

init_and_push "$OFX_ROOT/Hue-Contrast-Compressor-OFX" "Hue-Contrast-Compressor-OFX" \
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
}' "Hue Contrast Compressor OFX" "OFX: GPU-accelerated hue shift compression"

init_and_push "$OFX_ROOT/Technically-Technicolor-DRT" "Technically-Technicolor-DRT" \
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
}' "Technically Technicolor DRT" "OFX: Technicolor dye-transfer inspired Display Render Transform"

init_and_push "$OFX_ROOT/PhotoChemist-OFX" "PhotoChemist-OFX" \
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
}' "PhotoChemist DRT" "OFX: 43-band spectral film emulation engine"

init_and_push "$OFX_ROOT/OpenDRT-OFX" "OpenDRT-OFX" \
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
}' "OpenDRT" "OFX: Open-source Display Render Transform"

init_and_push "$OFX_ROOT/IBKeymaster-OFX" "IBKeymaster-OFX" \
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
}' "IBKeymaster" "OFX: Image-based keying and workflow plugin"

init_and_push "$OFX_ROOT/X-Grade-OFX" "X-Grade-OFX" \
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
}' "X-Grade" "OFX: Advanced grading workflow plugin"

# App repos (remote only, no local folders)
echo ""
echo "=== Workflow Apps ==="
for APP_INFO in \
  "Resolve-Node-Toggler|Standalone app that enables keyboard-driven node toggling in DaVinci Resolve." \
  "DCTL-Manager|Desktop application for managing and organizing DCTLs in DaVinci Resolve."
do
  IFS='|' read -r REPO_NAME DESC <<< "$APP_INFO"
  if ! gh repo view "$ORG/$REPO_NAME" --json name >/dev/null 2>&1; then
    gh repo create "$ORG/$REPO_NAME" --private --description "$DESC"
    echo "  ✓ Created $REPO_NAME (private, empty)"
  else
    echo "  ✓ $REPO_NAME already exists"
  fi
done

echo ""
echo "✅ All repos created!"
