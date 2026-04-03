# Local Testing

`Dec 18 Studios Plugins` can use the local dev feed from:

- `docs/plugins/dev/index.json`

Place local test manifests in `docs/plugins/dev/` for any plugin (e.g., `photochemist.local.json`).

Because the dev feed is read from disk at refresh time, you can edit manifests and then click **Refresh Plugin Catalog** — no rebuild or app restart needed.

## Suggested test flow

### Install test

1. Place a local manifest for your plugin in `docs/plugins/dev/`.
2. Point `docs/plugins/dev/index.json` at it.
3. Refresh the catalog.
4. Install the plugin and verify the bundle lands in the correct OFX path.

### Update test

1. Start with an older version manifest.
2. Refresh and install.
3. Swap to a newer version manifest.
4. Refresh and confirm `Update available` appears.
5. Run the update and verify the new version.

### Checksum failure test

1. Edit a manifest to have an intentionally wrong `sha256`.
2. Refresh the catalog.
3. Trigger install/update.
4. Confirm the visible alert and activity log show a checksum mismatch.

### Host-running block test

1. Launch a supported host (Resolve, Nuke, etc.).
2. Trigger install/update.
3. Confirm the visible alert mentions the running host process.

### Rollback test

1. Install an older package.
2. Swap to a manifest with a deliberate post-backup failure.
3. Trigger update.
4. Confirm the install fails visibly.
5. Refresh and confirm the installed version is still the previous one.
