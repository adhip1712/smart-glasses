# Chrome Web Store submission pack

## Store listing name
Visionary Nexus - YouTube Skip Helper

## Short description
Clicks YouTube's native Skip Ads button when it is visibly available. Does not block or bypass ads.

## Detailed description
Visionary Nexus - YouTube Skip Helper is an optional companion extension for Visionary Nexus. When YouTube displays its own enabled Skip Ads control, the extension can click that control for the user. It does not hide advertisements, skip non-skippable ads, alter ad delivery, collect browsing history, or communicate with a remote server. It runs only on YouTube pages and requires no special host permissions beyond its YouTube content-script match.

The extension may stop working if YouTube changes its interface. It cannot make a Skip Ads button appear sooner or guarantee that every ad is skippable.

## Category
Productivity

## Single purpose
Click YouTube's own visible and enabled Skip Ads button when the button is available.

## Permission justification
No optional or powerful permissions are requested. The content script is limited to YouTube pages because it needs to detect YouTube's native Skip Ads control in the page DOM.

## Privacy practices
- Personally identifiable information: Not collected.
- Health, financial, authentication, location, web history, or user activity data: Not collected.
- Data is not sold, transferred, or used for advertising.
- No analytics or remote server communication.

## Before submitting
1. Replace the privacy policy URL in the Web Store dashboard with a publicly accessible URL to `PRIVACY.md` (or a hosted HTML version).
2. Upload `visionary-nexus-youtube-skip-helper.zip` in the Chrome Web Store Developer Dashboard.
3. Add at least one genuine screenshot of the extension's behavior; do not use mock screenshots as proof of operation.
4. Complete the data-use disclosures truthfully.
5. Submit for Google's review. The extension is not published until Google approves it.

## After approval
Copy the published Chrome Web Store item URL. Add that exact URL to Visionary Nexus as the installation link. Do not ship a guessed or placeholder store URL.
