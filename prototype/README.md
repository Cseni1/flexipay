# FlexiPay console prototype

A clickable UX prototype with simulated data, deployed as the separate Vercel project
`flexipay-console-prototype` (https://flexipay-console-prototype.vercel.app). It is not connected to the API and no
money moves. It shows the product experience we are building toward: dashboard, payments, new payment, recipients,
pay-from accounts, the FlexiPay wallet, the recipient's claim page, activity, developers and settings.

It is one static page (`index.html`); the QR code on the wallet page comes from `qrcodejs` 1.0.0 on cdnjs.

Deploy from this folder (Vercel CLI, logged in to the team scope that owns the project):

```bash
cd prototype && npx vercel deploy --prod --yes --scope <team-scope>
```

The production plan is to connect this experience to the real API (see the 12 November plan); until then every
screen is labelled simulated.
