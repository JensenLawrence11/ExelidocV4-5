Exelidoc Office Add-in Preview
=============================

This is an experimental developer preview, not a finished or tested release.
It is not published in Microsoft AppSource. Outlook is not included.

The manifest targets Word, Excel, and PowerPoint desktop apps, but these hosts
have not been verified by the maintainer. Do not rely on this preview with
important documents or production data.

Installation
------------

1. Extract this ZIP.
2. In a supported Office desktop app, open the Add-ins menu and choose the
   option to upload a custom add-in manifest.
3. Select manifest.xml and follow Office's prompts.

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