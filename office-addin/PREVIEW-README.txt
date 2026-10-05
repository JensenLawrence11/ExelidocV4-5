Exelidoc Office Add-in Preview
=============================

This is an experimental developer preview, not a finished or tested release.
It is not published in Microsoft AppSource. Outlook uses a separate compose
manifest; its manifest passes schema validation, but live behavior still needs
to be verified in a signed-in Outlook client.

The manifest targets Word, Excel, and PowerPoint desktop apps, but these hosts
have not been verified by the maintainer. Do not rely on this preview with
important documents or production data.

Installation
------------

1. Extract this ZIP.
2. For Word, Excel, or PowerPoint, upload manifest.xml from the app's Add-ins
   menu. For Outlook, open My Add-ins, choose Add a custom add-in, then Add
   from file and select manifest-outlook.xml.
3. Sign in to Microsoft 365 and follow the host's prompts. In Outlook, open a
   message compose window and choose Open Exelidoc from the ribbon.

The manifest loads the task pane from the Exelidoc hosted service. The Office
preview currently does not share the Chrome extension's saved sign-in, and
Office authentication has not been verified. The add-in may therefore be
unable to access an Exelidoc account or complete requests.

Account and billing
-------------------

Create a free account in the Exelidoc browser extension first. Stripe Checkout
is for paid upgrades only; it does not create an Exelidoc account. Use the
same account email when upgrading on the website.

Support and current status
--------------------------

This preview is supplied for testing only. No promise is made that it works
in a particular Office version or tenant configuration.