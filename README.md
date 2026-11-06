# Pivovara · Skladište – web verzija

Web verzija programa za skladište, proizvodnju i HACCP evidencije mini pivovare.
Radi u pregledniku (Chrome, Edge, Firefox, Safari) na računalu, tabletu i mobitelu.

- Stranica se poslužuje s GitHub Pages (ovaj repozitorij).
- **Podaci NISU u ovom repozitoriju.** Spremaju se u zaseban **privatni** repozitorij (npr. `pivovara-podaci`)
  kao datoteka `skladiste.db`. Svako spremanje je nova verzija
  (povijest = sigurnosne kopije).
- Program radi u pregledniku pomoću Pythona (Pyodide):
  FIFO, LOT-ovi, šarže, kegovi, HACCP zapisi i dokumenti (PDF/Excel), trošarine MI-PI, otpremnice, naljepnice.

## Postavljanje
1. U repozitoriju: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
2. Napravite privatni repozitorij za podatke (`pivovara-podaci`, Private, s README datotekom).
3. Napravite fine-grained token samo za taj repozitorij (Contents: Read and write).
4. Otvorite stranicu `https://<korisnik>.github.io/<repozitorij>/`, upišite korisničko ime, repozitorij podataka i token.
5. Učitajte postojeću bazu `skladiste.db` (sigurnosnu kopiju) ili počnite s praznom bazom.

Detaljne upute: dokument „Web verzija – postavljanje na GitHub”.

