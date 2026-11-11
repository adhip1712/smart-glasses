# YouTube playlist publishing setup

Visionary Nexus uses YouTube Data API v3 OAuth to create real playlists in the signed-in YouTube account. The existing YOUTUBE_API_KEY remains responsible for public catalogue search; it is not an account authorization credential.

## Google Cloud setup

1. Open Google Cloud Console and select the project used by Visionary Nexus.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. If the app is in Testing mode, add the Google account that will connect as a test user.
4. Create an OAuth client ID with application type **Web application**.
5. Add this exact Authorized redirect URI:
   http://localhost:8000/api/music/youtube-oauth/callback

## Backend environment

Add these values to the repository-root `.env` file (the same file that already contains `YOUTUBE_API_KEY`; do not commit the client secret):

YOUTUBE_CLIENT_ID=your-google-oauth-client-id
YOUTUBE_CLIENT_SECRET=your-google-oauth-client-secret
YOUTUBE_REDIRECT_URI=http://localhost:8000/api/music/youtube-oauth/callback

Keep the existing YOUTUBE_API_KEY. It is still used for public YouTube search.

Restart the FastAPI backend after changing .env. In Visionary Nexus, open Music and click **Connect YouTube**. Complete Google's consent screen, return to Visionary Nexus, and refresh the page. The button should show **YouTube connected**.

## CSV import behavior

Importing a CSV searches for each title/artist, creates a private playlist in the connected YouTube account, adds the matched videos in CSV order, saves the playlist reference in Visionary Nexus, and opens the real YouTube playlist in a separate browser tab. Tracks with no search match or that YouTube refuses to add are reported in the import message.

The OAuth refresh token is stored in the existing SQLite settings table. Keep the repository-root `.env` and the SQLite database private.
