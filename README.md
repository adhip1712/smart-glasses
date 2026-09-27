# Smart Glasses

## Navidrome Music Setup

1. Install Navidrome and configure a legitimate music library.
2. Create a Navidrome user that has access to the library you want to stream.
3. Set the backend-only environment variables in the project .env file:

```env
NAVIDROME_URL=http://127.0.0.1:4533
NAVIDROME_USERNAME=your_username
NAVIDROME_PASSWORD=your_password
NAVIDROME_ENABLED=true
```

4. Start the Smart Glasses backend.
5. Use the existing music voice and route commands such as:
   - play
   - pause
   - resume
   - next
   - previous

These commands use the Navidrome Subsonic/OpenSubsonic API for real library playback and do not expose the Navidrome password to the frontend.
