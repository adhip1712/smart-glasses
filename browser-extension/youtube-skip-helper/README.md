# Visionary Nexus — YouTube Skip Helper

This optional Chrome extension clicks YouTube's own visible, enabled **Skip Ads** button when YouTube makes it available. It does not block ads, bypass non-skippable ads, or force an ad to become skippable.

## Download for Visionary Nexus users

1. Download the extension ZIP from the [GitHub file page](https://github.com/adhip1712/smart-glasses/blob/fix/visionary-nexus-feature-wiring/browser-extension/youtube-skip-helper/visionary-nexus-youtube-skip-helper.zip) using the **Download raw file** button.
2. Extract the ZIP into a folder you can keep, such as `Documents\VisionaryNexusSkipHelper`.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
6. Reload any open YouTube tab.

Chrome requires this manual approval for extensions installed outside the Chrome Web Store. Visionary Nexus cannot install it silently. Only install it if you trust the source and have reviewed the extension files.

## What it does

- Runs only on `youtube.com` pages.
- Clicks only YouTube's native Skip Ads control when it is visible and enabled.
- Does not read Visionary Nexus pages, account data, playlists, or browsing history.
- Does not bypass non-skippable ads or modify ad playback.

## Remove or disable

Open `chrome://extensions`, find **Visionary Nexus - YouTube Skip Helper**, and use the toggle to disable it or select **Remove** to uninstall it.

## Troubleshooting

- If Chrome says the folder is invalid, make sure you selected the extracted folder containing `manifest.json`, not the ZIP file or its parent folder.
- If YouTube was already open during installation, reload that tab.
- The helper can only click a Skip Ads button when YouTube actually displays one. It cannot make an ad skippable.
- YouTube may change its interface, which can require an extension update.

## Developer testing

For local testing, extract the ZIP and load the folder containing `manifest.json` from `chrome://extensions` with Developer mode enabled.
