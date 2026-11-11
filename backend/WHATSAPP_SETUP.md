# WhatsApp in Visionary Nexus

Visionary Nexus supports two distinct WhatsApp paths.

## Personal WhatsApp

Personal WhatsApp remains available through official click-to-chat links. Visionary Nexus opens the selected recipient's chat and prepares a message; sending from a personal account still requires the user to tap **Send**.

Contacts can be imported from a phone picker or VCF/CSV file. When signed in, the contact list is synced to the user's Visionary Nexus account; a local browser copy is also kept for convenience.

Example: "Hey Vision, send a WhatsApp message to Adhiksh. The message is I am going to be late."

## WhatsApp Business automatic sending

Automatic sending uses Meta's official WhatsApp Cloud API. Create/configure a Meta developer app and WhatsApp Business Platform phone number, then set these variables in the project-root `.env` file (never put these in frontend environment variables):

- `WHATSAPP_ACCESS_TOKEN`: server-side access token with the WhatsApp messaging permission.
- `WHATSAPP_PHONE_NUMBER_ID`: phone-number ID shown in the WhatsApp API setup panel.
- `WHATSAPP_BUSINESS_ACCOUNT_ID`: optional account identifier for future account-management features.
- `WHATSAPP_APP_SECRET`: Meta app secret, used to verify webhook signatures.
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: a private string you choose and also enter in Meta's webhook configuration.
- `WHATSAPP_GRAPH_API_VERSION`: Graph API version, default `v23.0`; change it to a version currently supported by your Meta app.

Restart the backend after changing environment variables.

The WhatsApp tab includes a Business sender. Choose a saved contact, enter the message, and confirm the recipient's opt-in; Visionary Nexus then calls Meta's Cloud API directly from the backend. This can send to ordinary personal WhatsApp users—the recipient does not need WhatsApp Business. Meta may require an approved template outside the 24-hour customer-service window. A successful API response means Meta accepted the request, not that delivery is guaranteed. Keep the access token and app secret server-side only.

## API routes

- `GET /api/whatsapp/status` — authenticated integration status.
- `POST /api/whatsapp/business/send` — authenticated Cloud API text send; requires `opt_in_confirmed: true`.
- The WhatsApp tab uses this endpoint for its Business sender.
- `GET /api/whatsapp/webhook` — Meta webhook verification.
- `POST /api/whatsapp/webhook` — webhook callback signature validation and acknowledgement.

The webhook currently acknowledges Meta callbacks; inbound messages and delivery receipts are not yet shown in the Visionary Nexus interface or copied into AI chat history.
