# Synthetic localhost SMTP certificate

These PEM files are public test fixtures, including a deliberately shared synthetic private key. They are only for the isolated localhost SMTP regression test. Never use them for a deployed server, real mailbox, or customer data.

The test starts a child Node process with `NODE_EXTRA_CA_CERTS` pointing to this fixture certificate. It does not change system trust, disable TLS verification, contact a real mail provider, or require OpenSSL at test runtime. The server certificate includes `localhost` and `127.0.0.1`; the test verifies the SNI hostname even though the client connects to a validated pinned IP.

Maintainers can regenerate the pair with an existing OpenSSL installation:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout tests/fixtures/mail/localhost-key.pem -out tests/fixtures/mail/localhost-cert.pem -days 3650 -subj '/CN=localhost/O=Form Studio synthetic tests only' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -addext 'basicConstraints=critical,CA:TRUE'
```

Regenerate together before expiry or if a local clock falls outside the certificate validity period, then rerun `node --import tsx --test tests/mail-settings.test.ts`. Keep the files synthetic and publicly reproducible; no production secrets belong here.
